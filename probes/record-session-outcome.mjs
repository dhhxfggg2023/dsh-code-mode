/**
 * Record this session's outcome directly in the ledger store.
 *
 * `code_record` cannot be used for this: the *running* plugin still holds the old code, so its
 * writes would land in `<repo>/.dsh-code/` — exactly the split this session removed — while the
 * next session reads `~/.dsh/code/`. The entries below go where the new code looks.
 *
 * Usage: node probes/record-session-outcome.mjs [--apply]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const HOME = path.join(os.homedir(), '.dsh', 'code');
const now = new Date().toISOString().slice(0, 10);

const mistake = [
  '',
  `## ${now} · 账本搬到-c-盘用户目录的-单个顶层目录-换机器时不要重建第二个-dsh-code-y8k2m`,
  '- symptom: 用户报告"C 盘垃圾太多/不要乱创建文件夹"，而账本当时散在两处：每个项目一份 `<repo>/.dsh-code/`，机器层一份 `~/.dsh-code/`（用户目录下第二个 dsh 顶层目录）。',
  '- cause: 项目账本按设计随项目走，机器账本按设计随机器走，两处各自合理，合起来就是"多个顶层目录 + 每个仓库一个隐藏目录"。',
  '- fix: 项目账本迁移进 `~/.dsh/code/projects/<slug>/`（由 `<repo>/.dsh-code/CENTRAL` 指针显式触发迁移，读写都跟着指针走）；机器账本搬到 `~/.dsh/code/`——即 DSH 自己的目录里面，不再新增顶层目录。旧 `~/.dsh-code/` 已退役删除。',
  '- do not repeat: 给这台机器上的 DSH 插件选数据目录时，不要新建 `~/.<插件名>` 这种顶层目录——用户明确不要 C 盘多出文件夹，`~/.dsh/` 已经是 DSH 的合法位置（里面已有 profiles/ sessions/ storages/）。另外：删目录前先比对两边同名文件的**字节数**，并注意正在运行的旧插件还在往旧路径写（本次实测旧文件在被复制后仍长了 2 字节，脚本因此拒绝退役，等它安静下来才删）。',
  '',
].join('\n');

const decisions = [
  '',
  `## ${now} · 账本只有一个家：~/.dsh/code/`,
  '',
  '- 机器账本（跨项目事实）：`~/.dsh/code/` —— `project.json` / `decisions.md` / `mistakes.md` / `journal.jsonl`（机器层没有任务板，设计如此）。',
  '- 项目账本（随项目走的那份）：`~/.dsh/code/projects/<项目名>-<8位哈希>\\`，目录里有 `project-root` 文件写明它属于哪个项目。',
  '- 迁移过的项目在仓库里只留一个 3 行指针 `<repo>/.dsh-code/CENTRAL`（内容 `central <项目绝对路径>`）。**没有指针就不迁移**——这是刻意的：`guard-probe` 等 25+ 个判据会手工播种 `<fixture>/.dsh-code/`，把"新项目一律进统一库"会让一个文件出现两个所有者（实测把该探针从 45 项全绿变成红）。',
  '- 已迁移：另外三个项目（各自 7KB–2.8MB，其中一个含 4 个 journal 轮转段）与本包自己。旧目录里的副本已删除，各仓库现在只剩指针。',
  '- 迁移工具：`probes/migrate-ledgers.mjs`（默认预演，`--apply` 才动；复制不搬、目标已存在先存 `.bak`、带"读方就绪"预检）；退役工具：`probes/retire-machine-ledger-home.mjs`（逐文件比对字节数才删，含递归比对）；判据：`probes/ledger-store-probe.mjs` S1–S8。',
  '',
].join('\n');

const journal = [
  JSON.stringify({
    ts: new Date().toISOString(),
    session: 'session-manual-ledger-move',
    kind: 'note',
    scope: 'global',
    note: 'ledger home moved to ~/.dsh/code (machine ledger + projects/<slug> store); per-project ledgers migrated and their local copies deleted; old ~/.dsh-code retired',
  }),
  '',
].join('\n');

const plan = [
  { file: path.join(HOME, 'mistakes.md'), text: mistake, label: 'machine mistake entry' },
  { file: path.join(HOME, 'decisions.md'), text: decisions, label: 'machine decision entry' },
  { file: path.join(HOME, 'journal.jsonl'), text: journal, label: 'machine journal note' },
];

console.log(JSON.stringify(plan.map((item) => ({ file: item.file, label: item.label, exists: fs.existsSync(item.file), appendChars: item.text.length, apply: APPLY })), null, 1));
if (!APPLY) {
  console.log('dry run: pass --apply to append these three entries');
} else {
  for (const item of plan) fs.appendFileSync(item.file, item.text, 'utf8');
  console.log(JSON.stringify({ appended: plan.map((item) => item.file) }, null, 1));
}
