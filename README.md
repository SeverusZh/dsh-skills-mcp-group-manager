# DeepSeek Harness Skills & MCPs 分组管理器

**DeepSeek Harness Skills & MCPs Group Manager** — DSH 插件:分组管理 Skills、过滤模型技能目录、独立开关 MCP 服务器,左侧面板一键管理。

> A DSH plugin that groups Skills, filters the model skill catalog, toggles MCP servers independently, and manages everything from a left panel.

[![npm version](https://img.shields.io/npm/v/dsh-skills-mcp-group-manager.svg?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-skills-mcp-group-manager)
[![npm downloads](https://img.shields.io/npm/dm/dsh-skills-mcp-group-manager.svg?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-skills-mcp-group-manager)
[![license](https://img.shields.io/npm/l/dsh-skills-mcp-group-manager.svg?style=flat-square)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/SeverusZh/dsh-skills-mcp-group-manager?style=flat-square&logo=github)](https://github.com/SeverusZh/dsh-skills-mcp-group-manager/releases)
[![GitHub stars](https://img.shields.io/github/stars/SeverusZh/dsh-skills-mcp-group-manager?style=flat-square&logo=github)](https://github.com/SeverusZh/dsh-skills-mcp-group-manager)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square&logo=node.js)](package.json)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.2--alpha.4-blue?style=flat-square)](https://github.com/deepseek-ai/dsh)

---

> **兼容性 / Compatibility**：v0.3.3 支持 DSH **0.1.2-alpha.4+**（peer `^0.1.2-alpha.4`，真实 dsh-tools registry 探针通过）；旧版 DSH（0.1.0-rc.x）请使用最后兼容的 npm 版本 **0.3.2**。
> v0.3.3 targets DSH **0.1.2-alpha.4+**; for older DSH releases use the last compatible npm version **0.3.2**.

## ✨ 功能特性 / Features

- **🎯 Skill 分组 / Skill Groups** — 创建/重命名/删除分组,分组可折叠;成员与挑选器均为列表 + 多选,支持搜索过滤后的全选/全不选与批量增删。
- **🧠 注入过滤 / Injection Filtering** — 上下文只注入启用分组中出现的 Skill(并集去重,一次一个);未分组 Skill 默认不注入;切换分组实时刷新目录。
- **🔌 MCP 管理 / MCP Management** — 枚举全部 MCP 服务器(profile 配置 + 用户新增),独立开关;用户新增的 MCP 动态挂载并持久化,重启自动恢复。
- **💾 持久化 / Persistence** — `~/.dsh/mcp-skill-manager/state.json`(原子写),下次会话默认沿用上次分组设置。
- **🖥️ UI** — 对话框左侧分组管理面板(`shell.overlay`)+ 会话头部开关(`conversation.session.header.actions`,带 "Skills&MCPs" 标签)。纯浮动面板,不修改产品布局。

---

## 📦 安装 / Install

```bash
# 单命令安装(无需其他步骤)
dsh plugin --profile web add dsh-skills-mcp-group-manager

# 重启 web profile 进程后生效(当前 GUI 由 dsh web 提供,重启后刷新页面)
```

> **为什么无需额外步骤?** 宿主半插件零外部包依赖(仅 Node 内置模块与本地模块),`dsh plugin add` 的 `link:` 安装即可直接解析,无需符号链接或构建步骤。

## 🗑️ 卸载 / Uninstall(数据随插件一并删除)

```bash
dsh plugin --profile web remove dsh-skills-mcp-group-manager
```

卸载时 pnpm 会执行包的 `postuninstall` 脚本(`scripts/cleanup.mjs`),删除整个状态目录 `~/.dsh/mcp-skill-manager/`(含 `state.json`),分组与 MCP 配置随插件一同移除。手动删除亦可:`rm -rf ~/.dsh/mcp-skill-manager`。

---

## 🧩 组成 / Structure

| 文件 | 说明 |
| --- | --- |
| `lib/index.js` | Host 半插件:状态模型、skill 目录过滤(shadow provider `skill-manager-filter`)、MCP 枚举/restrict/动态挂载(经 loader)、12 个 `manager_*` 工具、RPC 路由 `/plugins/dsh-mcp-skill-manager/rpc` |
| `lib/client.js` | Client 半插件:左侧分组管理面板 + 会话头部开关 |
| `lib/state.js` | 纯状态逻辑(零依赖) |
| `lib/store.js` | 状态存储(原子写 + 序列化写链 + 容错读取) |
| `scripts/cleanup.mjs` | `postuninstall` 清理脚本 |
| `cordis.patch.yml` | bundle 补丁,把插件行插入宿主组合 |

## 🛠️ 工具 / Tools

`manager_groups_list/create/delete/rename/set_enabled/add_skill/remove_skill`、`manager_skills_list`、`manager_mcp_list/toggle/add/remove`。

---

## 📄 License

[MIT](LICENSE) © [SeverusZh](https://github.com/SeverusZh)
