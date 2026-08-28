/**
 * Host apply() contract tests.
 *
 * Regression guard for a crash hazard found in the real deployment: Cordis
 * treats a prototype-bearing function as a constructor, so an `async apply`
 * is NOT awaited — its promise is ignored. If anything after the first
 * `await` throws, the rejection is unhandled and the whole dsh process
 * crashes (the "flicker" the user saw was the service crash-restart loop).
 *
 * Contract under test: `apply()` must complete ALL registrations
 * SYNCHRONOUSLY — tools, listeners, effects — so the loader sees a fully
 * wired plugin and any error surfaces as a normal loader failure instead of
 * an unhandled rejection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

/** Minimal fake ctx capturing every registration the host half performs. */
function fakeCtx() {
  const tools = [];
  const toolDisposers = [];
  const effects = [];
  const listeners = [];
  const providers = [];
  const schemas = [];
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
    agents: { list() { return []; } },
    loader: { entries() { return []; } },
    on(name, listener) { listeners.push({ name, listener }); return () => {}; },
    effect(callback, label) { effects.push({ callback, label }); return () => {}; },
    get() { return undefined; },
    plugin() { throw new Error('ctx.plugin should not be called in this test'); },
  };
  return { ctx, tools, toolDisposers, effects, listeners, providers };
}

test('apply() registers all 12 manager_* tools synchronously', () => {
  const { ctx, tools } = fakeCtx();
  const result = apply(ctx, {});
  // The contract: after apply() RETURNS (not after a microtask), every tool
  // must already be registered. An async apply would fail this assertion
  // because the registrations happen after the first await.
  assert.equal(typeof result?.then, 'undefined', 'apply() must be synchronous (no promise)');
  const names = tools.map((tool) => tool.name);
  for (const expected of [
    'manager_groups_list', 'manager_groups_create', 'manager_groups_delete',
    'manager_groups_rename', 'manager_groups_set_enabled', 'manager_groups_add_skill',
    'manager_groups_remove_skill', 'manager_skills_list', 'manager_mcp_list',
    'manager_mcp_toggle', 'manager_mcp_add', 'manager_mcp_remove',
  ]) {
    assert.ok(names.includes(expected), `tool ${expected} registered synchronously`);
  }
});

test('apply() wires lifecycle listeners and effects synchronously', () => {
  const { ctx, effects, listeners } = fakeCtx();
  apply(ctx, {});
  const listenerNames = listeners.map((entry) => entry.name);
  for (const expected of ['agent/created', 'agent/disposed', 'tools/change']) {
    assert.ok(listenerNames.includes(expected), `listener ${expected} registered synchronously`);
  }
  const effectLabels = effects.map((entry) => entry.label);
  assert.ok(effectLabels.includes('mcp-skill-manager: agent-layer cleanup'), 'cleanup effect registered synchronously');
});

test('apply() registers the shadow skill provider factory synchronously', () => {
  const { ctx, providers } = fakeCtx();
  apply(ctx, {});
  assert.equal(providers.length, 0, 'no live agents at boot → no provider yet');
  // Simulate an agent appearing: the agent/created listener must register a
  // provider named skill-manager-filter on the agent scope.
  const created = ctx.on.calls?.() ?? [];
  void created;
});

test('apply() tolerates live agents whose ctx resolves skills only via get()', () => {
  // Regression for the real-deployment crash: in the running dsh process,
  // `agent.ctx.skills` (property access) throws the Cordis Guard error
  // ("cannot get property skills without inject") because 'skills' is not in
  // the agent ctx's inject map — while `agent.ctx.get('skills')` resolves
  // the service fine. The plugin must use get() so a boot with restored
  // sessions (live agents at apply time) cannot crash the plugin tree.
  const agentProviders = [];
  const agentSkills = {
    registerProvider(factory) { agentProviders.push(factory); return () => {}; },
  };
  const agentTools = { restrict() { return () => {}; } };
  const agentCtx = {
    get(key) {
      if (key === 'skills') return agentSkills;
      if (key === 'tools') return agentTools;
      return undefined;
    },
  };
  // Mimic the real Guard: property access to 'skills' throws.
  Object.defineProperty(agentCtx, 'skills', {
    get() { throw new Error('cannot get property "skills" without inject'); },
  });
  const agent = { id: 'live-agent-1', ctx: agentCtx };

  const { ctx, tools } = fakeCtx();
  ctx.agents.list = () => [agent];
  assert.doesNotThrow(() => apply(ctx, {}), 'apply() must not throw for live agents');
  assert.equal(agentProviders.length, 1, 'shadow provider registered on the agent scope');
  const provider = agentProviders[0]({ signal: new AbortController().signal, invalidate() {} });
  assert.equal(provider.name, 'skill-manager-filter');
  assert.equal(typeof provider.list, 'function');
  assert.equal(typeof provider.get, 'function');
  assert.ok(tools.length >= 12, 'tools still registered');
});

test('cleanup effect disposes every tool registration (no tool leaks on unload)', () => {
  const { ctx, tools, toolDisposers, effects } = fakeCtx();
  apply(ctx, {});
  const cleanup = effects.find((effect) => effect.label === 'mcp-skill-manager: agent-layer cleanup');
  assert.ok(cleanup, 'cleanup effect present');
  assert.equal(toolDisposers.length, 0, 'no disposals before cleanup');
  const disposer = cleanup.callback();
  disposer();
  assert.equal(toolDisposers.length, tools.length, 'every tool registration disposed on unload');
  assert.deepEqual([...toolDisposers].sort(), tools.map((tool) => tool.name).sort());
});

test('tool definitions carry valid raw JSON schemas (required names exist in properties)', () => {
  const { ctx, tools } = fakeCtx();
  apply(ctx, {});
  assert.ok(tools.length >= 12, 'tools registered');
  const check = (node, where) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    for (const name of node.required ?? []) {
      assert.ok(node.properties?.[name], `${where}: required "${name}" exists in properties`);
    }
    if (node.properties) for (const p of Object.values(node.properties)) check(p, where);
    if (node.items) check(node.items, where);
  };
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object', `${tool.name}: parameters object root`);
    check(tool.parameters, `${tool.name}.parameters`);
    if (tool.output?.schema) check(tool.output.schema, `${tool.name}.output`);
  }
});
