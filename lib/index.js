/**
 * dsh-mcp-skill-manager — host half.
 *
 * A bundle plugin (installed via `dsh plugin --profile <p> add <path>`; the
 * cordis.patch.yml row mounts it into the host composition). It provides:
 *
 *  1. State model & persistence — a plugin-owned state file
 *     (`<harness home>/mcp-skill-manager/state.json`, atomic write; the
 *     directory is removed together with the plugin via the package's
 *     `postuninstall` script). State: skill groups (id/name/enabled/skills)
 *     and MCP server entries (serverName/transport/command|url/enabled/
 *     addedByUser).
 *  2. Skill-catalog filtering — a per-agent shadow skill provider
 *     (`skill-manager-filter`) registered on `agent.ctx` at `agent/created`.
 *     Its list() returns the FULL global catalog with the invocation of
 *     skills outside the enabled-group union rewritten to
 *     { modelInvocable: false, userInvocable: false }; the registry merges by
 *     skill name with the nearest layer winning, so disabled skills are
 *     removed from the model catalog and the `skill` tool refuses them.
 *  3. MCP enumeration & toggling — profile servers are enumerated from
 *     loader entries and disabled via per-agent `tools.restrict({ deny })`
 *     (exact live names only, re-applied on tools/change); user-added
 *     servers are dynamically mounted/unmounted via `ctx.plugin` with the
 *     real `@deepseek-ai/dsh-mcp-client` plugin.
 *  4. The 12 `manager_*` tools in the shared tools registry.
 *  5. The RPC surface for the browser half. NOTE: `harness.handle`/`host.call`
 *     exist only for sandboxed dynamic plugins; a bundle plugin exposes JSON
 *     methods over the web server instead. The same method names from the
 *     plan are served as a single POST route
 *     `/plugins/dsh-mcp-skill-manager/rpc` with body { method, args } →
 *     { ok, value } | { ok: false, error }.
 *
 * Lifecycle: every side effect is fiber-scoped or explicitly disposed
 * (store writes, tools.register, skills.registerProvider, webServer
 * routes, ctx.on listeners, ctx.plugin fibers, restrict disposers). No live
 * data is ever serialized: only scalar fields are extracted into fresh JSON.
 */
import { randomUUID } from 'node:crypto';
import {
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
} from './state.js';
import { createStateStore } from './store.js';

export const name = 'mcp-skill-manager';
export const inject = ['skills', 'tools', 'agents', 'loader'];

/** Unique shadow provider name; the registry merges by skill name, not provider name. */
const SHADOW_PROVIDER_NAME = 'skill-manager-filter';
/** Loader entry name of the MCP client plugin. */
const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client';
/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'];
/** Base path of the browser-half RPC route. */
const RPC_PATH = '/plugins/dsh-skills-mcp-group-manager/rpc';
/** Max RPC request body bytes. */
const MAX_RPC_BODY_BYTES = 64 * 1024;

/**
 * Host half plugin.
 * @param ctx - plugin context (injects skills/tools/agents/loader).
 * @param config - unused today; reserved for future composition options.
 *
 * MUST stay synchronous: Cordis treats a prototype-bearing function as a
 * constructor and ignores its returned promise, so an async apply would
 * turn any post-await throw into an unhandled rejection that crashes the
 * whole dsh process (observed as the service crash-restart "flicker").
 */
