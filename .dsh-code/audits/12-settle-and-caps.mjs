/**
 * Audit probe 12 — three smaller claims, each with an A/B control.
 *
 * A. `isAncestorOrSelf` cannot match a RELATIVE edit target against an ABSOLUTE
 *    proof cwd, although ledger.js:1576-1578 says it can. Control: the same debt
 *    with an absolute target is settled.
 * B. The `pool >= UNCAPPED_TOTAL` ceilings branch: at which `maxChars` does it first
 *    fire, and can `briefFull` (which passes exactly UNCAPPED_TOTAL = 8900) reach it?
 * C. `recordTask`'s `slice(0, CAP.tasks)` cap: is a task dropped silently?
 *
 *   <node> .dsh-code\audits\12-settle-and-caps.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);

process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit12-global-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit12-'));
const SESSION = 'audit-12';
const OTHER = 'sess-earlier';

console.log('=== probe 12A: does a proof at the project root settle a RELATIVE edit target? ===');
const settleCase = (label, editLine) => {
  const dir = path.join(tmp, label.replace(/[^a-z0-9]+/gi, '-'));
  fs.mkdirSync(dir, { recursive: true });
  ledger.initLedger(dir, SESSION);
  // Clean the init line's session out of the way: the debt and the proof are the fixture.
  fs.writeFileSync(
    path.join(dir, '.dsh-code', 'journal.jsonl'),
    [
      JSON.stringify({ ts: '2026-10-01T00:00:00.000Z', session: OTHER, kind: 'unverified', turn: 1, edits: [editLine], cwd: dir, state: 'none' }),
      JSON.stringify({ ts: '2026-10-01T00:10:00.000Z', session: OTHER, kind: 'verified', cmd: 'pnpm test', cwd: dir, ok: true }),
      '',
    ].join('\n'),
    'utf8',
  );
  const text = ledger.brief(dir, { session: SESSION, maxChars: 8900 }).text;
  const at = text.indexOf('## Turns that changed code');
  const section = at < 0 ? '(section absent => the debt was settled)' : text.slice(at).split('\n\n## ')[0];
  return { label, editLine, dir, settled: at < 0, section };
};
for (const [label, editLine] of [
  ['ABSOLUTE target (inside the project the proof ran in)', `edit ${path.join(tmp, 'settle-target', 'lib', 'ledger.js')}`],
  ['RELATIVE target `edit lib/ledger.js`', 'edit lib/ledger.js'],
]) {
  const row = settleCase(label, editLine);
  // The absolute variant must name a path inside THIS fixture; rewrite the line accordingly.
  if (label.startsWith('ABSOLUTE')) {
    fs.writeFileSync(
      path.join(row.dir, '.dsh-code', 'journal.jsonl'),
      [
        JSON.stringify({ ts: '2026-10-01T00:00:00.000Z', session: OTHER, kind: 'unverified', turn: 1, edits: [`edit ${path.join(row.dir, 'lib', 'ledger.js')}`], cwd: row.dir, state: 'none' }),
        JSON.stringify({ ts: '2026-10-01T00:10:00.000Z', session: OTHER, kind: 'verified', cmd: 'pnpm test', cwd: row.dir, ok: true }),
        '',
      ].join('\n'),
      'utf8',
    );
    const text = ledger.brief(row.dir, { session: SESSION, maxChars: 8900 }).text;
    const at = text.indexOf('## Turns that changed code');
    row.settled = at < 0;
    row.section = at < 0 ? '(section absent => the debt was settled)' : text.slice(at).split('\n\n## ')[0];
  }
  console.log(`\n-- ${row.label}`);
  console.log(`   edit target: ${label.startsWith('ABSOLUTE') ? `edit ${path.join(row.dir, 'lib', 'ledger.js')}` : row.editLine}`);
  console.log(`   proof: cmd 'pnpm test', cwd '${row.dir}' (the project the edit was in)`);
  console.log(`   settled by that proof: ${row.settled}`);
  console.log(`   ${row.section.replace(/\n/g, '\n   ')}`);
}

console.log('\n=== probe 12B: at which maxChars does the ceilings branch first fire? ===');
const fat = path.join(tmp, 'fat');
fs.mkdirSync(fat, { recursive: true });
ledger.initLedger(fat, SESSION);
ledger.writeProject(
  fat,
  {
    commands: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`cmd${i}`, `pnpm run thing-${i} ${'z'.repeat(80)}`])),
    stack: `Node 24 pure ESM ${'s'.repeat(600)}`,
    layout: `lib/ core ${'l'.repeat(600)}`,
    notes: `n${'n'.repeat(1500)}`,
  },
  SESSION,
);
const projectBody = (maxChars) => {
  const text = ledger.brief(fat, { session: SESSION, maxChars }).text;
  const at = text.indexOf('## Project');
  if (at < 0) return -1;
  const rest = text.slice(at + '## Project'.length);
  const next = rest.search(/\n\n## |\n\n… \(/);
  return (next < 0 ? rest : rest.slice(0, next)).trim().length;
};
console.log('   maxChars | ## Project body (its ceiling is 1700; a divided share is smaller)');
for (const maxChars of [8800, 8900, 8948, 9000, 9050, 9100, 9150, 9200, 9300, 9500]) {
  console.log(`   ${String(maxChars).padStart(8)} | ${projectBody(maxChars)}`);
}
const fullProbe = ledger.briefFull(fat, { session: SESSION });
console.log(`   briefFull() = brief(maxChars: 8900) passes exactly UNCAPPED_TOTAL; its project body: ${projectBody(8900)}`);
console.log(`   briefFull's own text length: ${fullProbe.text.length}`);
console.log(`   => the ceilings branch needs maxChars >= UNCAPPED_TOTAL + reserve (> 8900), and briefFull passes exactly 8900`);

console.log('\n=== probe 12C: the task-board cap ===');
const board = path.join(tmp, 'board');
fs.mkdirSync(board, { recursive: true });
ledger.initLedger(board, SESSION);
const created = [];
for (let i = 1; i <= 41; i += 1) created.push(ledger.recordTask(board, { title: `open task number ${i}` }, SESSION).task.id);
const tasksFile = path.join(board, '.dsh-code', 'tasks.json');
const loaded = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
const journal = fs.readFileSync(path.join(board, '.dsh-code', 'journal.jsonl'), 'utf8');
const dropped = created.filter((id) => ![...loaded.active, ...loaded.done, ...loaded.blocked].some((t) => t.id === id));
console.log(`   tasks created: ${created.length}; board holds active=${loaded.active.length} done=${loaded.done.length} blocked=${loaded.blocked.length}`);
console.log(`   tasks created but absent from the board: ${JSON.stringify(dropped)}`);
console.log(`   the journal mentions the dropped task as removed: ${dropped.some((id) => journal.includes(`"${id}"`) && journal.includes('remove'))}`);
console.log(`   the dropped task's creation line is still in the journal: ${dropped.every((id) => journal.includes(id))}`);
const briefText = ledger.brief(board, { session: SESSION, maxChars: 4000 }).text;
console.log(`   the brief says anything about the dropped task or a cap on the board: ${dropped.some((id) => briefText.includes(id)) || /board[^.\n]*cap|task[s]? dropped/i.test(briefText)}`);
