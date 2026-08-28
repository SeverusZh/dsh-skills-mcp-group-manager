# DeepSeek Harness Skills & MCPs 分组管理器

**DeepSeek Harness Skills & MCPs Group Manager** — DSH 插件:读取 DSH 当前装载的全部 MCP 与 Skills,支持创建分组、将 Skills 加入分组(不同分组可含相同 Skill,上下文注入按启用分组并集去重)、分组设置持久化到插件自有目录 `~/.dsh/mcp-skill-manager/state.json`(不写入 settings.yaml)并在下次会话默认沿用、MCP 单独开关管理(profile 服务器 restrict / 用户服务器动态挂载)、会话中可添加 Skill/MCP,并提供左侧分组管理 UI。

## 安装

```bash
# 从 npm 安装
dsh plugin --profile web add dsh-skills-mcp-group-manager

# 建立依赖符号链接(见下;若 postinstall 被 profile 的 allowBuilds 拦截则手动执行)
node <插件安装目录>/scripts/setup-links.mjs

# 重启 web profile 进程后生效(当前 GUI 由 dsh web 提供,重启后刷新页面)
```

### 依赖解析机制(重要)

`dsh plugin add` 以 `link:` 方式安装,Node 从插件源目录解析 import,而运行时依赖(`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-mcp-client` 等)只存在于**全局 dsh 安装**的 node_modules 中,不在解析链上——否则宿主激活会报 `Cannot find package '@deepseek-ai/dsh-tools'`。

`scripts/setup-links.mjs` 在插件目录内创建 `node_modules/@deepseek-ai/` 符号链接指向全局安装(被链接的包从自身真实位置解析传递依赖,无需其他配置)。幂等,可重复执行;`postinstall` 也会尝试自动执行(若 profile 的 `allowBuilds` 白名单拦截,手动跑一次即可)。

## 卸载(数据随插件一并删除)

```bash
dsh plugin --profile web remove dsh-skills-mcp-group-manager
```

卸载时 pnpm 会执行包的 `postuninstall` 脚本(`scripts/cleanup.mjs`),删除整个状态目录 `~/.dsh/mcp-skill-manager/`(含 `state.json`),分组与 MCP 配置随插件一同移除。手动删除亦可:`rm -rf ~/.dsh/mcp-skill-manager`。

## 功能

- **Skill 分组**:创建/重命名/删除分组,分组可折叠;成员与挑选器均为列表 + 多选,支持搜索过滤后的全选/全不选与批量增删。
- **注入过滤**:上下文只注入启用分组中出现的 Skill(并集去重,一次一个);未分组 Skill 默认不注入;切换分组实时刷新目录。
- **MCP 管理**:枚举全部 MCP 服务器(profile 配置 + 用户新增),独立开关;用户新增的 MCP 动态挂载并持久化,重启自动恢复。
- **持久化**:`~/.dsh/mcp-skill-manager/state.json`(原子写),下次会话默认沿用上次分组设置。
- **UI**:对话框左侧分组管理面板(`shell.overlay`)+ 会话头部开关(`conversation.session.header.actions`,带 "Skills&MCPs" 标签)+ 侧边栏底部固定开关(`sidebar.footer.action`)。纯浮动面板,不修改产品布局。

## 组成

- `lib/index.js` — Host 半插件:状态模型、skill 目录过滤(shadow provider `skill-manager-filter`,未启用 skill 改写 invocation 双 false)、MCP 枚举/restrict/动态挂载、12 个 `manager_*` 工具、RPC 路由 `/plugins/dsh-mcp-skill-manager/rpc`(POST `{method,args}` → `{ok,value}|{ok:false,error}`)。
- `lib/client.js` — Client 半插件:左侧分组管理面板 + 会话头部/侧边栏开关。
- `lib/state.js` — 纯状态逻辑(零依赖)。
- `lib/store.js` — 状态存储(原子写 + 序列化写链 + 容错读取)。
- `scripts/setup-links.mjs` — 依赖符号链接脚本。
- `scripts/cleanup.mjs` — `postuninstall` 清理脚本。
- `cordis.patch.yml` — bundle 补丁,把插件行插入宿主组合。

## 工具

`manager_groups_list/create/delete/rename/set_enabled/add_skill/remove_skill`、`manager_skills_list`、`manager_mcp_list/toggle/add/remove`。

## License

MIT
