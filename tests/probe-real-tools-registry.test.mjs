/**
 * Cordis plugin probe #2: mounts the manager plugin on a REAL cordis context
 * and drives it through the REAL @deepseek-ai/dsh-tools registry (not a
 * stub), proving alpha.4 alignment end to end:
 *
 *   - every manager_* tool registers through `ctx.tools.register` and passes
 *     the real registry's output-schema validation (`assertSupportedJsonSchema`);
 *   - one mutation tool (`manager_groups_create` + `manager_groups_add_skill`)
 *     executes through the real dispatch pipeline (`ctx.tools.execute`);
 *   - a disabled profile MCP server's tool is hidden from the AGENT scope by
 *     the real `tools.restrict({ deny })` layer while staying visible globally;
 *   - the shadow skill provider drives the REAL skills registry: disabling a
 *     group flips the member skill's invocation to double-false in the agent
 *     catalog.
 *
 * Requires the dsh packages; the test is skipped when they are not installed
 * (e.g. plain `npm test` on CI without a dsh deployment).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply as applyManager } from '../lib/index.js';

/** Root of the dsh scoped packages; override with DSH_PKG_ROOT for other installs. */
const DSH_PKG_ROOT = process.env.DSH_PKG_ROOT ?? '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';

let dsh;
try {
  dsh = {
    cordis: await import(pathToFileURL(join(DSH_PKG_ROOT, 'cordis/lib/index.js'))),
    skill: await import(pathToFileURL(join(DSH_PKG_ROOT, 'dsh-skill/lib/index.js'))),
    skillFilesystem: await import(pathToFileURL(join(DSH_PKG_ROOT, 'dsh-skill-filesystem/lib/index.js'))),
    scope: await import(pathToFileURL(join(DSH_PKG_ROOT, 'dsh-scope/lib/index.js'))),
    tools: await import(pathToFileURL(join(DSH_PKG_ROOT, 'dsh-tools/lib/index.js'))),
  };
} catch {
  dsh = undefined;
}

const skillFile = (name, description) => [
  '---',
  `name: ${name}`,
  `description: "${description}"`,
  '---',
  '',
  `# ${name}`,
  '',
  'Probe body.',
  '',
].join('\n');

/** Stand-in for a tool an MCP server would register globally. */
function mcpTool(name) {
  return {
    name,
    description: 'Probe MCP server tool.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: () => [],
    },
    async execute() {
      return {};
    },
  };
}

const MANAGER_TOOL_NAMES = [
  'manager_groups_list',
  'manager_groups_create',
  'manager_groups_delete',
  'manager_groups_rename',
  'manager_groups_set_enabled',
  'manager_groups_add_skill',
  'manager_groups_remove_skill',
  'manager_skills_list',
  'manager_mcp_list',
  'manager_mcp_toggle',
  'manager_mcp_add',
  'manager_mcp_remove',
];

