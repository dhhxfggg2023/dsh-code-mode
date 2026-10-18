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
 * What this file deliberately does NOT use: the locale service, the theme service and the
 * ui-primitives module. Each is a version-coupled dependency (`dshmarket` carries three
 * fallback seats because those names moved twice), and none of them is needed to render a
 * list, a `<pre>` and four buttons. The page renders with `react.createElement` and inline
 * styles only, and reads `color: inherit` so it follows whatever theme the shell is in.
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
    const module = { exports: {} };
    const exports = module.exports;

    /** Where the host row serves from. Changing it means changing `web-routes.js` too. */
    const BASE = '/code-mode';

    const S = {
      wrap: { padding: '4px 2px', fontSize: 13, lineHeight: 1.5, color: 'inherit' },
      head: { display: 'flex', alignItems: 'baseline', gap: 10, margin: '0 0 10px' },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      muted: { opacity: 0.65, fontSize: 12 },
      btn: {
        font: 'inherit',
        padding: '3px 10px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,0.45)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      btnDanger: { borderColor: 'rgba(220,80,80,0.6)', color: '#d05050' },
      card: {
        border: '1px solid rgba(128,128,128,0.28)',
        borderRadius: 8,
        padding: '10px 12px',
        margin: '0 0 10px',
      },
      groupHead: { display: 'flex', alignItems: 'baseline', gap: 8, margin: '12px 0 6px' },
      groupPath: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, wordBreak: 'break-all' },
      row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 0' },
      chip: {
        fontSize: 11,
        padding: '1px 6px',
        borderRadius: 999,
        border: '1px solid rgba(128,128,128,0.4)',
        whiteSpace: 'nowrap',
      },
      chipBad: { borderColor: 'rgba(220,80,80,0.6)', color: '#d05050' },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11, wordBreak: 'break-all' },
      pre: {
        maxHeight: 420,
        overflow: 'auto',
        background: 'rgba(128,128,128,0.10)',
        borderRadius: 6,
        padding: 8,
        fontFamily: 'ui-monospace, Consolas, monospace',
        fontSize: 11.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      error: {
        border: '1px solid rgba(220,80,80,0.6)',
        color: '#d05050',
        borderRadius: 6,
        padding: '6px 10px',
        margin: '0 0 10px',
      },
      notice: {
        borderRadius: 6,
        padding: '6px 10px',
        margin: '0 0 10px',
        background: 'rgba(128,128,128,0.10)',
      },
      warn: {
        border: '1px solid rgba(220,160,60,0.55)',
        borderRadius: 6,
        padding: '6px 10px',
        margin: '6px 0 0',
      },
      empty: { padding: '10px 2px', opacity: 0.7 },
      tabs: { display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0' },
      tab: { font: 'inherit', fontSize: 12, padding: '2px 8px', borderRadius: 999, cursor: 'pointer', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit' },
      tabOn: { background: 'rgba(128,128,128,0.22)' },
      input: {
        font: 'inherit',
        fontSize: 12,
        padding: '3px 8px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,0.45)',
        background: 'transparent',
        color: 'inherit',
      },
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

    /** The read-only viewer for one ledger: file tabs, the text, and the collapse action. */
    function LedgerDetail({ entry, files, onClose }) {
      const [file, setFile] = react.useState('mistakes.md');
      const [view, setView] = react.useState({ status: 'loading', text: '', error: '', truncated: false, segments: [] });

      const loadFile = react.useCallback(
        async (name) => {
          setView({ status: 'loading', text: '', error: '', truncated: false, segments: [] });
          try {
            const response = await fetch(`${BASE}/ledger?id=${encodeURIComponent(entry.id)}&file=${encodeURIComponent(name)}`);
            const body = await response.json();
            if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
            setView({ status: 'ready', text: body.text ?? '', error: '', truncated: body.truncated === true, segments: body.segments ?? [] });
          } catch (thrown) {
            setView({ status: 'error', text: '', error: String(thrown?.message ?? thrown), truncated: false, segments: [] });
          }
        },
        [entry.id],
      );

      react.useEffect(() => {
        void loadFile(file);
      }, [file, loadFile]);

      return h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.row },
          h('strong', null, entry.label),
          h(Chips, { flags: entry.health }),
          h('span', { style: { flex: 1 } }),
          h('button', { style: S.btn, onClick: onClose }, '收起'),
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
          files.map((name) => h('button', { key: name, style: { ...S.tab, ...(name === file ? S.tabOn : {}) }, onClick: () => setFile(name) }, name)),
        ),
        view.status === 'loading'
          ? h('div', { style: S.muted }, '读取中…')
          : view.status === 'error'
            ? h('div', { style: S.error }, view.error)
            : h(
                'div',
                null,
                view.truncated ? h('div', { style: S.muted }, `内容过长，只显示了一部分${view.segments?.length ? `；journal 合并了 ${view.segments.length} 段` : ''}`) : null,
                h('pre', { style: S.pre }, view.text.length === 0 ? '(空)' : view.text),
              ),
        h(
          'div',
          { style: { ...S.row, marginTop: 8 } },
          h('span', { style: S.muted }, '删除请用列表这一行的「删除」按钮；这里只读。'),
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
          h('button', { style: S.btn, disabled: busy === 'restore' || purging, onClick: () => act('restore') }, busy === 'restore' ? '恢复中…' : '恢复到原位置'),
          purging
            ? h(
                'span',
                { style: S.row },
                h('span', null, `彻底删除不可撤销，请输入目录名 ${record.name}`),
                h('input', { style: S.input, value: typed, onChange: (event) => setTyped(event.target.value) }),
                h('button', { style: { ...S.btn, ...S.btnDanger }, disabled: typed !== record.name || busy === 'purge', onClick: () => act('purge', { confirm: typed }) }, busy === 'purge' ? '删除中…' : '彻底删除'),
                h('button', { style: S.btn, onClick: () => { setPurging(false); setTyped(''); } }, '取消'),
              )
            : h('button', { style: { ...S.btn, ...S.btnDanger }, onClick: () => setPurging(true) }, '彻底删除…'),
        ),
      );
    }

    /** One ledger row: header, path, a per-row delete confirm, and the content viewer. */
    function LedgerRow({ entry, files, open, confirming, busy, error, onToggle, onAskDelete, onCancelDelete, onConfirmDelete }) {
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
          h('span', { style: S.muted }, `${human(entry.bytes)} · ${counts.mistakes ?? 0} 坑 / ${counts.decisions ?? 0} 决定 / 任务 ${counts.tasksActive ?? 0} 在飞 / ${counts.tasksDone ?? 0} 完成`),
          h('button', { style: S.btn, onClick: onToggle }, open ? '收起内容' : '查看内容'),
          entry.deletable
            ? h('button', { style: { ...S.btn, ...S.btnDanger }, onClick: onAskDelete }, '删除')
            : h('button', { style: { ...S.btn, opacity: 0.55, cursor: 'not-allowed' }, disabled: true, title: entry.reason }, '不可删除'),
        ),
        h('div', { style: S.mono }, entry.dir),
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
              h('button', { style: { ...S.btn, ...S.btnDanger }, disabled: busy, onClick: onConfirmDelete }, busy ? '处理中…' : '确认移入回收站'),
              h('button', { style: S.btn, disabled: busy, onClick: onCancelDelete }, '取消'),
            )
          : null,
        error.length > 0 ? h('div', { style: S.error }, error) : null,
        open ? h(LedgerDetail, { entry, files, onClose: onToggle }) : null,
      );
    }

    function Console() {
      const [state, setState] = react.useState({ status: 'loading', data: null, error: '' });
      const [tab, setTab] = react.useState('project');
      const [openId, setOpenId] = react.useState(undefined);
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

      // Content first: the first ledger of the selected tab opens its files immediately, so
      // the tab shows actual text rather than one more click target. `undefined` means
      // "nothing chosen yet"; `null` means the user collapsed it and must stay collapsed.
      react.useEffect(() => {
        if (data === undefined || data === null) return;
        if (openId !== undefined) return;
        const pool =
          tab === 'machine'
            ? (data.ledgers ?? []).filter((entry) => entry.kind === 'machine')
            : (data.groups ?? []).filter((group) => group.root !== '(machine)').flatMap((group) => group.entries);
        setOpenId(pool[0]?.id ?? null);
      }, [data, tab, openId]);

      if (state.status === 'loading') return h('div', { style: S.wrap }, h('div', { style: S.muted }, '正在读取账本清单…'));
      if (state.status === 'error') {
        return h('div', { style: S.wrap }, h('div', { style: S.error }, state.error), h('button', { style: S.btn, onClick: () => void load() }, '重试'));
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
          setOpenId(undefined);
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
          'button',
          {
            key: id,
            style: { ...S.tab, ...(tab === id ? S.tabOn : {}) },
            onClick: () => {
              setTab(id);
              setOpenId(undefined);
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
          h('button', { style: S.btn, onClick: () => void load() }, '刷新'),
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
                h('button', { style: S.btn, onClick: () => setShowTrash((value) => !value) }, showTrash ? '收起' : '展开'),
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
