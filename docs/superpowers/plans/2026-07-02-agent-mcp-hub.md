# agent-mcp-hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `agent-mcp-hub` — a single stdio MCP server that lets any MCP client (Claude Code, Cursor, VS Code, …) delegate prompts to the Codex, Cursor, and OpenCode CLI agents, modeled on [tuannvm/codex-mcp-server](https://github.com/tuannvm/codex-mcp-server) but multi-agent.

**Architecture:** Adapter pattern with strict layering. Each CLI agent is a pure adapter (`name` + `binary` + `buildArgs()` — no I/O), all subprocess side effects are isolated in one `exec.ts` boundary module, and `server.ts` wires adapters into MCP tools. Tools exposed: one per agent (`codex`, `cursor`, `opencode`), plus `run_all` (parallel fan-out), `list_agents` (availability probe), and `ping`.

**Tech Stack:** TypeScript (strict, ESM), Node ≥20, `@modelcontextprotocol/sdk` ^1.12, `zod` ^3.24, `vitest` ^2 for tests, `tsx` for dev, plain `tsc` for build.

## Global Constraints

- Node engine: `>=20`; `"type": "module"`; TS `strict: true`, module `NodeNext`.
- Package/bin name: `agent-mcp-hub` (bin: `agent-mcp-hub`).
- Adapters MUST be pure (no imports of `node:child_process`); the ONLY module that spawns processes is `src/exec.ts`.
- Every tool handler must handle success, non-zero exit, spawn failure, and timeout explicitly.
- Default subprocess timeout: `300_000` ms; availability probes: `10_000` ms.
- Commit format: `<type>(<scope>): <subject>`; NO AI signatures or `Co-Authored-By` trailers ever.
- Never push without the pre-push security gate (gitleaks/trufflehog).

## File Structure

```
agent-mcp-hub/
├── package.json              # metadata, deps, bin, scripts
├── tsconfig.json             # strict ESM NodeNext config
├── src/
│   ├── types.ts              # AgentAdapter, AgentRunOptions contracts
│   ├── exec.ts               # runCommand() — ONLY subprocess boundary
│   ├── adapters/
│   │   ├── codex.ts          # wraps `codex exec …`
│   │   ├── cursor.ts         # wraps `cursor-agent -p …`
│   │   └── opencode.ts       # wraps `opencode run …`
│   ├── registry.ts           # allAdapters(), checkAvailability()
│   ├── server.ts             # buildServer() — MCP tool wiring
│   └── index.ts              # bin entry: stdio transport
├── tests/
│   ├── smoke.test.ts
│   ├── exec.test.ts
│   ├── adapters.test.ts
│   ├── registry.test.ts
│   └── server.test.ts
└── README.md
```

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a working `npm test` / `npm run typecheck` toolchain every later task relies on.

> Note: this is a brand-new project in an empty directory; `git init` here is authorized by approval of this plan.

- [ ] **Step 1: Initialize repo and npm project**

```bash
cd /Users/blackax/Projects/mcps/agent-mcp-hub
git init
```

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
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.24.0"
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

Create `.gitignore`:

```
node_modules/
dist/
*.log
.env
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
Expected: 1 test PASS, typecheck clean (no `src` files yet is fine — add an empty `src/types.ts` placeholder ONLY if tsc errors on empty include; Task 2 fills it).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore tests/smoke.test.ts
git commit -m "chore(scaffold): init agent-mcp-hub TypeScript project"
```

---

### Task 2: Types + Subprocess Boundary (`exec.ts`)

**Files:**
- Create: `src/types.ts`
- Create: `src/exec.ts`
- Test: `tests/exec.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface AgentRunOptions { model?: string }`
  - `interface AgentAdapter { readonly name: string; readonly binary: string; buildArgs(prompt: string, options?: AgentRunOptions): string[] }`
  - `interface ExecResult { stdout: string; stderr: string; exitCode: number | null }`
  - `type Exec = (binary: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>`
  - `runCommand: Exec` — rejects on spawn failure and on timeout; resolves with `exitCode` otherwise.

- [ ] **Step 1: Write the failing tests**

Create `tests/exec.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/exec.js";

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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/exec.test.ts`
Expected: FAIL — cannot resolve `../src/exec.js`.

- [ ] **Step 3: Implement types and exec**

Create `src/types.ts`:

