/**
 * Audit probe 05 — the merge path duplicates entry #1 whenever mistakes.md carries
 * no header line before its first entry.
 *
 * `headerOf` returns everything before the first `\n## `, and the merge writes
 * `header + '\n\n' + allBlocks` — so when the file *starts* with an entry, that
 * entry is emitted twice (once as the "header", once as a block), and the copy in
 * the header is the stale one. Every further repeat duplicates it again.
 *
 *   <node> .dsh-code\audits\05-merge-header-duplication.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);

process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit05-global-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit05-'));
const SESSION = 'audit-05';
const ENTRY = ['## 2026-10-01 · alpha-something', '- symptom: alpha something happened', '- cause: a cause', '- fix: a fix', '- files: src/a.js', '- do not repeat: the alpha rule'].join('\n');
const SECOND = ['## 2026-10-01 · beta-something', '- symptom: beta something happened', '- cause: b cause', '- fix: b fix', '- files: src/b.js', '- do not repeat: the beta rule'].join('\n');

const build = (label, body, bom) => {
  const dir = path.join(tmp, label);
  fs.mkdirSync(path.join(dir, '.dsh-code'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.dsh-code', 'projects.json'), '{}\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, '.dsh-code', 'mistakes.md'),
    `${bom ? '\ufeff' : ''}${body}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(dir, '.dsh-code', 'journal.jsonl'), '', 'utf8');
  return dir;
};
const headings = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim()) // mirrors markdownEntries(), which trims (and so strips a BOM)
    .filter((line) => line.startsWith('## '));
const report = (label, dir) => {
  const file = path.join(dir, '.dsh-code', 'mistakes.md');
  const once = ledger.recordMistake(dir, { symptom: 'alpha something happened', cause: 'c', fix: 'f', avoid: 'the alpha rule', files: 'src/a.js' }, SESSION);
  const afterOne = headings(file);
  const twice = ledger.recordMistake(dir, { symptom: 'alpha something happened', cause: 'c', fix: 'f', avoid: 'the alpha rule', files: 'src/a.js' }, SESSION);
  const afterTwo = headings(file);
  const text = fs.readFileSync(file, 'utf8');
  console.log(`\n-- ${label}`);
  console.log(`   merged=${once.merged} recurred=${once.recurred} -> headings: ${afterOne.length} ${JSON.stringify(afterOne.map((h) => h.slice(3)))}`);
  console.log(`   merged=${twice.merged} recurred=${twice.recurred} -> headings: ${afterTwo.length} ${JSON.stringify(afterTwo.map((h) => h.slice(3)))}`);
  console.log(`   file bytes: ${text.length}; 'alpha something happened' occurrences: ${text.split('alpha something happened').length - 1}`);
  return { label, afterOne: afterOne.length, afterTwo: afterTwo.length };
};

console.log('=== probe 05: merge path vs a header-less mistakes.md ===');
const results = [
  report('header+entry (as initLedger writes it)', build('with-header', `# Mistakes\n\n${ENTRY}\n\n${SECOND}`, false)),
  report('entry first, NO header line', build('headerless', `${ENTRY}\n\n${SECOND}`, false)),
  report('BOM + header+entry', build('bom-header', `# Mistakes\n\n${ENTRY}\n\n${SECOND}`, true)),
  report('BOM + entry first, NO header', build('bom-headerless', `${ENTRY}\n\n${SECOND}`, true)),
];

console.log('\n=== probe 05b: what a BOM does to the READER, before any write ===');
const GAMMA = ['## 2026-10-01 · gamma-something', '- symptom: gamma something happened', '- cause: g', '- fix: g', '- do not repeat: the gamma rule'].join('\n');
for (const [label, bom] of [['plain', false], ['BOM', true]]) {
  const dir = build(`reader-${label}`, `${ENTRY}\n\n${SECOND}\n\n${GAMMA}`, bom);
  const file = path.join(dir, '.dsh-code', 'mistakes.md');
  const onDisk = fs.readFileSync(file, 'utf8');
  const seen = headings(file).map((h) => h.slice(3));
  const briefText = ledger.brief(dir, { session: SESSION, maxChars: 8900 }).text;
  console.log(`\n-- mistakes.md written with a ${label} first byte`);
  console.log(`   on disk: ${onDisk.split('\n').filter((l) => l.startsWith('## ') || l.startsWith('\ufeff## ')).length} heading lines, ${onDisk.length} bytes`);
  console.log(`   markdownEntries-visible headings: ${seen.length} ${JSON.stringify(seen)}`);
  console.log(`   brief shows the FIRST entry's symptom ("alpha something happened"): ${briefText.includes('alpha something happened')}`);
  console.log(`   brief shows the FIRST entry's rule ("the alpha rule"): ${briefText.includes('the alpha rule')}`);
  console.log(`   API reader count (markdownEntries semantics, first byte ${label}): ${headings(file).length}`);
}

console.log('\nSUMMARY (entry count after two repeats of the same pit)');
for (const row of results) console.log(`   ${row.label.padEnd(40)} entries after 1st=${row.afterOne}  after 2nd=${row.afterTwo}`);
