import type { Exec } from "./exec.js";

// Routes git through the injected Exec — no direct process spawning.

export async function isGitRepo(exec: Exec, cwd: string): Promise<boolean> {
  const result = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

export async function worktreeDirty(exec: Exec, cwd: string): Promise<boolean> {
  const result = await exec("git", ["status", "--porcelain"], { cwd });
  return result.stdout.length > 0;
}

export async function captureChange(
  exec: Exec,
  cwd: string,
): Promise<{ stat: string; diff: string; untracked: string[] }> {
  const statResult = await exec("git", ["diff", "--stat", "HEAD"], { cwd });
  const diffResult = await exec("git", ["diff", "HEAD"], { cwd });
  const untrackedResult = await exec("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd,
  });

  const untracked = untrackedResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return {
    stat: statResult.stdout,
    diff: diffResult.stdout,
    untracked,
  };
}
