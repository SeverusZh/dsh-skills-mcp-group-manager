/**
 * Cordis Plugin probe: mounts the manager plugin on a REAL cordis context
 * with the REAL dsh-skill registry and filesystem providers, replicating the
 * deployment's layer split:
 *
 *   - global layer: a bundled-only filesystem provider (mirrors the
 *     aegis-method-pack extension, includeDefaultRoots: false)
 *   - agent scope: a user-dsh filesystem provider (mirrors the agent-preset
 *     `skill-filesystem` row, includeDefaultRoots: true)
 *
 * The probe asserts the pre-fix failure mode (the unscoped host view does
 * NOT see agent-plane skills) and the fixed behavior (manager_skills_list
 * merges each live agent's view, so user-dsh skills appear).
 *
 * Requires the dsh packages; the test is skipped when they are not
 * installed (e.g. plain `npm test` on CI without a dsh deployment).
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

test('probe: manager_skills_list merges agent-plane (user-dsh) skills on a real cordis context', { skip: dsh === undefined && 'dsh packages not installed' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'msm-probe-'));
  const userSkills = join(home, 'skills');
  const bundledDir = join(home, 'bundled');
  await mkdir(join(userSkills, 'probe-user-skill'), { recursive: true });
  await mkdir(join(bundledDir, 'probe-bundled-skill'), { recursive: true });
  await writeFile(join(userSkills, 'probe-user-skill', 'SKILL.md'), skillFile('probe-user-skill', 'user-dsh skill'), 'utf8');
  await writeFile(join(bundledDir, 'probe-bundled-skill', 'SKILL.md'), skillFile('probe-bundled-skill', 'bundled skill'), 'utf8');

  const root = new dsh.cordis.Context();
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

    // Host-plane services the manager plugin needs.
    const tools = [];
    root.agents = { list: () => [agent] };
    root.loader = { entries: () => [] };
    root.tools = {
      register(def) { tools.push(def); return () => {}; },
      schemas() { return []; },
      restrict() { return () => {}; },
    };

    applyManager(root, {});

    // Pre-fix failure mode: the unscoped host view only sees the global
    // layer — the user-dsh skill must NOT be there.
    const hostView = await root.skills.list();
    const hostNames = hostView.map((skill) => skill.name);
    assert.ok(hostNames.includes('probe-bundled-skill'), 'host view sees the bundled skill');
    assert.ok(!hostNames.includes('probe-user-skill'), 'host view must NOT see agent-plane skills (pre-fix failure mode)');

    // Fixed behavior: manager_skills_list merges the agent view.
    const tool = tools.find((entry) => entry.name === 'manager_skills_list');
    assert.ok(tool, 'manager_skills_list registered');
    const out = await tool.execute({});
    const names = out.skills.map((skill) => skill.name);
    assert.ok(names.includes('probe-user-skill'), 'manager must list the agent-plane (user-dsh) skill');
    assert.ok(names.includes('probe-bundled-skill'), 'manager must still list global-layer skills');
    assert.deepEqual(names, [...names].sort(), 'output sorted by name');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
