import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import { cursorAdapter } from "./adapters/cursor.js";
import { opencodeAdapter } from "./adapters/opencode.js";
import type { Exec } from "./exec.js";
import { classifyFailure } from "./failure.js";
import type { AgentAdapter } from "./types.js";

export function allAdapters(): AgentAdapter[] {
  return [codexAdapter, cursorAdapter, opencodeAdapter, claudeAdapter];
}

/**
 * Selects which adapters to expose based on MCP_AGENTS (comma-separated,
 * whitespace-tolerant, case-sensitive). Unset or empty-after-parse yields all
 * adapters (never an empty server). Unknown names fail fast with an actionable
 * message so typos are surfaced at wiring time rather than silently dropped.
 */
export function enabledAdapters(agentsSpec = process.env.MCP_AGENTS): AgentAdapter[] {
  const requested = [
    ...new Set(
      (agentsSpec ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  if (requested.length === 0) return allAdapters();
  const known = new Set(allAdapters().map((a) => a.name));
  for (const name of requested) {
    if (!known.has(name)) {
      throw new Error(
        `Unknown agent "${name}" in MCP_AGENTS. Valid agents: ${allAdapters()
          .map((a) => a.name)
          .join(", ")}`,
      );
    }
  }
  const set = new Set(requested);
  return allAdapters().filter((a) => set.has(a.name));
}

/**
 * Availability has THREE independent axes, and collapsing them is how a broken
 * agent passes for a healthy one:
 *
 *  - `installed` — the binary resolves on PATH with the exec bit. A filesystem
 *    fact; never inferred from running the binary.
 *  - `usable` — a probe actually succeeded. `available` mirrors this and is kept
 *    for callers written against the old boolean shape.
 *  - `reason` — why not, when not.
 *
 * The old implementation asked `--version` the availability question and trusted
 * its exit code. `codex --version` exits 0 while printing
 * "WARNING: … could not create PATH aliases: Read-only file system", so a codex
 * that could not run a single task reported `available: true`. Exit codes are the
 * weakest possible evidence; the output is where the truth is.
 */
export interface AgentAvailability {
  name: string;
  installed: boolean;
  usable: boolean;
  /** Mirrors `usable`. Retained so existing callers keep working. */
  available: boolean;
  reason?: string;
}

/**
 * A probe may exit 0 and still be announcing that the CLI cannot function.
 * These are read against combined stdout+stderr, not the exit code.
 */
const FATAL_PROBE_SIGNATURES: readonly RegExp[] = [
  /read-only file system/i,
  /permission denied/i,
  /\bEACCES\b/,
  /\bEROFS\b/,
  /\bENOSPC\b/,
];

const PROBE_TIMEOUT_MS = 10_000;

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a binary the way spawn will: absolute paths as-is, otherwise the first
 * executable match walking PATH. Returns undefined when nothing matches, which is
 * the ONLY thing that may set `installed: false`.
 */
export function resolveOnPath(binary: string, pathEnv = process.env.PATH): string | undefined {
  if (isAbsolute(binary)) return isExecutableFile(binary) ? binary : undefined;
  for (const dir of (pathEnv ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, binary);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Identifier-shaped lines only. A CLI can exit 0 while emitting a banner, an
 * update notice, or "you are not logged in" prose — none of which are ids. Lines
 * containing whitespace are prose; lines without it are candidate ids.
 */
export function parseProbeIds(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/\s/.test(line));
}

function firstFatalLine(output: string): string | undefined {
  for (const line of output.split("\n")) {
    if (FATAL_PROBE_SIGNATURES.some((re) => re.test(line))) return line.trim();
  }
  return undefined;
}

function result(
  name: string,
  installed: boolean,
  usable: boolean,
  reason?: string,
): AgentAvailability {
  return reason === undefined
    ? { name, installed, usable, available: usable }
    : { name, installed, usable, available: usable, reason };
}

/** Injected so availability stays testable without depending on the host's PATH. */
export type ResolveBinary = (binary: string) => string | undefined;

/**
 * Probes one adapter. Never throws: a probe failure is data, not an exception.
 * The probe command is per-adapter because the CLIs disagree — `opencode models`
 * lists models, `codex models` is not a subcommand at all — so there is no single
 * command that proves usability across all four.
 */
export async function checkAvailability(
  adapter: AgentAdapter,
  exec: Exec,
  resolve: ResolveBinary = resolveOnPath,
): Promise<AgentAvailability> {
  if (resolve(adapter.binary) === undefined) {
    return result(
      adapter.name,
      false,
      false,
      `${adapter.binary} was not found on PATH. Fix: install the CLI and ensure it is on PATH.`,
    );
  }

  const probeArgs = adapter.probeArgs ?? ["--version"];
  let outcome: { stdout: string; stderr: string; exitCode: number | null };
  try {
    outcome = await exec(adapter.binary, probeArgs, { timeoutMs: PROBE_TIMEOUT_MS });
  } catch (error) {
    // Installed (we just resolved it), but the probe could not complete.
    return result(adapter.name, true, false, classifyFailure(adapter, { error }).message);
  }

  if (outcome.exitCode !== 0) {
    return result(adapter.name, true, false, classifyFailure(adapter, { result: outcome }).message);
  }

  // Exit 0 is not a pass. Check what it actually said.
  const fatal = firstFatalLine(`${outcome.stdout}\n${outcome.stderr}`);
  if (fatal !== undefined) {
    return result(
      adapter.name,
      true,
      false,
      `${adapter.name} exited 0 but reported a fatal condition: ${fatal}`,
    );
  }

  if (adapter.probeRequiresOutput === true && parseProbeIds(outcome.stdout).length === 0) {
    return result(
      adapter.name,
      true,
      false,
      `${adapter.name} probe (\`${adapter.binary} ${probeArgs.join(" ")}\`) exited 0 but listed nothing. ` +
        `Fix: run \`${adapter.loginCommand}\`.`,
    );
  }

  return result(adapter.name, true, true);
}
