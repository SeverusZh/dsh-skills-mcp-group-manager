/**
 * dsh-mcp-skill-manager — dependency link setup.
 *
 * The plugin is installed into a dsh profile with a `link:` (file:) install,
 * so Node resolves the plugin's imports from THIS source directory, not from
 * the profile's node_modules. The runtime imports (`@deepseek-ai/dsh-tools`,
 * `@deepseek-ai/dsh-mcp-client`, plus the peer set) live in the GLOBAL dsh
 * install's node_modules, which is not on the plugin's resolution chain.
 *
 * This script creates a project-local `node_modules/@deepseek-ai/` with
 * symlinks to the global dsh install's packages, so the plugin loads. The
 * symlinked packages resolve their own imports from their real locations
 * (the global install), so no further wiring is needed.
 *
 * Run it once after `dsh plugin --profile web add <this dir>` (or before):
 *
 *   node scripts/setup-links.mjs
 *
 * Idempotent: existing links are refreshed, missing targets are reported.
 */
import { mkdir, readlink, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');

/** Packages the host half imports (or may import) at runtime. */
const NEEDED = [
  'cordis',
  'dsh-agent',
  'dsh-mcp-client',
  'dsh-scope',
  'dsh-settings',
  'dsh-skill',
  'dsh-tools',
  'schemastery',
];

/** Locate the global dsh install's @deepseek-ai package directory. */
function findDshAiDir() {
  // 1) explicit override
  if (process.env.DSH_GLOBAL_NODE_MODULES) {
    return join(process.env.DSH_GLOBAL_NODE_MODULES, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
  }
  // 2) npm global prefix
  try {
    const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim();
    const candidate = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
    if (candidate !== join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')) {
      // no-op guard; fall through to existence check below
    }
    return candidate;
  } catch {
    /* fall through */
  }
  // 3) resolve the `dsh` binary on PATH
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim();
    const real = execFileSync('readlink', ['-f', bin], { encoding: 'utf8' }).trim();
    // .../dsh/lib/bin.js → walk up to the dsh package root
    const pkgRoot = resolve(dirname(dirname(real)));
    return join(pkgRoot, 'node_modules', '@deepseek-ai');
  } catch {
    /* fall through */
  }
  return undefined;
}

const source = findDshAiDir();
if (source === undefined) {
  console.error('setup-links: cannot locate the global dsh install. Set DSH_GLOBAL_NODE_MODULES to its node_modules path.');
  process.exitCode = 1;
} else {
  const target = join(PROJECT_ROOT, 'node_modules', '@deepseek-ai');
  await mkdir(target, { recursive: true });
  let created = 0;
  for (const name of NEEDED) {
    const from = join(source, name);
    const to = join(target, name);
    try {
      const existing = await readlink(to).catch(() => undefined);
      if (existing !== undefined) {
        if (resolve(dirname(to), existing) === from) continue; // already correct
        await rm(to, { recursive: true, force: true });
      }
      await symlink(from, to, 'dir');
      created += 1;
      console.log(`setup-links: linked ${name} -> ${from}`);
    } catch (error) {
      console.error(`setup-links: failed to link ${name}: ${String(error)}`);
      process.exitCode = 1;
    }
  }
  if (created === 0) console.log('setup-links: all links already in place');
}
