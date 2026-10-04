/**
 * Audit probe 03 — does journal rotation keep working after the shift loop saturates?
 *
 * `rotateJournal` shifts `.00N` -> `.00(N+1)` for N = JOURNAL_KEEP-1 .. 0 and then
 * renames the live file to `.000`. Once `.008` exists, every `to` is occupied, the
 * loop moves nothing, and `if (fs.existsSync(target)) return undefined` refuses the
 * rotation — forever. This probe drives the real rotation 12 times and reports what
 * happens to the live file's size and the segment count.
 *
 *   <node> .dsh-code\audits\03-rotation-saturation.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);

process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit03-global-'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit03-'));
const ledgerDir = path.join(dir, '.dsh-code');
const journal = path.join(ledgerDir, 'journal.jsonl');
const ROTATE_AT = 512 * 1024;
const SESSION = 'audit-03';

ledger.initLedger(dir, SESSION);
const segments = () =>
  fs
    .readdirSync(ledgerDir)
    .filter((name) => name.startsWith('journal.jsonl.'))
    .sort();
const size = (file) => (fs.existsSync(file) ? fs.statSync(file).size : -1);
const fill = () => {
  const chunk = `${JSON.stringify({ ts: new Date().toISOString(), kind: 'filler', title: 'F'.repeat(120) })}\n`;
  while (size(journal) <= ROTATE_AT) fs.appendFileSync(journal, chunk.repeat(200), 'utf8');
};

console.log('=== probe 03: rotation after the shift loop saturates ===');
console.log(`fixture: ${dir}`);
console.log('round | segment files after the round | live journal bytes');
for (let round = 1; round <= 12; round += 1) {
  fill();
  const before = segments().length;
  ledger.journalEvent(dir, { session: SESSION, kind: 'rotate-trigger', title: `round-${round}` });
  const names = segments();
  console.log(
    `${String(round).padStart(5)} | count=${String(names.length).padStart(2)} max=${names.at(-1) ?? '-'} (before=${before}) | ${size(journal)}`,
  );
}

const names = segments();
const live = size(journal);
console.log('\n-- final state');
console.log(`   segment files: ${names.length} -> ${JSON.stringify(names)}`);
console.log(`   live journal: ${live} bytes (rotation threshold is ${ROTATE_AT})`);
console.log(`   live journal exceeds the threshold: ${live > ROTATE_AT}`);
const readBytes = ledger.readJournalText(dir, 'project').length;
console.log(`   readJournalText() must concatenate and every reader parses: ${readBytes} chars`);
console.log('\nSUMMARY');
console.log(`   rotation still works at the end: ${live <= ROTATE_AT}`);
console.log(`   segments created: ${names.length} (JOURNAL_KEEP=8, so the shift can only fill .000-.008)`);