test('probe: manager tools register, execute, and restrict through the REAL dsh-tools registry on a real cordis context', { skip: dsh === undefined && 'dsh packages not installed' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'msm-probe-tools-'));
  const userSkills = join(home, 'skills');
  const bundledDir = join(home, 'bundled');
  await mkdir(join(userSkills, 'probe-user-skill'), { recursive: true });
  await mkdir(join(bundledDir, 'probe-bundled-skill'), { recursive: true });
  await writeFile(join(userSkills, 'probe-user-skill', 'SKILL.md'), skillFile('probe-user-skill', 'user-dsh skill'), 'utf8');
  await writeFile(join(bundledDir, 'probe-bundled-skill', 'SKILL.md'), skillFile('probe-bundled-skill', 'bundled skill'), 'utf8');

  // Pre-seed a DISABLED profile MCP server: the restriction pass must hide its
  // live tools from each agent scope.
  const stateDir = join(home, 'mcp-skill-manager');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'state.json'), JSON.stringify({
    groups: [],
    mcp: [{ serverName: 'probe-srv', transport: 'stdio', command: 'probe', enabled: false, addedByUser: false }],
  }), 'utf8');

  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const root = new dsh.cordis.Context();
  // ToolRuntime (mode native) only needs the systemPrompt surface it touches.
  root.systemPrompt = { tools() {}, section() {} };
  try {
    new dsh.skill.SkillRegistry(root);
    // Global layer: bundled-only provider (mirrors aegis-method-pack).
    dsh.skillFilesystem.apply(root, {
      providerName: 'probe-bundled',
      includeDefaultRoots: false,
      bundledSkillDir: bundledDir,
      watch: false,
    });

    // Agent scope: user-dsh provider (mirrors the agent-preset row).
    const agent = { id: 'probe-agent', session: { header: { cwd: home } } };
    const { ctx: agentCtx } = dsh.scope.createScope(root, agent);
    agent.ctx = agentCtx;
    dsh.skillFilesystem.apply(agentCtx, {
      providerName: 'probe-agent-fs',
      dshHome: home,
      includeDefaultRoots: true,
      watch: false,
    });

    // REAL tools registry on the host context.
    root.tools = new dsh.tools.ToolRuntime(root, { mode: 'native' });
    root.agents = { list: () => [agent] };
    root.loader = { entries: () => [], create: async () => {}, remove: async () => {} };

    // The disabled server has one live tool in the global registry BEFORE the
    // plugin applies (mimics an MCP tool that already settled).
    root.tools.register(mcpTool('mcp__probe-srv__echo'));

    applyManager(root, {});

    // 1) Registration through the real registry (schema validation ran).
    const names = root.tools.schemas().map((schema) => schema.name);
    for (const expected of MANAGER_TOOL_NAMES) {
      assert.ok(names.includes(expected), `real registry schema includes ${expected}`);
    }

    // 2) One mutation-tool invocation through the real dispatch pipeline.
    const created = await root.tools.execute({
      callId: 'probe-call-create',
      name: 'manager_groups_create',
      arguments: { name: 'Probe Group' },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(created.isError, false, `manager_groups_create succeeded through the real registry (${created.isError === true ? created.error?.message : ''})`);
    assert.ok(typeof created.value?.id === 'string' && created.value.id.length > 0, 'create returns a stable group id');

    const added = await root.tools.execute({
      callId: 'probe-call-add',
      name: 'manager_groups_add_skill',
      arguments: { id: created.value.id, skill: 'probe-user-skill' },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(added.isError, false, `manager_groups_add_skill succeeded (${added.isError === true ? added.error?.message : ''})`);
    assert.deepEqual(added.value?.skills, ['probe-user-skill'], 'add skill echoes the post-operation membership');

    // 3) The disabled server's tool is restricted on the AGENT scope only.
    assert.equal(root.tools.get('mcp__probe-srv__echo', agent), undefined, 'agent scope hides the disabled server tool (real tools.restrict)');
    assert.ok(root.tools.get('mcp__probe-srv__echo') !== undefined, 'global view still sees the disabled server tool');

    // 3.5) An ENABLED agent-plane skill still loads its body: the shadow must
    //      not shadow agent-plane candidates that stay enabled (their get()
    //      would lose the filesystem provider).
    const loaded = await root.skills.get('probe-user-skill', { cwd: home, signal: AbortSignal.timeout(5000), scope: agent });
    assert.ok(loaded, 'enabled agent-plane skill body loads through the real registry');
    assert.ok(loaded.content.includes('Probe body.'), 'loaded body is the real skill content');

    // 4) The shadow catalog drives the REAL skills registry: disabling the
    //    group makes the member skill model/user-uninvocable at agent scope.
    const disabled = await root.tools.execute({
      callId: 'probe-call-disable',
      name: 'manager_groups_set_enabled',
      arguments: { id: created.value.id, enabled: false },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(disabled.isError, false, `manager_groups_set_enabled succeeded (${disabled.isError === true ? disabled.error?.message : ''})`);
    const agentSkills = await root.skills.list({ scope: agent });
    const userSkill = agentSkills.find((skill) => skill.name === 'probe-user-skill');
    assert.ok(userSkill, 'agent catalog still lists the member skill');
    assert.equal(userSkill.invocation.modelInvocable, false, 'disabled group hides the skill from the model');
    assert.equal(userSkill.invocation.userInvocable, false, 'disabled group hides the skill from the user');
  } finally {
    process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
