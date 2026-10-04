/**
 * Audit probe 13 — input-tolerance matrix: which hand-editable ledger shapes throw,
 * and which merely degrade. Every row is measured through the real API.
 *
 *   <node> .dsh-code\audits\13-input-tolerance.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);

process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit13-global-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit13-'));
const SESSION = 'audit-13';

/** A string containing a code unit that is half of a surrogate pair. */
const loneSurrogates = (text) => {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) count += 1;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) count += 1;
  }
  return count;
};

const attempt = (fn) => {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, value: `${error?.name}: ${error?.message}` };
  }
};

const fixture = (tag) => {
  const dir = path.join(tmp, tag);
  fs.mkdirSync(path.join(dir, '.dsh-code'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.dsh-code', 'journal.jsonl'), '', 'utf8');
  return dir;
};
const entry = (heading, fields) => [`## ${heading}`, ...fields].join('\n');

console.log('=== probe 13: hand-editable shapes, through the real readers ===');
console.log('   shape                                         | readTasks/brief | entries seen | note');

// --- tasks.json shapes -------------------------------------------------------
for (const [label, text] of [
  ['tasks.json with CRLF + BOM (valid content)', `\ufeff{"version":1,"active":[],"done":[],"blocked":[]}\r\n`],
  ['tasks.json with CRLF only', `{"version":1,"active":[{"id":"t","title":"T","status":"active"}],"done":[],"blocked":[]}\r\n`],
]) {
  const dir = fixture(label.replace(/[^a-z0-9]+/gi, '-'));
  fs.writeFileSync(path.join(dir, '.dsh-code', 'tasks.json'), text, 'utf8');
  const brief = attempt(() => ledger.brief(dir, { session: SESSION, maxChars: 4000 }).text.length);
  const tasks = attempt(() => ledger.readTasks(dir));
  console.log(`   ${label.padEnd(45)} | ${String(brief.ok).padStart(5)} ${String(tasks.ok).padStart(5)}    |              | ${brief.ok ? `brief ${brief.value} chars` : brief.value}`);
}

// --- mistakes.md shapes ------------------------------------------------------
const mistakesShapes = [
  ['CRLF line endings', [entry('2026-10-01 · alpha', ['- symptom: alpha thing', '- cause: c', '- fix: f', '- do not repeat: rule alpha']), entry('2026-10-01 · beta', ['- symptom: beta thing', '- do not repeat: rule beta'])].join('\r\n')],
  ['BOM + header + entry', `\ufeff# Mistakes\n\n${entry('2026-10-01 · alpha', ['- symptom: alpha thing', '- do not repeat: rule alpha'])}`],
  ['entry with NO fields', entry('2026-10-01 · bare-heading', [])],
  ['only the "# Mistakes" heading', '# Mistakes'],
  ['empty file', ''],
  ['heading containing a Windows path', entry('2026-10-01 · C:\\proj\\lib\\a.js:12 throws', ['- symptom: path heading', '- files: C:\\proj\\lib\\a.js:12', '- do not repeat: use forward slashes in your head'])],
  ['emoji in heading and symptom', entry('2026-10-01 · 💥 boom 😀', ['- symptom: 💥 boom 😀 in the middle', '- do not repeat: never let an emoji split a slice'])],
  ['body line starting with "## "', entry('2026-10-01 · nested-heading', ['- symptom: nested', '- cause: see below', '## not really an entry', '- do not repeat: do not write ## in a body'])],
];
for (const [label, body] of mistakesShapes) {
  const dir = fixture(`m-${label.replace(/[^a-z0-9]+/gi, '-')}`);
  fs.writeFileSync(path.join(dir, '.dsh-code', 'mistakes.md'), body, 'utf8');
  const brief = attempt(() => ledger.brief(dir, { session: SESSION, maxChars: 8900 }).text);
  const seen = brief.ok ? (brief.value.match(/^## 2026/gm) ?? []).length : -1;
  const merge = attempt(() => ledger.recordMistake(dir, { symptom: 'new pit for the tolerance matrix', cause: 'c', fix: 'f', avoid: 'a rule long enough to be a locator', files: 'lib/ledger.js' }, SESSION));
  console.log(`   ${label.padEnd(45)} | ${String(brief.ok).padStart(5)}       | ${String(seen).padStart(12)} | merge ${merge.ok ? 'ok' : merge.value.slice(0, 40)}`);
}

// --- journal shapes ----------------------------------------------------------
const journalCases = [
  ['torn last line (half-written JSON)', '{"ts":"2026-10-01T00:00:00.000Z","kind":"verified","ok":true,"cm'],
  ['a bare null line', 'null'],
  ['a bare number line', '42'],
  ['a bare JSON string naming a kind', '"restart_pending"'],
  ['a JSON array line', '["verified"]'],
  ['an object with kind but no ts', '{"kind":"verified","ok":true}'],
  ['a valid mistake line', '{"ts":"2026-10-01T00:00:00.000Z","kind":"mistake","symptom":"x","avoid":"y"}'],
];
for (const [label, line] of journalCases) {
  const dir = fixture(`j-${label.replace(/[^a-z0-9]+/gi, '-')}`);
  ledger.initLedger(dir, SESSION);
  fs.appendFileSync(path.join(dir, '.dsh-code', 'journal.jsonl'), `\n${line}\n`, 'utf8');
  const brief = attempt(() => ledger.brief(dir, { session: SESSION, maxChars: 8900 }).text);
  const pending = attempt(() => ledger.restartPending(dir));
  const recency = attempt(() => ledger.factRecency(ledger.SCOPE.global, undefined));
  console.log(`   journal: ${label.padEnd(36)} | brief ${brief.ok ? 'ok ' : `THREW ${brief.value.slice(0, 40)}`} | restartPending ${pending.ok ? 'ok' : 'THREW'} | factRecency ${recency.ok ? 'ok' : 'THREW'}`);
}

// --- string helpers: surrogate safety ---------------------------------------
console.log('\n=== probe 13B: do the truncation helpers cut inside a surrogate pair? ===');
const emoji = '😀'.repeat(20);
for (const limit of [5, 9, 21]) {
  const out = ledger.truncate(emoji, limit);
  console.log(`   truncate('😀'x20, ${limit}) -> ${out.length} chars, lone surrogates: ${loneSurrogates(out)}`);
}
const shaped = ledger.shapeEntries([entry('2026-10-01 · emoji', [`- symptom: ${emoji}`])], 4);
console.log(`   shapeEntries([emoji entry], 4) -> ${shaped.text.length} chars, lone surrogates: ${loneSurrogates(shaped.text)}`);
console.log(`   slug('💥 boom 😀') = ${JSON.stringify(ledger.slug('💥 boom 😀', 'mistake'))}`);
