# dsh-skills-mcp-group-manager 消融实验报告

基线：`19bac09` (0.3.3-beta.0, dev-slim) · 原测试套件 52/52 通过 · 消融探针 6/6 通过（`node ablation/run.mjs`）

## 结果总览

| 变体 | 类型 | 消融目标 | loadOk | 结果 | 关键观察 |
|---|---|---|---|---|---|
| M1 | code | state 持久化（store.js 读写） | ✅ | ✅ | 变更不落盘（无 state.json）；内存态读写正常；工具/RPC 保留 |
| M2 | code | skill-catalog 过滤（shadow provider） | ✅ | ✅ | boot 与 agent/created 均无 registerProvider；restrict/工具/RPC/持久化保留 |
| M3 | code | MCP 枚举与开关（tools.restrict） | ✅ | ✅ | boot/agent/created/tools/change 均无 restrict 调用；shadow/工具/RPC/user 挂载保留 |
| M4 | code | manager_* 工具（12 个） | ✅ | ✅ | 无任何 tools.register；RPC 路由存在且 handler 真实可用；shadow/restrict 保留 |
| M5 | code | RPC 表面（webServer 路由） | ✅ | ✅ | 无 webServer.register、无 internal/service 监听；工具/过滤/restrict 保留 |
| M6 | 静态 | 客户端 UI（lib/client.js） | ✅ | ✅ | client.js 无 import、不引用 index.js；index.js 不引用 client.js；`{ apply, inject }` 插件面完整；RPC 路径两端一致；`node --check` 通过 |

探针灵敏度阳性对照：基线（无 patch）下每个负向断言都如预期失败（M1 落盘、M2 双路径注册 provider、M3 双 agent restrict、M4 12 工具、M5 路由+监听），证明探针真实检测到被消融模块。

## 原测试套件在 code 消融下的反应

### M4（移除 manager_* 工具）— 44 通过 / 8 失败

失败 8/52（全部为工具依赖用例）→ **消融生效**：

- `host-apply.test.mjs`：12 工具同步注册、live-agent 容错（断言 tools≥12）、manager_skills_list 合并×2、工具 JSON schema 校验 — 5 个失败
- `tool-output-schema.test.mjs`：mutation 工具回显与输出 schema — 1 个失败
- `probe-agent-plane.test.mjs` / `probe-real-tools-registry.test.mjs`：真实 Cordis 注册/执行 — 2 个失败

通过 44/52（不依赖工具注册）→ **核心保留**：监听器/effect 接线、shadow provider 注册、restrict 重入防护（restrict-reentrancy 2/2）、store/state 纯函数、client/package-name/host-imports 全部通过。

### M1（移除 state 持久化）— 49 通过 / 3 失败

失败 3/52（全部为持久化依赖用例）→ **消融生效**：

- `probe-real-tools-registry.test.mjs`：预置 state.json 的禁用服务器被内存态忽略 → agent 作用域不再隐藏其工具
- `restrict-reentrancy.test.mjs` 2/2：同样依赖预置 state.json 驱动 restrict 路径

通过 49/52 → **核心保留**：`store.test.mjs` 5/5 通过（直接测 lib/store.js 模块，消融点在 index.js 的接线层，模块本身未动）；工具注册、shadow provider、RPC、client 等全部通过。

## 结论

1. **模块独立性高**：6 个模块全部可独立消融，互不级联破坏；每个变体 loadOk=true，保留模块的注册与功能均通过正向断言。
2. **依赖关系**：M1（持久化）是 M3（restrict）的间接输入源——内存态忽略预置 state 后 restrict 路径自然失效（M1 变体下无 deny 可算）；M4（工具）与 M5（RPC）共享 `api` 业务层，互为消融时的正向保留证据（M4 下 RPC handler 真实可用、M5 下工具真实可用）。
3. **M3 消融范围**：按设计仅移除 `applyMcpRestrictions`/`applyMcpRestrictionsToAll`（profile 服务器 restrict 路径）；user 服务器动态挂载（loader.create）作为独立机制保留，探针验证其仍工作。
4. **M6 解耦成立**：client.js 是自包含浏览器脚本（无 import、无 index.js 引用），与宿主侧仅通过约定的 RPC 路径通信，静态消融（删除 client.js 产物）不影响宿主加载。
5. **测试套件敏感性**：原测试对 M4 高度敏感（8 个工具用例失败）、对 M1 中度敏感（3 个持久化用例失败），与消融探针的负向断言一致，交叉验证了消融有效性。
