/**
 * The ledger console's browser half: one `settings.section` page that lists every ledger on
 * this machine, groups them by project, shows what is inside one, and moves a ledger aside.
 *
 * Why this file is hand-written rather than built. Every other client plugin on this host
 * ships a bundle produced by tsdown/esbuild (`dshmarket/client/client.js`, 806 KB, wrapped
 * as `window.__ModuleLoader__.load({ id, factory })`). This package has no toolchain, no
 * `node_modules` and no build step — it is installed with `link:` and loaded straight from
 * its checkout — and adding one to write a single settings page would cost more than the
 * page. The loader's contract is small enough to meet by hand: register a factory, and
 * resolve `react` through the `require` it hands over (`react` is in the shell's baseline
 * module table; `dshmarket`'s bundle does exactly `require("react")` with no `external`
 * declaration of its own).
 *
 * What this file uses from the shell: `react` and `@deepseek-ai/dsh-client-ui-primitives`
 * (the official `Button` / `Input` controls). Both are baseline modules, so no `external`
 * declaration or build step is needed; each is required through the loader's `require`, with
 * a plain-DOM fallback if a future shell stops seeding one. Layout and colour come from the
 * shell's `--dsw-alias-*` design tokens instead of a private palette, which is what makes the
 * page follow light/dark and match the rest of Settings.
 *
 * Every decision about *what may happen* lives on the host side (`lib/ledger-admin.js` via
 * `lib/web-routes.js`). This file sends back ids it was given and nothing else: it cannot
 * name a path, so it cannot name a path outside the ledgers it was shown.
 */
