/**
 * dsh-mcp-skill-manager — dedicated state store.
 *
 * The user asked for group/MCP state to live OUTSIDE `settings.yaml`, in a
 * plugin-owned location that is removed together with the plugin on
 * uninstall. This module persists state to:
 *
 *   `<harness home>/mcp-skill-manager/state.json`
 *
 * (`<harness home>` = `$DSH_HOME` or `~/.dsh`). Writes are atomic
 * (temp file + rename) and serialized through a promise chain; reads fall
 * back to the empty state on missing or corrupt files. The whole directory
 * is plugin-owned, so uninstalling the plugin (which runs the package's
 * `postuninstall` script, `scripts/cleanup.mjs`) removes the data with it.
 *
 * The store exposes the same surface the host half used on the settings
 * scope — `get()` / `update(patch)` — plus `load()` for startup.
 */
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolve the plugin-owned state directory under the harness home. */
export function resolveStateDir(dshHome) {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'mcp-skill-manager');
}

/** Normalize an untrusted parsed document into the state shape. */
export function normalizeState(raw) {
  const groups = Array.isArray(raw?.groups)
    ? raw.groups.filter((g) => g !== null && typeof g === 'object'
      && typeof g.id === 'string' && typeof g.name === 'string'
      && typeof g.enabled === 'boolean' && Array.isArray(g.skills)
      && g.skills.every((s) => typeof s === 'string'))
    : [];
  const mcp = Array.isArray(raw?.mcp)
    ? raw.mcp.filter((m) => m !== null && typeof m === 'object'
      && typeof m.serverName === 'string'
      && (m.transport === 'stdio' || m.transport === 'streamable-http')
      && typeof m.enabled === 'boolean' && typeof m.addedByUser === 'boolean')
    : [];
  return { groups, mcp };
}

/**
 * Create the state store.
 * @param options.dshHome - explicit harness home (tests pass a temp dir).
 * @param options.logger - optional `{ warn, error }` logger (defaults to console).
 */
export function createStateStore({ dshHome, logger = console } = {}) {
  const dir = resolveStateDir(dshHome);
  const file = join(dir, 'state.json');
  let state = { groups: [], mcp: [] };
  let writeChain = Promise.resolve();

  /**
   * Load state from disk SYNCHRONOUSLY (idempotent; safe to call once at
   * startup). The host plugin's apply() must stay synchronous — Cordis
   * treats a prototype-bearing function as a constructor and ignores its
   * returned promise, so an async apply would turn any post-await throw
   * into an unhandled rejection that crashes the whole dsh process.
   */
  function loadSync() {
    try {
      state = normalizeState(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn?.(`mcp-skill-manager: state file unreadable (${file}): ${String(error)}; starting empty`);
      }
      state = { groups: [], mcp: [] };
    }
    return state;
  }

  /** Load state from disk (async variant; kept for tests and tooling). */
  async function load() {
    try {
      const raw = await readFile(file, 'utf8');
      state = normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn?.(`mcp-skill-manager: state file unreadable (${file}): ${String(error)}; starting empty`);
      }
      state = { groups: [], mcp: [] };
    }
    return state;
  }

  /** Current in-memory state (plain data; callers must not mutate it). */
  function get() {
    return state;
  }

  /** Merge a patch into the state and persist atomically. */
  function update(patch) {
    state = { ...state, ...patch };
    return persist();
  }

  /** Replace the whole state and persist atomically. */
  function replace(next) {
    state = normalizeState(next);
    return persist();
  }

  /** Serialized atomic write; failures never poison the chain. */
  function persist() {
    const snapshot = JSON.stringify(state, null, 2);
    writeChain = writeChain
      .then(async () => {
        await mkdir(dir, { recursive: true });
        const tmp = join(dir, `.state.${process.pid}.${Date.now()}.tmp`);
        await writeFile(tmp, snapshot, 'utf8');
        await rename(tmp, file);
      })
      .catch((error) => {
        logger.error?.(`mcp-skill-manager: state write failed (${file}): ${String(error)}`);
      });
    return writeChain;
  }

  return { load, loadSync, get, update, replace, persist, dir, file };
}
