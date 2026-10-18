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
      machine: '机器账本（只读）',
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

    /** The viewer for one ledger: file tabs, the text, and the actions that move it aside. */
    function LedgerDetail({ entry, token, files, onChanged, onClose }) {
      const [file, setFile] = react.useState('mistakes.md');
      const [view, setView] = react.useState({ status: 'loading', text: '', error: '', truncated: false, segments: [] });
      const [busy, setBusy] = react.useState('');
      const [error, setError] = react.useState('');
      const [confirming, setConfirming] = react.useState(false);

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

      const act = async (action, extra = {}) => {
        setBusy(action);
        setError('');
        try {
          const response = await fetch(`${BASE}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-code-mode-token': token },
            body: JSON.stringify({ action, id: entry.id, ...extra }),
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
          onChanged();
          if (action === 'trash') onClose();
        } catch (thrown) {
          setError(String(thrown?.message ?? thrown));
        } finally {
          setBusy('');
          setConfirming(false);
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
          h('button', { style: S.btn, onClick: onClose }, '收起'),
        ),
        h('div', { style: S.mono }, entry.dir),
        h(
          'div',
          { style: S.row },
          h('span', { style: S.muted }, `mistakes ${entry.counts?.mistakes ?? 0} · decisions ${entry.counts?.decisions ?? 0} · 任务 ${entry.counts?.tasksActive ?? 0} 在飞 / ${entry.counts?.tasksDone ?? 0} 完成`),
          h('span', { style: S.muted }, `${human(entry.bytes)} · 最后写入 ${when(entry.lastWrite)}`),
        ),
        error.length > 0 ? h('div', { style: S.error }, error) : null,
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
        entry.deletable
          ? h(
              'div',
              { style: { ...S.row, marginTop: 8 } },
              confirming
                ? h(
                    'span',
                    { style: S.row },
                    h('span', null, `确认把这个账本移入回收站？(${entry.label})`),
                    h('button', { style: { ...S.btn, ...S.btnDanger }, disabled: busy === 'trash', onClick: () => act('trash') }, busy === 'trash' ? '处理中…' : '确认移入回收站'),
                    h('button', { style: S.btn, onClick: () => setConfirming(false) }, '取消'),
                  )
                : h('button', { style: S.btn, onClick: () => setConfirming(true) }, '移到回收站（可恢复）'),
              h('button', { style: S.btn, onClick: () => void navigator.clipboard?.writeText(entry.dir) }, '复制路径'),
            )
          : h('div', { style: { ...S.muted, marginTop: 8 } }, `不可删除：${entry.reason ?? '未说明'}`),
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
        h('div', { style: S.row }, h('strong', null, record.name), h('span', { style: S.muted }, `移入于 ${record.trashedAt ? new Date(record.trashedAt).toLocaleString() : '—'}`)),
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

    function Console() {
      const [state, setState] = react.useState({ status: 'loading', data: null, error: '' });
      const [openId, setOpenId] = react.useState(null);

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

      if (state.status === 'loading') return h('div', { style: S.wrap }, h('div', { style: S.muted }, '正在读取账本清单…'));
      if (state.status === 'error') {
        return h('div', { style: S.wrap }, h('div', { style: S.error }, state.error), h('button', { style: S.btn, onClick: () => void load() }, '重试'));
      }
      const data = state.data;
      const open = (data.ledgers ?? []).find((entry) => entry.id === openId);

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: S.head },
          h('h3', { style: S.title }, '编程模式账本'),
          h('span', { style: S.muted }, `${(data.ledgers ?? []).length} 个账本 · 回收站 ${(data.trash ?? []).length}`),
          h('span', { style: { flex: 1 } }),
          h('button', { style: S.btn, onClick: () => void load() }, '刷新'),
        ),
        h('div', { style: S.muted }, `机器账本 ${data.machine}（只读）· store ${data.store}`),
        open !== undefined
          ? h(LedgerDetail, { entry: open, token: data.token, files: data.files, onChanged: () => void load(), onClose: () => setOpenId(null) })
          : null,
        (data.groups ?? []).map((group) =>
          h(
            'div',
            { key: group.root },
            h(
              'div',
              { style: S.groupHead },
              h('strong', null, group.root === '(machine)' ? '机器账本' : group.root),
              h('span', { style: S.muted }, `${group.entries.length} 个`),
            ),
            group.entries.map((entry) =>
              h(
                'div',
                { key: entry.id, style: S.card },
                h(
                  'div',
                  { style: S.row },
                  h('strong', null, entry.label),
                  h(Chips, { flags: entry.health }),
                  h('span', { style: { flex: 1 } }),
                  h('span', { style: S.muted }, `${human(entry.bytes)} · ${entry.counts?.mistakes ?? 0} 坑 / ${entry.counts?.decisions ?? 0} 决定`),
                  h('button', { style: S.btn, onClick: () => setOpenId(entry.id) }, '查看'),
                ),
                h('div', { style: S.groupPath }, entry.dir),
              ),
            ),
          ),
        ),
        (data.trash ?? []).length > 0
          ? h(
              'div',
              null,
              h('div', { style: S.groupHead }, h('strong', null, '回收站'), h('span', { style: S.muted }, `${data.trash.length} 个（可恢复）`)),
              data.trash.map((record) => h(Trash, { key: record.id, record, token: data.token, onChanged: () => void load() })),
            )
          : null,
      );
    }

    exports.name = 'code-ledger-console';
    exports.apply = (ctx) => {
      // The seat is the slot itself: a shell that never declares `settings.section` simply
      // never runs this, and no version string is consulted.
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
    };
    return module.exports;
  },
});
