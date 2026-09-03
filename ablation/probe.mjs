/**
 * dsh-skills-mcp-group-manager 消融探针（ablation/probe.mjs）
 *
 * 用法：node ablation/probe.mjs <variant-id>   （M1..M6）
 *
 * 对每个 code 变体（M1..M5，patch 已由 run.mjs 应用）在扩展自
 * tests/host-apply.test.mjs 的 fakeCtx 上挂载插件，断言：
 *   - loadOk：apply() 不抛错（同步完成全部注册）；
 *   - ablationEffective（负向）：被消融模块的注册/副作用消失；
 *   - corePass（正向）：保留模块的注册与功能仍可用。
 *
 * M6 为静态验证：client.js 与 index.js 的模块解耦（无相互引用、RPC 路径
 * 一致、client.js 语法可加载）。
 *
 * 输出：单行 JSON { variant, loadOk, checks, pass, note }。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../lib/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const MANAGER_TOOL_COUNT = 12;
const STATE_FILE = path.join('mcp-skill-manager', 'state.json');

/* ------------------------------------------------------------------ *
 * 变体矩阵
 * ------------------------------------------------------------------ */

const VARIANTS = {
  M1: { note: '移除 createStateStore/loadSync → 状态仅存内存，不落盘' },
  M2: { note: '移除 applyAgentFilter → 无 shadow provider 注册' },
  M3: { note: '移除 applyMcpRestrictions/applyMcpRestrictionsToAll → 无 tools.restrict' },
  M4: { note: '移除 tool() 注册循环 → 无 manager_* 工具' },
  M5: { note: '移除 registerWebSurface → 无 RPC 路由' },
  M6: { note: '静态验证：client.js 独立于 index.js（模块解耦）' },
};

/* ------------------------------------------------------------------ *
 * fakeCtx（扩展自 tests/host-apply.test.mjs，捕获全部注册面）
 * ------------------------------------------------------------------ */

/** 一个 live agent：agent.ctx.get('skills'/'tools') 解析到捕获桩。 */
function makeAgent(id) {
  const agentProviders = [];
  const restrictCalls = [];
  const invalidateCalls = [];
  const agentSkills = {
    registerProvider(factory) {
      // 真实 Cordis 同步调用 factory；controlRef 在 factory 内被捕获，
      // 因此必须同步执行，否则 refreshSkillCatalogs 会拿到 undefined。
      const control = {
        invalidate() { invalidateCalls.push(1); },
        signal: new AbortController().signal,
      };
      const provider = factory(control);
      agentProviders.push(provider);
      return () => {};
    },
    async list() { return []; },
  };
  const agentTools = {
    restrict({ deny }) { restrictCalls.push([...deny]); return () => {}; },
  };
  const agentCtx = {
    get(key) {
      if (key === 'skills') return agentSkills;
      if (key === 'tools') return agentTools;
      return undefined;
    },
  };
  return { agent: { id, ctx: agentCtx }, agentProviders, restrictCalls, invalidateCalls };
}

/** 主 ctx：捕获 tools.register / skills.registerProvider / loader / on / effect / webServer。 */
function fakeCtx({ agents = [], schemas = [], loaderEntries = [], withWebServer = true } = {}) {
  const tools = [];
  const toolDisposers = [];
  const effects = [];
  const listeners = [];
  const providers = [];
  const webRoutes = [];
  const loaderCreates = [];
  const loaderRemoves = [];
  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    tools: {
      register(def) {
        tools.push(def);
        return () => { toolDisposers.push(def.name); };
      },
      schemas() { return schemas; },
      restrict() { return () => {}; },
    },
    skills: {
      registerProvider(factory) { providers.push(factory); return () => {}; },
      async list() { return []; },
      async get() { return undefined; },
    },
    agents: { list() { return agents.map((entry) => entry.agent); } },
    loader: {
      entries() { return loaderEntries; },
      async create(opts) { loaderCreates.push(opts); },
      async remove(id) { loaderRemoves.push(id); },
    },
    on(name, listener) { listeners.push({ name, listener }); return () => {}; },
    effect(callback, label) {
      // 真实 Cordis 同步执行 effect 回调；webServer.register 因此发生在 apply 内。
      const disposer = callback();
      effects.push({ callback, label, disposer });
      return disposer;
    },
    get(key) {
      if (withWebServer && key === 'webServer') {
        return {
          register(route) { webRoutes.push(route); return () => {}; },
        };
      }
      return undefined;
    },
    plugin() { throw new Error('ctx.plugin should not be called'); },
  };
  return { ctx, tools, toolDisposers, effects, listeners, providers, webRoutes, loaderCreates, loaderRemoves };
}

