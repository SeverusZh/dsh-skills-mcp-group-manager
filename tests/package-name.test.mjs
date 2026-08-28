/**
 * TDD tests guarding the package-rename consistency.
 *
 * Regression for the "cannot enter DSH" crash: the client half's
 * `__ModuleLoader__.load({ id })` registration id must equal the package
 * name, because the client-modules graph resolves bundles by that id. After
 * the package was renamed to `dsh-skills-mcp-group-manager` the bundle still
 * registered as `dsh-mcp-skill-manager`, so the client graph failed to
 * compose and the whole web app refused to boot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

test('client bundle registration id equals the package name', () => {
  const match = client.match(/__ModuleLoader__\.load\(\{\s*\n?\s*id:\s*'([^']+)'/);
  assert.ok(match, 'client bundle registration id found');
  assert.equal(match[1], pkg.name, `registration id must be "${pkg.name}" (client-modules resolves bundles by package id)`);
});

test('RPC path is consistent between host and client and uses the package name', () => {
  const hostPath = host.match(/RPC_PATH = '([^']+)'/);
  const clientPath = client.match(/const RPC_PATH = '([^']+)'/);
  assert.ok(hostPath && clientPath, 'RPC paths found in both halves');
  assert.equal(hostPath[1], clientPath[1], 'host and client RPC paths must match');
  assert.ok(hostPath[1].includes(pkg.name), `RPC path should use the package name "${pkg.name}" (got ${hostPath[1]})`);
});

test('style tag plugin identity uses the package name', () => {
  assert.ok(client.includes(`dataset.plugin = '${pkg.name}'`), 'style tag data-plugin uses the package name');
});

test('skill add/remove wiring passes (id, names) correctly (no id-character iteration)', () => {
  // Regression for a real bug: a one-arg wrapper `(names) => onAddSkills(group.id, names)`
  // at the GroupSection→GroupCard level swallowed the names array — GroupCard calls
  // the prop with (group.id, namesArray), so the wrapper's first param `names` bound
  // to the group id and `for (const name of names)` iterated the id's characters,
  // adding each character of the group id as a skill.
  // The ONLY legitimate one-arg wrappers are GroupCard→GroupDetail (the detail
  // calls with a single names array).
  const addOneArg = [...client.matchAll(/onAddSkills: \(names\) =>/g)].length;
  assert.equal(addOneArg, 1, `exactly one one-arg onAddSkills wrapper (got ${addOneArg})`);
  const removeOneArg = [...client.matchAll(/onRemoveSkills: \(names\) =>/g)].length;
  assert.equal(removeOneArg, 1, `exactly one one-arg onRemoveSkills wrapper (got ${removeOneArg})`);
  const addTwoArg = [...client.matchAll(/onAddSkills: \(id, names\) =>/g)].length;
  assert.ok(addTwoArg >= 1, 'GroupSection→GroupCard uses a two-arg onAddSkills wrapper');
  const removeTwoArg = [...client.matchAll(/onRemoveSkills: \(id, names\) =>/g)].length;
  assert.ok(removeTwoArg >= 1, 'GroupSection→GroupCard uses a two-arg onRemoveSkills wrapper');
});
