/**
 * Unit tests for the pure state logic of the dsh-mcp-skill-manager host half.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVER_NAME_PATTERN,
  addSkillsToGroup,
  denyNamesForDisabled,
  enabledSkillNames,
  groupById,
  isValidServerName,
  mcpClientConfig,
  mcpServerByName,
  removeSkillsFromGroup,
  snapshotState,
  toolsOfServer,
  validateMcpServerInput,
} from '../lib/state.js';

const emptyState = () => ({ groups: [], mcp: [] });

test('enabledSkillNames: union across enabled groups, deduped', () => {
  const state = {
    groups: [
      { id: 'a', name: 'A', enabled: true, skills: ['skill-one', 'skill-two'] },
      { id: 'b', name: 'B', enabled: true, skills: ['skill-two', 'skill-three'] },
    ],
    mcp: [],
  };
  const set = enabledSkillNames(state);
  assert.deepEqual([...set].sort(), ['skill-one', 'skill-three', 'skill-two']);
});

test('enabledSkillNames: disabled groups contribute nothing', () => {
  const state = {
    groups: [
      { id: 'a', name: 'A', enabled: false, skills: ['skill-one'] },
      { id: 'b', name: 'B', enabled: true, skills: ['skill-two'] },
    ],
    mcp: [],
  };
  assert.deepEqual([...enabledSkillNames(state)], ['skill-two']);
});

test('enabledSkillNames: empty state yields empty set', () => {
  assert.equal(enabledSkillNames(emptyState()).size, 0);
});

test('groupById / mcpServerByName find entries and miss cleanly', () => {
  const state = {
    groups: [{ id: 'g1', name: 'G1', enabled: true, skills: [] }],
    mcp: [{ serverName: 'srv', transport: 'stdio', enabled: true, addedByUser: true }],
  };
  assert.equal(groupById(state, 'g1').name, 'G1');
  assert.equal(groupById(state, 'nope'), undefined);
  assert.equal(mcpServerByName(state, 'srv').serverName, 'srv');
  assert.equal(mcpServerByName(state, 'nope'), undefined);
});

test('toolsOfServer: mcp__<server>__ prefix matching', () => {
  const schemas = [
    { name: 'mcp__github__list_issues' },
    { name: 'mcp__github__create_issue' },
    { name: 'mcp__other__tool' },
    { name: 'manager_groups_list' },
  ];
  assert.deepEqual(toolsOfServer(schemas, 'github'), ['mcp__github__list_issues', 'mcp__github__create_issue']);
  assert.deepEqual(toolsOfServer(schemas, 'unknown'), []);
});

test('denyNamesForDisabled: exact live names of disabled servers only', () => {
  const state = {
    groups: [],
    mcp: [
      { serverName: 'github', enabled: false, addedByUser: false },
      { serverName: 'alive', enabled: true, addedByUser: true },
    ],
  };
  const schemas = [
    { name: 'mcp__github__list_issues' },
    { name: 'mcp__alive__tool' },
    { name: 'manager_groups_list' },
  ];
  assert.deepEqual(denyNamesForDisabled(state, schemas), ['mcp__github__list_issues']);
});

test('denyNamesForDisabled: offline disabled server (0 live tools) is skipped', () => {
  const state = {
    groups: [],
    mcp: [{ serverName: 'offline', enabled: false, addedByUser: false }],
  };
  assert.deepEqual(denyNamesForDisabled(state, [{ name: 'manager_groups_list' }]), []);
});

test('denyNamesForDisabled: all enabled yields empty deny', () => {
  const state = {
    groups: [],
    mcp: [{ serverName: 'github', enabled: true, addedByUser: false }],
  };
  assert.deepEqual(denyNamesForDisabled(state, [{ name: 'mcp__github__x' }]), []);
});

test('isValidServerName: domain matches dsh-mcp-client', () => {
  assert.equal(SERVER_NAME_PATTERN.source, '^[A-Za-z0-9_-]{1,32}$');
  assert.ok(isValidServerName('github'));
  assert.ok(isValidServerName('my_server-2'));
  assert.ok(!isValidServerName('has space'));
  assert.ok(!isValidServerName(''));
  assert.ok(!isValidServerName('x'.repeat(33)));
  assert.ok(!isValidServerName(42));
});

test('validateMcpServerInput: stdio requires command; normalizes args/env', () => {
  const out = validateMcpServerInput({
    serverName: 'srv',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'pkg'],
    env: { KEY: 'value' },
  });
  assert.deepEqual(out, {
    serverName: 'srv',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'pkg'],
    env: { KEY: 'value' },
  });
});

test('validateMcpServerInput: streamable-http requires url', () => {
  const out = validateMcpServerInput({ serverName: 'srv', transport: 'streamable-http', url: 'https://x' });
  assert.deepEqual(out, { serverName: 'srv', transport: 'streamable-http', url: 'https://x' });
});

test('validateMcpServerInput: rejects bad input', () => {
  assert.throws(() => validateMcpServerInput({ serverName: 'bad name', transport: 'stdio', command: 'x' }), /serverName/);
  assert.throws(() => validateMcpServerInput({ serverName: 'srv', transport: 'bogus' }), /transport/);
  assert.throws(() => validateMcpServerInput({ serverName: 'srv', transport: 'stdio' }), /command/);
  assert.throws(() => validateMcpServerInput({ serverName: 'srv', transport: 'streamable-http' }), /url/);
  assert.throws(() => validateMcpServerInput({ serverName: 'srv', transport: 'stdio', command: 'x', args: [1] }), /args/);
  assert.throws(() => validateMcpServerInput({ serverName: 'srv', transport: 'stdio', command: 'x', env: { K: 1 } }), /env/);
  assert.throws(() => validateMcpServerInput(null), /object/);
});

test('mcpClientConfig: stdio and http config shapes', () => {
  const stdio = mcpClientConfig({ serverName: 'srv', transport: 'stdio', command: 'npx', args: ['a'], env: { K: 'v' } });
  assert.equal(stdio.transport, 'stdio');
  assert.equal(stdio.command, 'npx');
  assert.deepEqual(stdio.args, ['a']);
  assert.deepEqual(stdio.env, { K: 'v' });
  assert.equal(stdio.failOnStartupError, false);
  assert.equal(stdio.toolCallTimeoutMs, 60000);

  const http = mcpClientConfig({ serverName: 'srv', transport: 'streamable-http', url: 'https://x' });
  assert.equal(http.transport, 'streamable-http');
  assert.equal(http.url, 'https://x');
  assert.deepEqual(http.headers, {});
});

test('snapshotState: fresh JSON copies, no shared references', () => {
  const state = {
    groups: [{ id: 'g1', name: 'G1', enabled: true, skills: ['s1'] }],
    mcp: [{ serverName: 'srv', transport: 'stdio', command: 'npx', args: ['a'], env: { K: 'v' }, enabled: true, addedByUser: true }],
  };
  const snap = snapshotState(state);
  assert.deepEqual(snap, state);
  assert.notEqual(snap.groups, state.groups);
  assert.notEqual(snap.groups[0].skills, state.groups[0].skills);
  assert.notEqual(snap.mcp[0].args, state.mcp[0].args);
  assert.notEqual(snap.mcp[0].env, state.mcp[0].env);
  // mutating the snapshot must not touch the source
  snap.groups[0].skills.push('s2');
  assert.deepEqual(state.groups[0].skills, ['s1']);
});

test('addSkillsToGroup: appends multiple names in one immutable update, deduped', () => {
  const state = { groups: [{ id: 'g1', name: 'G1', enabled: true, skills: ['a'] }], mcp: [] };
  const next = addSkillsToGroup(state, 'g1', ['b', 'c', 'a']);
  assert.deepEqual(next.groups[0].skills, ['a', 'b', 'c']);
  // duplicates WITHIN the input array are also dropped
  const next2 = addSkillsToGroup(state, 'g1', ['b', 'b', 'c', 'b']);
  assert.deepEqual(next2.groups[0].skills, ['a', 'b', 'c']);
  // immutability: the source state is untouched
  assert.deepEqual(state.groups[0].skills, ['a']);
  assert.notEqual(next.groups, state.groups);
  // unknown group: throws
  assert.throws(() => addSkillsToGroup(state, 'nope', ['x']), /does not exist/);
});

test('removeSkillsFromGroup: removes multiple names in one immutable update', () => {
  const state = { groups: [{ id: 'g1', name: 'G1', enabled: true, skills: ['a', 'b', 'c'] }], mcp: [] };
  const next = removeSkillsFromGroup(state, 'g1', ['a', 'c']);
  assert.deepEqual(next.groups[0].skills, ['b']);
  assert.deepEqual(state.groups[0].skills, ['a', 'b', 'c']);
  assert.throws(() => removeSkillsFromGroup(state, 'nope', ['x']), /does not exist/);
});
