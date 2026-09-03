# dsh-skills-mcp-group-manager 消融实验

基线：`19bac09` (0.3.3-beta.0, dev-slim)，原测试套件 52/52 通过（`npm test` = `node --test`）。

## 模块清单（lib/index.js 宿主侧单文件 + lib/client.js 浏览器侧）

| ID | 模块 | 消融方式 | 消融点 |
|---|---|---|---|
| M1 | state 持久化（store.js 读写） | code | 移除 `createStateStore`/`loadSync` → 内存态（同表面，不落盘） |
| M2 | skill-catalog 过滤（shadow provider） | code | 移除 `applyAgentFilter` 注册（boot 循环 + agent/created） |
| M3 | MCP 枚举与开关（tools.restrict） | code | 移除 `applyMcpRestrictions`/`applyMcpRestrictionsToAll`（boot、agent/created、tools/change、applyStateEffects、cleanup） |
| M4 | manager_* 工具（12 个） | code | 移除 `tool()` 注册循环（含 parameterSchema/valueSchema 辅助） |
| M5 | RPC 表面（webServer 路由） | code | 移除 `registerWebSurface` + `internal/service` 监听 + rpcMethods |
| M6 | 客户端 UI（lib/client.js） | 静态 | client.js 独立于 index.js（模块解耦，无相互引用） |

## 消融方式

- **code 变体**：`variants/<ID>.patch` 为 lib/index.js 的 git diff（生成后 `git checkout` 恢复，生产代码零残留）。`run.mjs` 逐个 `git apply` → 探针 → `git checkout` 恢复。
- **M6 静态验证**：探针直接检查 client.js 与 index.js 无相互引用、client.js 无 import 语句、导出 `{ apply, inject }` 插件面、RPC 路径两端一致、`node --check` 语法可加载。

## 验证

- 探针 `ablation/probe.mjs`：扩展自 `tests/host-apply.test.mjs` 的 fakeCtx（捕获 tools.register / skills.registerProvider / tools.restrict / loader.create / webServer.register / on / effect，effect 同步执行以贴近真实 Cordis），挂载插件后断言：
  - **loadOk**：apply() 不抛错；
  - **ablationEffective（负向）**：被消融模块的注册/副作用消失（如 M2 后无 registerProvider、M4 后无 tools.register、M5 后无 webServer.register）；
  - **corePass（正向）**：保留模块的注册与功能仍可用（工具/过滤/restrict/RPC/持久化/挂载交叉验证）。
  - 探针灵敏度已做阳性对照：基线（无 patch）下每个负向断言都如预期失败。
- 每个变体跑 `node ablation/probe.mjs <variant>`，`run.mjs` 汇总到 `results.json`。
- 原测试套件反应：对 M4（tools）与 M1（persistence）变体跑 `npm test`，记录失败/通过分布（见 report.md）。

## 结果摘要

`node ablation/run.mjs` → **6/6 变体通过**（全部 loadOk=true）：

| 变体 | 负向（ablationEffective） | 正向（corePass） |
|---|---|---|
| M1 | 变更不落盘（无 state.json） | 内存态读写、12 工具、RPC 路由 |
| M2 | boot + agent/created 均无 registerProvider | restrict、12 工具、RPC、持久化 |
| M3 | boot + agent/created + tools/change 均无 restrict | shadow provider、12 工具、RPC、user 挂载 |
| M4 | 无 tools.register | RPC 路由 + handler 真实可用、shadow、restrict |
| M5 | 无 webServer.register、无 internal/service 监听 | 12 工具、shadow、restrict |
| M6 | client.js 无 import / 不引用 index.js | index.js 不引用 client.js、插件面完整、RPC 路径一致 |

原测试套件反应：M4 变体 44 通过 / 8 失败（全部工具依赖用例）、M1 变体 49 通过 / 3 失败（全部持久化依赖用例），详见 `report.md`。
