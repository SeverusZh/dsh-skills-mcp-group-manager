/**
 * Unit tests for the plugin-owned state store (lib/store.js).
 * Uses a temp directory as the harness home; never touches ~/.dsh.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStateStore, normalizeState, resolveStateDir } from '../lib/store.js';

async function tempHome() {
  return mkdtemp(join(tmpdir(), 'msm-store-'));
}

test('resolveStateDir: uses DSH_HOME override', () => {
  const dir = resolveStateDir('/tmp/custom-home');
  assert.equal(dir, join('/tmp/custom-home', 'mcp-skill-manager'));
});

test('load: missing file yields empty state', async () => {
  const home = await tempHome();
  try {
    const store = createStateStore({ dshHome: home });
    const state = await store.load();
    assert.deepEqual(state, { groups: [], mcp: [] });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('load: corrupt file yields empty state', async () => {
  const home = await tempHome();
  try {
    const dir = join(home, 'mcp-skill-manager');
    await writeFile(join(dir, 'state.json'), '{not json', 'utf8').catch(() => {});
    const store = createStateStore({ dshHome: home });
    const state = await store.load();
    assert.deepEqual(state, { groups: [], mcp: [] });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('update: persists atomically and survives a fresh store', async () => {
  const home = await tempHome();
  try {
    const store = createStateStore({ dshHome: home });
    await store.load();
    await store.update({
      groups: [{ id: 'g1', name: 'G1', enabled: true, skills: ['skill-a'] }],
    });
    const raw = await readFile(join(home, 'mcp-skill-manager', 'state.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.groups[0].name, 'G1');

    // a fresh store (simulating a restart) reads the same state back
    const store2 = createStateStore({ dshHome: home });
    const state2 = await store2.load();
    assert.equal(state2.groups[0].id, 'g1');
    assert.deepEqual(state2.groups[0].skills, ['skill-a']);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('normalizeState: drops malformed entries, keeps valid ones', () => {
  const raw = {
    groups: [
      { id: 'g1', name: 'G1', enabled: true, skills: ['a'] },
      { id: 42, name: 'bad', enabled: true, skills: [] },
      { name: 'no-id', enabled: true, skills: [] },
    ],
    mcp: [
      { serverName: 'srv', transport: 'stdio', command: 'npx', enabled: true, addedByUser: true },
      { serverName: 'bad', transport: 'carrier-pigeon', enabled: true, addedByUser: true },
    ],
  };
  const state = normalizeState(raw);
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].id, 'g1');
  assert.equal(state.mcp.length, 1);
  assert.equal(state.mcp[0].serverName, 'srv');
});

test('normalizeState: non-object input yields empty state', () => {
  assert.deepEqual(normalizeState(null), { groups: [], mcp: [] });
  assert.deepEqual(normalizeState('nope'), { groups: [], mcp: [] });
  assert.deepEqual(normalizeState(undefined), { groups: [], mcp: [] });
});
