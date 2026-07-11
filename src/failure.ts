import {
  AgentStalledError,
  InvalidCwdError,
  OutputLimitError,
  ServerBusyError,
  SpawnError,
  TimeoutError,
  type ExecResult,
} from "./exec.js";
import { stripAnsi } from "./ansi.js";

export { stripAnsi } from "./ansi.js";

/** Lowercased, ANSI-free view of `s` used for phrase matching (never shown). */
export function normalize(s: string): string {
  return stripAnsi(s).toLowerCase();
}

export type FailureCode =
  | "not_installed"
  | "invalid_cwd"
  | "not_authenticated"
  | "not_configured"
  | "timed_out"
  | "output_limit"
  | "stream_stalled"
  | "server_busy"
  | "tool_failure";

/** Static per-adapter remediation metadata (the pure subset classification needs). */
interface AdapterMeta {
  name: string;
  loginCommand: string;
  apiKeyEnv?: string;
}

/** What the caller supplies: exactly one of a rejected error OR a resolved result. */
interface Outcome {
  result?: ExecResult;
  error?: unknown;
}

export interface FailureClassification {
  code: FailureCode;
  message: string;
}

/** Upstream-overload markers — checked FIRST so they never become auth. */
const BUSY_PHRASES = ["rate limit", "429", "overloaded", "try again later", "503", "server busy"];

/**
 * High-confidence, adapter-specific auth phrases (R10). Only these trigger
 * `not_authenticated`; broad HTTP/token markers (`401`, `unauthorized`, …) are
 * deliberately absent so a bare log line like `HTTP 401 GET /x` stays a
 * `tool_failure`.
 */
const PRIMARY_AUTH_PHRASES = [
  "not logged in",
  "not authenticated",
  "sign in",
  "sign-in",
  "please log in",
  "please run /login",
  "login required",
  "authentication required",
  "no credentials",
  "no api key",
  "set openai_api_key",
  "set anthropic_api_key",
  "invalid api key",
  "api key not found",
  "press any key to sign in",
  // NB: only the specific "please run /login" (above) — bare "please run" is too
  // broad (e.g. "please run `npm install`" is NOT an auth failure).
  "auth login",
];

/** Quota/billing is a spend problem, never an auth problem — suppresses auth. */
const QUOTA_PHRASES = ["insufficient_quota", "billing"];

const CONFIG_PHRASES = [
  "not configured",
  "no default model",
  "no model",
  "no provider",
  "missing config",
  "model not found",
];

const CAUSE_MAX = 160;
const TAIL_MAX = 500;