```ts
export interface AgentRunOptions {
  model?: string;
}

export interface AgentAdapter {
  /** Tool name exposed over MCP, e.g. "codex". */
  readonly name: string;
  /** Executable looked up on PATH, e.g. "cursor-agent". */
  readonly binary: string;
  /** Pure function: prompt + options -> argv. No I/O allowed here. */
  buildArgs(prompt: string, options?: AgentRunOptions): string[];
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
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<ExecResult>;

export const DEFAULT_TIMEOUT_MS = 300_000;

export const runCommand: Exec = (binary, args, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`"${binary}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

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
      resolve({ stdout, stderr, exitCode: code });
    });
  });
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/exec.test.ts && npm run typecheck`
Expected: 4 tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/exec.ts tests/exec.test.ts
git commit -m "feat(exec): add adapter contracts and subprocess boundary with timeout handling"
```

---

### Task 3: Codex Adapter

**Files:**
- Create: `src/adapters/codex.ts`
- Test: `tests/adapters.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter`, `AgentRunOptions` from `src/types.ts`.
- Produces: `codexAdapter: AgentAdapter` with `name: "codex"`, `binary: "codex"`.

- [ ] **Step 1: Write the failing tests**

Create `tests/adapters.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapters/codex.js";

describe("codexAdapter", () => {
  it("builds non-interactive exec args", () => {
    expect(codexAdapter.buildArgs("fix the bug")).toEqual([
      "exec",
      "--skip-git-repo-check",
      "fix the bug",
    ]);
  });

  it("inserts --model before the prompt when given", () => {
    expect(codexAdapter.buildArgs("fix the bug", { model: "o3" })).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--model",
      "o3",
      "fix the bug",
    ]);
  });

  it("exposes correct identity", () => {
    expect(codexAdapter.name).toBe("codex");
    expect(codexAdapter.binary).toBe("codex");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/adapters.test.ts`
Expected: FAIL — cannot resolve `../src/adapters/codex.js`.

- [ ] **Step 3: Implement the adapter**

Create `src/adapters/codex.ts`:

```ts
import type { AgentAdapter, AgentRunOptions } from "../types.js";

export const codexAdapter: AgentAdapter = {
  name: "codex",
  binary: "codex",
  buildArgs(prompt: string, options: AgentRunOptions = {}): string[] {
    const args = ["exec", "--skip-git-repo-check"];
    if (options.model) args.push("--model", options.model);
    args.push(prompt);
    return args;
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/adapters.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/codex.ts tests/adapters.test.ts
git commit -m "feat(adapters): add codex adapter wrapping codex exec"
```

---

### Task 4: Cursor Adapter

**Files:**
- Create: `src/adapters/cursor.ts`
- Modify: `tests/adapters.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `AgentAdapter`, `AgentRunOptions` from `src/types.ts`.
- Produces: `cursorAdapter: AgentAdapter` with `name: "cursor"`, `binary: "cursor-agent"`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/adapters.test.ts`:

```ts
import { cursorAdapter } from "../src/adapters/cursor.js";

describe("cursorAdapter", () => {
  it("builds print-mode args with text output", () => {
    expect(cursorAdapter.buildArgs("explain this repo")).toEqual([
      "-p",
      "--output-format",
      "text",
      "explain this repo",
    ]);
  });

  it("inserts --model before the prompt when given", () => {
    expect(cursorAdapter.buildArgs("explain this repo", { model: "gpt-5" })).toEqual([
      "-p",
      "--output-format",
      "text",
      "--model",
      "gpt-5",
      "explain this repo",
    ]);
  });

  it("exposes correct identity", () => {
    expect(cursorAdapter.name).toBe("cursor");
    expect(cursorAdapter.binary).toBe("cursor-agent");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/adapters.test.ts`
Expected: FAIL — cannot resolve `../src/adapters/cursor.js`.

- [ ] **Step 3: Implement the adapter**

Create `src/adapters/cursor.ts`:

```ts
import type { AgentAdapter, AgentRunOptions } from "../types.js";

export const cursorAdapter: AgentAdapter = {
  name: "cursor",
  binary: "cursor-agent",
  buildArgs(prompt: string, options: AgentRunOptions = {}): string[] {
    const args = ["-p", "--output-format", "text"];
    if (options.model) args.push("--model", options.model);
    args.push(prompt);
    return args;
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/adapters.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/cursor.ts tests/adapters.test.ts
git commit -m "feat(adapters): add cursor adapter wrapping cursor-agent print mode"
```

---

### Task 5: OpenCode Adapter

**Files:**
- Create: `src/adapters/opencode.ts`
- Modify: `tests/adapters.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `AgentAdapter`, `AgentRunOptions` from `src/types.ts`.
- Produces: `opencodeAdapter: AgentAdapter` with `name: "opencode"`, `binary: "opencode"`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/adapters.test.ts`:

