# agent-mcp-hub Implementation Plan (rev 2 — post plan-review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Subagent execution note:** when tasks run as subagents (workflow), SKIP every "Commit" step — subagents never commit; the orchestrator verifies and commits per phase.

**Goal:** Build `agent-mcp-hub` — a single stdio MCP server that lets any MCP client (Claude Code, Cursor, VS Code, …) delegate prompts to the Codex, Cursor, and OpenCode CLI agents, modeled on [tuannvm/codex-mcp-server](https://github.com/tuannvm/codex-mcp-server) but multi-agent.

**Architecture:** Adapter pattern with strict layering. Each CLI agent is a pure adapter (`name` + `binary` + `buildInvocation()` → `{args, stdin?}` — no I/O), all subprocess side effects are isolated in one `exec.ts` boundary module, and `server.ts` wires adapters into MCP tools. Prompts are delivered via stdin where the CLI documents it (codex `-` sentinel, cursor piped print mode) to avoid option-parser injection; opencode takes a positional prompt with a leading-dash guard. Tools exposed: `codex`, `cursor`, `opencode`, `run_all` (parallel fan-out), `list_agents` (availability probe), `ping`.

**Tech Stack:** TypeScript (strict, ESM), Node ≥20, `@modelcontextprotocol/sdk` ^1.29, `zod` ^3.25, `vitest` ^2 for tests, `tsx` for dev, plain `tsc` for build.

## Global Constraints

- Node engine: `>=20`; `"type": "module"`; TS `strict: true`, module `NodeNext`.
- Package/bin name: `agent-mcp-hub` (bin: `agent-mcp-hub`).
- Adapters MUST be pure (no imports of `node:child_process`); the ONLY module that spawns processes is `src/exec.ts` (guard-tested).
- Never `shell: true`; prompt travels as one argv element or via stdin.
- Server never writes to stdout outside the MCP transport; diagnostics go to stderr (guard-tested).
- Every tool handler must handle success, non-zero exit, spawn failure, and timeout explicitly.
- Default subprocess timeout: `300_000` ms; availability probes: `10_000` ms.
- `npm run typecheck` must cover BOTH `src/` and `tests/` (via `tsconfig.test.json`).
- Commit format: `<type>(<scope>): <subject>`; NO AI signatures or `Co-Authored-By` trailers ever.
- Never push without the pre-push security gate (gitleaks/trufflehog).

## File Structure

```
agent-mcp-hub/
├── package.json              # metadata, deps, bin, scripts
├── tsconfig.json             # strict ESM NodeNext config (build: src only)
├── tsconfig.test.json        # typecheck config covering src + tests
├── src/
│   ├── types.ts              # AgentAdapter, AgentInvocation, AgentRunOptions
│   ├── exec.ts               # runCommand() — ONLY subprocess boundary
│   ├── adapters/
│   │   ├── codex.ts          # `codex exec … -` (prompt via stdin)
│   │   ├── cursor.ts         # `cursor-agent -p …` (prompt via stdin)
│   │   └── opencode.ts       # `opencode run … <prompt>` (+ dash guard)
│   ├── registry.ts           # allAdapters(), checkAvailability()
│   ├── server.ts             # buildServer() — MCP tool wiring
│   └── index.ts              # bin entry: stdio transport
├── tests/
│   ├── smoke.test.ts
│   ├── exec.test.ts
│   ├── adapters/
│   │   ├── codex.test.ts     # per-adapter files → disjoint parallel ownership
│   │   ├── cursor.test.ts
│   │   └── opencode.test.ts
│   ├── registry.test.ts
│   ├── server.test.ts
│   └── constraints.test.ts   # C1/C5 architecture guard
└── README.md
```

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.test.json`
- Create: `.gitignore`
- Create: `src/types.ts` (placeholder — Task 2 fills it)
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a working `npm test` / `npm run typecheck` toolchain every later task relies on.

> Note: `git init` was already run by the orchestrator (user-provided repo `git@github.com:blackaxgit/agent-mcp-hub.git`).

- [ ] **Step 1: Create the project files**

Create `package.json`:

```json
{
  "name": "agent-mcp-hub",
  "version": "0.1.0",
  "description": "One MCP server bridging the Codex, Cursor, and OpenCode CLI agents",
  "license": "MIT",
  "type": "module",
  "bin": { "agent-mcp-hub": "dist/index.js" },
  "files": ["dist"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.test.json"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

Create `tsconfig.test.json` (typechecks tests too; never emits):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true,
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src", "tests"]
}
```

Create `.gitignore`:

```
node_modules/
dist/
*.log
.env
```

Create placeholder `src/types.ts` (so both tsconfigs have inputs before Task 2):

```ts
export {};
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: lockfile created, no errors.

- [ ] **Step 3: Write the smoke test**

Create `tests/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("toolchain smoke", () => {
  it("runs vitest", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: 1 test PASS, typecheck clean.

- [ ] **Step 5: Commit** *(skip if running as subagent)*

```bash
git add package.json package-lock.json tsconfig.json tsconfig.test.json .gitignore src/types.ts tests/smoke.test.ts
git commit -m "chore(scaffold): init agent-mcp-hub TypeScript project"
```

---

### Task 2: Types + Subprocess Boundary (`exec.ts`)

**Files:**
- Modify: `src/types.ts` (replace placeholder)
- Create: `src/exec.ts`
- Test: `tests/exec.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface AgentRunOptions { model?: string }`
  - `interface AgentInvocation { args: string[]; stdin?: string }`
  - `interface AgentAdapter { readonly name: string; readonly binary: string; buildInvocation(prompt: string, options?: AgentRunOptions): AgentInvocation }`
  - `interface ExecResult { stdout: string; stderr: string; exitCode: number | null }`
  - `type Exec = (binary: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; input?: string }) => Promise<ExecResult>`
  - `runCommand: Exec` — rejects on spawn failure and on timeout (rejection happens from the `close` handler AFTER the kill, so no process outlives the promise); resolves with `exitCode` otherwise. `input`, when set, is piped to the child's stdin.
  - `DEFAULT_TIMEOUT_MS = 300_000`

- [ ] **Step 1: Write the failing tests**

Create `tests/exec.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUT_MS, runCommand } from "../src/exec.js";

