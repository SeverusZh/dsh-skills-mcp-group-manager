/**
 * TDD tests for the client selection logic (multi-select / select-all /
 * select-none for the skill picker and the selected-skill list).
 *
 * The logic lives in the client bundle and is exported as `__logic` so it
 * can be unit-tested without a browser. The bundle is evaluated with stubbed
 * browser globals (same harness as client.test.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

const reactStub = {
  createElement: () => ({}),
  Fragment: Symbol('Fragment'),
  useState: () => [],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
};

function evaluateBundle() {
  const registrations = [];
  globalThis.window = {
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
    innerWidth: 1440,
    innerHeight: 900,
  };
  globalThis.document = {
    head: { appendChild: () => {} },
    documentElement: { lang: 'en' },
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    querySelector: () => null,
  };
  vm.runInThisContext(code, { filename: 'lib/client.js' });
  const plugin = registrations[0].factory((specifier) => {
    if (specifier === 'react') return reactStub;
    throw new Error(`unexpected require("${specifier}")`);
  });
  return plugin;
}

const SKILLS = [
  { name: 'alpha', description: 'A skill' },
  { name: 'beta', description: 'B skill' },
  { name: 'gamma', description: 'C skill' },
  { name: 'delta', description: 'D skill' },
];

test('__logic is exported from the bundle', () => {
  const plugin = evaluateBundle();
  assert.ok(plugin.__logic, 'bundle exports __logic');
  for (const fn of [
    'filterCandidates', 'filterMembers', 'toggleInSet', 'selectAllFiltered', 'clearAllFiltered',
    'toggleAllMembers', 'addSelectedToGroup', 'removeSelectedFromGroup',
  ]) {
    assert.equal(typeof plugin.__logic[fn], 'function', `${fn} exported`);
  }
});

test('filterMembers: filters the member name list by the query', () => {
  const { filterMembers } = evaluateBundle().__logic;
  const members = ['alpha', 'beta', 'gamma'];
  assert.deepEqual(filterMembers(members, ''), members);
  assert.deepEqual(filterMembers(members, 'ALP'), ['alpha']);
  assert.deepEqual(filterMembers(members, 'et'), ['beta']);
  assert.deepEqual(filterMembers(members, 'zzz'), []);
});

test('filterCandidates: excludes members and matches the query on name or description', () => {
  const { filterCandidates } = evaluateBundle().__logic;
  const members = ['beta'];
  assert.deepEqual(filterCandidates(SKILLS, members, '').map((s) => s.name), ['alpha', 'gamma', 'delta']);
  assert.deepEqual(filterCandidates(SKILLS, members, 'ALP').map((s) => s.name), ['alpha']);
  assert.deepEqual(filterCandidates(SKILLS, members, 'c skill').map((s) => s.name), ['gamma']);
  assert.deepEqual(filterCandidates(SKILLS, members, 'zzz'), []);
});

test('toggleInSet: adds and removes names', () => {
  const { toggleInSet } = evaluateBundle().__logic;
  assert.deepEqual([...toggleInSet(new Set(), 'a')], ['a']);
  assert.deepEqual([...toggleInSet(new Set(['a']), 'a')], []);
  assert.deepEqual([...toggleInSet(new Set(['a']), 'b')].sort(), ['a', 'b']);
});

test('selectAllFiltered: unions the filtered candidates into the selection', () => {
  const { selectAllFiltered } = evaluateBundle().__logic;
  const filtered = [SKILLS[0], SKILLS[1]];
  const selected = selectAllFiltered(filtered, new Set(['gamma']));
  assert.deepEqual([...selected].sort(), ['alpha', 'beta', 'gamma']);
});

test('clearAllFiltered: removes only the filtered candidates from the selection', () => {
  const { clearAllFiltered } = evaluateBundle().__logic;
  const filtered = [SKILLS[0], SKILLS[1]];
  const selected = clearAllFiltered(filtered, new Set(['alpha', 'beta', 'gamma']));
  assert.deepEqual([...selected], ['gamma']);
});

test('toggleAllMembers: selects all when not all selected, clears when all selected', () => {
  const { toggleAllMembers } = evaluateBundle().__logic;
  const members = ['alpha', 'beta'];
  assert.deepEqual([...toggleAllMembers(members, new Set())].sort(), ['alpha', 'beta']);
  assert.deepEqual([...toggleAllMembers(members, new Set(['alpha', 'beta']))], []);
  assert.deepEqual([...toggleAllMembers(members, new Set(['alpha']))].sort(), ['alpha', 'beta']);
  assert.deepEqual([...toggleAllMembers([], new Set())], []);
});

test('addSelectedToGroup: appends selected names without duplicates', () => {
  const { addSelectedToGroup } = evaluateBundle().__logic;
  assert.deepEqual(addSelectedToGroup(['alpha'], new Set(['beta', 'alpha'])), ['alpha', 'beta']);
});

test('removeSelectedFromGroup: removes exactly the selected names', () => {
  const { removeSelectedFromGroup } = evaluateBundle().__logic;
  assert.deepEqual(removeSelectedFromGroup(['alpha', 'beta', 'gamma'], new Set(['beta'])), ['alpha', 'gamma']);
});