/* ------------------------------------------------------------------ *
 * 场景与工具辅助
 * ------------------------------------------------------------------ */

/**
 * 建临时 DSH_HOME。除 M1 外预置一个 DISABLED profile 服务器（srv-a）及其
 * live 工具 schema，使基线中 applyMcpRestrictions 真实触发 tools.restrict
 * （M3 负向断言依赖它触发；M1 不预置，因为内存态 store 会忽略它）。
 */
async function setupHome(seed) {
  const home = await mkdtemp(join(os.tmpdir(), 'msm-ablation-'));
  if (seed) {
    const stateDir = join(home, 'mcp-skill-manager');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'state.json'), JSON.stringify({
      groups: [],
      mcp: [{ serverName: 'srv-a', transport: 'stdio', command: 'probe', enabled: false, addedByUser: false }],
    }), 'utf8');
  }
  return home;
}

/** 执行一个已注册的 manager_* 工具；未注册返回 undefined。 */
async function execTool(f, name, args) {
  const def = f.tools.find((t) => t.name === name);
  if (def === undefined) return undefined;
  try {
    return await def.execute(args ?? {});
  } catch (err) {
    return { __error: String(err?.message ?? err) };
  }
}

/** 触发 agent/created 监听器（运行时新增 agent 的路径）。 */
function fireAgentCreated(f, agentEntry) {
  const listener = f.listeners.find((l) => l.name === 'agent/created')?.listener;
  if (listener) listener({ agent: agentEntry.agent });
}

/** 触发 tools/change 监听器。 */
function fireToolsChange(f) {
  const listener = f.listeners.find((l) => l.name === 'tools/change')?.listener;
  if (listener) listener();
}

/** 断言持久化生效：state.json 存在且包含刚创建的组。 */
function persistCheck(stateFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return raw.groups?.some((g) => g.name === 'abl-group') ? 'ok' : 'FAIL: mutation not persisted';
  } catch (err) {
    return 'FAIL: ' + String(err?.message ?? err);
  }
}

/** 通过 RPC 路由 handler 发一次请求（M4 正向：无工具时 RPC 仍可用）。 */
function fakeReq(body) {
  const chunks = [Buffer.from(JSON.stringify(body), 'utf8')];
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }),
      };
    },
  };
}
function fakeRes() {
  const out = { status: 0, headers: null, body: '' };
  return {
    writeHead(status, headers) { out.status = status; out.headers = headers; },
    end(body) { out.body = body; },
    out,
  };
}
async function rpcCheck(f) {
  const route = f.webRoutes[0];
  if (route === undefined) return 'FAIL: no route registered';
  const res = fakeRes();
  try {
    // 组列表经 manager.state.get 暴露（RPC 表面无 manager.groups.list）。
    await route.handler(fakeReq({ method: 'manager.state.get', args: {} }), res);
    const parsed = JSON.parse(res.out.body);
    return parsed.ok === true && Array.isArray(parsed.value?.groups)
      ? 'ok'
      : 'FAIL: ' + res.out.body;
  } catch (err) {
    return 'FAIL: ' + String(err?.message ?? err);
  }
}

/* ------------------------------------------------------------------ *
 * M6 静态验证
 * ------------------------------------------------------------------ */