/** Clip to the first `max` chars, appending an ellipsis marker when truncated. */
function clipHead(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/** Clip to the last `max` chars, prefixing an ellipsis marker when truncated. */
function clipTail(s: string, max: number): string {
  return s.length <= max ? s : "…" + s.slice(s.length - max);
}

/** First non-empty ANSI-stripped line of stderr (falling back to stdout), clipped. */
function causeSnippet(result: ExecResult): string {
  const source = result.stderr.trim().length > 0 ? result.stderr : result.stdout;
  const line = stripAnsi(source)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return clipHead(line ?? "", CAUSE_MAX);
}

/** Trimmed, ANSI-stripped stderr/stdout tail for tool_failure bodies. */
function outputTail(result: ExecResult): string {
  const source = result.stderr.trim().length > 0 ? result.stderr : result.stdout;
  const cleaned = stripAnsi(source).trim();
  return cleaned.length === 0 ? "(no output)" : clipTail(cleaned, TAIL_MAX);
}

/** `Fix: run \`<loginCommand>\`` plus an optional `(or set <ENV>)` clause. */
function remediation(adapter: AdapterMeta): string {
  const env = adapter.apiKeyEnv ? ` (or set ${adapter.apiKeyEnv})` : "";
  return `Fix: run \`${adapter.loginCommand}\`${env}.`;
}

function classifyError(adapter: AdapterMeta, error: unknown): FailureClassification {
  // Before SpawnError: a missing cwd also surfaces as ENOENT, and reporting it as
  // "not installed" sends the caller after the wrong fault entirely.
  if (error instanceof InvalidCwdError) {
    return {
      code: "invalid_cwd",
      message:
        `${adapter.name} failed: cwd is not a directory this server can see.\n` +
        `${error.cwd}\n` +
        `Fix: pass an absolute path that exists on this machine — the path must be ` +
        `resolvable by the server process itself.`,
    };
  }
  if (error instanceof SpawnError) {
    return {
      code: "not_installed",
      message:
        `${adapter.name} failed: not installed.\n` +
        `${adapter.name} was not found on PATH (spawn failed).\n` +
        `Fix: install the CLI and ensure it is on PATH.`,
    };
  }
  if (error instanceof ServerBusyError) {
    return {
      code: "server_busy",
      message:
        `${adapter.name} failed: server busy.\n` +
        `The agent pool/queue is full.\n` +
        `Fix: retry shortly.`,
    };
  }
  if (error instanceof AgentStalledError) {
    // Matched BEFORE TimeoutError: a stalled agent is a network-path problem, not
    // a "wait longer" problem. The message names the agent, quotes the matched
    // signature, points at the common cause (TLS-intercepting proxy), and tells
    // the caller to treat the agent as unavailable. Never suggests raising the
    // timeout — that is what the timed_out message wrongly says.
    return {
      code: "stream_stalled",
      message:
        `${adapter.name} failed: stream stalled.\n` +
        `Detected diagnostic reconnect pattern: "${error.signature}" (strike ${error.strikes}).\n` +
        `The agent cannot complete a run in this environment — common cause is a TLS-intercepting ` +
        `proxy or a network path that drops the agent's backend connection.\n` +
        `Treat ${adapter.name} as unavailable until the network path is fixed.`,
    };
  }
  if (error instanceof TimeoutError) {
    // Split by WHICH cap fired: an idle timeout means the agent went silent
    // (likely hung or its backend is unreachable) — raising the cap won't help,
    // so we point at the CLI/model/connection instead. A total timeout means a
    // genuinely long run outgrew the runtime cap, so raising it is the fix.
    if (error.kind === "idle") {
      return {
        code: "timed_out",
        message:
          `${adapter.name} failed: no output (idle timeout).\n` +
          `The agent produced no output for ${error.timeoutMs}ms — it may be hung, ` +
          `or its model/backend is unreachable.\n` +
          `Fix: check the ${adapter.name} CLI, its model, and the network connection.`,
      };
    }
    return {
      code: "timed_out",
      message:
        `${adapter.name} failed: timed out after ${error.timeoutMs}ms.\n` +
        `The total runtime cap was exceeded before the agent finished.\n` +
        `Fix: raise timeoutMs (or MCP_AGENT_TIMEOUT_MS), or check the agent/model is responsive.`,
    };
  }
  if (error instanceof OutputLimitError) {
    return {
      code: "output_limit",
      message:
        `${adapter.name} failed: output limit exceeded.\n` +
        `The agent produced more than ${error.maxOutputBytes} bytes.\n` +
        `Fix: narrow the prompt, or raise maxOutputBytes.`,
    };
  }
  // Default class — every thrown error (incl. the opencode dash-guard) lands here.
  const raw = error instanceof Error ? error.message : String(error);
  return {
    code: "tool_failure",
    message: `${adapter.name} failed:\n${clipHead(stripAnsi(raw).trim(), TAIL_MAX)}`,
  };
}

function classifyResult(adapter: AdapterMeta, result: ExecResult): FailureClassification {
  const text = normalize(`${result.stderr}\n${result.stdout}`);

  // 1. Overload first: these must never be read as auth.
  if (BUSY_PHRASES.some((p) => text.includes(p))) {
    return {
      code: "server_busy",
      message:
        `${adapter.name} failed: server busy.\n` +
        `${causeSnippet(result)}\n` +
        `Fix: retry shortly.`,
    };
  }

  // 2. Auth — precision over recall: a primary phrase is required, and quota
  //    always wins (it is a spend problem, not an auth problem).
  const hasPrimaryAuth = PRIMARY_AUTH_PHRASES.some((p) => text.includes(p));
  const hasQuota = QUOTA_PHRASES.some((p) => text.includes(p));
  if (hasPrimaryAuth && !hasQuota) {
    return {
      code: "not_authenticated",
      message:
        `${adapter.name} failed: not authenticated.\n` +
        `${causeSnippet(result)}\n` +
        remediation(adapter),
    };
  }

  // 3. Configuration.
  if (CONFIG_PHRASES.some((p) => text.includes(p))) {
    return {
      code: "not_configured",
      message:
        `${adapter.name} failed: not configured.\n` +
        `${causeSnippet(result)}\n` +
        `Fix: set a model/provider (run \`${adapter.loginCommand}\` or configure the CLI)` +
        `${adapter.apiKeyEnv ? ` — or set ${adapter.apiKeyEnv}` : ""}.`,
    };
  }

  // 4. Default.
  return {
    code: "tool_failure",
    message: `${adapter.name} failed (exit ${result.exitCode ?? "unknown"}).\n${outputTail(result)}`,
  };
}

/**
 * Map any agent failure to a stable `{ code, message }` with clean, ANSI-free,
 * actionable text. Pure — no I/O. Precedence (R3): the error branch (classified
 * by TYPE) takes priority over the result branch; within the result branch,
 * overload → auth → config → generic tool_failure.
 */
export function classifyFailure(adapter: AdapterMeta, outcome: Outcome): FailureClassification {
  if (outcome.error !== undefined && outcome.error !== null) {
    return classifyError(adapter, outcome.error);
  }
  if (outcome.result) {
    return classifyResult(adapter, outcome.result);
  }
  // Neither supplied — defensive fallback, should not happen in practice.
  return { code: "tool_failure", message: `${adapter.name} failed.\n(no output)` };
}
