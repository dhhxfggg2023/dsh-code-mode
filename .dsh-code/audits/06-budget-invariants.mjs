/**
 * Audit probe 06 — the two budget invariants the briefing documents for itself.
 *
 * A. `shapeEntries` documents "the returned text never exceeds `limit`" as its
 *    first guarantee, while the single-entry branch deliberately returns more.
 * B. `allocateSectionBudget`'s ceilings branch (`pool >= UNCAPPED_TOTAL`) is the
 *    branch `briefFull` exists to take — but `pool` is the budget MINUS the
 *    reserve, and `briefFull` passes exactly `UNCAPPED_TOTAL`.
 * C. When section bodies overrun their allowances, the only remaining bound is the
 *    final head-`clip`, which removes the tail — where the retrieval hint and the
 *    omission notices live. Does the brief then lose its own index line while
 *    still reporting no omissions?
 *
 *   <node> .dsh-code\audits\06-budget-invariants.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit06-'));
const SESSION = 'audit-06';
const HINT = 'This brief is a selection, not the ledger';

/** A fresh project with everything a real one has: fat project.json, one long entry
 *  per entry-bearing section, a board, and both journal debts from an earlier session. */
const richProject = (tag, entryChars) => {
  const dir = path.join(tmp, tag);
  fs.mkdirSync(dir, { recursive: true });
  const global = path.join(tmp, `${tag}-global`);
  fs.mkdirSync(global, { recursive: true });
  process.env.DSH_CODE_GLOBAL_DIR = global;
  ledger.initLedger(global, SESSION, 'global');
  ledger.writeProject(
    global,
    {
      node: `E:\\tools\\node.exe (${'x'.repeat(200)})`,
      shell: `pwsh -NoProfile (${'x'.repeat(200)})`,
      host: `windows 11, ${'y'.repeat(300)}`,
    },
    SESSION,
    'global',
  );
  for (let i = 0; i < 6; i += 1) {
    ledger.recordMistake(
      global,
      {
        symptom: `MACHINE-PIT-${i} ${'m'.repeat(80)}`,
        cause: `cause ${'c'.repeat(120)}`,
        fix: `fix ${'f'.repeat(120)}`,
        avoid: `never do machine thing ${i} because it bites: ${'a'.repeat(120)}`,
        trigger: `npm run machine-${i}`,
      },
      SESSION,
      'global',
    );
  }
  ledger.initLedger(dir, SESSION);
  ledger.writeProject(
    dir,
    {
      commands: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`cmd${i}`, `pnpm run thing-${i} --flag ${'z'.repeat(60)}`])),
      stack: `Node 24, pure ESM (${'s'.repeat(400)})`,
      layout: `lib/ core (${'l'.repeat(400)})`,
      notes: `n${'n'.repeat(1500)}`,
    },
    SESSION,
  );
  ledger.recordTask(dir, { title: 'Fixture task with a long acceptance line', acceptance: 'a'.repeat(200) }, SESSION);
  ledger.recordMistake(
    dir,
    {
      symptom: 'SINGLE-LONG-MISTAKE-SYMPTOM',
      cause: 'LONGCAUSE '.repeat(Math.ceil(entryChars / 10)).slice(0, entryChars),
      fix: 'LONGFIX '.repeat(10).slice(0, 200),
      files: 'lib/ledger.js:2086',
      avoid: 'LONGRULE '.repeat(Math.ceil(entryChars / 9)).slice(0, entryChars),
    },
    SESSION,
  );
  ledger.recordDecision(
    dir,
    {
      title: 'SINGLE-LONG-DECISION',
      body: 'LONGBODY '.repeat(Math.ceil(entryChars / 9)).slice(0, entryChars),
      alternatives: 'REJECTED '.repeat(10).slice(0, 150),
    },
    SESSION,
  );
  const journal = path.join(dir, '.dsh-code', 'journal.jsonl');
  fs.appendFileSync(
    journal,
    `${JSON.stringify({ ts: '2026-10-01T00:00:00.000Z', session: 'sess-earlier', kind: 'unverified', turn: 3, edits: ['write src/important.js'], state: 'none' })}\n`,
    'utf8',
  );
  fs.appendFileSync(
    journal,
    `${JSON.stringify({ ts: '2026-10-01T00:01:00.000Z', session: 'sess-earlier', kind: 'mistake_unrecorded', turn: 3, failures: [{ cmd: 'pnpm test', signature: 'TypeError: x is not a function' }] })}\n`,
    'utf8',
  );
  for (let i = 0; i < 4; i += 1) {
    ledger.journalEvent(dir, { session: 'sess-earlier', kind: 'note', title: `earlier journal line ${i}` });
  }
  return dir;
};