describe("runCommand", () => {
  it("captures stdout and exit code 0 on success", async () => {
    const r = await runCommand("node", ["-e", "console.log('hi')"]);
    expect(r.stdout.trim()).toBe("hi");
    expect(r.exitCode).toBe(0);
  });

  it("captures stderr and non-zero exit code on failure", async () => {
    const r = await runCommand("node", ["-e", "console.error('boom'); process.exit(3)"]);
    expect(r.stderr.trim()).toBe("boom");
    expect(r.exitCode).toBe(3);
  });

  it("pipes input to the child's stdin", async () => {
    const r = await runCommand("node", ["-e", "process.stdin.pipe(process.stdout)"], {
      input: "echo me",
    });
    expect(r.stdout).toBe("echo me");
    expect(r.exitCode).toBe(0);
  });

  it("rejects with an actionable error for a missing binary", async () => {
    await expect(runCommand("definitely-not-a-binary-xyz", [])).rejects.toThrow(
      /Is it installed and on PATH/,
    );
  });

  it("kills the process and rejects when the timeout is exceeded", async () => {
    await expect(
      runCommand("node", ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out after 200ms/);
  });

  it("defaults the timeout to 300000ms", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(300_000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/exec.test.ts`
Expected: FAIL — cannot resolve `../src/exec.js`.

- [ ] **Step 3: Implement types and exec**

Replace `src/types.ts`:

```ts
export interface AgentRunOptions {
  model?: string;
}

export interface AgentInvocation {
  /** argv passed to the binary (no shell involved). */
  args: string[];
  /** When set, the executor must pipe this to the child's stdin. */
  stdin?: string;
}

export interface AgentAdapter {
  /** Tool name exposed over MCP, e.g. "codex". */
  readonly name: string;
  /** Executable looked up on PATH, e.g. "cursor-agent". */
  readonly binary: string;
  /** Pure function: prompt + options -> invocation. No I/O allowed here. */
  buildInvocation(prompt: string, options?: AgentRunOptions): AgentInvocation;
}
```

Create `src/exec.ts`:

```ts
import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type Exec = (
  binary: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; input?: string },
) => Promise<ExecResult>;

export const DEFAULT_TIMEOUT_MS = 300_000;

export const runCommand: Exec = (binary, args, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: opts.cwd,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    if (opts.input !== undefined) {
      // Swallow EPIPE if the child exits before reading its stdin.
      child.stdin?.on("error", () => {});
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(
        new Error(`Failed to start "${binary}": ${err.message}. Is it installed and on PATH?`),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (timedOut) {
        reject(new Error(`"${binary}" timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code,
      });
    });
  });
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/exec.test.ts && npm run typecheck`
Expected: 6 tests PASS, typecheck clean.

- [ ] **Step 5: Commit** *(skip if running as subagent)*

```bash
git add src/types.ts src/exec.ts tests/exec.test.ts
git commit -m "feat(exec): add adapter contracts and stdin-capable subprocess boundary"
```

---

### Task 3: Codex Adapter

**Files:**
- Create: `src/adapters/codex.ts`
- Test: `tests/adapters/codex.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter`, `AgentInvocation`, `AgentRunOptions` from `src/types.ts`.
- Produces: `codexAdapter: AgentAdapter` with `name: "codex"`, `binary: "codex"`. Prompt travels via stdin using Codex's documented `-` sentinel (immune to option-parser injection).

- [ ] **Step 1: Write the failing tests**

Create `tests/adapters/codex.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { codexAdapter } from "../../src/adapters/codex.js";

describe("codexAdapter", () => {
  it("pipes the prompt via stdin using the '-' sentinel", () => {
    expect(codexAdapter.buildInvocation("fix the bug")).toEqual({
      args: ["exec", "--skip-git-repo-check", "-"],
      stdin: "fix the bug",
    });
  });

  it("inserts --model before the stdin sentinel when given", () => {
    expect(codexAdapter.buildInvocation("fix the bug", { model: "o3" })).toEqual({
      args: ["exec", "--skip-git-repo-check", "--model", "o3", "-"],
      stdin: "fix the bug",
    });
  });

  it("is injection-safe for prompts that look like flags", () => {
    const inv = codexAdapter.buildInvocation("--help me understand this");
    expect(inv.args).toEqual(["exec", "--skip-git-repo-check", "-"]);
    expect(inv.stdin).toBe("--help me understand this");
  });

  it("exposes correct identity", () => {
    expect(codexAdapter.name).toBe("codex");
    expect(codexAdapter.binary).toBe("codex");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/adapters/codex.test.ts`
Expected: FAIL — cannot resolve `../../src/adapters/codex.js`.

- [ ] **Step 3: Implement the adapter**

Create `src/adapters/codex.ts`:

```ts
import type { AgentAdapter, AgentInvocation, AgentRunOptions } from "../types.js";

export const codexAdapter: AgentAdapter = {
  name: "codex",
  binary: "codex",
  buildInvocation(prompt: string, options: AgentRunOptions = {}): AgentInvocation {
    const args = ["exec", "--skip-git-repo-check"];
    if (options.model) args.push("--model", options.model);
    // "-" = read the prompt from stdin (documented Codex CLI sentinel).
    args.push("-");
    return { args, stdin: prompt };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/adapters/codex.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit** *(skip if running as subagent)*

```bash
git add src/adapters/codex.ts tests/adapters/codex.test.ts
git commit -m "feat(adapters): add codex adapter with stdin prompt delivery"
```

---

### Task 4: Cursor Adapter

**Files:**
- Create: `src/adapters/cursor.ts`
- Test: `tests/adapters/cursor.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter`, `AgentInvocation`, `AgentRunOptions` from `src/types.ts`.
- Produces: `cursorAdapter: AgentAdapter` with `name: "cursor"`, `binary: "cursor-agent"`. Prompt travels via piped stdin (documented print-mode input path — no positional prompt).

- [ ] **Step 1: Write the failing tests**

Create `tests/adapters/cursor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cursorAdapter } from "../../src/adapters/cursor.js";

describe("cursorAdapter", () => {
  it("builds print-mode args and pipes the prompt via stdin", () => {
    expect(cursorAdapter.buildInvocation("explain this repo")).toEqual({
      args: ["-p", "--output-format", "text"],
      stdin: "explain this repo",
    });
  });

  it("appends --model when given", () => {
    expect(cursorAdapter.buildInvocation("explain this repo", { model: "gpt-5" })).toEqual({
      args: ["-p", "--output-format", "text", "--model", "gpt-5"],
      stdin: "explain this repo",
    });
  });

  it("is injection-safe for prompts that look like flags", () => {
    const inv = cursorAdapter.buildInvocation("--force what does this flag do");
    expect(inv.args).toEqual(["-p", "--output-format", "text"]);
    expect(inv.stdin).toBe("--force what does this flag do");
  });

  it("exposes correct identity", () => {
    expect(cursorAdapter.name).toBe("cursor");
    expect(cursorAdapter.binary).toBe("cursor-agent");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/adapters/cursor.test.ts`
Expected: FAIL — cannot resolve `../../src/adapters/cursor.js`.

- [ ] **Step 3: Implement the adapter**

Create `src/adapters/cursor.ts`:

```ts
import type { AgentAdapter, AgentInvocation, AgentRunOptions } from "../types.js";

export const cursorAdapter: AgentAdapter = {
  name: "cursor",
  binary: "cursor-agent",
  buildInvocation(prompt: string, options: AgentRunOptions = {}): AgentInvocation {
    const args = ["-p", "--output-format", "text"];
    if (options.model) args.push("--model", options.model);
    // No positional prompt: cursor-agent reads it from piped stdin in print mode.
    return { args, stdin: prompt };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/adapters/cursor.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit** *(skip if running as subagent)*

```bash
git add src/adapters/cursor.ts tests/adapters/cursor.test.ts
git commit -m "feat(adapters): add cursor adapter with stdin prompt delivery"
```

---

### Task 5: OpenCode Adapter

**Files:**
- Create: `src/adapters/opencode.ts`
- Test: `tests/adapters/opencode.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter`, `AgentInvocation`, `AgentRunOptions` from `src/types.ts`.
- Produces: `opencodeAdapter: AgentAdapter` with `name: "opencode"`, `binary: "opencode"`. OpenCode documents neither stdin nor `--`, so the prompt is positional; `buildInvocation` THROWS an actionable error for prompts starting with `-` (the server maps thrown errors to `isError`).

- [ ] **Step 1: Write the failing tests**

Create `tests/adapters/opencode.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { opencodeAdapter } from "../../src/adapters/opencode.js";

describe("opencodeAdapter", () => {
  it("builds run args with a positional prompt", () => {
    expect(opencodeAdapter.buildInvocation("write tests")).toEqual({
      args: ["run", "write tests"],
    });
  });

  it("inserts --model before the prompt when given", () => {
    expect(
      opencodeAdapter.buildInvocation("write tests", { model: "anthropic/claude-sonnet-5" }),
    ).toEqual({
      args: ["run", "--model", "anthropic/claude-sonnet-5", "write tests"],
    });
  });

  it("rejects prompts starting with '-' with an actionable error", () => {
    expect(() => opencodeAdapter.buildInvocation("--help me")).toThrow(
      /prompts that start with '-'/,
    );
  });

  it("exposes correct identity", () => {
    expect(opencodeAdapter.name).toBe("opencode");
    expect(opencodeAdapter.binary).toBe("opencode");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/adapters/opencode.test.ts`
Expected: FAIL — cannot resolve `../../src/adapters/opencode.js`.

- [ ] **Step 3: Implement the adapter**

Create `src/adapters/opencode.ts`:

```ts
import type { AgentAdapter, AgentInvocation, AgentRunOptions } from "../types.js";

export const opencodeAdapter: AgentAdapter = {
  name: "opencode",
  binary: "opencode",
  buildInvocation(prompt: string, options: AgentRunOptions = {}): AgentInvocation {
    if (prompt.startsWith("-")) {
      // opencode documents neither stdin input nor a "--" delimiter, so a
      // dash-leading prompt could be parsed as a flag by its CLI.
      throw new Error(
        "opencode cannot safely run prompts that start with '-' (its CLI may parse them as flags). Rephrase the prompt to start with a word, e.g. \"explain --help ...\".",
      );
    }
    const args = ["run"];
    if (options.model) args.push("--model", options.model);
    args.push(prompt);
    return { args };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/adapters/opencode.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit** *(skip if running as subagent)*

```bash
git add src/adapters/opencode.ts tests/adapters/opencode.test.ts
git commit -m "feat(adapters): add opencode adapter with dash-prompt guard"
```

---

### Task 6: Registry + Availability Probe

**Files:**
- Create: `src/registry.ts`
- Test: `tests/registry.test.ts`

**Interfaces:**
- Consumes: `codexAdapter`, `cursorAdapter`, `opencodeAdapter`; `Exec` from `src/exec.ts`.
- Produces:
  - `allAdapters(): AgentAdapter[]` — returns `[codexAdapter, cursorAdapter, opencodeAdapter]`.
  - `checkAvailability(adapter: AgentAdapter, exec: Exec): Promise<boolean>` — `true` iff `<binary> --version` (top-level, NOT a subcommand flag) exits 0 within 10s; never throws.

- [ ] **Step 1: Write the failing tests**

Create `tests/registry.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { Exec } from "../src/exec.js";
import { allAdapters, checkAvailability } from "../src/registry.js";
import { codexAdapter } from "../src/adapters/codex.js";

describe("allAdapters", () => {
  it("returns codex, cursor, and opencode in stable order", () => {
    expect(allAdapters().map((a) => a.name)).toEqual(["codex", "cursor", "opencode"]);
  });
});

describe("checkAvailability", () => {
  it("returns true when --version exits 0", async () => {
    const exec: Exec = vi.fn(async () => ({ stdout: "1.0.0\n", stderr: "", exitCode: 0 }));
    await expect(checkAvailability(codexAdapter, exec)).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("codex", ["--version"], { timeoutMs: 10_000 });
  });

  it("returns false when --version exits non-zero", async () => {
    const exec: Exec = vi.fn(async () => ({ stdout: "", stderr: "bad", exitCode: 1 }));
    await expect(checkAvailability(codexAdapter, exec)).resolves.toBe(false);
  });

  it("returns false instead of throwing when the binary is missing", async () => {
    const exec: Exec = vi.fn(async () => {
      throw new Error("Failed to start");
    });
    await expect(checkAvailability(codexAdapter, exec)).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/registry.test.ts`
Expected: FAIL — cannot resolve `../src/registry.js`.

- [ ] **Step 3: Implement the registry**

Create `src/registry.ts`:

```ts
import { codexAdapter } from "./adapters/codex.js";
import { cursorAdapter } from "./adapters/cursor.js";
import { opencodeAdapter } from "./adapters/opencode.js";
import type { Exec } from "./exec.js";
import type { AgentAdapter } from "./types.js";

export function allAdapters(): AgentAdapter[] {
  return [codexAdapter, cursorAdapter, opencodeAdapter];
}

export async function checkAvailability(adapter: AgentAdapter, exec: Exec): Promise<boolean> {
  try {
    const result = await exec(adapter.binary, ["--version"], { timeoutMs: 10_000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/registry.test.ts && npm run typecheck`
Expected: 4 tests PASS, typecheck clean.

- [ ] **Step 5: Commit** *(skip if running as subagent)*

```bash
git add src/registry.ts tests/registry.test.ts
git commit -m "feat(registry): add adapter registry and availability probe"
```

---

### Task 7: MCP Server Wiring

**Files:**
- Create: `src/server.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter`; `Exec`, `runCommand` from `src/exec.ts`; `checkAvailability` from `src/registry.ts`.
- Produces: `buildServer(adapters: AgentAdapter[], exec?: Exec): McpServer` exposing tools `ping`, `list_agents`, and one tool per adapter (named after the adapter) with input `{ prompt: string; model?: string; cwd?: string; timeoutMs?: number }`. NOTE: Task 8 adds `run_all` and UPDATES this task's tool-list assertion to six tools.

- [ ] **Step 1: Write the failing tests**

Create `tests/server.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Exec } from "../src/exec.js";
import { allAdapters } from "../src/registry.js";
import { buildServer } from "../src/server.js";

async function connectedClient(exec: Exec) {
  const server = buildServer(allAdapters(), exec);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(res: Awaited<ReturnType<Client["callTool"]>>): string {
  return (res.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");
}

const okExec: Exec = vi.fn(async () => ({ stdout: "agent says hi\n", stderr: "", exitCode: 0 }));

describe("buildServer", () => {
  it("responds to ping", async () => {
    const client = await connectedClient(okExec);
    const res = await client.callTool({ name: "ping", arguments: {} });
    expect(textOf(res)).toBe("pong");
  });

  it("exposes one tool per adapter plus ping and list_agents", async () => {
    const client = await connectedClient(okExec);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["codex", "cursor", "list_agents", "opencode", "ping"]);
  });

  it("runs an agent tool through exec with the adapter invocation", async () => {
    const exec: Exec = vi.fn(async () => ({ stdout: "done\n", stderr: "", exitCode: 0 }));
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "codex", arguments: { prompt: "hello", model: "o3" } });
    expect(exec).toHaveBeenCalledWith(
      "codex",
      ["exec", "--skip-git-repo-check", "--model", "o3", "-"],
      { cwd: undefined, timeoutMs: undefined, input: "hello" },
    );
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe("done");
  });

  it("returns isError with stderr on non-zero exit", async () => {
    const exec: Exec = vi.fn(async () => ({ stdout: "", stderr: "auth required", exitCode: 2 }));
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "cursor", arguments: { prompt: "x" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("exit 2");
    expect(textOf(res)).toContain("auth required");
  });

  it("returns isError when exec rejects with a spawn failure", async () => {
    const exec: Exec = vi.fn(async () => {
      throw new Error('Failed to start "opencode": ENOENT. Is it installed and on PATH?');
    });
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "opencode", arguments: { prompt: "x" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Is it installed");
  });

  it("returns isError with the timeout message when exec times out", async () => {
    const exec: Exec = vi.fn(async () => {
      throw new Error('"cursor-agent" timed out after 50ms');
    });
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "cursor", arguments: { prompt: "x", timeoutMs: 50 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("timed out after 50ms");
  });

  it("returns isError for opencode prompts starting with '-' without calling exec", async () => {
    const exec: Exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "opencode", arguments: { prompt: "--help me" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("prompts that start with '-'");
    expect(exec).not.toHaveBeenCalled();
  });

  it("list_agents reports availability per adapter", async () => {
    const exec: Exec = vi.fn(async (binary: string) => {
      if (binary === "codex") return { stdout: "1.0\n", stderr: "", exitCode: 0 };
      throw new Error("missing");
    });
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "list_agents", arguments: {} });
    const parsed = JSON.parse(textOf(res)) as Array<{ name: string; available: boolean }>;
    expect(parsed).toEqual([
      { name: "codex", available: true },
      { name: "cursor", available: false },
      { name: "opencode", available: false },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — cannot resolve `../src/server.js`.

- [ ] **Step 3: Implement the server**

Create `src/server.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runCommand, type Exec } from "./exec.js";
import { checkAvailability } from "./registry.js";
import type { AgentAdapter } from "./types.js";

const agentInputSchema = {
  prompt: z.string().describe("The task or question to send to the agent"),
  model: z.string().optional().describe("Model override passed to the agent CLI"),
  cwd: z.string().optional().describe("Working directory for the agent process"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Kill the agent after this many ms (default 300000)"),
};

export function buildServer(adapters: AgentAdapter[], exec: Exec = runCommand): McpServer {
  const server = new McpServer({ name: "agent-mcp-hub", version: "0.1.0" });

  server.registerTool(
    "ping",
    { description: "Health check for agent-mcp-hub", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );

  server.registerTool(
    "list_agents",
    { description: "List wrapped CLI agents and whether each is installed", inputSchema: {} },
    async () => {
      const statuses = await Promise.all(
        adapters.map(async (a) => ({ name: a.name, available: await checkAvailability(a, exec) })),
      );
      return { content: [{ type: "text", text: JSON.stringify(statuses, null, 2) }] };
    },
  );

  for (const adapter of adapters) {
    server.registerTool(
      adapter.name,
      {
        description: `Delegate a prompt to the ${adapter.name} CLI agent (non-interactive) and return its output`,
        inputSchema: agentInputSchema,
      },
      async ({ prompt, model, cwd, timeoutMs }) => {
        try {
          const invocation = adapter.buildInvocation(prompt, { model });
          const result = await exec(adapter.binary, invocation.args, {
            cwd,
            timeoutMs,
            input: invocation.stdin,
          });
          if (result.exitCode !== 0) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `${adapter.name} failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`,
                },
              ],
            };
          }
          return { content: [{ type: "text", text: result.stdout.trim() }] };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          };
        }
      },
    );
  }

  return server;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server.test.ts && npm run typecheck`
Expected: 8 tests PASS, typecheck clean.

- [ ] **Step 5: Commit** *(skip if running as subagent)*

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): wire adapters into MCP tools with full failure-path handling"
```

---

### Task 8: `run_all` Fan-Out Tool

**Files:**
- Modify: `src/server.ts` (add one `registerTool` block before `return server;`)
- Modify: `tests/server.test.ts` (UPDATE the tool-list assertion AND append a describe block)

**Interfaces:**
- Consumes: `buildServer` internals from Task 7.
- Produces: MCP tool `run_all` with input `{ prompt: string; cwd?: string; timeoutMs?: number }`; runs every adapter in parallel and returns one text block per agent formatted `## <name> (ok|failed)` + output. Total tool count becomes SIX (spec F2).

- [ ] **Step 1: Write the failing tests**

FIRST, in `tests/server.test.ts`, UPDATE the existing tool-list expectation (Task 7 wrote five names) to include `run_all`:

```ts
    expect(names).toEqual(["codex", "cursor", "list_agents", "opencode", "ping", "run_all"]);
```

THEN append:

```ts
describe("run_all", () => {
  it("fans out to every adapter and labels ok/failed per agent", async () => {
    const exec: Exec = vi.fn(async (binary: string) => {
      if (binary === "cursor-agent") return { stdout: "", stderr: "not logged in", exitCode: 1 };
      return { stdout: `${binary} answer\n`, stderr: "", exitCode: 0 };
    });
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "run_all", arguments: { prompt: "compare" } });
    const text = textOf(res);
    expect(text).toContain("## codex (ok)");
    expect(text).toContain("codex answer");
    expect(text).toContain("## cursor (failed)");
    expect(text).toContain("not logged in");
    expect(text).toContain("## opencode (ok)");
    expect(res.isError).toBeFalsy();
  });

  it("starts all agents before any finishes and forwards options", async () => {
    let started = 0;
    const resolvers: Array<(r: { stdout: string; stderr: string; exitCode: number | null }) => void> = [];
    const exec: Exec = vi.fn((binary: string) => {
      started += 1;
      void binary;
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    });
    const client = await connectedClient(exec);
    const pending = client.callTool({
      name: "run_all",
      arguments: { prompt: "p", cwd: "/tmp", timeoutMs: 1234 },
    });
    await vi.waitFor(() => expect(started).toBe(3));
    for (const resolve of resolvers) resolve({ stdout: "ok\n", stderr: "", exitCode: 0 });
    const res = await pending;
    expect(exec).toHaveBeenCalledWith("codex", ["exec", "--skip-git-repo-check", "-"], {
      cwd: "/tmp",
      timeoutMs: 1234,
      input: "p",
    });
    expect(textOf(res)).toContain("## codex (ok)");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — tool-list assertion fails (no `run_all` yet) and `run_all` tool not found.

- [ ] **Step 3: Implement run_all**

In `src/server.ts`, insert before `return server;`:

```ts
  server.registerTool(
    "run_all",
    {
      description: "Send the same prompt to every wrapped agent in parallel and return all answers",
      inputSchema: {
        prompt: z.string().describe("The task or question to send to all agents"),
        cwd: z.string().optional().describe("Working directory for the agent processes"),
        timeoutMs: z.number().int().positive().optional().describe("Per-agent timeout in ms"),
      },
    },
    async ({ prompt, cwd, timeoutMs }) => {
      const settled = await Promise.allSettled(
        adapters.map(async (adapter) => {
          const invocation = adapter.buildInvocation(prompt, {});
          return exec(adapter.binary, invocation.args, { cwd, timeoutMs, input: invocation.stdin });
        }),
      );
      const content = settled.map((outcome, i) => {
        const name = adapters[i].name;
        if (outcome.status === "rejected") {
          const msg =
            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          return { type: "text" as const, text: `## ${name} (failed)\n${msg}` };
        }
        const { stdout, stderr, exitCode } = outcome.value;
        return exitCode === 0
          ? { type: "text" as const, text: `## ${name} (ok)\n${stdout.trim()}` }
          : {
              type: "text" as const,
              text: `## ${name} (failed)\nexit ${exitCode}: ${stderr || stdout}`,
            };
      });
      return { content };
    },
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server.test.ts && npm run typecheck`
Expected: 10 tests PASS, typecheck clean.

- [ ] **Step 5: Commit** *(skip if running as subagent)*

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): add run_all parallel fan-out tool"
```

---

### Task 9: Bin Entry, Constraint Guard, Build, README

**Files:**
- Create: `src/index.ts`
- Create: `tests/constraints.test.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: `buildServer` from `src/server.ts`, `allAdapters` from `src/registry.ts`.
- Produces: `agent-mcp-hub` executable (stdio MCP server), architecture guard tests (C1/C5), and user-facing docs.

- [ ] **Step 1: Write the constraint guard tests**

Create `tests/constraints.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("architecture constraints", () => {
  it("only exec.ts imports node:child_process (C1)", () => {
    const offenders = walk(SRC).filter(
      (file) => !file.endsWith("exec.ts") && readFileSync(file, "utf8").includes("child_process"),
    );
    expect(offenders).toEqual([]);
  });

  it("nothing writes to stdout outside the MCP transport (C5)", () => {
    const offenders = walk(SRC).filter((file) => {
      const source = readFileSync(file, "utf8");
      return source.includes("console.log(") || source.includes("process.stdout.write(");
    });
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the entry point**

Create `src/index.ts`:

```ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { allAdapters } from "./registry.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const server = buildServer(allAdapters());
  await server.connect(new StdioServerTransport());
  // stdio server stays alive until the client closes the pipe
}

main().catch((err: unknown) => {
  console.error("agent-mcp-hub fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 3: Build and smoke-test the binary**

Run: `npm run build && npm test && npm run typecheck`
Expected: `dist/index.js` produced, all tests PASS (smoke 1 + exec 6 + adapters 12 + registry 4 + server 10 + constraints 2 = 35), typecheck clean.

Run: `printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n' | node dist/index.js`
Expected: one JSON-RPC response line containing `"name":"agent-mcp-hub"` and `"version":"0.1.0"`.

- [ ] **Step 4: Write the README**

Create `README.md`:

```markdown
# agent-mcp-hub

One MCP server that bridges multiple CLI coding agents — **Codex**, **Cursor**, and
**OpenCode** — into any MCP client (Claude Code, Cursor, VS Code, Windsurf, …).
Like [codex-mcp-server](https://github.com/tuannvm/codex-mcp-server), but multi-agent.

## Tools

| Tool | Description |
|---|---|
| `codex` | Delegate a prompt to `codex exec` (prompt piped via stdin) |
| `cursor` | Delegate a prompt to `cursor-agent -p` (prompt piped via stdin) |
| `opencode` | Delegate a prompt to `opencode run` |
| `run_all` | Same prompt to all agents in parallel, results side by side |
| `list_agents` | Which agent CLIs are installed and on PATH |
| `ping` | Health check |

Agent tools accept `prompt` (required), `model`, `cwd`, `timeoutMs` (default 300000).

Known limitation: `opencode` prompts may not start with `-` (its CLI could parse
them as flags); the tool returns an actionable error instead of guessing.

## Prerequisites

Install and authenticate the CLIs you want to use (any subset works):

- Codex: `npm i -g @openai/codex && codex login`
- Cursor: `curl https://cursor.com/install -fsS | bash && cursor-agent login`
- OpenCode: `npm i -g opencode-ai && opencode auth login`

## Install

### Claude Code

```bash
claude mcp add agent-hub -- npx -y agent-mcp-hub
```

### Cursor / generic mcp.json

```json
{
  "mcpServers": {
    "agent-hub": {
      "command": "npx",
      "args": ["-y", "agent-mcp-hub"]
    }
  }
}
```

## Development

```bash
npm install
npm test           # vitest
npm run typecheck  # strict TS over src + tests
npm run dev        # run from source over stdio
npm run build      # emit dist/
```

## Architecture

Pure adapters (`src/adapters/*` — prompt → `{args, stdin?}`, no I/O) → one
subprocess boundary (`src/exec.ts`) → MCP wiring (`src/server.ts`). Adding an
agent = one ~15-line adapter file + one line in `src/registry.ts`.
```

- [ ] **Step 5: Run the full suite one last time**

Run: `npm run build && npm test && npm run typecheck`
Expected: 35 tests PASS, clean build and typecheck.

- [ ] **Step 6: Commit** *(skip if running as subagent)*

```bash
git add src/index.ts tests/constraints.test.ts README.md
git commit -m "feat(cli): add stdio bin entry, constraint guards, and README"
```

---

## Post-Plan Notes (not tasks — future backlog, YAGNI for v0.1)

- Session resume per agent (`codex exec resume`, `cursor-agent --resume`, `opencode run --session`).
- Streaming partial output via MCP progress notifications.
- Config file / env vars to enable-disable agents and set default models.
- `npm publish` (run the pre-push security gate first; verify the `agent-mcp-hub` npm name is free at publish time).
- Claude Code CLI adapter (`claude -p`) as a fourth agent.
- Revisit opencode dash-guard if/when opencode ships `--stdin` (tracked upstream as a feature request).
