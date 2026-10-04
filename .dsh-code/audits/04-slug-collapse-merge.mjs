/**
 * Audit probe 04 — `slug()` collapses every non-CJK non-ASCII symptom to the same
 * heading, and `recordMistake` merges on that heading.
 *
 *   <node> .dsh-code\audits\04-slug-collapse-merge.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);

process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit04-global-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit04-'));
const SESSION = 'audit-04';

console.log('=== probe 04a: what slug() does to each script ===');
const samples = [
  'pnpm test fails on a clean checkout',
  '重启 DSH 后缓存整段失效',
  '\u041e\u0448\u0438\u0431\u043a\u0430 \u043f\u0440\u0438 \u0441\u0431\u043e\u0440\u043a\u0435 \u043f\u0440\u043e\u0435\u043a\u0442\u0430', // Ошибка при сборке проекта
  '\u0423\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0430 \u043f\u0430\u0434\u0430\u0435\u0442 \u043d\u0430 \u0448\u0430\u0433\u0435 3', // Установка падает на шаге 3
  'Die Verbindung schlug fehl',
  '\u00c9chec de la compilation', // Échec de la compilation
  'npm ci skips optional deps',
  'A'.repeat(70) + '-first-variant',
  'A'.repeat(70) + '-second-variant',
  'lib/ledger.js:2119 new RegExp(trigger) hangs',
  'lib/ledger.js:2119 new RegExp[trigger] hangs',
];
for (const sample of samples) {
  const shown = sample.length > 52 ? `${sample.slice(0, 52)}…` : sample;
  console.log(`   slug(${JSON.stringify(shown)}) = ${JSON.stringify(ledger.slug(sample, 'mistake'))}`);
}

console.log('\n=== probe 04b: two unrelated non-ASCII-Latin pits, recorded one after the other ===');
const dir = path.join(tmp, 'two-cyrillic-pits');
fs.mkdirSync(dir, { recursive: true });
ledger.initLedger(dir, SESSION);
const first = ledger.recordMistake(
  dir,
  {
    symptom: '\u041e\u0448\u0438\u0431\u043a\u0430 \u043f\u0440\u0438 \u0441\u0431\u043e\u0440\u043a\u0435 \u043f\u0440\u043e\u0435\u043a\u0442\u0430: \u0441\u0431\u043e\u0440\u043a\u0430 \u043d\u0435 \u043d\u0430\u0447\u0438\u043d\u0430\u0435\u0442\u0441\u044f', // pure Cyrillic
    cause: 'tsc \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d \u0432 PATH',
    fix: '\u043f\u0440\u043e\u043f\u0438\u0441\u0430\u0442\u044c \u043f\u0443\u0442\u044c \u043a tsc',
    avoid: 'never rely on a global tsc: pin it in devDependencies',
    files: 'package.json',
  },
  SESSION,
);
// NOTE: an earlier version of this probe used a symptom containing the digit "3"
// (Установка падает на шаге 3…) and then one containing the word "peer" — neither
// merged, because digits and Latin letters survive `slug()`. That was a refutation
// of the *unqualified* claim ("any Russian text collides"), not of the mechanism:
// both symptoms must be free of Latin letters and digits for the collision to fire.
const second = ledger.recordMistake(
  dir,
  {
    symptom: '\u0423\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0430 \u043f\u0430\u0434\u0430\u0435\u0442 \u043f\u0440\u0438 \u0437\u0430\u043f\u0443\u0441\u043a\u0435 \u0441\u0435\u0440\u0432\u0435\u0440\u0430', // pure Cyrillic, no digits
    cause: 'two plugins require different @deepseek-ai/dsh-tools ranges',
    fix: 'align the peer ranges',
    avoid: 'never install two plugins with disjoint peer ranges: the resolver picks one silently',
    files: 'cordis.patch.yml',
  },
  SESSION,
);
const file = path.join(dir, '.dsh-code', 'mistakes.md');
const text = fs.readFileSync(file, 'utf8');
const headings = text.split('\n').filter((line) => line.startsWith('## '));
console.log(`   first  recordMistake -> merged=${first.merged} recurred=${first.recurred} entry=${first.entry}`);
console.log(`   second recordMistake -> merged=${second.merged} recurred=${second.recurred} entry=${second.entry}`);
console.log(`   mistakes.md entries: ${headings.length} -> ${JSON.stringify(headings)}`);
console.log(`   second pit's rule present in mistakes.md: ${text.includes('disjoint peer ranges')}`);
console.log(`   first  pit's rule present in mistakes.md: ${text.includes('pin it in devDependencies')}`);
const journalText = fs.readFileSync(path.join(dir, '.dsh-code', 'journal.jsonl'), 'utf8');
console.log(`   second pit's rule present in the journal only: ${journalText.includes('disjoint peer ranges')}`);

console.log('\n-- can the merged-away pit be retrieved by code_brief({topic})?');
const topic = '\u0423\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0430 \u043f\u0430\u0434\u0430\u0435\u0442 \u043f\u0440\u0438 \u0437\u0430\u043f\u0443\u0441\u043a\u0435'; // the SECOND pit's own symptom text
const searched = ledger.brief(dir, { session: SESSION, topic, maxChars: 8900 });
console.log(`   topic = ${JSON.stringify(topic)} (a distinctive phrase from the SECOND pit's symptom)`);
console.log(`   mistakes section present for that topic: ${searched.text.includes('## Known mistakes')}`);
console.log(`   brief text mentions "disjoint peer ranges": ${searched.text.includes('disjoint peer ranges')}`);
console.log(`   words of the merged-away pit visible anywhere in the brief: ${['peer', 'ranges', 'resolver'].filter((w) => searched.text.includes(w)).join(',') || '(none)'}`);

console.log('\n=== probe 04c: two symptoms identical for the first 60 slug characters ===');
const dir2 = path.join(tmp, 'long-prefix');
fs.mkdirSync(dir2, { recursive: true });
ledger.initLedger(dir2, SESSION);
const base = 'guarded operation reports failure while writing the very long ledger entry';
const a = ledger.recordMistake(dir2, { symptom: `${base} -- variant ALPHA`, cause: 'alpha cause', fix: 'alpha fix', avoid: 'alpha rule kept', files: 'lib/a.js' }, SESSION);
const b = ledger.recordMistake(dir2, { symptom: `${base} -- variant BRAVO`, cause: 'bravo cause', fix: 'bravo fix', avoid: 'bravo rule kept', files: 'lib/b.js' }, SESSION);
const text2 = fs.readFileSync(path.join(dir2, '.dsh-code', 'mistakes.md'), 'utf8');
console.log(`   A: merged=${a.merged} slug=${JSON.stringify(ledger.slug(`${base} -- variant ALPHA`, 'mistake'))}`);
console.log(`   B: merged=${b.merged} slug=${JSON.stringify(ledger.slug(`${base} -- variant BRAVO`, 'mistake'))}`);
console.log(`   "bravo rule kept" reachable from mistakes.md: ${text2.includes('bravo rule kept')}`);

console.log('\nSUMMARY');
console.log(`   non-ASCII-Latin symptoms collapse to the same slug: ${ledger.slug('\u041e\u0448\u0438\u0431\u043a\u0430 \u043f\u0440\u0438 \u0441\u0431\u043e\u0440\u043a\u0435', 'mistake') === ledger.slug('\u0423\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0430 \u043f\u0430\u0434\u0430\u0435\u0442', 'mistake')}`);
console.log(`   unrelated pit merged into the first entry: ${second.merged === true}`);
console.log(`   60-char prefix collision merged too: ${b.merged === true}`);
