/**
 * TDD tests for the single-command install requirement.
 *
 * `dsh plugin add` links the package into the profile; Node resolves the
 * plugin's imports from the source directory, which has no node_modules.
 * The ONLY way `dsh plugin add` alone can work is if the host half has NO
 * external package imports — only node builtins and local modules. This
 * static test guards that invariant (the runtime verification happens via
 * the Cordis probe: mounting the plugin in the live process).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

test('host half imports only node builtins and local modules', () => {
  const external = [...host.matchAll(/^\s*import\s+[^'"]*['"]([^'"]+)['"]/gm)]
    .map((m) => m[1])
    .filter((spec) => !spec.startsWith('node:') && !spec.startsWith('.'));
  assert.deepEqual(external, [], `no external package imports (found: ${external.join(', ')})`);
});

test('host half has no require() of external packages', () => {
  const requires = [...host.matchAll(/require\(['"]([^'"]+)['"]\)/g)]
    .map((m) => m[1])
    .filter((spec) => !spec.startsWith('node:') && !spec.startsWith('.'));
  assert.deepEqual(requires, [], `no external require() (found: ${requires.join(', ')})`);
});
