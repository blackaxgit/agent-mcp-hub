# Changelog

## [1.0.0](https://github.com/blackaxgit/agent-mcp-hub/compare/agent-mcp-hub-v0.5.0...agent-mcp-hub-v1.0.0) (2026-07-11)


### ⚠ BREAKING CHANGES

* ship stdio-only v0.5.0 — stall fast-fail, npm publish, review/spawn hardening ([#28](https://github.com/blackaxgit/agent-mcp-hub/issues/28))

### Features

* actionable agent-failure handling (auth/timeout/not-installed/…) ([#15](https://github.com/blackaxgit/agent-mcp-hub/issues/15)) ([a7364f7](https://github.com/blackaxgit/agent-mcp-hub/commit/a7364f7553d481ee0b9e21f8410da8083b16b6f4))
* **adapters:** add codex adapter with stdin prompt delivery ([9c853b6](https://github.com/blackaxgit/agent-mcp-hub/commit/9c853b6cf773dd6f491b9ac79cb87d9da18e69e2))
* **adapters:** add cursor adapter with stdin prompt delivery ([0d1aab5](https://github.com/blackaxgit/agent-mcp-hub/commit/0d1aab5ef3a2aa04842aa8e9f2953c10beb8eeed))
* **adapters:** add opencode adapter with dash-prompt guard ([754ac4c](https://github.com/blackaxgit/agent-mcp-hub/commit/754ac4c5f5bb51af5125b677398adb83b1bf116e))
* **agents:** add claude adapter and MCP_AGENTS enable-disable allowlist ([261dfdd](https://github.com/blackaxgit/agent-mcp-hub/commit/261dfdda07d63688e7de656f670df2971f278f28))
* **cli:** add stdio bin entry, constraint guards, and README ([5df3086](https://github.com/blackaxgit/agent-mcp-hub/commit/5df30860fe074126d54ed23fefc0538c1b23bbe8))
* confirm before running an agent (client-agnostic MCP elicitation) ([#16](https://github.com/blackaxgit/agent-mcp-hub/issues/16)) ([af0af76](https://github.com/blackaxgit/agent-mcp-hub/commit/af0af76606fb79355a267c4ae5f88504f22a6d99))
* **exec:** add adapter contracts and stdin-capable subprocess boundary ([d2ebaa8](https://github.com/blackaxgit/agent-mcp-hub/commit/d2ebaa8a537ec962dec846cf0483ac61161d2ddc))
* **http:** add stateless streamable HTTP transport entry ([7c97703](https://github.com/blackaxgit/agent-mcp-hub/commit/7c977037a83981b8c385b1890062469aee18a24a))
* idle timeout + progress — long agent runs survive, hung ones fail fast ([#20](https://github.com/blackaxgit/agent-mcp-hub/issues/20)) ([54c3468](https://github.com/blackaxgit/agent-mcp-hub/commit/54c3468a46462f045415aaf75ab720b50690c081))
* **registry:** add adapter registry and availability probe ([5ff015a](https://github.com/blackaxgit/agent-mcp-hub/commit/5ff015a628463880205e4447cd26880d95ce00bf))
* **release:** npm + MCP Registry publishing via release-please + OIDC ([e59e172](https://github.com/blackaxgit/agent-mcp-hub/commit/e59e172d29a802aadae1428195ddc25b65265a90))
* review_change — cross-agent git-diff review tool ([#19](https://github.com/blackaxgit/agent-mcp-hub/issues/19)) ([1e50982](https://github.com/blackaxgit/agent-mcp-hub/commit/1e50982a8023f9d7eed8ccf4ec7988d053d0d83f))
* **server:** wire adapters into MCP tools with run_all fan-out ([46ad38c](https://github.com/blackaxgit/agent-mcp-hub/commit/46ad38c031e569439057ad6a15b151651468b4ba))
* ship stdio-only v0.5.0 — stall fast-fail, npm publish, review/spawn hardening ([#28](https://github.com/blackaxgit/agent-mcp-hub/issues/28)) ([a44e2ba](https://github.com/blackaxgit/agent-mcp-hub/commit/a44e2bade75f40fe2734b05b3fdb0a64282319b4))


### Bug Fixes

* **agents:** repair codex, opencode, and cursor availability ([#22](https://github.com/blackaxgit/agent-mcp-hub/issues/22)) ([1e99366](https://github.com/blackaxgit/agent-mcp-hub/commit/1e993660a1e13c3f4426cfd8cb563cd90eb05632))
* **build:** declare node types explicitly for typescript 6 compatibility ([f3f2c46](https://github.com/blackaxgit/agent-mcp-hub/commit/f3f2c460842c67ef2668196aa17646b6c4d70bd4))
* **compose:** drop cursor-agent mount that shadows the image binary ([#14](https://github.com/blackaxgit/agent-mcp-hub/issues/14)) ([8c9c738](https://github.com/blackaxgit/agent-mcp-hub/commit/8c9c73894da19e7e3dfb2ad0440def78c7dc0a57))
* **compose:** reuse host CLI logins so API keys aren't required ([#13](https://github.com/blackaxgit/agent-mcp-hub/issues/13)) ([cc75707](https://github.com/blackaxgit/agent-mcp-hub/commit/cc7570750ec6485513be024f2eb8465e357a4033))
* **docker:** bake tini init, drop default 0.0.0.0 bind, require compose token, CI lint+smoke-token ([337954e](https://github.com/blackaxgit/agent-mcp-hub/commit/337954eca52183d26e28a5f4b5355179cb3be6a7))
* **docker:** pin agent CLI versions and make HEALTHCHECK honor PORT ([72378c4](https://github.com/blackaxgit/agent-mcp-hub/commit/72378c40388d1a1b86e9dee5e14bebd7bc95b4fe))
* **exec:** bounded agent queue with ServerBusyError fast-fail backpressure ([0556cf6](https://github.com/blackaxgit/agent-mcp-hub/commit/0556cf61f483d123bd9861d6db582c1f17d9ba98))
* **exec:** process-group kill on timeout, output cap, concurrency semaphore ([9e531ed](https://github.com/blackaxgit/agent-mcp-hub/commit/9e531ed791f1680903dc790524b2e471fc33b9ff))
* **http:** fail closed — refuse non-loopback bind without MCP_TOKEN ([1edfa43](https://github.com/blackaxgit/agent-mcp-hub/commit/1edfa43b15f69891bf7ba1a3fd077e99d6718b5c))
* **http:** reject on listen error, constant-time token compare, origin tests ([77b9746](https://github.com/blackaxgit/agent-mcp-hub/commit/77b9746085372197d547c5aa83db9fa044299cc9))
* **security:** loopback bind, origin allowlist, bearer auth for HTTP transport ([fd007c7](https://github.com/blackaxgit/agent-mcp-hub/commit/fd007c783c228a35a108b1942d9c47372985381c))
* **server:** dedup run_all via shared runAdapter, add per-run observability and dynamic version ([a470a9d](https://github.com/blackaxgit/agent-mcp-hub/commit/a470a9dd70f84eb95906bf5d613cdbec0cc3f324))

## 0.5.0

- stdio-only server (HTTP transport and Docker packaging removed).
- Groundwork for npm-registry distribution, pinned-version installs, and automated releases.
