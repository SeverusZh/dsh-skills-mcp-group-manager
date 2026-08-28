/**
 * Pure state logic for the dsh-mcp-skill-manager host half.
 *
 * Deliberately dependency-free (no Cordis, no schemastery): every function
 * here is unit-testable with plain `node --test` and is the single source of
 * truth for the state semantics shared by the manager_* tools, the RPC
 * surface, the skill-catalog shadow provider, and the MCP restrict/mount
 * logic in lib/index.js.
 *
 * All functions operate on plain JSON-shaped state objects:
 *   state = { groups: [{ id, name, enabled, skills: string[] }],
 *             mcp: [{ serverName, transport, command?, args?, env?, url?,
 *                    enabled, addedByUser }] }
 */

/** Same domain as dsh-mcp-client's SERVER_NAME_PATTERN. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Validate a serverName against the dsh-mcp-client domain. */
export function isValidServerName(name) {
  return typeof name === 'string' && SERVER_NAME_PATTERN.test(name);
}

/**
 * The injected skill set: the union of skill names across all enabled groups.
 * A skill listed in several enabled groups appears exactly once (Set dedup);
 * disabled groups contribute nothing.
 * @param state - the resolved manager state.
 * @returns a Set of skill names to keep model/user invocable.
 */
export function enabledSkillNames(state) {
  const set = new Set();
  for (const group of state.groups) {
    if (!group.enabled) continue;
    for (const skill of group.skills) set.add(skill);
  }
  return set;
}

/** Find one group by stable id; undefined when absent. */
export function groupById(state, id) {
  return state.groups.find((group) => group.id === id);
}

/** Find one MCP server entry by serverName; undefined when absent. */
export function mcpServerByName(state, serverName) {
  return state.mcp.find((server) => server.serverName === serverName);
}

/**
 * Live tool names of one MCP server: `mcp__<serverName>__<tool>`.
 * @param schemas - `ctx.tools.schemas()` result (array of { name, ... }).
 * @param serverName - the MCP server namespace.
 * @returns exact live tool names owned by that server.
 */
export function toolsOfServer(schemas, serverName) {
  const prefix = `mcp__${serverName}__`;
  return schemas.filter((tool) => tool.name.startsWith(prefix)).map((tool) => tool.name);
}

/**
 * Exact deny list for every disabled server against the live tool surface.
 * Only names that are currently registered are returned: `tools.restrict`
 * throws on unknown names, so callers must never deny a name that is not
 * live (offline servers with zero tools are skipped here).
 * @param state - the resolved manager state.
 * @param schemas - `ctx.tools.schemas()` result.
 * @returns exact live tool names to deny.
 */
export function denyNamesForDisabled(state, schemas) {
  const disabled = state.mcp.filter((server) => !server.enabled).map((server) => server.serverName);
  if (disabled.length === 0) return [];
  const live = schemas.map((tool) => tool.name).filter((name) => name.startsWith('mcp__'));
  const deny = [];
  for (const server of disabled) {
    const prefix = `mcp__${server}__`;
    for (const name of live) if (name.startsWith(prefix)) deny.push(name);
  }
  return deny;
}

/**
 * Build the dsh-mcp-client plugin config for one user server entry.
 * @param server - a state.mcp entry (transport stdio or streamable-http).
 * @returns a lossless-JSON config object accepted by dsh-mcp-client's Config.
 */
export function mcpClientConfig(server) {
  if (server.transport === 'stdio') {
    return {
      serverName: server.serverName,
      transport: 'stdio',
      command: server.command,
      args: server.args ?? [],
      env: server.env ?? {},
      toolCallTimeoutMs: 60000,
      failOnStartupError: false,
    };
  }
  return {
    serverName: server.serverName,
    transport: 'streamable-http',
    url: server.url,
    headers: {},
    toolCallTimeoutMs: 60000,
    failOnStartupError: false,
  };
}

/**
 * Validate a user-supplied MCP server descriptor (tool/RPC `manager_mcp_add`
 * input). Throws an Error with a user-facing message on any violation.
 * @param input - raw args object.
 * @returns a normalized plain object with only the fields the state stores.
 */
export function validateMcpServerInput(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('mcp server input must be an object');
  }
  const { serverName, transport } = input;
  if (typeof serverName !== 'string' || !isValidServerName(serverName)) {
    throw new Error(`serverName must be a string matching ${SERVER_NAME_PATTERN.source}`);
  }
  if (transport !== 'stdio' && transport !== 'streamable-http') {
    throw new Error('transport must be "stdio" or "streamable-http"');
  }
  if (transport === 'stdio') {
    if (typeof input.command !== 'string' || input.command.length === 0) {
      throw new Error('stdio transport requires a non-empty command');
    }
  } else if (typeof input.url !== 'string' || input.url.length === 0) {
    throw new Error('streamable-http transport requires a non-empty url');
  }
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== 'string'))) {
    throw new Error('args must be an array of strings');
  }
  if (input.env !== undefined) {
    if (typeof input.env !== 'object' || input.env === null || Array.isArray(input.env)) {
      throw new Error('env must be an object of string values');
    }
    for (const [key, value] of Object.entries(input.env)) {
      if (typeof value !== 'string') throw new Error(`env.${key} must be a string`);
    }
  }
  return {
    serverName,
    transport,
    ...(transport === 'stdio'
      ? { command: input.command, args: input.args ?? [], env: input.env ?? {} }
      : { url: input.url }),
  };
}

/**
 * Fresh plain-JSON copy of the state (scalar fields only; never live data).
 * @param state - the resolved (frozen) manager state.
 * @returns an independent JSON-safe snapshot.
 */
export function snapshotState(state) {
  return {
    groups: state.groups.map((group) => ({
      id: group.id,
      name: group.name,
      enabled: group.enabled,
      skills: [...group.skills],
    })),
    mcp: state.mcp.map((server) => ({
      serverName: server.serverName,
      transport: server.transport,
      ...(server.command !== undefined ? { command: server.command } : {}),
      ...(server.args !== undefined ? { args: [...server.args] } : {}),
      ...(server.env !== undefined ? { env: { ...server.env } } : {}),
      ...(server.url !== undefined ? { url: server.url } : {}),
      enabled: server.enabled,
      addedByUser: server.addedByUser,
    })),
  };
}
