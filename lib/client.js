/**
 * dsh-mcp-skill-manager — client half (browser).
 *
 * A bundle-plugin client half: a classic script in the client-modules format
 * (`window.__ModuleLoader__.load({ id, factory })`). The factory is CJS-style
 * and may require only platform seed words (`react`, `react/jsx-runtime`,
 * `@deepseek-ai/dsh-client-ui-primitives`); everything else is self-contained.
 * The exports are the Cordis plugin face: `{ apply, inject }`.
 *
 * UI: a left-docked management panel registered in the additive `shell.overlay`
 * slot (root scope) plus a toggle button in `conversation.session.header.actions`
 * (session scope). The panel manages skill groups (create/rename/delete/enable,
 * add/remove member skills) and MCP servers (toggle/add/remove) by calling the
 * host RPC route `POST /plugins/dsh-mcp-skill-manager/rpc` (bundle plugins have
 * no `harness.handle`/`host.call`; the host serves the same business logic over
 * one JSON POST route with body { method, args } → { ok, value } | { ok: false,
 * error }).
 *
 * Interaction model: loading / empty / error states; optimistic local updates
 * with rollback on RPC failure; busy gating; localStorage remembers the open
 * state; the header button and the panel sync through a window event.
 *
 * Lifecycle: every side effect is fiber-scoped — locale dictionaries and the
 * stylesheet are installed through ctx.effect (disposed on unload), slot
 * registrations go through ctx.slots.inject/register (fiber-owned), and all
 * component effects (measurement, yield, storage, event listeners) return
 * cleanups. No live data is serialized: only plain JSON from the RPC route.
 */
