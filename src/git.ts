import type { Exec } from "./exec.js";

// Routes git AND file reads through the injected Exec — no direct process
// spawning and no node:fs, keeping this module free of I/O side effects (C1).

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
  const result = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

export async function worktreeDirty(exec: Exec, cwd: string): Promise<boolean> {
  const result = await exec("git", ["status", "--porcelain"], { cwd });
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
  const result = await exec("git", ["--no-pager", "diff", "--no-index", "--", "/dev/null", path], {
    cwd,
  });
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
  const statResult = await exec("git", ["diff", "--stat", "HEAD"], { cwd });
  const diffResult = await exec("git", ["diff", "HEAD"], { cwd });
  const untrackedResult = await exec("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd,
  });

  const paths = untrackedResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

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