console.log('=== probe 06A: shapeEntries vs its own first guarantee ===');
const oneEntry = ['## 2026-10-01 · big', `- symptom: ${'s'.repeat(300)}`, `- cause: ${'c'.repeat(300)}`, `- fix: ${'f'.repeat(300)}`, '- do not repeat: something'].join('\n');
for (const limit of [30, 200, 700]) {
  const shaped = ledger.shapeEntries([oneEntry], limit);
  console.log(
    `   shapeEntries([entry ${oneEntry.length} chars], limit=${limit}) -> text ${shaped.text.length} chars, full=${shaped.full}  EXCEEDS LIMIT: ${shaped.text.length > limit}`,
  );
}
const twoEntries = ledger.shapeEntries([oneEntry, `${oneEntry}\n- extra: yes`], 700);
console.log(`   control with 2 entries, limit=700 -> text ${twoEntries.text.length} chars (within limit: ${twoEntries.text.length <= 700})`);

console.log('\n=== probe 06B: can `briefFull` ever reach the ceilings branch? ===');
const dir = richProject('budget', 1150);
const sectionOf = (text, heading) => {
  const at = text.indexOf(heading);
  if (at < 0) return { present: false, chars: 0 };
  const rest = text.slice(at + heading.length);
  const next = rest.search(/\n\n## |\n\n… \(/);
  return { present: true, chars: (next < 0 ? rest : rest.slice(0, next)).trim().length };
};
console.log('   maxChars | text chars | ## Project body | ## Known mistakes body | ends with … | hint present');
for (const maxChars of [4000, 8800, 8900, 8948, 9000, 9400, 12000, 20000]) {
  const out = ledger.brief(dir, { session: SESSION, maxChars });
  const project = sectionOf(out.text, '## Project');
  const mistakes = sectionOf(out.text, '## Known mistakes');
  console.log(
    `   ${String(maxChars).padStart(8)} | ${String(out.text.length).padStart(10)} | ${String(project.chars).padStart(15)} | ${String(mistakes.chars).padStart(22)} | ${String(out.text.endsWith('…')).padStart(11)} | ${out.text.includes(HINT)}`,
  );
}
const full = ledger.briefFull(dir, { session: SESSION });
const generous = ledger.brief(dir, { session: SESSION, maxChars: 20000 });
console.log(`   briefFull()            -> ${full.text.length} chars, project body ${sectionOf(full.text, '## Project').chars}`);
console.log(`   brief(maxChars: 20000) -> ${generous.text.length} chars, project body ${sectionOf(generous.text, '## Project').chars}`);
console.log(`   briefFull lifts the division: ${sectionOf(full.text, '## Project').chars === sectionOf(generous.text, '## Project').chars}`);

console.log('\n=== probe 06C: when the sections overrun, what gets clipped away? ===');
console.log('   maxChars | text chars | ends with … | omission notices present | hint present | omitted[]');
for (const maxChars of [4000, 3600, 3000, 2400, 1800, 1200]) {
  const out = ledger.brief(dir, { session: SESSION, maxChars });
  const hasNotice = /ledger section\(s\) dropped for length|exist in the ledger but had no entry/.test(out.text);
  console.log(
    `   ${String(maxChars).padStart(8)} | ${String(out.text.length).padStart(10)} | ${String(out.text.endsWith('…')).padStart(11)} | ${String(hasNotice).padStart(24)} | ${String(out.text.includes(HINT)).padStart(12)} | ${JSON.stringify(out.omitted)}`,
  );
  if (maxChars === 2400) {
    console.log('\n   --- the 2400-char brief, verbatim tail (last 300 chars) ---');
    console.log(`   ${JSON.stringify(out.text.slice(-300))}`);
    console.log(`   --- sections present: ${['## Project', '## Task board', '## Recent ledger entries', '## Turns that changed code', '## Failing commands nobody', '## Known mistakes', '## Recent decisions'].filter((h) => out.text.includes(h)).join(' | ')}`);
  }
}
