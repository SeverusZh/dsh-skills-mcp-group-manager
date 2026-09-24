# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.5-beta.0] - 2026-09-24

### Beta（DSH 0.1.7-rc.1 适配，测试版）

- 本分支（`dev-0.1.7.rc1`，尚未合并 `main`）相对 `main` 的适配改动：
  `peerDependencies` 的 `@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-tools` 由
  `^0.1.5-rc.1` 升至 `^0.1.7-rc.1`；`dsh.compatibility.dshReleases` 新增
  `"0.1.7-rc.1": "compatible"`；README 徽章与兼容性说明同步。源码逻辑无变更。
- 发布为 npm 测试版（`--tag beta`）；`latest` 保持不变。正式版 `0.3.5` 待 `main` 合并后发布。

## [0.3.5] - 2026-09-24

### Changed

- **DSH 0.1.7-rc.1 compatibility.** `peerDependencies` for
  `@deepseek-ai/dsh-mcp-client` and `@deepseek-ai/dsh-tools` move from
  `^0.1.5-rc.1` to `^0.1.7-rc.1`; `dsh.compatibility.dshReleases` gains
  `"0.1.7-rc.1": "compatible"`; README badges and the compatibility note are
  updated. Verified by a real load on 0.1.7-rc.1 (host entry active, zero
  errors).

### Verified (no source change required)

- The MCP client schema this plugin mounts (`mcpClientConfig`: `transport` /
  `serverName` / `command` / `args` / `env` / `toolCallTimeoutMs` /
  `failOnStartupError`; streamable-http: `url` / `headers`) is unchanged in
  `@deepseek-ai/dsh-mcp-client@0.1.7-rc.1`, so the dynamic MCP mount and the
  loader `create(id, …)` / `remove(id)` calls remain valid.
- The host contracts it consumes — `agent/created` (`{ agent }`),
  `agent/disposed`, `tools/change`, `internal/service`, `ctx.loader.entries()`,
  `ctx.tools.restrict({ deny })`, and the `webServer` prefix route — are all
  present and unchanged in 0.1.7-rc.1.

## [0.3.4] - 2026-09-22

### Added

- **`dsh.compatibility` declaration (DSH STORE listing contract).** A new
  `compatibility` block under the `dsh` field (the existing `bundle` and
  `client` entries are unchanged) declares per-release compatibility through
  `dshReleases`: `0.1.5-rc.1`, `0.1.5-rc.2` and `0.1.6-alpha.2` are all marked
  `compatible` — the plugin was actually loaded and run on all three, with no
  errors. Releases that were not tested are deliberately left unlisted (the
  scanner treats them as `unknown`).
- `node` is declared as `>=18`, matching the existing `engines.node` field.

## [0.3.3] - 2026-09-04

### Fixed

- **alpha.4 compatibility: peer ranges no longer match nothing.** The
  `@deepseek-ai/dsh-mcp-client` / `@deepseek-ai/dsh-tools` peer ranges were
  `^0.1.0`, which matches NO published version (every published version is a
  prerelease, and the semver prerelease rule excludes them), so `npm install`
  failed with `ETARGET`. Both ranges are now `^0.1.2-alpha.4`, and the tree
  installs cleanly against the alpha.4 scoped packages without
  `--legacy-peer-deps`.
- **alpha.4 layer split: the skill-catalog allowlist now filters agent-plane
  skills.** In alpha.4 the user-dsh/project skill providers live in the agent
  layer while the shadow catalog provider used to read only the global layer,
  so skills served by the agent plane (e.g. `~/.dsh/skills`) could no longer
  be suppressed by disabling a group. The shadow provider now unions the
  global view with the agent's raw view (re-entrancy-guarded) and emits
  double-false invocation candidates for every disallowed name — while
  leaving enabled agent-plane skills to their filesystem provider so body
  loading keeps working.

### Added

- `tests/probe-real-tools-registry.test.mjs`: real-Cordis probe driving the
  manager through the REAL `@deepseek-ai/dsh-tools` registry — registration
  with output-schema validation, a mutation-tool execution through the real
  dispatch pipeline, per-agent `tools.restrict({ deny })` for a disabled MCP
  server, agent-plane skill-body loading, and the group allowlist flip on a
  real `@deepseek-ai/dsh-skill` registry.