window.__ModuleLoader__.load({
  id: 'dsh-skills-mcp-group-manager',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    let react = require('react');
    const h = react.createElement;

    // ── constants ──────────────────────────────────────────────────────────
    const PANEL_WIDTH = 320;
    const PANEL_DOCK_TOP = 64;
    const PANEL_DOCK_LEFT = 18;
    const PANEL_DOCK_BOTTOM = 48;
    const PANEL_GAP = 14;
    const PANEL_COMPACT_BREAKPOINT = 960;
    const STORAGE_KEY = 'dsh-mcp-skill-manager:panel:v1';
    const TOGGLE_EVENT = 'mcp-skill-manager:toggle-panel';
    const RPC_PATH = '/plugins/dsh-skills-mcp-group-manager/rpc';
    const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

    // ── dictionaries ────────────────────────────────────────────────────────
    const zh = {
      'panel.title': 'MCP 与 Skills 管理',
      'panel.aria': 'MCP 与 Skills 管理面板',
      'panel.collapse': '收起面板',
      'badge.aria': '打开 MCP 与 Skills 管理面板',
      'badge.title': 'MCP 与 Skills 管理',
      'badge.label': '管理',
      'toggle.aria': '切换 MCP 与 Skills 管理面板',
      'toggle.title': 'MCP 与 Skills 管理',
      'toggle.label': 'Skills&MCPs',
      'tab.groups': '分组',
      'tab.mcp': 'MCP',
      'state.loading': '加载中…',
      'state.retry': '重试',
      'group.create': '新建',
      'group.createPlaceholder': '新分组名称',
      'group.empty': '还没有分组。创建一个分组并加入 skill,即可控制注入到会话的 skill 目录。',
      'group.members': '{count} 个 skill',
      'group.rename': '重命名',
      'group.delete': '删除分组',
      'group.expand': '展开分组',
      'group.collapse': '收起分组',
      'group.selectAll': '全选',
      'group.deselectAll': '全不选',
      'group.removeSelected': '移除选中({count})',
      'group.selectAllFiltered': '全选',
      'group.deselectAllFiltered': '全不选',
      'group.addSelected': '添加选中({count})',
      'group.deleteConfirm': '确定删除该分组?其成员 skill 不会从其他分组移除。',
      'group.detailTitle': '分组:{name}',
      'group.membersLabel': '成员 skill',
      'group.memberSearchPlaceholder': '搜索成员…',
      'group.noMembers': '该分组还没有成员 skill。',
      'group.pickerLabel': '添加 skill',
      'group.searchPlaceholder': '搜索 skill…',
      'group.noMatch': '没有匹配的 skill。',
      'group.allAdded': '全部 skill 已加入该分组。',
      'group.addSkill': '将 {skill} 加入分组',
      'group.removeSkill': '从分组移除 {skill}',
      'mcp.empty': '没有 MCP 服务器。',
      'mcp.sourceUser': '用户',
      'mcp.sourceProfile': '配置',
      'mcp.tools': '{count} 个工具',
      'mcp.enable': '启用 {name}',
      'mcp.disable': '停用 {name}',
      'mcp.remove': '删除 {name}',
      'mcp.removeConfirm': '确定删除 MCP 服务器 {name}?',
      'mcp.addTitle': '新增 MCP 服务器',
      'mcp.formName': 'serverName(字母/数字/_/-)',
      'mcp.formCommand': '命令(如 npx)',
      'mcp.formArgs': '参数(空格分隔,可选)',
      'mcp.formUrl': 'URL(streamable-http)',
      'mcp.add': '新增',
      'mcp.formErrorName': 'serverName 需匹配 ^[A-Za-z0-9_-]{1,32}$',
      'mcp.formErrorCommand': 'stdio 传输需要非空命令',
      'mcp.formErrorUrl': 'streamable-http 传输需要非空 URL',
    };
    const en = {
      'panel.title': 'MCP & Skills manager',
      'panel.aria': 'MCP & Skills manager panel',
      'panel.collapse': 'Collapse panel',
      'badge.aria': 'Open the MCP & Skills manager panel',
      'badge.title': 'MCP & Skills manager',
      'badge.label': 'Manage',
      'toggle.aria': 'Toggle the MCP & Skills manager panel',
      'toggle.title': 'MCP & Skills manager',
      'toggle.label': 'Skills&MCPs',
      'tab.groups': 'Groups',
      'tab.mcp': 'MCP',
      'state.loading': 'Loading…',
      'state.retry': 'Retry',
      'group.create': 'Create',
      'group.createPlaceholder': 'New group name',
      'group.empty': 'No groups yet. Create a group and add skills to control which skills are injected into sessions.',
      'group.members': '{count} skills',
      'group.rename': 'Rename',
      'group.delete': 'Delete group',
      'group.expand': 'Expand group',
      'group.collapse': 'Collapse group',
      'group.selectAll': 'Select all',
      'group.deselectAll': 'Deselect all',
      'group.removeSelected': 'Remove selected ({count})',
      'group.selectAllFiltered': 'Select all',
      'group.deselectAllFiltered': 'Deselect all',
      'group.addSelected': 'Add selected ({count})',
      'group.deleteConfirm': 'Delete this group? Its member skills are not removed from other groups.',
      'group.detailTitle': 'Group: {name}',
      'group.membersLabel': 'Member skills',
      'group.memberSearchPlaceholder': 'Search members…',
      'group.noMembers': 'This group has no member skills yet.',
      'group.pickerLabel': 'Add skills',
      'group.searchPlaceholder': 'Search skills…',
      'group.noMatch': 'No matching skills.',
      'group.allAdded': 'All skills are already in this group.',
      'group.addSkill': 'Add {skill} to the group',
      'group.removeSkill': 'Remove {skill} from the group',
      'mcp.empty': 'No MCP servers.',
      'mcp.sourceUser': 'user',
      'mcp.sourceProfile': 'profile',
      'mcp.tools': '{count} tools',
      'mcp.enable': 'Enable {name}',
      'mcp.disable': 'Disable {name}',
      'mcp.remove': 'Remove {name}',
      'mcp.removeConfirm': 'Remove MCP server {name}?',
      'mcp.addTitle': 'Add MCP server',
      'mcp.formName': 'serverName (letters/digits/_/-)',
      'mcp.formCommand': 'Command (e.g. npx)',
      'mcp.formArgs': 'Args (space-separated, optional)',
      'mcp.formUrl': 'URL (streamable-http)',
      'mcp.add': 'Add',
      'mcp.formErrorName': 'serverName must match ^[A-Za-z0-9_-]{1,32}$',
      'mcp.formErrorCommand': 'stdio transport requires a non-empty command',
      'mcp.formErrorUrl': 'streamable-http transport requires a non-empty URL',
    };

    /** Fallback translator when the framework `t` prop is unavailable. */
    function dictFor() {
      const lang = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || 'en';
      return lang.toLowerCase().startsWith('zh') ? zh : en;
    }
    function makeT(t) {
      if (typeof t === 'function') return t;
      const dict = dictFor();
      return (key, params) => {
        let text = dict[key] ?? key;
        if (params !== undefined) {
          for (const [name, value] of Object.entries(params)) {
            text = text.split(`{${name}}`).join(String(value));
          }
        }
        return text;
      };
    }

    // ── RPC client ─────────────────────────────────────────────────────────
    async function rpc(method, args) {
      const res = await fetch(RPC_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, args: args ?? {} }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || `RPC ${method} failed`);
      return data.value;
    }
    function errorMessage(error) {
      return error instanceof Error ? error.message : String(error);
    }

    // ── icons (inline SVG, currentColor) ───────────────────────────────────
    function GearIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round', 'aria-hidden': true },
        h('circle', { cx: '8', cy: '8', r: '2.4' }),
        h('path', { d: 'M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4' }),
      );
    }
    function ChevronIcon({ size, direction }) {
      const paths = {
        left: 'M10 3L7 6l3 3',
        right: 'M6 3l3 3-3 3',
        down: 'M3 6l3 3 3-3',
        up: 'M3 9l3-3 3 3',
      };
      const d = paths[direction] ?? paths.down;
      return h('svg', { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d }),
      );
    }
    function PlusIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M6 2.5v7M2.5 6h7' }),
      );
    }
    function XIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M3 3l6 6M9 3l-6 6' }),
      );
    }
    function PencilIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M8.6 1.9l1.5 1.5L3.4 10H2V8.6L8.6 1.9Z' }),
        h('path', { d: 'M7.4 3.1l1.5 1.5' }),
      );
    }

    // ── geometry ───────────────────────────────────────────────────────────
    function initialBounds() {
      if (typeof window === 'undefined') return { width: 1440, height: 900, anchorLeft: 0 };
      return { width: window.innerWidth, height: window.innerHeight, anchorLeft: 0 };
    }
    function readStoredOpen() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) return false;
        const parsed = JSON.parse(raw);
        return parsed.open === true;
      } catch {
        return false;
      }
    }
    function resolveGeometry(bounds) {
      const compact = bounds.width <= PANEL_COMPACT_BREAKPOINT;
      if (compact) {
        return {
          x: 12,
          y: 12,
          width: Math.max(160, Math.min(PANEL_WIDTH, bounds.width - 24)),
          height: Math.max(120, bounds.height - 24),
          compact: true,
        };
      }
      const maxX = Math.max(12, bounds.width - PANEL_WIDTH - 12);
      const x = Math.min(Math.max(bounds.anchorLeft + PANEL_DOCK_LEFT, 12), maxX);
      return {
        x,
        y: PANEL_DOCK_TOP,
        width: PANEL_WIDTH,
        height: Math.max(120, bounds.height - PANEL_DOCK_TOP - PANEL_DOCK_BOTTOM),
        compact: false,
      };
    }

    // ── selection logic (pure; exported as __logic for unit tests) ─────────
    /** Candidates for the picker: not already members, matching the query. */
    function filterCandidates(skills, members, query) {
      const q = query.trim().toLowerCase();
      return skills.filter((skill) =>
        !members.includes(skill.name)
        && (q.length === 0
          || skill.name.toLowerCase().includes(q)
          || (skill.description ?? '').toLowerCase().includes(q)));
    }
    /** Filter a member name list by the query (name match only). */
    function filterMembers(members, query) {
      const q = query.trim().toLowerCase();
      if (q.length === 0) return members;
      return members.filter((name) => name.toLowerCase().includes(q));
    }
    /** Toggle one name in a Set (immutable). */
    function toggleInSet(set, name) {
      const next = new Set(set);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    }
    /** Select every filtered candidate (union with the current selection). */
    function selectAllFiltered(filtered, selected) {
      const next = new Set(selected);
      for (const skill of filtered) next.add(skill.name);
      return next;
    }
    /** Deselect every filtered candidate (keeps non-filtered selections). */
    function clearAllFiltered(filtered, selected) {
      const next = new Set(selected);
      for (const skill of filtered) next.delete(skill.name);
      return next;
    }
    /** Select all members when not all are selected; clear them when all are. */
    function toggleAllMembers(members, selected) {
      const allSelected = members.length > 0 && members.every((name) => selected.has(name));
      const next = new Set(selected);
      if (allSelected) {
        for (const name of members) next.delete(name);
      } else {
        for (const name of members) next.add(name);
      }
      return next;
    }
    /** Append the selected names to the member list, deduped. */
    function addSelectedToGroup(members, selected) {
      const next = [...members];
      for (const name of selected) if (!next.includes(name)) next.push(name);
      return next;
    }
    /** Remove exactly the selected names from the member list. */
    function removeSelectedFromGroup(members, selected) {
      return members.filter((name) => !selected.has(name));
    }

    // ── group card ─────────────────────────────────────────────────────────
    function GroupCard({ t, group, skills, busy, onDelete, onRename, onSetEnabled, onAddSkills, onRemoveSkills }) {
      const [editing, setEditing] = react.useState(false);
      const [draft, setDraft] = react.useState(group.name);
      const [expanded, setExpanded] = react.useState(false);
      const commit = () => {
        const name = draft.trim();
        if (name.length > 0 && name !== group.name) onRename(name);
        setEditing(false);
      };
      return h('div', { className: 'msm-group', 'data-expanded': expanded || undefined },
        h('div', { className: 'msm-group-row' },
          h('button', {
            type: 'button',
            className: 'msm-group-caret',
            onClick: () => setExpanded((current) => !current),
            'aria-label': expanded ? t('group.collapse') : t('group.expand'),
            title: expanded ? t('group.collapse') : t('group.expand'),
          }, h(ChevronIcon, { size: 12, direction: expanded ? 'down' : 'right' })),
          h('input', {
            type: 'checkbox',
            className: 'msm-group-check',
            checked: group.enabled,
            disabled: busy,
            onChange: (event) => onSetEnabled(event.target.checked),
            'aria-label': t('group.members', { count: group.skills.length }),
          }),
          editing
            ? h('input', {
                className: 'msm-input msm-group-edit',
                value: draft,
                autoFocus: true,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') commit();
                  if (event.key === 'Escape') setEditing(false);
                },
                onBlur: commit,
              })
            : h('span', {
                className: 'msm-group-name',
                onClick: () => setExpanded((current) => !current),
                onDoubleClick: () => { setDraft(group.name); setEditing(true); },
                title: group.name,
              }, group.name),
          h('span', { className: 'msm-group-count' }, t('group.members', { count: group.skills.length })),
          h('div', { className: 'msm-group-actions' },
            h('button', {
              type: 'button',
              className: 'msm-icon-button',
              onClick: () => { setDraft(group.name); setEditing(true); },
              'aria-label': t('group.rename'),
              title: t('group.rename'),
              disabled: busy,
            }, h(PencilIcon, { size: 12 })),
            h('button', {
              type: 'button',
              className: 'msm-icon-button msm-danger',
              onClick: onDelete,
              'aria-label': t('group.delete'),
              title: t('group.delete'),
              disabled: busy,
            }, h(XIcon, { size: 12 })),
          ),
        ),
        expanded && h(GroupDetail, {
          t,
          group,
          skills,
          busy,
          onAddSkills: (names) => onAddSkills(group.id, names),
          onRemoveSkills: (names) => onRemoveSkills(group.id, names),
        }),
      );
    }

    // ── group detail (members list + picker, both multi-select) ────────────
    function GroupDetail({ t, group, skills, busy, onAddSkills, onRemoveSkills }) {
      const [query, setQuery] = react.useState('');
      const [memberQuery, setMemberQuery] = react.useState('');
      const [picked, setPicked] = react.useState(() => new Set());
      const [removing, setRemoving] = react.useState(() => new Set());
      const members = group.skills;
      const visibleMembers = filterMembers(members, memberQuery);
      const candidates = filterCandidates(skills, members, query);
      const visibleCandidates = candidates.slice(0, 50);
      return h('div', { className: 'msm-detail' },
        // ── selected members: searchable list with multi-select ────────────
        h('div', { className: 'msm-detail-head' },
          h('span', { className: 'msm-detail-label' }, t('group.membersLabel')),
          h('div', { className: 'msm-bulk-actions' },
            h('button', {
              type: 'button',
              className: 'msm-button msm-button-mini',
              disabled: busy || visibleMembers.length === 0,
              onClick: () => setRemoving((current) => selectAllFiltered(visibleMembers.map((name) => ({ name })), current)),
            }, t('group.selectAll')),
            h('button', {
              type: 'button',
              className: 'msm-button msm-button-mini',
              disabled: busy || visibleMembers.length === 0,
              onClick: () => setRemoving((current) => clearAllFiltered(visibleMembers.map((name) => ({ name })), current)),
            }, t('group.deselectAll')),
            h('button', {
              type: 'button',
              className: 'msm-button msm-button-mini msm-button-danger',
              disabled: busy || removing.size === 0,
              onClick: () => { onRemoveSkills([...removing]); setRemoving(new Set()); },
            }, t('group.removeSelected', { count: removing.size })),
          ),
        ),
        h('input', {
          className: 'msm-input',
          value: memberQuery,
          placeholder: t('group.memberSearchPlaceholder'),
          onChange: (event) => setMemberQuery(event.target.value),
        }),
        members.length === 0
          ? h('div', { className: 'msm-empty' }, t('group.noMembers'))
          : visibleMembers.length === 0
            ? h('div', { className: 'msm-empty' }, t('group.noMatch'))
            : h('div', { className: 'msm-list' },
                visibleMembers.map((name) => h('label', { key: name, className: 'msm-list-row' },
                  h('input', {
                    type: 'checkbox',
                    className: 'msm-row-check',
                    checked: removing.has(name),
                    disabled: busy,
                    onChange: () => setRemoving((current) => toggleInSet(current, name)),
                  }),
                  h('span', { className: 'msm-list-name', title: name }, name),
                )),
              ),
        // ── picker: search + filtered multi-select ─────────────────────────
        h('div', { className: 'msm-detail-head' },
          h('span', { className: 'msm-detail-label' }, t('group.pickerLabel')),
          h('div', { className: 'msm-bulk-actions' },
            h('button', {
              type: 'button',
              className: 'msm-button msm-button-mini',
              disabled: busy || visibleCandidates.length === 0,
              onClick: () => setPicked((current) => selectAllFiltered(visibleCandidates, current)),
            }, t('group.selectAllFiltered')),
            h('button', {
              type: 'button',
              className: 'msm-button msm-button-mini',
              disabled: busy || visibleCandidates.length === 0,
              onClick: () => setPicked((current) => clearAllFiltered(visibleCandidates, current)),
            }, t('group.deselectAllFiltered')),
            h('button', {
              type: 'button',
              className: 'msm-button msm-button-mini msm-button-primary',
              disabled: busy || picked.size === 0,
              onClick: () => { onAddSkills([...picked]); setPicked(new Set()); },
            }, t('group.addSelected', { count: picked.size })),
          ),
        ),
        h('input', {
          className: 'msm-input',
          value: query,
          placeholder: t('group.searchPlaceholder'),
          onChange: (event) => setQuery(event.target.value),
        }),
        visibleCandidates.length === 0
          ? h('div', { className: 'msm-empty' }, query.trim().length > 0 ? t('group.noMatch') : t('group.allAdded'))
          : h('div', { className: 'msm-list msm-picker-list' },
              visibleCandidates.map((skill) => h('label', { key: skill.name, className: 'msm-list-row' },
                h('input', {
                  type: 'checkbox',
                  className: 'msm-row-check',
                  checked: picked.has(skill.name),
                  disabled: busy,
                  onChange: () => setPicked((current) => toggleInSet(current, skill.name)),
                }),
                h('span', { className: 'msm-list-name', title: skill.description ?? '' }, skill.name),
              )),
            ),
      );
    }

    // ── groups tab ──────────────────────────────────────────────────────────
    function GroupSection({ t, state, skills, busy, onCreate, onDelete, onRename, onSetEnabled, onAddSkills, onRemoveSkills }) {
      const [newName, setNewName] = react.useState('');
      const submitCreate = () => {
        const name = newName.trim();
        if (name.length === 0) return;
        setNewName('');
        onCreate(name);
      };
      return h('div', { className: 'msm-section' },
        h('div', { className: 'msm-create-row' },
          h('input', {
            className: 'msm-input',
            value: newName,
            placeholder: t('group.createPlaceholder'),
            disabled: busy,
            onChange: (event) => setNewName(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') submitCreate(); },
          }),
          h('button', {
            type: 'button',
            className: 'msm-button msm-button-primary',
            disabled: busy || newName.trim().length === 0,
            onClick: submitCreate,
          }, t('group.create')),
        ),
        state.groups.length === 0
          ? h('div', { className: 'msm-empty' }, t('group.empty'))
          : h('div', { className: 'msm-group-list' },
              state.groups.map((group) => h(GroupCard, {
                key: group.id,
                t,
                group,
                skills,
                busy,
                onDelete: () => onDelete(group.id),
                onRename: (name) => onRename(group.id, name),
                onSetEnabled: (enabled) => onSetEnabled(group.id, enabled),
                // Two-arg wrapper: GroupCard calls onAddSkills(group.id, names);
                // a one-arg wrapper here would bind `names` to the group id and
                // `for (const name of names)` would iterate the id's characters.
                onAddSkills: (id, names) => onAddSkills(id, names),
                onRemoveSkills: (id, names) => onRemoveSkills(id, names),
              })),
            ),
      );
    }

    // ── MCP add form ─────────────────────────────────────────────────────────
    function McpAddForm({ t, busy, onAdd }) {
      const [serverName, setServerName] = react.useState('');
      const [transport, setTransport] = react.useState('stdio');
      const [command, setCommand] = react.useState('');
      const [args, setArgs] = react.useState('');
      const [url, setUrl] = react.useState('');
      const [formError, setFormError] = react.useState(null);
      const submit = () => {
        const name = serverName.trim();
        if (!SERVER_NAME_PATTERN.test(name)) { setFormError(t('mcp.formErrorName')); return; }
        if (transport === 'stdio') {
          if (command.trim().length === 0) { setFormError(t('mcp.formErrorCommand')); return; }
          const argsList = args.split(/\s+/).filter((part) => part.length > 0);
          onAdd({ serverName: name, transport, command: command.trim(), args: argsList });
        } else {
          if (url.trim().length === 0) { setFormError(t('mcp.formErrorUrl')); return; }
          onAdd({ serverName: name, transport, url: url.trim() });
        }
        setFormError(null);
        setServerName('');
        setCommand('');
        setArgs('');
        setUrl('');
      };
      return h('div', { className: 'msm-form' },
        h('div', { className: 'msm-detail-label' }, t('mcp.addTitle')),
        h('input', {
          className: 'msm-input',
          value: serverName,
          placeholder: t('mcp.formName'),
          disabled: busy,
          onChange: (event) => setServerName(event.target.value),
        }),
        h('div', { className: 'msm-form-row' },
          h('label', { className: 'msm-radio' },
            h('input', { type: 'radio', name: 'msm-transport', checked: transport === 'stdio', onChange: () => setTransport('stdio') }),
            'stdio'),
          h('label', { className: 'msm-radio' },
            h('input', { type: 'radio', name: 'msm-transport', checked: transport === 'streamable-http', onChange: () => setTransport('streamable-http') }),
            'streamable-http'),
        ),
        transport === 'stdio'
          ? h(react.Fragment, null,
              h('input', {
                className: 'msm-input',
                value: command,
                placeholder: t('mcp.formCommand'),
                disabled: busy,
                onChange: (event) => setCommand(event.target.value),
              }),
              h('input', {
                className: 'msm-input',
                value: args,
                placeholder: t('mcp.formArgs'),
                disabled: busy,
                onChange: (event) => setArgs(event.target.value),
              }),
            )
          : h('input', {
              className: 'msm-input',
              value: url,
              placeholder: t('mcp.formUrl'),
              disabled: busy,
              onChange: (event) => setUrl(event.target.value),
            }),
        formError !== null && h('div', { className: 'msm-op-error' }, formError),
        h('button', {
          type: 'button',
          className: 'msm-button msm-button-primary',
          disabled: busy,
          onClick: submit,
        }, t('mcp.add')),
      );
    }

    // ── MCP tab ─────────────────────────────────────────────────────────────
    function McpSection({ t, servers, busy, onToggle, onRemove, onAdd }) {
      return h('div', { className: 'msm-section' },
        servers.length === 0
          ? h('div', { className: 'msm-empty' }, t('mcp.empty'))
          : h('div', { className: 'msm-server-list' },
              servers.map((server) => h('div', { key: server.serverName, className: 'msm-server' },
                h('span', { className: 'msm-server-dot', 'data-enabled': server.enabled || undefined, 'data-live': server.live || undefined }),
                h('span', { className: 'msm-server-name', title: server.serverName }, server.serverName),
                h('span', { className: 'msm-server-badge', 'data-source': server.source },
                  server.source === 'user' ? t('mcp.sourceUser') : t('mcp.sourceProfile')),
                h('span', { className: 'msm-server-meta' }, t('mcp.tools', { count: server.toolCount })),
                h('button', {
                  type: 'button',
                  role: 'switch',
                  'aria-checked': server.enabled,
                  className: 'msm-switch',
                  'data-on': server.enabled || undefined,
                  onClick: () => onToggle(server.serverName, !server.enabled),
                  'aria-label': t(server.enabled ? 'mcp.disable' : 'mcp.enable', { name: server.serverName }),
                  title: t(server.enabled ? 'mcp.disable' : 'mcp.enable', { name: server.serverName }),
                  disabled: busy,
                }),
                server.source === 'user' && h('button', {
                  type: 'button',
                  className: 'msm-icon-button msm-danger',
                  onClick: () => onRemove(server.serverName),
                  'aria-label': t('mcp.remove', { name: server.serverName }),
                  title: t('mcp.remove', { name: server.serverName }),
                  disabled: busy,
                }, h(XIcon, { size: 12 })),
              )),
            ),
        h(McpAddForm, { t, busy, onAdd }),
      );
    }

    // ── panel root (shell.overlay entry) ────────────────────────────────────
    function ManagerPanel(props) {
      const t = makeT(props.t);
      const [open, setOpen] = react.useState(readStoredOpen);
      const [status, setStatus] = react.useState('loading');
      const [loadError, setLoadError] = react.useState(null);
      const [state, setState] = react.useState({ groups: [], mcp: [] });
      const [skills, setSkills] = react.useState([]);
      const [servers, setServers] = react.useState([]);
      const [tab, setTab] = react.useState('groups');
      const [opError, setOpError] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [bounds, setBounds] = react.useState(initialBounds);
      const wasOpen = react.useRef(open);

      const load = react.useCallback(async (silent) => {
        if (!silent) { setStatus('loading'); setLoadError(null); }
        try {
          const [stateValue, skillsValue, serversValue] = await Promise.all([
            rpc('manager.state.get', {}),
            rpc('manager.skills.list', {}),
            rpc('manager.mcp.list', {}),
          ]);
          setState(stateValue);
          setSkills(skillsValue.skills ?? []);
          setServers(serversValue.servers ?? []);
          if (!silent) setStatus('ready');
        } catch (error) {
          const message = errorMessage(error);
          if (silent) setOpError(message);
          else { setLoadError(message); setStatus('error'); }
        }
      }, []);

      /** Optimistic mutate: apply locally, call RPC, re-align; roll back on failure. */
      const mutate = async (method, args, optimistic) => {
        setOpError(null);
        setBusy(true);
        const prev = { state, skills, servers };
        if (optimistic !== undefined) optimistic();
        try {
          await rpc(method, args);
          await load(true);
        } catch (error) {
          setState(prev.state);
          setSkills(prev.skills);
          setServers(prev.servers);
          setOpError(errorMessage(error));
        } finally {
          setBusy(false);
        }
      };

      // operations
      const createGroup = (name) => mutate('manager.groups.create', { name });
      const deleteGroup = (id) => {
        if (!window.confirm(t('group.deleteConfirm'))) return;
        mutate('manager.groups.delete', { id }, () => {
          setState((prev) => ({ ...prev, groups: prev.groups.filter((group) => group.id !== id) }));
        });
      };
      const renameGroup = (id, name) => mutate('manager.groups.rename', { id, name }, () => {
        setState((prev) => ({ ...prev, groups: prev.groups.map((group) => (group.id === id ? { ...group, name } : group)) }));
      });
      const setGroupEnabled = (id, enabled) => mutate('manager.groups.setEnabled', { id, enabled }, () => {
        setState((prev) => ({ ...prev, groups: prev.groups.map((group) => (group.id === id ? { ...group, enabled } : group)) }));
      });
      /** Batch add/remove: one RPC per name, then re-align. */
      const batchGroupSkills = async (method, id, names) => {
        setOpError(null);
        setBusy(true);
        const prev = { state, skills, servers };
        try {
          for (const name of names) await rpc(method, { id, skill: name });
          await load(true);
        } catch (error) {
          setState(prev.state);
          setSkills(prev.skills);
          setServers(prev.servers);
          setOpError(errorMessage(error));
        } finally {
          setBusy(false);
        }
      };
      const addSkills = (id, names) => batchGroupSkills('manager.groups.addSkill', id, names);
      const removeSkills = (id, names) => batchGroupSkills('manager.groups.removeSkill', id, names);
      const toggleMcp = (serverName, enabled) => mutate('manager.mcp.toggle', { serverName, enabled }, () => {
        setState((prev) => ({
          ...prev,
          mcp: prev.mcp.map((server) => (server.serverName === serverName ? { ...server, enabled } : server)),
        }));
        setServers((prev) => prev.map((server) => (server.serverName === serverName ? { ...server, enabled } : server)));
      });
      const removeMcp = (serverName) => {
        if (!window.confirm(t('mcp.removeConfirm', { name: serverName }))) return;
        mutate('manager.mcp.remove', { serverName }, () => {
          setServers((prev) => prev.filter((server) => server.serverName !== serverName));
        });
      };
      const addMcp = (input) => mutate('manager.mcp.add', input);

      // initial load
      react.useEffect(() => { load(false); }, [load]);
      // refresh when the panel re-opens (host state may have changed via tools)
      react.useEffect(() => {
        if (open && !wasOpen.current) load(true);
        wasOpen.current = open;
      }, [open, load]);
      // persist open state
      react.useEffect(() => {
        try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ open })); } catch { /* ignore */ }
      }, [open]);
      // header toggle button sync
      react.useEffect(() => {
        const onToggle = () => setOpen((current) => !current);
        window.addEventListener(TOGGLE_EVENT, onToggle);
        return () => window.removeEventListener(TOGGLE_EVENT, onToggle);
      }, []);

      // Measure the dock anchor ONCE on mount (no observers, no resize
      // listeners): the management icon and panel keep a fixed position for
      // the page lifetime instead of jumping when the conversation column
      // resizes or the session phase changes.
      react.useLayoutEffect(() => {
        const overlay = document.querySelector('[data-shell-overlay]');
        if (overlay === null) return;
        const conversation = document.querySelector("[data-phase='active']");
        const overlayRect = overlay.getBoundingClientRect();
        const conversationRect = conversation?.getBoundingClientRect();
        const next = {
          width: overlayRect.width,
          height: overlayRect.height,
          anchorLeft: conversationRect === undefined
            ? 0
            : Math.min(Math.max(conversationRect.left - overlayRect.left, 0), overlayRect.width),
        };
        setBounds((prev) => (prev.width === next.width && prev.height === next.height && prev.anchorLeft === next.anchorLeft ? prev : next));
      }, []);

      // wide docked mode: keep the panel floating (never mutate product layout —
      // the product owns `data-phase` lifecycle and the AppFrame grid, and any
      // padding/attribute interference caused app-wide flicker and broke
      // session transitions; the overlay layer is frame-wide and click-through
      // by default, so the panel simply floats above the conversation column).
      const compact = bounds.width <= PANEL_COMPACT_BREAKPOINT;

      if (!open) return null;

      const geometry = resolveGeometry(bounds);
      return h('aside', {
        className: 'msm-panel',
        'data-mcp-skill-manager-panel': true,
        'data-compact': compact || undefined,
        style: { left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height },
        'aria-label': t('panel.aria'),
      },
        h('header', { className: 'msm-panel-head' },
          h('span', { className: 'msm-panel-title' }, h(GearIcon, { size: 15 }), t('panel.title')),
          h('div', { className: 'msm-panel-controls' },
            h('button', {
              type: 'button',
              className: 'msm-icon-button',
              onClick: () => setOpen(false),
              'aria-label': t('panel.collapse'),
              title: t('panel.collapse'),
            }, h(ChevronIcon, { size: 12, direction: 'left' })),
          ),
        ),
        h('div', { className: 'msm-tabs', role: 'tablist' },
          h('button', {
            type: 'button',
            role: 'tab',
            'aria-selected': tab === 'groups',
            className: 'msm-tab',
            'data-active': tab === 'groups' || undefined,
            onClick: () => setTab('groups'),
          }, t('tab.groups')),
          h('button', {
            type: 'button',
            role: 'tab',
            'aria-selected': tab === 'mcp',
            className: 'msm-tab',
            'data-active': tab === 'mcp' || undefined,
            onClick: () => setTab('mcp'),
          }, t('tab.mcp')),
        ),
        h('div', { className: 'msm-body' },
          status === 'loading'
            ? h('div', { className: 'msm-loading' }, t('state.loading'))
            : status === 'error'
              ? h('div', { className: 'msm-error' },
                  h('div', { className: 'msm-error-text' }, loadError),
                  h('button', { type: 'button', className: 'msm-button', onClick: () => load(false) }, t('state.retry')),
                )
              : h(react.Fragment, null,
                  opError !== null && h('div', { className: 'msm-op-error' }, opError),
                  tab === 'groups'
                    ? h(GroupSection, {
                        t,
                        state,
                        skills,
                        busy,
                        onCreate: createGroup,
                        onDelete: deleteGroup,
                        onRename: renameGroup,
                        onSetEnabled: setGroupEnabled,
                        onAddSkills: addSkills,
                        onRemoveSkills: removeSkills,
                      })
                    : h(McpSection, { t, servers, busy, onToggle: toggleMcp, onRemove: removeMcp, onAdd: addMcp }),
                ),
        ),
      );
    }

    // ── header toggle button (conversation.session.header.actions entry) ───
    function PanelToggleButton(props) {
      const t = makeT(props.t);
      return h('button', {
        type: 'button',
        className: 'msm-toggle',
        'aria-label': t('toggle.aria'),
        title: t('toggle.title'),
        onClick: () => { window.dispatchEvent(new CustomEvent(TOGGLE_EVENT)); },
      }, h(GearIcon, { size: 14 }), h('span', { className: 'msm-toggle-label' }, t('toggle.label')));
    }

    // ── stylesheet (fiber-scoped) ───────────────────────────────────────────
    const PANEL_CSS = [
      '.msm-panel{box-sizing:border-box;position:absolute;display:flex;flex-direction:column;overflow:hidden;border:1px solid color-mix(in srgb,var(--dsw-alias-line-strong,#cfd3d6) 58%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-module,#fff) 95%,transparent);backdrop-filter:blur(20px) saturate(1.08);box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 12%,transparent),0 32px 72px color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 16%,transparent);border-radius:16px;color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:18px;animation:msm-panel-in .16s ease-out}',
      '@keyframes msm-panel-in{from{opacity:0}to{opacity:1}}',
      '.msm-panel-head{display:flex;align-items:center;justify-content:space-between;flex:none;min-height:44px;padding:0 10px 0 14px;border-bottom:1px solid var(--dsw-alias-line-normal,#e7e9ee)}',
      '.msm-panel-title{display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.msm-panel-controls{display:inline-flex;align-items:center;gap:2px;flex:none}',
      '.msm-icon-button{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;color:var(--dsw-alias-label-tertiary,#8a919c);background:transparent;border:0;border-radius:7px;cursor:pointer;transition:background-color .12s,color .12s}',
      '.msm-icon-button:hover{background:var(--dsw-alias-bg-fill-neutral,#eef0f4);color:var(--dsw-alias-label-primary,#1f2329)}',
      '.msm-icon-button:disabled{opacity:.45;cursor:default}',
      '.msm-icon-button.msm-danger:hover{color:var(--dsw-alias-state-danger,#e5484d);background:color-mix(in srgb,var(--dsw-alias-state-danger,#e5484d) 10%,transparent)}',
      '.msm-tabs{display:flex;gap:4px;flex:none;padding:8px 10px 0}',
      '.msm-tab{flex:1;padding:5px 0;text-align:center;color:var(--dsw-alias-label-tertiary,#8a919c);background:transparent;border:0;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer}',
      '.msm-tab:hover{color:var(--dsw-alias-label-secondary,#5c6470)}',
      '.msm-tab[data-active]{color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-fill-neutral,#eef0f4)}',
      '.msm-body{flex:1;min-height:0;overflow-y:auto;padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px}',
      '.msm-section{display:flex;flex-direction:column;gap:10px}',
      '.msm-loading,.msm-error{display:flex;flex-direction:column;align-items:center;gap:8px;padding:24px 0;color:var(--dsw-alias-label-tertiary,#8a919c);font-size:12px}',
      '.msm-error-text{color:var(--dsw-alias-state-danger,#e5484d);text-align:center}',
      '.msm-op-error{color:var(--dsw-alias-state-danger,#e5484d);font-size:12px;line-height:16px}',
      '.msm-empty{color:var(--dsw-alias-label-tertiary,#8a919c);font-size:12px;line-height:16px;padding:6px 0}',
      '.msm-create-row{display:flex;gap:6px}',
      '.msm-input{box-sizing:border-box;flex:1;min-width:0;height:30px;padding:0 8px;color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-module-platform,#f7f8fa);border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:8px;font-size:12px;font-family:inherit}',
      '.msm-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px;border-color:transparent}',
      '.msm-button{flex:none;height:30px;padding:0 12px;color:var(--dsw-alias-label-secondary,#5c6470);background:var(--dsw-alias-bg-module-platform,#f7f8fa);border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:8px;font-size:12px;font-weight:600;cursor:pointer}',
      '.msm-button:hover{background:var(--dsw-alias-bg-fill-neutral,#eef0f4)}',
      '.msm-button:disabled{opacity:.5;cursor:default}',
      '.msm-button-primary{color:var(--dsw-alias-label-on-fill,#fff);background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:transparent}',
      '.msm-button-primary:hover{filter:brightness(1.06)}',
      '.msm-button-mini{height:22px;padding:0 8px;font-size:11px;border-radius:6px}',
      '.msm-button-danger{color:var(--dsw-alias-state-danger,#e5484d)}',
      '.msm-button-danger:not(:disabled):hover{background:color-mix(in srgb,var(--dsw-alias-state-danger,#e5484d) 10%,transparent)}',
      '.msm-group-list{display:flex;flex-direction:column;gap:6px}',
      '.msm-group{border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:10px;padding:7px 8px}',
      '.msm-group[data-expanded]{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 5%,transparent)}',
      '.msm-group-row{display:flex;align-items:center;gap:8px;min-width:0}',
      '.msm-group-caret{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;padding:0;color:var(--dsw-alias-label-tertiary,#8a919c);background:transparent;border:0;border-radius:5px;cursor:pointer}',
      '.msm-group-caret:hover{color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-fill-neutral,#eef0f4)}',
      '.msm-group-check{flex:none;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe);cursor:pointer}',
      '.msm-group-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329);cursor:pointer}',
      '.msm-group-name:hover{color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.msm-group-edit{flex:1;height:26px}',
      '.msm-group-count{flex:none;color:var(--dsw-alias-label-tertiary,#8a919c);font-size:10.5px}',
      '.msm-group-actions{display:inline-flex;gap:2px;flex:none}',
      '.msm-detail{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-line-normal,#e7e9ee);padding-top:10px}',
      '.msm-detail-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}',
      '.msm-detail-label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#5c6470)}',
      '.msm-bulk-actions{display:inline-flex;gap:4px;flex:none}',
      '.msm-list{display:flex;flex-direction:column;gap:2px;max-height:200px;overflow-y:auto}',
      '.msm-list-row{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:6px;cursor:pointer}',
      '.msm-list-row:hover{background:var(--dsw-alias-bg-fill-neutral,#eef0f4)}',
      '.msm-row-check{flex:none;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe);cursor:pointer}',
      '.msm-list-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.msm-server-list{display:flex;flex-direction:column;gap:6px}',
      '.msm-server{display:flex;align-items:center;gap:8px;min-width:0;padding:7px 8px;border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:10px}',
      '.msm-server-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8a919c)}',
      '.msm-server-dot[data-enabled]{background:var(--dsw-alias-state-success-primary,#12a150)}',
      '.msm-server-dot[data-live]{box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#12a150) 22%,transparent)}',
      '.msm-server-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.msm-server-badge{flex:none;padding:0 6px;border-radius:4px;font-size:10px;font-weight:600;line-height:16px;background:var(--dsw-alias-bg-fill-neutral,#eef0f4);color:var(--dsw-alias-label-tertiary,#8a919c)}',
      '.msm-server-badge[data-source=user]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 12%,transparent);color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.msm-server-meta{flex:none;color:var(--dsw-alias-label-tertiary,#8a919c);font-size:10.5px}',
      '.msm-switch{position:relative;flex:none;width:32px;height:18px;padding:0;border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:999px;background:var(--dsw-alias-bg-fill-neutral,#eef0f4);cursor:pointer;transition:background-color .12s,border-color .12s}',
      '.msm-switch::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .12s}',
      '.msm-switch[data-on]{background:var(--dsw-alias-state-success-primary,#12a150);border-color:transparent}',
      '.msm-switch[data-on]::after{transform:translateX(14px)}',
      '.msm-switch:disabled{opacity:.5;cursor:default}',
      '.msm-form{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-line-normal,#e7e9ee);padding-top:10px}',
      '.msm-form-row{display:flex;gap:10px}',
      '.msm-radio{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary,#5c6470);cursor:pointer}',
      '.msm-radio input{accent-color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.msm-toggle{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:28px;padding:3px 8px;color:var(--dsw-alias-label-tertiary,#8a919c);background:transparent;border:0;border-radius:6px;cursor:pointer}',
      '.msm-toggle:hover,.msm-toggle:focus-visible{color:var(--dsw-alias-label-secondary,#5c6470)}',
      '.msm-toggle-label{font-size:12px;font-weight:600;white-space:nowrap}',
      '@media (prefers-reduced-motion:reduce){.msm-panel{animation:none;transition:none}}',
    ].join('');

    // ── plugin face ─────────────────────────────────────────────────────────
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register('mcp-skill-manager', { zh, en }), 'mcp-skill-manager: dictionaries');
      ctx.effect(() => {
        if (typeof document === 'undefined') return;
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-skills-mcp-group-manager';
        tag.dataset.pluginCss = 'dsh-skills-mcp-group-manager/panel.css';
        tag.textContent = PANEL_CSS;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      }, 'mcp-skill-manager: styles');
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'mcp-skill-manager-panel',
        order: 70,
        label: 'MCP & Skills manager',
        locale: 'mcp-skill-manager',
      }, ManagerPanel));
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'mcp-skill-manager-toggle',
        order: 10,
        label: 'MCP & Skills manager',
        locale: 'mcp-skill-manager',
      }, PanelToggleButton));
    }

    exports.apply = apply;
    exports.inject = inject;
    // Pure selection logic, exported for unit tests (the browser runtime
    // ignores this extra export).
    exports.__logic = {
      filterCandidates,
      filterMembers,
      toggleInSet,
      selectAllFiltered,
      clearAllFiltered,
      toggleAllMembers,
      addSelectedToGroup,
      removeSelectedFromGroup,
    };
    return module.exports;
  },
});
