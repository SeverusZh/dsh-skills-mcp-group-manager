/**
 * Contract test: every manager_* tool's declared output schema must describe
 * the value its execute() actually returns.
 *
 * Background: the 8 mutation tools used to return `{}` with a degenerate
 * empty-object schema (`additionalProperties: false, properties: {}`) —
 * self-consistent, but a useless contract: callers got no confirmation
 * payload, and nothing kept schema and return value together. The fix makes
 * each mutation echo the affected entity and declares it in the schema. This
 * test locks BOTH sides: a schema edit without the matching return change
 * (or vice versa) fails here.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

/** Minimal fake ctx capturing every registration the host half performs. */
function fakeCtx() {
  const tools = [];
  const mounted = new Map();
  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    tools: {
      register(def) {
        tools.push(def);
        return () => {};
      },
      schemas() { return []; },
      restrict() { return () => {}; },
    },
    skills: {
      registerProvider() { return () => {}; },
      async list() { return []; },
      async get() { return undefined; },
    },
    agents: { list() { return []; } },
    loader: {
      entries() { return []; },
      async create({ id }) { mounted.set(id, true); },
      async remove(id) { mounted.delete(id); },
    },
    on() { return () => {}; },
    effect() { return () => {}; },
    get() { return undefined; },
    plugin() { throw new Error('ctx.plugin should not be called in this test'); },
  };
  return { ctx, tools, mounted };
}

/** Validate a value against the JSON-schema subset the plugin emits. */
function assertMatchesSchema(node, value, where) {
  if (node === null || typeof node !== 'object') return;
  if (node.type === 'object') {
    assert.equal(typeof value, 'object', `${where}: object value`);
    assert.ok(!Array.isArray(value), `${where}: object is not an array`);
    const props = node.properties ?? {};
    for (const key of Object.keys(value)) {
      assert.ok(key in props, `${where}: "${key}" is returned but not declared (additionalProperties: false)`);
      assertMatchesSchema(props[key], value[key], `${where}.${key}`);
    }
    for (const name of node.required ?? []) {
      assert.ok(name in value, `${where}: required "${name}" is missing from the returned value`);
    }
    return;
  }
  if (node.type === 'array') {
    assert.ok(Array.isArray(value), `${where}: array value`);
    for (const [index, item] of (node.items ? value : []).entries()) {
      assertMatchesSchema(node.items, item, `${where}[${index}]`);
    }
    return;
  }
  if (node.type === 'string') { assert.equal(typeof value, 'string', `${where}: string value`); return; }
  if (node.type === 'boolean') { assert.equal(typeof value, 'boolean', `${where}: boolean value`); return; }
  if (node.type === 'number') { assert.equal(typeof value, 'number', `${where}: number value`); return; }
}

test('mutation tools echo the affected entity and match their output schemas', async () => {
  const home = await mkdtemp(join(tmpdir(), 'msm-tool-output-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { ctx, tools, mounted } = fakeCtx();
    apply(ctx, {});
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const run = async (name, args) => {
      const tool = byName.get(name);
      assert.ok(tool, `tool ${name} registered`);
      const value = await tool.execute(args);
      assert.ok(tool.output?.schema, `${name}: output schema declared`);
      assertMatchesSchema(tool.output.schema, value, name);
      return value;
    };

    // Group lifecycle: every echo names the affected entity (+ its new state).
    const { id } = await run('manager_groups_create', { name: 'G' });
    assert.deepEqual(await run('manager_groups_rename', { id, name: 'G2' }), { id, name: 'G2' });
    assert.deepEqual(await run('manager_groups_set_enabled', { id, enabled: false }), { id, enabled: false });
    assert.deepEqual(
      await run('manager_groups_add_skill', { id, skill: 'demo-skill' }),
      { id, skills: ['demo-skill'] },
    );
    assert.deepEqual(
      await run('manager_groups_remove_skill', { id, skill: 'demo-skill' }),
      { id, skills: [] },
    );
    assert.deepEqual(await run('manager_groups_delete', { id }), { id });

    // MCP lifecycle (user-added server): echo serverName (+ state on toggle),
    // exercising the real mount/unmount paths through the fake loader.
    await run('manager_mcp_add', {
      serverName: 'demo',
      transport: 'streamable-http',
      url: 'http://127.0.0.1:1/rpc',
    });
    assert.ok(mounted.has('msm-mcp-demo'), 'add mounts the server');
    assert.deepEqual(
      await run('manager_mcp_toggle', { serverName: 'demo', enabled: false }),
      { serverName: 'demo', enabled: false },
    );
    assert.ok(!mounted.has('msm-mcp-demo'), 'disable unmounts the server');
    assert.deepEqual(
      await run('manager_mcp_toggle', { serverName: 'demo', enabled: true }),
      { serverName: 'demo', enabled: true },
    );
    assert.ok(mounted.has('msm-mcp-demo'), 'enable remounts the server');
    assert.deepEqual(await run('manager_mcp_remove', { serverName: 'demo' }), { serverName: 'demo' });
    assert.ok(!mounted.has('msm-mcp-demo'), 'remove unmounts the server');

    // Read-only tools keep matching their (already real) schemas.
    assert.deepEqual(await run('manager_groups_list', {}), { groups: [] });
    await run('manager_skills_list', {});
    await run('manager_mcp_list', {});
  } finally {
    process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