window.__ModuleLoader__.load({
  id: 'dsh-code-mode',
  factory: (require) => {
    const react = require('react');
    const h = react.createElement;
    const primitives = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives');
      } catch {
        return {};
      }
    })();
    const Button =
      primitives.Button ??
      (({ variant, size, children, ...rest }) => h('button', rest, children));
    const Input = primitives.Input ?? ((props) => h('input', props));
    const module = { exports: {} };
    const exports = module.exports;

    /** Where the host row serves from. Changing it means changing `web-routes.js` too. */
    const BASE = '/code-mode';

    /** The host keeps the pre-edit copy of a file here when one entry is deleted. */
    const ENTRY_TRASH_DIR = '.entry-trash';

    /** The shell's own design tokens, so this page follows the light/dark theme it is in. */
    const C = {
      text: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
      border: 'var(--dsw-alias-border-l2)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      danger: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      code: 'var(--ds-font-family-code)',
    };

    const S = {
      wrap: { fontSize: 13, lineHeight: 1.55, color: C.text, display: 'flex', flexDirection: 'column', gap: 10 },
      head: { display: 'flex', alignItems: 'baseline', gap: 10 },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      muted: { color: C.secondary, fontSize: 12 },
      notice: { color: C.secondary, fontSize: 12, background: C.surface, borderRadius: 'var(--dsw-radius-md)', padding: '8px 10px' },
      tabs: { display: 'flex', flexWrap: 'wrap', gap: 4, borderBottom: `1px solid ${C.border}`, paddingBottom: 2 },
      card: { borderBottom: `1px solid ${C.border}`, padding: '10px 0' },
      row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minHeight: 28 },
      groupHead: { display: 'flex', alignItems: 'baseline', gap: 8, margin: '14px 0 2px' },
      groupPath: { fontFamily: C.code, fontSize: 12, color: C.secondary, wordBreak: 'break-all' },
      chip: { fontSize: 11, padding: '1px 7px', borderRadius: 999, border: `1px solid ${C.border}`, color: C.secondary, whiteSpace: 'nowrap' },
      chipBad: { borderColor: C.danger, color: C.danger },
      mono: { fontFamily: C.code, fontSize: 11.5, color: C.secondary, wordBreak: 'break-all' },
      error: { color: C.danger, fontSize: 12.5 },
      warn: { border: `1px solid ${C.warn}`, borderRadius: 'var(--dsw-radius-sm)', padding: '8px 10px', marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      empty: { color: C.tertiary, padding: '12px 0' },
      entry: { padding: '8px 0', borderTop: `1px solid ${C.border}` },
      entryHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      entryTitle: { fontSize: 13, fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' },
      entrySummary: { color: C.tertiary, fontSize: 12, marginTop: 2, overflowWrap: 'anywhere' },
      fields: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: '6px 0 0' },
      dt: { color: C.tertiary, fontSize: 12, whiteSpace: 'nowrap' },
      dd: { margin: 0, fontSize: 12.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      raw: { margin: '6px 0 0', padding: 8, background: C.surface, borderRadius: 'var(--dsw-radius-sm)', fontFamily: C.code, fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto' },
    };

    /** Health flags as short Chinese labels; unknown flags pass through unchanged. */
    const HEALTH_TEXT = {
      machine: '所有项目共享',
      trash: '回收站',
      unmigrated: '未迁移（账本在仓库里）',
      migrated: '已迁移（仓库指向 store）',
      'central-dangling': '指针悬空：CENTRAL 指向的账本不在',
      'not-pointed-at': '仓库没指向它：插件读的是另一份',
      'repo-copy-also-live': '仓库里还有一份活的账本',
      'store-orphan': '项目已不存在',
      'no-project-root': '目录里没有 project-root 标记',
      locked: '正在被写（有锁）',
    };
    const BAD_HEALTH = new Set(['central-dangling', 'not-pointed-at', 'repo-copy-also-live', 'store-orphan', 'no-project-root', 'locked']);

    const human = (bytes) => {
      const value = Number(bytes) || 0;
      if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
      if (value >= 1024) return `${Math.round(value / 1024)} KB`;
      return `${value} B`;
    };
    const when = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : '—');

    function Chips({ flags }) {
      if (!Array.isArray(flags) || flags.length === 0) return h('span', { style: S.muted }, '正常');
      return h(
        'span',
        { style: { display: 'inline-flex', gap: 4, flexWrap: 'wrap' } },
        flags.map((flag) =>
          h('span', { key: flag, style: { ...S.chip, ...(BAD_HEALTH.has(flag) ? S.chipBad : {}) } }, HEALTH_TEXT[flag] ?? flag),
        ),
      );
    }

    /** One parsed record: a collapsed one-line row that expands in place. */
    function EntryCard({ record, open, onToggle, deletable, confirming, busy, error, onAskDelete, onCancelDelete, onConfirmDelete }) {
      const first = Array.isArray(record.fields) && record.fields.length > 0 ? record.fields[0] : undefined;
      const summary =
        record.kind === 'journal'
          ? String(record.raw ?? '').slice(0, 180)
          : first === undefined
            ? String(record.raw ?? '').replace(/\s+/gu, ' ').slice(0, 180)
            : `${first.label}: ${String(first.value).replace(/\s+/gu, ' ').slice(0, 180)}`;
      return h(
        'div',
        { style: S.entry },
        h(
          'div',
          { style: S.entryHead },
          h(Button, { size: 'sm', variant: 'ghost', style: { padding: '0 6px', minWidth: 22 }, onClick: onToggle }, open ? '▾' : '▸'),
          record.date ? h('span', { style: S.chip }, record.date) : null,
          h('strong', { style: S.entryTitle }, record.title || '(untitled)'),
          record.kind === 'task' ? h('span', { style: S.chip }, record.status === 'active' ? '进行中' : '已完成') : null,
          record.time ? h('span', { style: S.muted }, record.time) : null,
          h('span', { style: { flex: 1 } }),
          deletable ? h(Button, { size: 'sm', variant: 'ghost', style: { color: C.danger }, onClick: onAskDelete }, '删除') : null,
        ),
        open ? null : h('div', { style: S.entrySummary }, summary.length === 0 ? '(空)' : summary),
        confirming
          ? h(
              'div',
              { style: { ...S.warn, ...S.row } },
              h('span', { style: { flex: 1 } }, `确认删除这一条？原文件会先复制到账本里的 ${ENTRY_TRASH_DIR}/ 再改写。`),
              h(Button, { size: 'sm', variant: 'primary', disabled: busy, onClick: onConfirmDelete }, busy ? '删除中…' : '确认删除'),
              h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: onCancelDelete }, '取消'),
            )
          : null,
        error.length > 0 ? h('div', { style: S.error }, error) : null,
        open
          ? record.kind === 'journal'
            ? h('pre', { style: S.raw }, record.raw)
            : Array.isArray(record.fields) && record.fields.length > 0
              ? h(
                  'dl',
                  { style: S.fields },
                  record.fields.flatMap((field, index) => [
                    h('dt', { key: `t${index}`, style: S.dt }, field.label),
                    h('dd', { key: `d${index}`, style: S.dd }, field.value),
                  ]),
                )
              : h('pre', { style: S.raw }, record.raw ?? '')
          : null,
      );
    }

    /** The viewer for one ledger: file tabs, a collapsed list of entries, and the raw file. */
    function LedgerDetail({ entry, files, token, onClose }) {
      const [file, setFile] = react.useState('mistakes.md');
      const [mode, setMode] = react.useState('entries');
      const [view, setView] = react.useState({ status: 'loading', text: '', error: '', truncated: false, segments: [], entries: [], entryCount: 0, lines: 0 });
      const [expanded, setExpanded] = react.useState({});
      const [confirmKey, setConfirmKey] = react.useState('');
      const [busyKey, setBusyKey] = react.useState('');
      const [rowError, setRowError] = react.useState({ key: '', message: '' });

      const loadFile = react.useCallback(
        async (name) => {
          setView({ status: 'loading', text: '', error: '', truncated: false, segments: [], entries: [], entryCount: 0, lines: 0 });
          try {
            const response = await fetch(`${BASE}/ledger?id=${encodeURIComponent(entry.id)}&file=${encodeURIComponent(name)}`);
            const body = await response.json();
            if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
            const entries = Array.isArray(body.entries) ? body.entries : [];
            setView({
              status: 'ready',
              text: body.text ?? '',
              error: '',
              truncated: body.truncated === true,
              segments: body.segments ?? [],
              entries,
              entryCount: body.entryCount ?? entries.length,
              lines: body.lines ?? 0,
            });
          } catch (thrown) {
            setView({ status: 'error', text: '', error: String(thrown?.message ?? thrown), truncated: false, segments: [], entries: [], entryCount: 0, lines: 0 });
          }
        },
        [entry.id],
      );

      react.useEffect(() => {
        setMode('entries');
        setExpanded({});
        setConfirmKey('');
        setRowError({ key: '', message: '' });
        void loadFile(file);
      }, [file, loadFile]);

      const removeOne = async (record, key) => {
        setBusyKey(key);
        setRowError({ key: '', message: '' });
        try {
          const response = await fetch(`${BASE}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-code-mode-token': token },
            body: JSON.stringify({ action: 'remove-entry', id: entry.id, file, index: record.index }),
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
          setConfirmKey('');
          setExpanded((previous) => ({ ...previous, [key]: false }));
          await loadFile(file);
        } catch (thrown) {
          setRowError({ key, message: String(thrown?.message ?? thrown) });
        } finally {
          setBusyKey('');
        }
      };

      return h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.row },
          h('strong', null, entry.label),
          h(Chips, { flags: entry.health }),
          h('span', { style: { flex: 1 } }),
          h(Button, { size: 'sm', variant: 'ghost', onClick: onClose }, '收起'),
        ),
        h('div', { style: S.mono }, entry.dir),
        h(
          'div',
          { style: S.row },
          h('span', { style: S.muted }, `mistakes ${entry.counts?.mistakes ?? 0} · decisions ${entry.counts?.decisions ?? 0} · 任务 ${entry.counts?.tasksActive ?? 0} 在飞 / ${entry.counts?.tasksDone ?? 0} 完成`),
          h('span', { style: S.muted }, `${human(entry.bytes)} · 最后写入 ${when(entry.lastWrite)}`),
        ),
        h(
          'div',
          { style: S.tabs },
          files.map((name) =>
            h(
              Button,
              {
                key: name,
                size: 'sm',
                variant: 'ghost',
                style: name === file ? { background: 'var(--dsw-alias-interactive-bg-active)' } : undefined,
                onClick: () => setFile(name),
              },
              name,
            ),
          ),
        ),
        view.status === 'loading'
          ? h('div', { style: S.muted }, '读取中…')
          : view.status === 'error'
            ? h('div', { style: S.error }, view.error)
            : h(
                'div',
                null,
                h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.muted }, `${view.entryCount} 条`),
                  view.truncated ? h('span', { style: S.muted }, `（journal 仅显示最近 ${view.entryCount} 条，共 ${view.lines} 行）`) : null,
                  h('span', { style: { flex: 1 } }),
                  h(Button, { size: 'sm', variant: 'ghost', onClick: () => setMode(mode === 'entries' ? 'raw' : 'entries') }, mode === 'entries' ? '原文' : '条目'),
                ),
                mode === 'raw' || view.entries.length === 0
                  ? h('pre', { style: S.raw }, view.text.length === 0 ? '(空)' : view.text)
                  : view.entries.map((record) => {
                      const key = `${record.kind}:${record.index}`;
                      const systemField = record.kind === 'project' && ['version', 'createdAt', 'updatedAt'].includes(record.title);
                      return h(EntryCard, {
                        key,
                        record,
                        open: expanded[key] === true,
                        deletable: !systemField,
                        confirming: confirmKey === key,
                        busy: busyKey === key,
                        error: rowError.key === key ? rowError.message : '',
                        onToggle: () => setExpanded((previous) => ({ ...previous, [key]: previous[key] !== true })),
                        onAskDelete: () => {
                          setConfirmKey(key);
                          setRowError({ key: '', message: '' });
                        },
                        onCancelDelete: () => setConfirmKey(''),
                        onConfirmDelete: () => void removeOne(record, key),
                      });
                    }),
              ),
        h(
          'div',
          { style: { ...S.row, marginTop: 8 } },
          h('span', { style: S.muted }, '每条右侧的「删除」只删这一条；删前会把原文件复制到账本里的 .entry-trash/，可手工恢复。'),
        ),
      );
    }

    /** The trash: restore puts a ledger back, purge is the only irreversible act here. */
    function Trash({ record, token, onChanged }) {
      const [busy, setBusy] = react.useState('');
      const [error, setError] = react.useState('');
      const [typed, setTyped] = react.useState('');
      const [purging, setPurging] = react.useState(false);

      const act = async (action, extra = {}) => {
        setBusy(action);
        setError('');
        try {
          const response = await fetch(`${BASE}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-code-mode-token': token },
            body: JSON.stringify({ action, id: record.id, ...extra }),
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
          onChanged();
        } catch (thrown) {
          setError(String(thrown?.message ?? thrown));
        } finally {
          setBusy('');
        }
      };

      return h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.row },
          h('strong', null, record.label),
          h('span', { style: S.muted }, record.scope === 'global' ? '机器账本' : '项目账本'),
          h('span', { style: S.muted }, `移入于 ${record.trashedAt ? new Date(record.trashedAt).toLocaleString() : '—'}`),
        ),
        h('div', { style: S.mono }, `原位置 ${record.originalDir || '(未知)'}`),
        error.length > 0 ? h('div', { style: S.error }, error) : null,
        h(
          'div',
          { style: { ...S.row, marginTop: 6 } },
          h(Button, { size: 'sm', variant: 'outline', disabled: busy === 'restore' || purging, onClick: () => act('restore') }, busy === 'restore' ? '恢复中…' : '恢复到原位置'),
          purging
            ? h(
                'span',
                { style: S.row },
                h('span', null, `彻底删除不可撤销，请输入目录名 ${record.name}`),
                h(Input, { value: typed, onChange: (event) => setTyped(event.target.value) }),
                h(
                  Button,
                  {
                    size: 'sm',
                    variant: 'outline',
                    style: { color: C.danger, borderColor: C.danger },
                    disabled: typed !== record.name || busy === 'purge',
                    onClick: () => act('purge', { confirm: typed }),
                  },
                  busy === 'purge' ? '删除中…' : '彻底删除',
                ),
                h(Button, { size: 'sm', variant: 'ghost', onClick: () => { setPurging(false); setTyped(''); } }, '取消'),
              )
            : h(
                Button,
                { size: 'sm', variant: 'outline', style: { color: C.danger, borderColor: C.danger }, onClick: () => setPurging(true) },
                '彻底删除…',
              ),
        ),
      );
    }

    /** One ledger row: header, path, a per-row delete confirm, and the content viewer. */
    function LedgerRow({ entry, files, token, open, confirming, busy, error, onToggle, onAskDelete, onCancelDelete, onConfirmDelete }) {
      const counts = entry.counts ?? {};
      return h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.row },
          h('strong', null, entry.label),
          h(Chips, { flags: entry.health }),
          h('span', { style: { flex: 1 } }),
          h(Button, { size: 'sm', variant: 'ghost', onClick: onToggle }, open ? '收起内容' : '查看内容'),
          entry.deletable
            ? h(Button, { size: 'sm', variant: 'ghost', style: { color: C.danger }, onClick: onAskDelete }, '删除')
            : h(Button, { size: 'sm', variant: 'ghost', disabled: true, title: entry.reason }, '不可删除'),
        ),
        h('div', { style: S.mono }, entry.dir),
        h(
          'div',
          { style: S.muted },
          `${human(entry.bytes)} · ${counts.mistakes ?? 0} 坑 / ${counts.decisions ?? 0} 决定 / 任务 ${counts.tasksActive ?? 0} 在飞 / ${counts.tasksDone ?? 0} 完成`,
        ),
        entry.deletable ? null : h('div', { style: S.muted }, entry.reason ?? '不可删除'),
        confirming
          ? h(
              'div',
              { style: { ...S.warn, ...S.row } },
              h(
                'span',
                { style: { flex: 1 } },
                entry.kind === 'machine'
                  ? '机器账本被所有项目共享。移入回收站后，所有项目都会暂时读不到它；它可以在本页的回收站里恢复。'
                  : `确认把「${entry.label}」移入回收站？目录会改名保留，可以恢复。`,
              ),
              h(Button, { size: 'sm', variant: 'primary', disabled: busy, onClick: onConfirmDelete }, busy ? '处理中…' : '确认移入回收站'),
              h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: onCancelDelete }, '取消'),
            )
          : null,
        error.length > 0 ? h('div', { style: S.error }, error) : null,
        open ? h(LedgerDetail, { entry, files, token, onClose: onToggle }) : null,
      );
    }

    function Console() {
      const [state, setState] = react.useState({ status: 'loading', data: null, error: '' });
      const [tab, setTab] = react.useState('project');
      const [openId, setOpenId] = react.useState(null);
      const [confirmId, setConfirmId] = react.useState(null);
      const [busyId, setBusyId] = react.useState('');
      const [rowError, setRowError] = react.useState({ id: '', message: '' });
      const [showTrash, setShowTrash] = react.useState(false);

      const load = react.useCallback(async () => {
        setState((previous) => ({ ...previous, status: 'loading', error: '' }));
        try {
          const response = await fetch(`${BASE}/ledgers`);
          const body = await response.json();
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
          setState({ status: 'ready', data: body, error: '' });
        } catch (thrown) {
          setState({
            status: 'error',
            data: null,
            error: `${String(thrown?.message ?? thrown)} — 宿主行没在跑？lib/ 的改动需要重启 DSH 才生效`,
          });
        }
      }, []);

      react.useEffect(() => {
        void load();
      }, [load]);

      const data = state.data;
      const ledgers = data?.ledgers ?? [];
      const machineEntries = ledgers.filter((entry) => entry.kind === 'machine');
      const projectGroups = (data?.groups ?? []).filter((group) => group.root !== '(machine)');
      const projectEntries = projectGroups.flatMap((group) => group.entries);
      const activeEntries = tab === 'machine' ? machineEntries : projectEntries;

      if (state.status === 'loading') return h('div', { style: S.wrap }, h('div', { style: S.muted }, '正在读取账本清单…'));
      if (state.status === 'error') {
        return h('div', { style: S.wrap }, h('div', { style: S.error }, state.error), h(Button, { size: 'sm', variant: 'outline', onClick: () => void load() }, '重试'));
      }

      const confirmDelete = async (entry) => {
        setBusyId(entry.id);
        setRowError({ id: '', message: '' });
        try {
          const response = await fetch(`${BASE}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-code-mode-token': data.token },
            body: JSON.stringify({ action: 'trash', id: entry.id }),
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
          setConfirmId(null);
          setOpenId(null);
          setShowTrash(true);
          await load();
        } catch (thrown) {
          setRowError({ id: entry.id, message: String(thrown?.message ?? thrown) });
        } finally {
          setBusyId('');
        }
      };

      const row = (entry) =>
        h(LedgerRow, {
          key: entry.id,
          entry,
          files: data.files,
          token: data.token,
          open: openId === entry.id,
          confirming: confirmId === entry.id,
          busy: busyId === entry.id,
          error: rowError.id === entry.id ? rowError.message : '',
          onToggle: () => setOpenId(openId === entry.id ? null : entry.id),
          onAskDelete: () => {
            setConfirmId(entry.id);
            setRowError({ id: '', message: '' });
          },
          onCancelDelete: () => setConfirmId(null),
          onConfirmDelete: () => void confirmDelete(entry),
        });

      const tabButton = (id, label, count) =>
        h(
          Button,
          {
            key: id,
            size: 'sm',
            variant: 'ghost',
            style: tab === id ? { background: 'var(--dsw-alias-interactive-bg-active)' } : undefined,
            onClick: () => {
              setTab(id);
              setOpenId(null);
              setConfirmId(null);
              setRowError({ id: '', message: '' });
            },
          },
          `${label} ${count}`,
        );

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: S.head },
          h('h3', { style: S.title }, '编程模式账本'),
          h('span', { style: S.muted }, `${ledgers.length} 个账本 · 回收站 ${(data.trash ?? []).length}`),
          h('span', { style: { flex: 1 } }),
          h(Button, { size: 'sm', variant: 'ghost', onClick: () => void load() }, '刷新'),
        ),
        h(
          'div',
          { style: S.tabs },
          tabButton('machine', '机器账本', machineEntries.length),
          tabButton('project', '项目账本', projectEntries.length),
        ),
        tab === 'machine'
          ? h(
              'div',
              { style: S.notice },
              `机器账本 ${data.machine}：所有项目共享。可以单独查看内容，也可以单独移入回收站；恢复后在所有项目里重新可见。`,
            )
          : h(
              'div',
              { style: S.notice },
              `项目账本 ${projectEntries.length} 个，按项目根目录分组。当前项目自己的账本会被标记为不可删除，先切换到别的项目再管理。`,
            ),
        activeEntries.length === 0
          ? h('div', { style: S.empty }, tab === 'machine' ? '没有机器账本。' : '没有项目账本。')
          : tab === 'machine'
            ? machineEntries.map(row)
            : projectGroups.map((group) =>
                h(
                  'div',
                  { key: group.root },
                  h(
                    'div',
                    { style: S.groupHead },
                    h('strong', null, group.root),
                    h('span', { style: S.muted }, `${group.entries.length} 个`),
                  ),
                  group.entries.map(row),
                ),
              ),
        (data.trash ?? []).length > 0
          ? h(
              'div',
              { style: { marginTop: 14 } },
              h(
                'div',
                { style: S.groupHead },
                h('strong', null, '回收站'),
                h('span', { style: S.muted }, `${data.trash.length} 个（可恢复）`),
                h('span', { style: { flex: 1 } }),
                h(Button, { size: 'sm', variant: 'ghost', onClick: () => setShowTrash((value) => !value) }, showTrash ? '收起' : '展开'),
              ),
              showTrash
                ? data.trash.map((record) => h(Trash, { key: record.id, record, token: data.token, onChanged: () => void load() }))
                : null,
            )
          : null,
      );
    }

    exports.name = 'code-ledger-console';

    // Declared, not assumed. A client plugin's `inject` list is what keeps `apply` from
    // running before the service it touches exists: without it the fiber starts
    // immediately, `ctx.slots` is still undefined, and the throw happens before the
    // shell can render anything. Every shipped settings section declares its services
    // the same way (`dsh-client-ui-settings-plugins` injects `slots`, `locale`, …).
    exports.inject = ['slots'];

    exports.apply = (ctx) => {
      // The seat is the slot itself: a shell that never declares `settings.section` simply
      // never runs this, and no version string is consulted.
      //
      // Contained on purpose. The Web boot audit treats *any* inactive client entry as a
      // fatal "entry did not activate" and replaces the whole shell with the failure
      // screen; one settings page must never be able to black-screen the application.
      // A broken slot API therefore costs this page, not the session.
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'code-ledgers',
              order: 55,
              label: () => '编程模式账本',
            },
            () => h(Console, null),
          ),
        );
      } catch (error) {
        console.error('[dsh-code-mode] ledger console section unavailable; the rest of the shell is unaffected:', error);
      }
    };
    return module.exports;
  },
});