```ts
import { opencodeAdapter } from "../src/adapters/opencode.js";

describe("opencodeAdapter", () => {
  it("builds run args", () => {
    expect(opencodeAdapter.buildArgs("write tests")).toEqual(["run", "write tests"]);
  });

  it("inserts --model before the prompt when given", () => {
    expect(opencodeAdapter.buildArgs("write tests", { model: "anthropic/claude-sonnet-5" })).toEqual([
      "run",
      "--model",
      "anthropic/claude-sonnet-5",
      "write tests",
    ]);
  });

  it("exposes correct identity", () => {
    expect(opencodeAdapter.name).toBe("opencode");
    expect(opencodeAdapter.binary).toBe("opencode");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/adapters.test.ts`
Expected: FAIL — cannot resolve `../src/adapters/opencode.js`.

- [ ] **Step 3: Implement the adapter**

Create `src/adapters/opencode.ts`:

```ts
import type { AgentAdapter, AgentRunOptions } from "../types.js";

export const opencodeAdapter: AgentAdapter = {
  name: "opencode",
  binary: "opencode",
  buildArgs(prompt: string, options: AgentRunOptions = {}): string[] {
    const args = ["run"];
    if (options.model) args.push("--model", options.model);
    args.push(prompt);
    return args;
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/adapters.test.ts`
Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/opencode.ts tests/adapters.test.ts
git commit -m "feat(adapters): add opencode adapter wrapping opencode run"
```

---

### Task 6: Registry + Availability Probe

**Files:**
- Create: `src/registry.ts`
- Test: `tests/registry.test.ts`

**Interfaces:**
- Consumes: `codexAdapter`, `cursorAdapter`, `opencodeAdapter`; `Exec`, `ExecResult` from `src/exec.ts`.
- Produces:
  - `allAdapters(): AgentAdapter[]` — returns `[codexAdapter, cursorAdapter, opencodeAdapter]`.
  - `checkAvailability(adapter: AgentAdapter, exec: Exec): Promise<boolean>` — `true` iff `<binary> --version` exits 0 within 10s; never throws.

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

- [ ] **Step 5: Commit**

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
- Consumes: `AgentAdapter`; `Exec`, `runCommand`, `DEFAULT_TIMEOUT_MS` from `src/exec.ts`; `checkAvailability` from `src/registry.ts`.
- Produces: `buildServer(adapters: AgentAdapter[], exec?: Exec): McpServer` exposing tools `ping`, `list_agents`, and one tool per adapter (named after the adapter) with input `{ prompt: string; model?: string; cwd?: string; timeoutMs?: number }`.

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

const okExec: Exec = vi.fn(async () => ({ stdout: "agent says hi\n", stderr: "", exitCode: 0 }));

describe("buildServer", () => {
  it("responds to ping", async () => {
    const client = await connectedClient(okExec);
    const res = await client.callTool({ name: "ping", arguments: {} });
    expect((res.content as Array<{ type: string; text: string }>)[0].text).toBe("pong");
  });

  it("exposes one tool per adapter plus ping and list_agents", async () => {
    const client = await connectedClient(okExec);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["codex", "cursor", "list_agents", "opencode", "ping"]);
  });

  it("runs an agent tool through exec with adapter args", async () => {
    const exec: Exec = vi.fn(async () => ({ stdout: "done\n", stderr: "", exitCode: 0 }));
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "codex", arguments: { prompt: "hello", model: "o3" } });
    expect(exec).toHaveBeenCalledWith(
      "codex",
      ["exec", "--skip-git-repo-check", "--model", "o3", "hello"],
      { cwd: undefined, timeoutMs: undefined },
    );
    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ type: string; text: string }>)[0].text).toBe("done");
  });

  it("returns isError with stderr on non-zero exit", async () => {
    const exec: Exec = vi.fn(async () => ({ stdout: "", stderr: "auth required", exitCode: 2 }));
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "cursor", arguments: { prompt: "x" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ type: string; text: string }>)[0].text).toContain("exit 2");
    expect((res.content as Array<{ type: string; text: string }>)[0].text).toContain("auth required");
  });

  it("returns isError when exec rejects (missing binary / timeout)", async () => {
    const exec: Exec = vi.fn(async () => {
      throw new Error('Failed to start "opencode": ENOENT. Is it installed and on PATH?');
    });
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "opencode", arguments: { prompt: "x" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ type: string; text: string }>)[0].text).toContain("Is it installed");
  });

  it("list_agents reports availability per adapter", async () => {
    const exec: Exec = vi.fn(async (binary) => {
      if (binary === "codex") return { stdout: "1.0\n", stderr: "", exitCode: 0 };
      throw new Error("missing");
    });
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "list_agents", arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as Array<{ name: string; available: boolean }>;
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
  timeoutMs: z.number().int().positive().optional().describe("Kill the agent after this many ms (default 300000)"),
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
          const result = await exec(adapter.binary, adapter.buildArgs(prompt, { model }), {
            cwd,
            timeoutMs,
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
Expected: 6 tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): wire adapters into MCP tools with error handling"
```

