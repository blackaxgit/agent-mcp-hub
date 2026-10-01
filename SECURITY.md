# Security Policy

`agent-mcp-hub` is a stdio MCP server that spawns local coding-agent CLIs
(`codex`, `cursor-agent`, `opencode`, `claude`, `agy`) on behalf of an MCP
client. It is maintained on a best-effort basis.

## Supported versions

The project is pre-1.0. Only the latest release receives security fixes.

| Version        | Supported |
| -------------- | --------- |
| Latest release | Yes       |
| Anything older | No        |

To upgrade: `npm i -g agent-mcp-hub@latest`, then restart your MCP client.

## Reporting a vulnerability

Please report privately through GitHub's advisory form:
<https://github.com/blackaxgit/agent-mcp-hub/security/advisories/new>

Do **not** open a public issue for a suspected vulnerability.

Helpful details:

- `agent-mcp-hub` version, MCP client, and OS
- the agent CLI involved and its version
- reproduction steps
- the impact you believe it has

This is a best-effort project with no guaranteed response or fix timeline. A
confirmed fix ships as a normal release, published together with an advisory.

## Threat model

The hub runs as a child process of your MCP client, on your machine, as you.
Each agent it spawns runs with your user privileges.

- **Attacker-influenced inputs.** The MCP client is often an LLM acting on
  untrusted content (a web page, an issue, a repository). `prompt`, `model`,
  `cwd`, and the `models` map are therefore treated as attacker-influenced.
- **`review_change` feeds attacker-controlled data to a second model.** The git
  diff and new-file contents it captures come from a worktree that may be
  hostile.
- **stdout is the JSON-RPC channel.** Diagnostics go to stderr.
- **No sandbox.** The agent CLIs run with your privileges; the hub does not
  contain them (see Known limitations).

## In scope

A bypass of any of these protections is worth reporting:

- **Argument injection through `model`**: every `model` value, including each
  value in the `models` map, must pass the `MODEL_RE` allowlist, which rejects
  a leading `-`.
- **Prompt-as-flag injection**: `codex`, `cursor`, and `claude` receive the
  prompt on stdin, `agy` receives it glued as `--print=<prompt>`, and the
  `opencode` adapter rejects prompts that start with `-`.
- **Code execution via git config or attributes during `review_change`**: every
  git call goes through one hardened runner (`core.fsmonitor` and
  `core.hooksPath` disabled; system and global config ignored); diff calls
  additionally pass `--no-ext-diff --no-textconv`.
- **Credential leakage between agents**: one agent's API-key env var reaching a
  sibling agent's child process. The strip set is derived from each adapter's
  `apiKeyEnv`.
- **Breaking out of the nonce-fenced untrusted block** in the `review_change`
  reviewer prompt.
- **Spawning without the `MCP_CONFIRM` gate** when it is enabled, for any tool
  that runs an agent (`codex`, `cursor`, `opencode`, `claude`, `agy`,
  `run_all`, `review_change`).
- **Anything written to stdout that corrupts the protocol.**

## Known limitations

These are by design and are not vulnerabilities:

- **The hub is not a sandbox.** A write run edits files in `cwd` with your
  privileges.
- **Read-only enforcement for the `review_change` reviewer differs per agent:**

  | Agent      | Read-only reviewer                                               |
  | ---------- | ---------------------------------------------------------------- |
  | `codex`    | Enforced by the OS sandbox (`-s read-only`)                      |
  | `claude`   | Enforced by harness deny rules (`--disallowedTools ...`)         |
  | `cursor`   | Advisory only (`--mode plan`); the model may ignore it           |
  | `agy`      | Partial: headless agy auto-denies writes without the skip flag   |
  | `opencode` | None: the reviewer is unrestricted                               |

- **The reviewer's temp cwd narrows blast radius but is not a sandbox.** It runs
  in an empty temp directory instead of the repo, but still has your filesystem
  privileges. The nonce fence around the untrusted block is defense-in-depth,
  not prevention.
- **Git hardening is not total.** With an attacker-controlled `.git` directory,
  `.gitattributes` can select an attacker-configured `filter.<driver>.clean`;
  the hub has no blanket flag disabling all such drivers. Review untrusted
  repositories from a fresh clone with trusted git configuration, rather than
  reusing the supplied `.git` directory.
- **Credential stripping is environment isolation, not a secret boundary.**
  `HOME` is preserved, so credentials stored on disk remain reachable by any
  agent.
- **`MCP_CONFIRM=on` degrades open.** A client that does not advertise form
  elicitation runs ungated (with one stderr warning). Use `MCP_CONFIRM=strict`
  to fail closed. Neither mode gates `list_agents`, which probes each enabled
  agent's CLI.
- **`agy` leaves state behind.** Each run writes a new project file under
  `~/.gemini/config/projects/`.
- **Upstream issues.** Vulnerabilities in the agent CLIs themselves or in your
  MCP client belong with those projects.
