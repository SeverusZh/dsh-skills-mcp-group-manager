# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