---

### Task 8: `run_all` Fan-Out Tool

**Files:**
- Modify: `src/server.ts` (add one `registerTool` block before the `return server;` line)
- Modify: `tests/server.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `buildServer` internals from Task 7.
- Produces: MCP tool `run_all` with input `{ prompt: string; cwd?: string; timeoutMs?: number }`; runs every adapter in parallel and returns one text block per agent formatted as `## <name> (ok|failed)\n<output>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/server.test.ts`:

```ts
describe("run_all", () => {
  it("fans out to every adapter in parallel and labels each result", async () => {
    const exec: Exec = vi.fn(async (binary) => {
      if (binary === "cursor-agent") return { stdout: "", stderr: "not logged in", exitCode: 1 };
      return { stdout: `${binary} answer\n`, stderr: "", exitCode: 0 };
    });
    const client = await connectedClient(exec);
    const res = await client.callTool({ name: "run_all", arguments: { prompt: "compare" } });
    const text = (res.content as Array<{ type: string; text: string }>)
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain("## codex (ok)");
    expect(text).toContain("codex answer");
    expect(text).toContain("## cursor (failed)");
    expect(text).toContain("not logged in");
    expect(text).toContain("## opencode (ok)");
    expect(res.isError).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — tool `run_all` not found.

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
        adapters.map((a) => exec(a.binary, a.buildArgs(prompt, {}), { cwd, timeoutMs })),
      );
      const content = settled.map((outcome, i) => {
        const name = adapters[i].name;
        if (outcome.status === "rejected") {
          const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          return { type: "text" as const, text: `## ${name} (failed)\n${msg}` };
        }
        const { stdout, stderr, exitCode } = outcome.value;
        return exitCode === 0
          ? { type: "text" as const, text: `## ${name} (ok)\n${stdout.trim()}` }
          : { type: "text" as const, text: `## ${name} (failed)\nexit ${exitCode}: ${stderr || stdout}` };
      });
      return { content };
    },
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat(server): add run_all parallel fan-out tool"
```

---

### Task 9: Bin Entry, Build, and README

**Files:**
- Create: `src/index.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: `buildServer` from `src/server.ts`, `allAdapters` from `src/registry.ts`.
- Produces: `agent-mcp-hub` executable (stdio MCP server) and user-facing docs.

- [ ] **Step 1: Write the entry point**

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

- [ ] **Step 2: Build and smoke-test the binary**

Run: `npm run build && npm test && npm run typecheck`
Expected: `dist/index.js` produced, all tests PASS.

Run: `printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n' | node dist/index.js`
Expected: one JSON-RPC response line containing `"name":"agent-mcp-hub"`.

- [ ] **Step 3: Write the README**

Create `README.md`:

```markdown
# agent-mcp-hub

One MCP server that bridges multiple CLI coding agents — **Codex**, **Cursor**, and
**OpenCode** — into any MCP client (Claude Code, Cursor, VS Code, Windsurf, …).
Like [codex-mcp-server](https://github.com/tuannvm/codex-mcp-server), but multi-agent.

## Tools

| Tool | Description |
|---|---|
| `codex` | Delegate a prompt to `codex exec` |
| `cursor` | Delegate a prompt to `cursor-agent -p` |
| `opencode` | Delegate a prompt to `opencode run` |
| `run_all` | Same prompt to all agents in parallel, results side by side |
| `list_agents` | Which agent CLIs are installed and on PATH |
| `ping` | Health check |

All agent tools accept `prompt` (required), `model`, `cwd`, `timeoutMs`.

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
npm test        # vitest
npm run dev     # run from source over stdio
npm run build   # emit dist/
```

## Architecture

Pure adapters (`src/adapters/*` — prompt → argv, no I/O) → one subprocess
boundary (`src/exec.ts`) → MCP wiring (`src/server.ts`). Adding an agent =
one ~15-line adapter file + one line in `src/registry.ts`.
```

- [ ] **Step 4: Verify full suite one last time**

Run: `npm run build && npm test && npm run typecheck`
Expected: all PASS, clean build.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts README.md
git commit -m "feat(cli): add stdio bin entry and README"
```

---

## Post-Plan Notes (not tasks — future backlog, YAGNI for v0.1)

- Session resume per agent (`codex exec resume`, `cursor-agent --resume`, `opencode run --session`).
- Streaming partial output via MCP progress notifications.
- Config file / env vars to enable-disable agents and set default models.
- `npm publish` (run the pre-push security gate first; verify the `agent-mcp-hub` npm name is free at publish time).
- Claude Code CLI adapter (`claude -p`) as a fourth agent.