function staticChecks() {
  const clientSrc = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
  const checks = {};
  checks['client-no-import'] = /^\s*import\s/m.test(clientSrc)
    ? 'FAIL: client.js contains import statements'
    : 'ok';
  checks['client-no-index-ref'] = /index\.js/.test(clientSrc)
    ? 'FAIL: client.js references index.js'
    : 'ok';
  checks['index-no-client-ref'] = /client\.js/.test(indexSrc)
    ? 'FAIL: index.js references client.js'
    : 'ok';
  checks['client-plugin-face'] = /exports\.apply\s*=/.test(clientSrc) && /exports\.inject\s*=/.test(clientSrc)
    ? 'ok'
    : 'FAIL: client.js lacks { apply, inject } exports';
  const clientPath = (clientSrc.match(/RPC_PATH\s*=\s*'([^']+)'/) ?? [])[1];
  const indexPath = (indexSrc.match(/RPC_PATH\s*=\s*'([^']+)'/) ?? [])[1];
  checks['rpc-path-consistent'] = clientPath !== undefined && clientPath === indexPath
    ? 'ok'
    : `FAIL: client=${clientPath} index=${indexPath}`;
  return checks;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const variantId = process.argv[2];
if (!variantId || !VARIANTS[variantId]) {
  console.error('usage: node ablation/probe.mjs <variant-id>');
  console.error('variants: ' + Object.keys(VARIANTS).join(', '));
  process.exit(2);
}

const result = { variant: variantId, loadOk: false, checks: {}, pass: false, note: VARIANTS[variantId].note };

// ── M6：静态验证（不挂载插件）────────────────────────────────────────────
if (variantId === 'M6') {
  try {
    execFileSync('node', ['--check', path.join('lib', 'client.js')], { cwd: root, encoding: 'utf8' });
    result.loadOk = true;
  } catch (err) {
    result.checks['client-syntax'] = 'FAIL: ' + String(err?.message ?? err);
    console.log(JSON.stringify(result));
    process.exit(0);
  }
  result.checks = staticChecks();
  result.pass = Object.values(result.checks).every((v) => v === 'ok');
  console.log(JSON.stringify(result));
  process.exit(0);
}

// ── M1..M5：fakeCtx 挂载 + 变体断言 ─────────────────────────────────────
const seed = variantId !== 'M1';
const home = await setupHome(seed);
const stateFile = path.join(home, STATE_FILE);
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;

const agent1 = makeAgent('agent-1');
const agent2 = makeAgent('agent-2');
const schemas = [{ name: 'mcp__srv-a__tool1' }, { name: 'plain-tool' }];
const f = fakeCtx({ agents: [agent1], schemas });

try {
  try {
    apply(f.ctx, {});
    result.loadOk = true;
  } catch (err) {
    result.checks.load = 'FAIL: ' + String(err?.message ?? err);
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  const managerTools = f.tools.filter((t) => t.name.startsWith('manager_'));
  const toolsOk = managerTools.length === MANAGER_TOOL_COUNT
    ? 'ok'
    : `FAIL: ${managerTools.length}/${MANAGER_TOOL_COUNT} manager_* tools`;
  const rpcOk = f.webRoutes.length === 1 ? 'ok' : `FAIL: ${f.webRoutes.length} RPC routes`;
  const shadowOk = agent1.agentProviders.length === 1
    ? 'ok'
    : `FAIL: ${agent1.agentProviders.length} shadow providers`;
  const restrictOk = agent1.restrictCalls.length === 1 && agent1.restrictCalls[0].includes('mcp__srv-a__tool1')
    ? 'ok'
    : `FAIL: restrictCalls=${JSON.stringify(agent1.restrictCalls)}`;

  switch (variantId) {
    case 'M1': {
      // 负向：变更不落盘；正向：内存态可用 + 工具/RPC 保留。
      const created = await execTool(f, 'manager_groups_create', { name: 'abl-group' });
      const list = await execTool(f, 'manager_groups_list', {});
      result.checks['no-state-file'] = fs.existsSync(stateFile)
        ? 'FAIL: state file written despite ablation'
        : 'ok';
      result.checks['in-memory-works'] = typeof created?.id === 'string'
        && list?.groups?.some((g) => g.name === 'abl-group')
        ? 'ok'
        : `FAIL: created=${JSON.stringify(created)} list=${JSON.stringify(list)}`;
      result.checks['tools-registered'] = toolsOk;
      result.checks['rpc-registered'] = rpcOk;
      break;
    }
    case 'M2': {
      // 负向：boot 与 agent/created 两条路径都不注册 shadow provider。
      fireAgentCreated(f, agent2);
      result.checks['no-shadow-provider'] = agent1.agentProviders.length === 0
        && agent2.agentProviders.length === 0
        ? 'ok'
        : `FAIL: providers agent1=${agent1.agentProviders.length} agent2=${agent2.agentProviders.length}`;
      // 正向：工具 / restrict / RPC / 持久化保留。
      result.checks['tools-registered'] = toolsOk;
      result.checks['restrict-applied'] = restrictOk;
      result.checks['rpc-registered'] = rpcOk;
      await execTool(f, 'manager_groups_create', { name: 'abl-group' });
      result.checks['persist-works'] = persistCheck(stateFile);
      break;
    }
    case 'M3': {
      // 负向：boot、agent/created、tools/change 三条路径都不触发 restrict。
      fireAgentCreated(f, agent2);
      fireToolsChange(f);
      result.checks['no-restrict'] = agent1.restrictCalls.length === 0
        && agent2.restrictCalls.length === 0
        ? 'ok'
        : `FAIL: restrictCalls agent1=${JSON.stringify(agent1.restrictCalls)} agent2=${JSON.stringify(agent2.restrictCalls)}`;
      // 正向：shadow provider / 工具 / RPC / user 服务器挂载保留。
      result.checks['shadow-provider'] = shadowOk;
      result.checks['tools-registered'] = toolsOk;
      result.checks['rpc-registered'] = rpcOk;
      const added = await execTool(f, 'manager_mcp_add', { serverName: 'user-srv', transport: 'stdio', command: 'probe' });
      result.checks['mount-works'] = added?.serverName === 'user-srv' && f.loaderCreates.length === 1
        ? 'ok'
        : `FAIL: added=${JSON.stringify(added)} loaderCreates=${f.loaderCreates.length}`;
      break;
    }
    case 'M4': {
      // 负向：无任何 tools.register；正向：RPC 表面可用（含真实 handler 调用）。
      result.checks['no-tools'] = f.tools.length === 0 ? 'ok' : `FAIL: ${f.tools.length} tools registered`;
      result.checks['rpc-registered'] = rpcOk;
      result.checks['rpc-works'] = await rpcCheck(f);
      result.checks['shadow-provider'] = shadowOk;
      result.checks['restrict-applied'] = restrictOk;
      break;
    }
    case 'M5': {
      // 负向：无 RPC 路由、无 internal/service 监听；正向：工具/过滤/restrict 保留。
      result.checks['no-rpc-route'] = f.webRoutes.length === 0 ? 'ok' : `FAIL: ${f.webRoutes.length} routes`;
      result.checks['no-internal-service-listener'] = f.listeners.some((l) => l.name === 'internal/service')
        ? 'FAIL: internal/service listener still registered'
        : 'ok';
      result.checks['tools-registered'] = toolsOk;
      result.checks['tools-work'] = (await execTool(f, 'manager_groups_create', { name: 'abl-group' }))?.id
        ? 'ok'
        : 'FAIL: manager_groups_create failed';
      result.checks['shadow-provider'] = shadowOk;
      result.checks['restrict-applied'] = restrictOk;
      break;
    }
  }

  result.pass = Object.values(result.checks).every((v) => v === 'ok');
} catch (err) {
  result.checks.scenario = 'FAIL: ' + String(err?.message ?? err);
  result.pass = false;
} finally {
  process.env.DSH_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
}

console.log(JSON.stringify(result));
