/**
 * Regression test: disabling an MCP server whose tools are LIVE must not
 * wedge the process.
 *
 * Real-deployment bug: `tools.restrict()` emits `tools/change` SYNCHRONOUSLY
 * (ScopedLayers.effect notifies right after the layer mutation), and the
 * plugin's `tools/change` listener re-runs `applyMcpRestrictions`. Because
 * the `restrictDisposers` map entry was only written AFTER `restrict()`
 * returned, the reentrant call saw no current restriction, recomputed the
 * same deny set, and called `restrict()` again — an unbounded synchronous
 * recursion that stack-overflowed and froze the whole dsh process (the
 * manager "卡死" when toggling MCP off).
 *
 * This test drives the exact interaction with a fake ctx whose `restrict()`
 * synchronously emits `tools/change`, and asserts the application round
 * terminates with exactly one restriction per agent.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

/** Fake ctx with a synchronous tools/change emit on restrict/dispose. */
function reentrantCtx({ schemas, agents }) {
  const listeners = new Map();
  const restrictCalls = [];
  const disposeCalls = [];
  const emit = (name) => {
    for (const listener of listeners.get(name) ?? []) listener();
  };
  const tools = {
    schemas() { return schemas; },
    restrict({ deny }) {
      restrictCalls.push([...deny]);
      emit('tools/change'); // synchronous, like ScopedLayers.effect's onChange
      return () => {
        disposeCalls.push([...deny]);
        emit('tools/change'); // the disposer also emits, like the effect cleanup
      };
    },
    register() { return () => {}; },
  };
  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    tools,
    skills: {
      registerProvider() { return () => {}; },
      async list() { return []; },
      async get() { return undefined; },
    },
    agents: { list() { return agents; } },
    loader: { entries() { return []; } },
    on(name, listener) {
      (listeners.get(name) ?? listeners.set(name, []).get(name)).push(listener);
      return () => {};
    },
    effect() { return () => {}; },
    get() { return undefined; },
    plugin() { throw new Error('ctx.plugin should not be called in this test'); },
  };
  return { ctx, tools, restrictCalls, disposeCalls, emit };
}

/** Live agent whose ctx.get('tools') resolves the SHARED tools service. */
function liveAgent(id, tools) {
  return { id, ctx: { get(key) { return key === 'tools' ? tools : undefined; } } };
}

async function withStateHome(state) {
  const home = await mkdtemp(join(tmpdir(), 'msm-reentrancy-'));
  const dir = join(home, 'mcp-skill-manager');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify(state), 'utf8');
  return home;
}

test('disabling a live MCP server applies one restriction per agent (no reentrant recursion)', async () => {
  const home = await withStateHome({
    groups: [],
    mcp: [{ serverName: 'github', transport: 'stdio', command: 'x', enabled: false, addedByUser: true }],
  });
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const schemas = [
      { name: 'mcp__github__tool1' },
      { name: 'mcp__github__tool2' },
      { name: 'mcp__github__tool3' },
      { name: 'some_other_tool' },
    ];
    const { ctx, tools, restrictCalls, disposeCalls, emit } = reentrantCtx({ schemas, agents: [] });
    apply(ctx, {});
    // The agent appears AFTER apply(): the first restriction application must
    // happen through the tools/change listener (exactly what a toggle's
    // applyStateEffects() drives) — the pre-fix code recursed there until
    // RangeError: Maximum call stack size exceeded.
    ctx.agents.list = () => [liveAgent('agent-1', tools)];

    // Simulate the toggle: state already says disabled (written above), and
    // the tools/change listener is what applyStateEffects() drives after the
    // state update. The listener must terminate.
    assert.doesNotThrow(() => emit('tools/change'), 'tools/change application must terminate');

    // Exactly one restriction per agent, naming every live tool of the
    // disabled server — no duplicate layers from reentrant calls.
    assert.equal(restrictCalls.length, 1, 'restrict called exactly once per agent');
    assert.deepEqual(restrictCalls[0], ['mcp__github__tool1', 'mcp__github__tool2', 'mcp__github__tool3']);
    assert.equal(disposeCalls.length, 0, 'no disposals on first application');
  } finally {
    process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('deny-set change swaps the restriction exactly once (disposer reentrancy is contained)', async () => {
  const home = await withStateHome({
    groups: [],
    mcp: [{ serverName: 'github', transport: 'stdio', command: 'x', enabled: false, addedByUser: true }],
  });
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const schemas = [
      { name: 'mcp__github__tool1' },
      { name: 'mcp__github__tool2' },
      { name: 'mcp__github__tool3' },
    ];
    const { ctx, tools, restrictCalls, disposeCalls, emit } = reentrantCtx({ schemas, agents: [] });
    apply(ctx, {});
    ctx.agents.list = () => [liveAgent('agent-1', tools)];
    emit('tools/change'); // first application: deny = all 3 tools
    assert.equal(restrictCalls.length, 1);

    // A tool disappears (server unmount in progress) → next tools/change
    // must swap to the smaller deny set exactly once, not loop.
    schemas.pop();
    assert.doesNotThrow(() => emit('tools/change'), 'swap must terminate');
    assert.equal(disposeCalls.length, 1, 'old restriction disposed exactly once');
    assert.equal(restrictCalls.length, 2, 'new restriction applied exactly once');
    assert.deepEqual(restrictCalls[1], ['mcp__github__tool1', 'mcp__github__tool2']);

    // Stable state: further events are no-ops.
    assert.doesNotThrow(() => emit('tools/change'));
    assert.equal(restrictCalls.length, 2, 'no churn on unchanged deny set');
    assert.equal(disposeCalls.length, 1, 'no churn on unchanged deny set');
  } finally {
    process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
