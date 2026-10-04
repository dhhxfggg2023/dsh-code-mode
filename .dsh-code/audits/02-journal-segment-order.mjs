/**
 * Audit probe 02 — journal rotation writes `.000` = NEWEST segment, while every
 * reader treats the ascending name order as oldest-first.
 *
 * Builds a fixture ledger in os.tmpdir() that is rotated twice (real
 * `journalEvent` calls trigger the real `rotateJournal`), then asks the real
 * `restartPending` / `brief` what the ledger says. The ledger's own `ts` fields
 * are the independent truth: they prove which event came last.
 *
 *   <node> .dsh-code\audits\02-journal-segment-order.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);

process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit02-global-'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit02-'));
const SESSION = 'audit-02';
const ROTATE_AT = 512 * 1024;

ledger.initLedger(dir, SESSION);
const journal = path.join(dir, '.dsh-code', 'journal.jsonl');
const seg = (n) => path.join(dir, '.dsh-code', `journal.jsonl.${String(n).padStart(3, '0')}`);
const size = (file) => (fs.existsSync(file) ? fs.statSync(file).size : -1);
/** Filler is written straight into the live journal: rotation is driven by size alone. */
const fill = (tag) => {
  const chunk = `${JSON.stringify({ ts: new Date().toISOString(), session: 'filler', kind: 'filler', title: tag })}\n`;
  let n = 0;
  while (size(journal) <= ROTATE_AT) {
    fs.appendFileSync(journal, chunk.repeat(200), 'utf8');
    n += 1;
  }
  return n;
};

// 1. an OLD session_start, then enough content to rotate once.
ledger.journalEvent(dir, { session: 'sess-OLD', kind: 'session_start', processBoot: 'boot-old' });
const fillsA = fill('OLD-SEGMENT');
ledger.journalEvent(dir, { session: SESSION, kind: 'rotate-trigger', title: 'rotation-1-trigger' });
const afterFirstRotation = [size(seg(0)), size(seg(1)), size(journal)];

// 2. a restart_pending (NEWER than that session_start, nothing after it), then rotate again.
ledger.journalEvent(dir, { session: SESSION, kind: 'restart_pending', files: ['lib/ledger.js (probe fixture)'] });
const fillsB = fill('NEW-SEGMENT');
ledger.journalEvent(dir, { session: SESSION, kind: 'rotate-trigger', title: 'rotation-2-trigger' });
const afterSecondRotation = [size(seg(0)), size(seg(1)), size(journal)];

// 3. what the readers answer.
const files = ledger.journalFiles(dir, 'project').map((f) => path.basename(f));
const text = ledger.readJournalText(dir, 'project');
const lines = text.split('\n').filter((l) => l.trim().length > 0);
const tsOf = (line) => {
  try {
    return JSON.parse(line).ts ?? '(no ts)';
  } catch {
    return '(unparseable)';
  }
};
const firstOf = (file) => {
  const l = fs.readFileSync(file, 'utf8').split('\n').filter((x) => x.trim().length > 0);
  return { first: tsOf(l[0]), last: tsOf(l[l.length - 1]) };
};
const pending = ledger.restartPending(dir);
const briefText = ledger.brief(dir, { session: SESSION, maxChars: 8900 }).text;
const recentAt = briefText.indexOf('## Recent ledger entries');
const recentBody = recentAt < 0 ? '(section absent)' : briefText.slice(recentAt, briefText.indexOf('\n\n', recentAt)).trim();

console.log('=== probe 02: journal segment order after two real rotations ===');
console.log(`fixture: ${dir}`);
console.log(`fills: A=${fillsA} chunks, B=${fillsB} chunks (each chunk = 200 journal lines)`);
console.log(`segment sizes after rotation 1 [.000 .001 live] = ${JSON.stringify(afterFirstRotation)}`);
console.log(`segment sizes after rotation 2 [.000 .001 live] = ${JSON.stringify(afterSecondRotation)}`);
console.log(`journalFiles() = ${JSON.stringify(files)}`);
console.log('\n-- timestamps at each segment boundary, in journalFiles() order (readers concatenate in this order)');
for (const name of files) {
  const info = firstOf(path.join(dir, '.dsh-code', name));
  console.log(`   ${name.padEnd(22)} first=${info.first}  last=${info.last}`);
}
console.log('\n-- ts of the two events whose ORDER is the question');
for (const line of lines) {
  if (!line.includes('session_start') && !line.includes('restart_pending')) continue;
  console.log(`   ${tsOf(line)}  ${line.slice(0, 150)}`);
}
console.log('\n-- concatenated (reader) order: is it monotonic in ts?');
let previous = '';
let inversions = 0;
for (const line of lines) {
  const ts = tsOf(line);
  if (ts.startsWith('(')) continue;
  if (previous !== '' && ts < previous) inversions += 1;
  previous = ts;
}
console.log(`   adjacent lines whose ts goes BACKWARDS: ${inversions} of ${lines.length} lines`);

const lastStart = lines
  .map((line) => (line.includes('"kind":"session_start"') ? tsOf(line) : undefined))
  .filter(Boolean)
  .pop();
const restartLine = lines.find((line) => line.includes('"kind":"restart_pending"'));
const truth = lastStart !== undefined && restartLine !== undefined && tsOf(restartLine) > lastStart;
console.log('\n-- the question the notice answers: is a lib/ change still dormant?');
console.log(`   newest session_start ts = ${lastStart}`);
console.log(`   restart_pending   ts = ${restartLine === undefined ? '(none)' : tsOf(restartLine)}`);
console.log(`   TRUTH from the ledger's own ts fields: restart IS still pending = ${truth}`);
console.log(`   restartPending() answered: ${pending === undefined ? 'undefined  <-- NOTICE SILENTLY DROPPED' : JSON.stringify(pending)}`);

console.log('\n-- brief(): the "Recent ledger entries" section, same fixture');
console.log(recentBody);
const showsOld = recentBody.includes('OLD-SEGMENT');
const showsNew = recentBody.includes('NEW-SEGMENT');
console.log(`   mentions OLD-SEGMENT (oldest segment): ${showsOld};  mentions NEW-SEGMENT (newer segment): ${showsNew}`);

console.log('\nSUMMARY');
console.log(`   order inversion (ts decreases inside readJournalText): ${inversions > 0}`);
console.log(`   restartPending() contradicts the ledger's own timestamps: ${truth && pending === undefined}`);
