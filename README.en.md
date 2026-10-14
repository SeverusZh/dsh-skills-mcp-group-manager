<div align="center">

# 🗂️ DeepSeek Harness Skills & MCPs Group Manager

**A DSH plugin that groups Skills, filters the model skill catalog, toggles MCP servers independently, and manages everything from a left panel**

[![npm version](https://img.shields.io/npm/v/dsh-skills-mcp-group-manager?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-skills-mcp-group-manager)
[![npm downloads](https://img.shields.io/npm/dm/dsh-skills-mcp-group-manager?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-skills-mcp-group-manager)
[![license](https://img.shields.io/npm/l/dsh-skills-mcp-group-manager?style=flat-square)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square&logo=node.js)](package.json)
[![GitHub release](https://img.shields.io/github/v/release/SeverusZh/dsh-skills-mcp-group-manager?style=flat-square&logo=github)](https://github.com/SeverusZh/dsh-skills-mcp-group-manager/releases)
[![GitHub stars](https://img.shields.io/github/stars/SeverusZh/dsh-skills-mcp-group-manager?style=flat-square&logo=github)](https://github.com/SeverusZh/dsh-skills-mcp-group-manager)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.1.7--rc.1-blue?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

</div>

---

## ✨ 功能特性 / Features

- **🎯 Skill Groups** — create / rename / delete groups, groups are collapsible; both the member and picker views are list + multi-select, supporting select-all / deselect-all after search filtering and batch add / remove.
- **🧠 Injection Filtering** — the context injects only the Skills that appear in enabled groups (union, deduplicated, one at a time); ungrouped Skills are not injected by default; switching groups refreshes the catalog live.
- **🔌 MCP Management** — enumerate all MCP servers (profile config + user-added) and toggle them independently; user-added MCPs are mounted dynamically and persisted, restored automatically on restart.
- **💾 Persistence** — `~/.dsh/mcp-skill-manager/state.json` (atomic write); the next session reuses the previous group settings by default.
- **🖥️ UI** — a group-management panel on the left of the dialog (`shell.overlay`) + a session-header toggle (`conversation.session.header.actions`, with a "Skills&MCPs" label). A pure floating panel; it does not modify the product layout.

## 📦 安装 / Install

```bash
# 单命令安装(无需其他步骤)
dsh plugin --profile web add dsh-skills-mcp-group-manager

# 重启 web profile 进程后生效(当前 GUI 由 dsh web 提供,重启后刷新页面)
```

> **Why no extra steps?** The host half-plugin has zero external package dependencies (only Node built-ins and local modules), so the `link:` install performed by `dsh plugin add` resolves directly — no symlinks or build step needed.

## 🗑️ 卸载 / Uninstall

Uninstalling removes the data together with the plugin.

```bash
dsh plugin --profile web remove dsh-skills-mcp-group-manager
```

On uninstall pnpm runs the package's `postuninstall` script (`scripts/cleanup.mjs`), which deletes the entire state directory `~/.dsh/mcp-skill-manager/` (including `state.json`), so groups and MCP configuration are removed together with the plugin. Manual removal also works: `rm -rf ~/.dsh/mcp-skill-manager`.

## 🧱 组成 / Structure

| File | Description |
| --- | --- |
| `lib/index.js` | Host half-plugin: state model, skill catalog filtering (shadow provider `skill-manager-filter`), MCP enumeration / restrict / dynamic mount (via the loader), 12 `manager_*` tools, RPC route `/plugins/dsh-mcp-skill-manager/rpc` |
| `lib/client.js` | Client half-plugin: left-side group-management panel + session-header toggle |
| `lib/state.js` | Pure state logic (zero dependencies) |
| `lib/store.js` | State storage (atomic write + serialized write chain + fault-tolerant read) |
| `scripts/cleanup.mjs` | `postuninstall` cleanup script |
| `cordis.patch.yml` | Bundle patch that inserts the plugin line into the host composition |

## 🛠️ 工具 / Tools

`manager_groups_list/create/delete/rename/set_enabled/add_skill/remove_skill`, `manager_skills_list`, `manager_mcp_list/toggle/add/remove`.

## 🧩 兼容性 / Compatibility

The `@deepseek-ai/dsh*` range in `peerDependencies` determines whether the plugin passes DSH's compatibility gate. This plugin declares **`>=0.1.7-rc.1`** (no upper bound), and has been tested on:

| DSH version | Status |
| --- | --- |
| 0.1.5-rc.1 | ✅ Tested |
| 0.1.5-rc.2 | ✅ Tested |
| 0.1.6-alpha.2 | ✅ Tested |
| 0.1.7-rc.1 | ✅ Tested |
| 0.1.7-rc.2 | ✅ Tested |
| 0.2.0-rc.1 | ✅ Tested |

> Only versions that were **actually run** are listed; untested versions are omitted.

v0.3.7 targets DSH **0.1.5-rc.1+**, verified on **0.1.5-rc.1 / 0.1.5-rc.2 / 0.1.6-alpha.2 / 0.1.7-rc.1 / 0.1.7-rc.2 / 0.2.0-rc.1** (peer `>=0.1.7-rc.1`; the real dsh-tools registry probe passes; on 0.1.7-rc.2 the `manager.state.get` RPC returns as measured; on 0.2.0-rc.1 it passes the new compatibility gate and loads normally); for older DSH releases (0.1.0-rc.x) use the last compatible npm version, **0.3.2**.

## 📄 许可证 / License

[MIT](LICENSE) © [SeverusZh](https://github.com/SeverusZh)
