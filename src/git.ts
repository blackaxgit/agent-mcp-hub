import type { Exec } from "./exec.js";

// Routes git AND file reads through the injected Exec — no direct process
// spawning and no node:fs, keeping this module free of I/O side effects (C1).

/**
 * Hardening for running git against an UNTRUSTED working tree. git config is a
 * code-execution surface: a hostile `.git/config` / `.gitattributes` in the repo
 * being inspected can make a plain `git diff`/`git status` run an arbitrary
 * command (CVE-2025-27613/27614 family). Every git call below goes through
 * `git()`, which neutralises the known execution vectors:
 *
 *  - `-c core.fsmonitor=` / `-c core.hooksPath=/dev/null` — a command-line `-c`
 *    is the HIGHEST-precedence config source (above the repo's own `.git/config`),
 *    so this disables a hostile local fsmonitor/hook even though the local config
 *    is still read.
 *  - `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM=/dev/null` —
 *    ignore system/global config entirely.
 *  - `--no-pager` / `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0` — no pager, no prompt.
 *  - diff subcommands additionally pass `--no-ext-diff --no-textconv` (see
 *    `diffArgs`), disabling external-diff and textconv drivers from ANY config.
 *
 * Documented RESIDUAL: an attacker-named `filter.<driver>.clean` assigned via the
 * repo's own `.gitattributes` cannot be disabled by a flag for a fully
 * attacker-controlled `.git/`. Closing that requires operating on a clean clone
 * (git's own guidance); it is out of scope for this in-place hardening and is
 * tracked as a follow-up.
 */
export const GIT_HARDENING_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
};

export const GIT_HARDENING_TOPLEVEL = [
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.hooksPath=/dev/null",
  "--no-pager",
];

/** The full argv a hardened git call uses for `subcommand` (exported for tests). */
export function hardenedGitArgs(subcommand: string[]): string[] {
  return [...GIT_HARDENING_TOPLEVEL, ...subcommand];
}

/** Run a read-only git subcommand hardened against the worktree's own config. */
function git(
  exec: Exec,
  cwd: string,
  subcommand: string[],
  extra?: { timeoutMs?: number },
): ReturnType<Exec> {
  return exec("git", hardenedGitArgs(subcommand), {
    cwd,
    env: GIT_HARDENING_ENV,
    ...extra,
  });
}

/** Diff args with the external-diff and textconv execution vectors disabled. */
function diffArgs(...rest: string[]): string[] {
  return ["diff", "--no-ext-diff", "--no-textconv", ...rest];
}

/** A newly-created file surfaced to the reviewer with its bounded contents. */
export interface UntrackedFile {
  path: string;
  /**
   * The file as a git add-diff (leading `+`, `diff --git`/`Binary files …`
   * headers), decoded as UTF-8 and capped at MAX_UNTRACKED_FILE_BYTES. A
   * placeholder when the file could not be read.
   */
  content: string;
  /** True when `content` was cut at the byte cap OR the file was unreadable. */
  truncated: boolean;
}

/**
 * Per-file byte cap. A malicious or generated file must not blow up the review
 * prompt, so contents past this point are dropped and `truncated` is set.
 */
export const MAX_UNTRACKED_FILE_BYTES = 64 * 1024;

/**
 * Cap on how many untracked files we read contents for. Beyond this the review
 * would be unusably large; the overflow is signalled via `untrackedTruncated`.
 */
export const MAX_UNTRACKED_FILES = 50;

export async function isGitRepo(exec: Exec, cwd: string): Promise<boolean> {
  const result = await git(exec, cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

export async function worktreeDirty(exec: Exec, cwd: string): Promise<boolean> {
  const result = await git(exec, cwd, ["status", "--porcelain"]);
  return result.stdout.length > 0;
}

/**
 * Read one untracked file's contents through the injected Exec, bounded to
 * MAX_UNTRACKED_FILE_BYTES. `git diff --no-index -- /dev/null <path>` prints the
 * file as an addition diff and, crucially, collapses BINARY files to a short
 * "Binary files … differ" line — so a binary blob can never flood the prompt.
 * git exits 1 when a diff exists (the normal case) and 0 for an empty file; any
 * other code means it could not read the file. Surfacing that as an explicit
 * placeholder (truncated) is safer than a silent empty body, which a reviewer
 * would read as "nothing to see here".
 */
async function readUntracked(exec: Exec, cwd: string, path: string): Promise<UntrackedFile> {
  // `--` fences `path` as a positional, so a path starting with `-` is safe; the
  // hardened `git()` disables ext-diff/textconv so reading the file can't execute.
  const result = await git(exec, cwd, diffArgs("--no-index", "--", "/dev/null", path));
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return { path, content: "(unreadable — git could not read this file)", truncated: true };
  }
  const raw = result.stdout;
  const bytes = Buffer.from(raw, "utf8");
  if (bytes.length > MAX_UNTRACKED_FILE_BYTES) {
    return {
      path,
      content: bytes.subarray(0, MAX_UNTRACKED_FILE_BYTES).toString("utf8"),
      truncated: true,
    };
  }
  return { path, content: raw, truncated: false };
}

export async function captureChange(
  exec: Exec,
  cwd: string,
): Promise<{
  stat: string;
  diff: string;
  untracked: UntrackedFile[];
  /** True when more than MAX_UNTRACKED_FILES exist; the overflow is not read. */
  untrackedTruncated: boolean;
}> {
  const statResult = await git(exec, cwd, diffArgs("--stat", "HEAD"));
  const diffResult = await git(exec, cwd, diffArgs("HEAD"));
  // `-z`: NUL-delimited, verbatim paths. Splitting on "\n" + trim would drop or
  // corrupt filenames containing newlines/leading/trailing whitespace, letting a
  // runner hide a payload file from the review.
  const untrackedResult = await git(exec, cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);

  const paths = untrackedResult.stdout.split("\0").filter((p) => p.length > 0);

  const untrackedTruncated = paths.length > MAX_UNTRACKED_FILES;
  const untracked: UntrackedFile[] = [];
  for (const path of paths.slice(0, MAX_UNTRACKED_FILES)) {
    untracked.push(await readUntracked(exec, cwd, path));
  }

  return {
    stat: statResult.stdout,
    diff: diffResult.stdout,
    untracked,
    untrackedTruncated,
  };
}