export function apply(ctx, config = {}) {
  // ── 1) state model & persistence ─────────────────────────────────────────
  // Plugin-owned state file (NOT settings.yaml): `<harness home>/
  // mcp-skill-manager/state.json`, removed on uninstall via postuninstall.
  const store = createStateStore({ dshHome: process.env.DSH_HOME, logger: ctx.logger });
  store.loadSync();

  // Per-apply runtime bookkeeping (all plain data, no live objects).
  /** agent.id -> { control, dispose } of the shadow provider registration. */
  const shadowControls = new Map();
  /** agent.id -> disposer of the current tools.restrict({ deny }) layer. */
  const restrictDisposers = new Map();
  /** serverName -> mounted ctx.plugin fiber (user-added servers only). */
  const mountedMcp = new Map();
  /** Serializes read-modify-write cycles so concurrent calls never interleave. */
  let writeChain = Promise.resolve();

  // ── 2) skill-catalog filtering ──────────────────────────────────────────
  function applyAgentFilter(agent) {
    if (shadowControls.has(agent.id)) return;
    // IMPORTANT: use agent.ctx.get('skills') — NOT agent.ctx.skills. In the
    // running process the agent ctx's inject map lacks 'skills', so the
    // property access throws the Cordis Guard error ("cannot get property
    // skills without inject") and crashes the plugin tree at boot when
    // sessions are restored; get() resolves the service directly.
    const skills = agent.ctx.get('skills');
    if (skills === undefined) return;
    let controlRef;
    const dispose = skills.registerProvider((control) => {
      controlRef = control; // factory runs synchronously; captured for invalidate()
      return {
        name: SHADOW_PROVIDER_NAME,
        async list(options) {
          // No scope = the global layer alone (never recurses into this agent
          // layer). The full catalog is returned; disabled skills get a
          // double-false invocation so dsh-tool-skill's isModelInvocable filter
          // drops them and the `skill` tool refuses to load them.
          const all = await ctx.skills.list({ cwd: options.cwd, signal: options.signal });
          const enabled = enabledSkillNames(store.get());
          return all.map((skill) => ({
            name: skill.name,
            description: skill.description,
            ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
            invocation: enabled.has(skill.name)
              ? skill.invocation
              : { modelInvocable: false, userInvocable: false },
            source: skill.source,
            provider: SHADOW_PROVIDER_NAME, // must equal this provider's name
            ...(skill.resourceBase !== undefined ? { resourceBase: skill.resourceBase } : {}),
            rank: 0, // sole provider in this layer
            locator: skill.name, // opaque handle, passed back to get()
          }));
        },
        async get(candidate, options) {
          // Delegate body loading to the global view (resolves to the real
          // filesystem provider's candidate).
          return ctx.skills.get(candidate.name, { cwd: options.cwd, signal: options.signal });
        },
      };
    });
    shadowControls.set(agent.id, { control: controlRef, dispose });
  }

  function refreshSkillCatalogs() {
    for (const { control } of shadowControls.values()) control.invalidate();
  }

  // ── 3) MCP restrict (profile servers) ────────────────────────────────────
  // IMPORTANT: applying a restriction emits `tools/change`, and our
  // `tools/change` listener re-runs this function. Unconditionally swapping
  // the restriction layer would therefore loop forever (restrict → change →
  // restrict → …) and churn the tool registry, which flickered the whole UI.
  // We only swap when the deny set actually changed.
  function applyMcpRestrictions(agent) {
    const deny = denyNamesForDisabled(store.get(), ctx.tools.schemas());
    const current = restrictDisposers.get(agent.id);
    if (current !== undefined && current.deny.join('\u0000') === deny.join('\u0000')) {
      return; // unchanged — do not touch the registry, do not emit tools/change
    }
    if (current !== undefined) {
      current.disposer();
      restrictDisposers.delete(agent.id);
    }
    if (deny.length === 0) return;
    const tools = agent.ctx.get('tools');
    if (tools === undefined) return;
    const disposer = tools.restrict({ deny });
    restrictDisposers.set(agent.id, { deny, disposer });
  }

  function applyMcpRestrictionsToAll() {
    for (const agent of ctx.agents.list()) applyMcpRestrictions(agent);
  }

  // ── 4) MCP dynamic mount (user-added servers) ───────────────────────────
  // User-added servers are mounted as loader entries named
  // '@deepseek-ai/dsh-mcp-client' (resolved from the global dsh install,
  // exactly like profile-configured rows) — the host half never imports the
  // mcp-client package, keeping `dsh plugin add` a single-command install.
  const MCP_ENTRY_PREFIX = 'msm-mcp-';

  function profileServerConfig(serverName) {
    for (const entry of ctx.loader.entries()) {
      if (entry.options.name !== MCP_PLUGIN_NAME) continue;
      if (String(entry.options.id ?? '').startsWith(MCP_ENTRY_PREFIX)) continue; // our own dynamic mounts
      if (entry.options.config?.serverName === serverName) return entry.options.config;
    }
    return undefined;
  }

  function isProfileServer(serverName) {
    return profileServerConfig(serverName) !== undefined;
  }

  async function mountMcpServer(server) {
    if (mountedMcp.has(server.serverName)) return;
    if (isProfileServer(server.serverName)) {
      ctx.logger.warn(`mcp-skill-manager: "${server.serverName}" is already a profile-configured server; not mounting a duplicate`);
      return;
    }
    const entryId = `${MCP_ENTRY_PREFIX}${server.serverName}`;
    try {
      await ctx.loader.create({ id: entryId, name: MCP_PLUGIN_NAME, config: mcpClientConfig(server) });
      mountedMcp.set(server.serverName, entryId);
    } catch (error) {
      // failOnStartupError: false keeps a failed connection from killing the
      // entry; contain any setup rejection (e.g. duplicate serverName) so the
      // manager keeps working and the error is visible in logs.
      ctx.logger.warn(`mcp-skill-manager: mount of "${server.serverName}" failed: ${String(error)}`);
    }
  }

  async function unmountMcpServer(serverName) {
    const entryId = mountedMcp.get(serverName);
    if (entryId === undefined) return;
    mountedMcp.delete(serverName);
    try {
      await ctx.loader.remove(entryId);
    } catch (error) {
      ctx.logger.warn(`mcp-skill-manager: unmount of "${serverName}" failed: ${String(error)}`);
    }
  }

  async function syncUserMcpMounts() {
    const state = store.get();
    for (const server of state.mcp) {
      if (!server.addedByUser) continue;
      if (server.enabled) await mountMcpServer(server);
      else await unmountMcpServer(server.serverName);
    }
  }

  // ── 5) shared business logic (tools + RPC) ───────────────────────────────
  /** Serialize one read-modify-write cycle; failures never poison the chain. */
  function withWriteLock(task) {
    const run = writeChain.then(task, task);
    writeChain = run.catch(() => {});
    return run;
  }

  /** Re-apply every dynamic effect after a state change. */
  function applyStateEffects() {
    refreshSkillCatalogs();
    applyMcpRestrictionsToAll();
  }

  function requireGroup(state, id) {
    const group = groupById(state, id);
    if (group === undefined) throw new Error(`group "${id}" does not exist`);
    return group;
  }

  function requireUserServer(state, serverName) {
    const server = mcpServerByName(state, serverName);
    if (server === undefined) throw new Error(`MCP server "${serverName}" is not managed by this plugin`);
    if (!server.addedByUser) throw new Error(`MCP server "${serverName}" is profile-configured and cannot be removed`);
    return server;
  }

  const api = {
    async stateGet() {
      return snapshotState(store.get());
    },
    async skillsList() {
      const all = await ctx.skills.list();
      return {
        skills: all.map((skill) => ({
          name: skill.name,
          description: skill.description,
          invocation: {
            modelInvocable: skill.invocation.modelInvocable,
            userInvocable: skill.invocation.userInvocable,
          },
        })),
      };
    },
    async groupsCreate(args) {
      const nameArg = typeof args?.name === 'string' ? args.name.trim() : '';
      if (nameArg.length === 0) throw new Error('group name must be a non-empty string');
      const id = randomUUID();
      await withWriteLock(async () => {
        const state = store.get();
        await store.update({ groups: [...state.groups, { id, name: nameArg, enabled: true, skills: [] }] });
        applyStateEffects();
      });
      return { id };
    },
    async groupsRename(args) {
      const { id } = args ?? {};
      const nameArg = typeof args?.name === 'string' ? args.name.trim() : '';
      if (typeof id !== 'string' || nameArg.length === 0) throw new Error('rename requires { id, name }');
      await withWriteLock(async () => {
        const state = store.get();
        requireGroup(state, id);
        await store.update({
          groups: state.groups.map((group) => (group.id === id ? { ...group, name: nameArg } : group)),
        });
        applyStateEffects();
      });
      return {};
    },
    async groupsDelete(args) {
      const { id } = args ?? {};
      if (typeof id !== 'string') throw new Error('delete requires { id }');
      await withWriteLock(async () => {
        const state = store.get();
        requireGroup(state, id);
        await store.update({ groups: state.groups.filter((group) => group.id !== id) });
        applyStateEffects();
      });
      return {};
    },
    async groupsSetEnabled(args) {
      const { id, enabled } = args ?? {};
      if (typeof id !== 'string' || typeof enabled !== 'boolean') throw new Error('setEnabled requires { id, enabled: boolean }');
      await withWriteLock(async () => {
        const state = store.get();
        requireGroup(state, id);
        await store.update({
          groups: state.groups.map((group) => (group.id === id ? { ...group, enabled } : group)),
        });
        applyStateEffects();
      });
      return {};
    },
    async groupsAddSkill(args) {
      const { id } = args ?? {};
      const names = Array.isArray(args?.skills)
        ? args.skills.filter((s) => typeof s === 'string' && s.length > 0)
        : typeof args?.skill === 'string' && args.skill.length > 0
          ? [args.skill]
          : [];
      if (typeof id !== 'string' || names.length === 0) {
        throw new Error('addSkill requires { id, skill } or { id, skills: [...] }');
      }
      // Batch: ONE write + ONE catalog invalidation for N names (the client
      // used to send one RPC per skill, which was slow over HTTP).
      await withWriteLock(async () => {
        const next = addSkillsToGroup(store.get(), id, names);
        if (next !== store.get()) {
          await store.update({ groups: next.groups });
          applyStateEffects();
        }
      });
      return {};
    },
    async groupsRemoveSkill(args) {
      const { id } = args ?? {};
      const names = Array.isArray(args?.skills)
        ? args.skills.filter((s) => typeof s === 'string' && s.length > 0)
        : typeof args?.skill === 'string' && args.skill.length > 0
          ? [args.skill]
          : [];
      if (typeof id !== 'string' || names.length === 0) {
        throw new Error('removeSkill requires { id, skill } or { id, skills: [...] }');
      }
      await withWriteLock(async () => {
        const next = removeSkillsFromGroup(store.get(), id, names);
        if (next !== store.get()) {
          await store.update({ groups: next.groups });
          applyStateEffects();
        }
      });
      return {};
    },
    async mcpList() {
      const schemas = ctx.tools.schemas();
      const state = store.get();
      const servers = [];
      const seen = new Set();
      for (const entry of ctx.loader.entries()) {
        if (entry.options.name !== MCP_PLUGIN_NAME) continue;
        if (String(entry.options.id ?? '').startsWith(MCP_ENTRY_PREFIX)) continue; // our own dynamic mounts
        const serverName = entry.options.config?.serverName;
        if (typeof serverName !== 'string') continue;
        seen.add(serverName);
        const stateEntry = mcpServerByName(state, serverName);
        servers.push({
          serverName,
          source: 'profile',
          enabled: stateEntry === undefined ? true : stateEntry.enabled,
          toolCount: toolsOfServer(schemas, serverName).length,
          live: entry.fiber !== undefined && !entry.disabled,
        });
      }
      for (const server of state.mcp) {
        if (!server.addedByUser || seen.has(server.serverName)) continue;
        seen.add(server.serverName);
        servers.push({
          serverName: server.serverName,
          source: 'user',
          enabled: server.enabled,
          toolCount: toolsOfServer(schemas, server.serverName).length,
          live: mountedMcp.has(server.serverName),
        });
      }
      return { servers };
    },
    async mcpToggle(args) {
      const { serverName, enabled } = args ?? {};
      if (typeof serverName !== 'string' || typeof enabled !== 'boolean') {
        throw new Error('toggle requires { serverName, enabled: boolean }');
      }
      await withWriteLock(async () => {
        const state = store.get();
        const server = mcpServerByName(state, serverName);
        if (server === undefined) {
          const profileCfg = profileServerConfig(serverName);
          if (profileCfg === undefined) throw new Error(`MCP server "${serverName}" is not known`);
          // Profile server without a state entry: create one (transport from
          // the loader config) so the flag persists across sessions.
          await store.update({
            mcp: [...state.mcp, {
              serverName,
              transport: profileCfg.transport,
              ...(profileCfg.command !== undefined ? { command: profileCfg.command } : {}),
              ...(profileCfg.url !== undefined ? { url: profileCfg.url } : {}),
              enabled,
              addedByUser: false,
            }],
          });
        } else {
          await store.update({
            mcp: state.mcp.map((m) => (m.serverName === serverName ? { ...m, enabled } : m)),
          });
        }
        if (server !== undefined && server.addedByUser) {
          if (enabled) await mountMcpServer({ ...server, enabled });
          else await unmountMcpServer(serverName);
        }
        applyStateEffects();
      });
      return {};
    },
    async mcpAdd(args) {
      const input = validateMcpServerInput(args ?? {});
      await withWriteLock(async () => {
        const state = store.get();
        if (mcpServerByName(state, input.serverName) !== undefined) {
          throw new Error(`MCP server "${input.serverName}" is already managed`);
        }
        if (isProfileServer(input.serverName)) {
          throw new Error(`MCP server "${input.serverName}" is already configured in the profile`);
        }
        const server = { ...input, enabled: true, addedByUser: true };
        await store.update({ mcp: [...state.mcp, server] });
        await mountMcpServer(server);
        applyStateEffects();
      });
      return {};
    },
    async mcpRemove(args) {
      const { serverName } = args ?? {};
      if (typeof serverName !== 'string') throw new Error('remove requires { serverName }');
      await withWriteLock(async () => {
        const state = store.get();
        requireUserServer(state, serverName);
        await unmountMcpServer(serverName);
        await store.update({ mcp: state.mcp.filter((m) => m.serverName !== serverName) });
        applyStateEffects();
      });
      return {};
    },
  };

  // ── 6) manager_* tools (shared registry) ────────────────────────────────
  // The host half must stay free of external package imports so that
  // `dsh plugin add` alone works (Node resolves the plugin's imports from
  // the linked source directory, which has no node_modules). The compact
  // parameter/value specs below are converted to raw JSON schema locally.
  /** Convert the compact parameter spec to a raw JSON-schema object root. */
  function parameterSchema(spec) {
    const properties = {};
    const required = [];
    for (const [name, field] of Object.entries(spec ?? {})) {
      const { required: isRequired, ...rest } = field;
      properties[name] = rest;
      if (isRequired) required.push(name);
    }
    return {
      type: 'object',
      additionalProperties: false,
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  /** Convert a compact value spec (required flags inside properties) to raw JSON schema. */
  function valueSchema(spec) {
    if (spec === undefined) return undefined;
    const convert = (node) => {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) return node;
      const out = {};
      const required = [];
      for (const [key, value] of Object.entries(node)) {
        if (key === 'required' && value === true) continue; // hoisted to this level
        if (key === 'properties' && typeof value === 'object') {
          out.properties = {};
          for (const [pname, pnode] of Object.entries(value)) {
            if (pnode !== null && typeof pnode === 'object' && pnode.required === true) {
              required.push(pname);
              const { required: _drop, ...rest } = pnode;
              out.properties[pname] = convert(rest);
            } else {
              out.properties[pname] = convert(pnode);
            }
          }
        } else if (key === 'items' && typeof value === 'object') {
          out.items = convert(value);
        } else {
          out[key] = value;
        }
      }
      if (required.length > 0) out.required = required;
      return out;
    };
    return convert(spec);
  }

  const toolDisposers = [];
  const tool = (definition) => {
    toolDisposers.push(ctx.tools.register({
      ...definition,
      parameters: parameterSchema(definition.parameters),
      ...(definition.output !== undefined
        ? { output: { ...definition.output, schema: valueSchema(definition.output.schema) } }
        : {}),
    }));
  };

  tool({
    name: 'manager_groups_list',
    description: 'List every skill group with its enabled flag and member skill names.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groups: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                enabled: { type: 'boolean', required: true },
                skills: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      return api.stateGet();
    },
  });

  tool({
    name: 'manager_groups_create',
    description: 'Create a new skill group (enabled by default, empty member list). Returns the stable group id.',
    parameters: {
      name: { type: 'string', required: true, description: 'Display name of the new group.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', required: true } },
      },
      render: (args, value) => [{ type: 'text', text: `Group "${args.name}" created (id ${value.id}).` }],
    },
    async execute(args) {
      return api.groupsCreate(args);
    },
  });

  tool({
    name: 'manager_groups_delete',
    description: 'Delete a skill group by id. Its skills are not removed from other groups.',
    parameters: {
      id: { type: 'string', required: true, description: 'Stable group id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      render: (args) => [{ type: 'text', text: `Group ${args.id} deleted.` }],
    },
    async execute(args) {
      return api.groupsDelete(args);
    },
  });

  tool({
    name: 'manager_groups_rename',
    description: 'Rename a skill group by id.',
    parameters: {
      id: { type: 'string', required: true, description: 'Stable group id.' },
      name: { type: 'string', required: true, description: 'New display name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      render: (args) => [{ type: 'text', text: `Group ${args.id} renamed to "${args.name}".` }],
    },
    async execute(args) {
      return api.groupsRename(args);
    },
  });

  tool({
    name: 'manager_groups_set_enabled',
    description: 'Enable or disable a skill group. Disabling removes its skills from the injected catalog; enabling re-injects them (union-deduped across enabled groups).',
    parameters: {
      id: { type: 'string', required: true, description: 'Stable group id.' },
      enabled: { type: 'boolean', required: true, description: 'New enabled state.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      render: (args) => [{ type: 'text', text: `Group ${args.id} ${args.enabled ? 'enabled' : 'disabled'}.` }],
    },
    async execute(args) {
      return api.groupsSetEnabled(args);
    },
  });

  tool({
    name: 'manager_groups_add_skill',
    description: 'Add a skill name to a group. The same skill may exist in several groups; injection dedups by union.',
    parameters: {
      id: { type: 'string', required: true, description: 'Stable group id.' },
      skill: { type: 'string', required: true, description: 'Skill name (kebab-case) to add.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      render: (args) => [{ type: 'text', text: `Skill "${args.skill}" added to group ${args.id}.` }],
    },
    async execute(args) {
      return api.groupsAddSkill(args);
    },
  });

  tool({
    name: 'manager_groups_remove_skill',
    description: 'Remove a skill name from a group.',
    parameters: {
      id: { type: 'string', required: true, description: 'Stable group id.' },
      skill: { type: 'string', required: true, description: 'Skill name to remove.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      render: (args) => [{ type: 'text', text: `Skill "${args.skill}" removed from group ${args.id}.` }],
    },
    async execute(args) {
      return api.groupsRemoveSkill(args);
    },
  });

  tool({
    name: 'manager_skills_list',
    description: 'List every skill currently available in the global catalog (name, description, invocation policy) for picking group members.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skills: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                invocation: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    modelInvocable: { type: 'boolean', required: true },
                    userInvocable: { type: 'boolean', required: true },
                  },
                },
              },
            },
          },
        },
      },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      return api.skillsList();
    },
  });

  tool({
    name: 'manager_mcp_list',
    description: 'List every MCP server (profile-configured and user-added) with source, enabled flag, live tool count, and activation state.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          servers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                serverName: { type: 'string', required: true },
                source: { type: 'string', required: true },
                enabled: { type: 'boolean', required: true },
                toolCount: { type: 'number', required: true },
                live: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      return api.mcpList();
    },
  });

  tool({
    name: 'manager_mcp_toggle',
    description: 'Enable or disable an MCP server. Profile-configured servers are restricted per agent (tools removed from the catalog); user-added servers are dynamically mounted/unmounted.',
    parameters: {
      serverName: { type: 'string', required: true, description: 'MCP server name.' },
      enabled: { type: 'boolean', required: true, description: 'New enabled state.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      render: (args) => [{ type: 'text', text: `MCP server "${args.serverName}" ${args.enabled ? 'enabled' : 'disabled'}.` }],
    },
    async execute(args) {
      return api.mcpToggle(args);
    },
  });

  tool({
    name: 'manager_mcp_add',
    description: 'Add a new user-managed MCP server (persisted and mounted immediately). stdio needs command/args/env; streamable-http needs url.',
    parameters: {
      serverName: { type: 'string', required: true, description: 'Unique server name (^[A-Za-z0-9_-]{1,32}$).' },
      transport: { type: 'string', required: true, description: '"stdio" or "streamable-http".' },
      command: { type: 'string', description: 'stdio: executable command.' },
      args: { type: 'array', items: { type: 'string' }, description: 'stdio: command arguments.' },
      env: { type: 'object', additionalProperties: true, description: 'stdio: environment overrides (string values).' },
      url: { type: 'string', description: 'streamable-http: endpoint URL.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      render: (args) => [{ type: 'text', text: `MCP server "${args.serverName}" added.` }],
    },
    async execute(args) {
      return api.mcpAdd(args);
    },
  });

  tool({
    name: 'manager_mcp_remove',
    description: 'Remove a user-added MCP server (unmounts it and deletes its persisted entry). Profile-configured servers cannot be removed.',
    parameters: {
      serverName: { type: 'string', required: true, description: 'MCP server name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      render: (args) => [{ type: 'text', text: `MCP server "${args.serverName}" removed.` }],
    },
    async execute(args) {
      return api.mcpRemove(args);
    },
  });

  // ── 7) RPC surface for the browser half ─────────────────────────────────
  // Bundle plugins have no `harness.handle`/`host.call` (those exist only for
  // sandboxed dynamic plugins); the browser half calls the same business
  // logic over one JSON POST route. Method names match the plan exactly.
  const rpcMethods = {
    'manager.state.get': async () => api.stateGet(),
    'manager.skills.list': async () => api.skillsList(),
    'manager.groups.create': async (args) => api.groupsCreate(args),
    'manager.groups.rename': async (args) => api.groupsRename(args),
    'manager.groups.delete': async (args) => api.groupsDelete(args),
    'manager.groups.setEnabled': async (args) => api.groupsSetEnabled(args),
    'manager.groups.addSkill': async (args) => api.groupsAddSkill(args),
    'manager.groups.removeSkill': async (args) => api.groupsRemoveSkill(args),
    'manager.mcp.list': async () => api.mcpList(),
    'manager.mcp.toggle': async (args) => api.mcpToggle(args),
    'manager.mcp.add': async (args) => api.mcpAdd(args),
    'manager.mcp.remove': async (args) => api.mcpRemove(args),
  };

  async function readJsonBody(req) {
    const chunks = [];
    let received = 0;
    for await (const chunk of req) {
      received += chunk.byteLength;
      if (received > MAX_RPC_BODY_BYTES) throw new Error('request body too large');
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    const text = Buffer.concat(chunks).toString('utf8');
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('request body must be a JSON object');
    }
    return parsed;
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  let webRegistered = false;
  const registerWebSurface = () => {
    if (webRegistered) return;
    const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]);
    if (webServer === undefined) return;
    webRegistered = true;
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: RPC_PATH,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const method = body.method;
          const handler = typeof method === 'string' ? rpcMethods[method] : undefined;
          if (handler === undefined) {
            sendJson(res, 400, { ok: false, error: `unknown method ${JSON.stringify(method)}` });
            return;
          }
          const value = await handler(body.args ?? {});
          sendJson(res, 200, { ok: true, value });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    }), 'mcp-skill-manager: rpc route');
  };
  registerWebSurface();
  ctx.on('internal/service', (serviceName) => {
    if (WEB_SERVER_KEYS.includes(serviceName)) registerWebSurface();
  });

  // ── 8) apply to live agents + lifecycle wiring ──────────────────────────
  // Shadow providers and restrict layers are registered on AGENT fibers (they
  // must live as long as the agent), so they are NOT auto-disposed with this
  // plugin fiber. On plugin unload/reload (HMR) dispose them explicitly —
  // otherwise a reload would hit duplicate provider names in the agent layer.
  ctx.effect(() => () => {
    for (const dispose of toolDisposers) dispose();
    toolDisposers.length = 0;
    for (const { dispose } of shadowControls.values()) dispose();
    shadowControls.clear();
    for (const { disposer } of restrictDisposers.values()) disposer();
    restrictDisposers.clear();
    // User-added MCP mounts are loader entries; remove them explicitly on
    // unload so they do not outlive this plugin fiber.
    for (const entryId of mountedMcp.values()) {
      void ctx.loader.remove(entryId).catch(() => {});
    }
    mountedMcp.clear();
  }, 'mcp-skill-manager: agent-layer cleanup');

  for (const agent of ctx.agents.list()) {
    applyAgentFilter(agent);
    applyMcpRestrictions(agent);
  }

  ctx.on('agent/created', ({ agent }) => {
    applyAgentFilter(agent);
    applyMcpRestrictions(agent);
  });

  ctx.on('agent/disposed', ({ agent }) => {
    shadowControls.delete(agent.id);
    restrictDisposers.delete(agent.id);
  });

  // New tools appear (server reconnects, mounts settle): retry restrict so
  // disabled servers' tools are denied as soon as they register. The
  // compare-before-apply guard in applyMcpRestrictions keeps this from
  // looping (restrict emits tools/change).
  ctx.on('tools/change', () => {
    applyMcpRestrictionsToAll();
  });

  // Startup: mount every enabled user-added server (persisted state carries
  // over sessions). Contained — a failing mount never blocks boot.
  void syncUserMcpMounts().catch((error) => {
    ctx.logger.warn(`mcp-skill-manager: initial MCP mount pass failed: ${String(error)}`);
  });
}
