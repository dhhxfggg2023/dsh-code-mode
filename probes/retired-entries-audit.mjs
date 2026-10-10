/**
 * retired-entries-audit — did the 2026-10-05 machine-ledger retirement actually hold?
 *
 * The claim under test (from the restart gate): "the machine ledger got lighter — the
 * nunif family (audit / wx / screenshots / pip) is no longer in the machine section of
 * `code_brief`", with "28 entries retired" attached to it.
 *
 * Two ways to check that are NOT good enough, and both were tried first on 2026-10-06:
 *
 * 1. `Select-String 'nunif|audit|screenshot|pip'` over `~/.dsh-code/mistakes.md` — a
 *    keyword search over entry *bodies* counts legitimately surviving entries that merely
 *    mention the word `audit`, and misses every retired entry whose heading does not
 *    contain a keyword at all. It reported 7 and proved nothing either way.
 * 2. Looking at `mistakes.md.bak-*`: those are backups of `mistakes.md`, not of a
 *    previous generation, so their entry counts bookend the *edit*, not the retirement.
 *
 * What this does instead is the thing the ledger itself does to define identity: split
 * both files on `\n## ` and compare **heading keys** (heading minus the date prefix,
 * numbers and punctuation folded — the same collapse `headingKey()` in `lib/ledger.js`
 * uses, so "the same entry" means here what it means everywhere else).
 *
 * It is a reader. It prints, per current entry, whether any retired candidate's *distinctive
 * words* survive anywhere in the current ledger, and it flags matches by the strong
 * criterion (≥4 distinctive words present) separately from noise (1–3 words).
 *
 * Run: `node probes/retired-entries-audit.mjs <backup-file>`
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Resolved, not restated: reading the retired `~/.dsh-code` made this audit report every
// current entry as missing.
const ledger = await import('../lib/ledger.js');
const globalDir = ledger.globalDir();
const current = path.join(globalDir, 'mistakes.md');
const backup = process.argv[2] ?? path.join(globalDir, 'mistakes.md.bak-applies');

function entriesOf(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\n(?=## )/)
    .map((block) => block.trim())
    .filter((block) => block.startsWith('## '))
    .map((block) => ({ heading: block.split('\n')[0].replace(/^##\s*/, '').trim(), body: block }));
}

/** Same collapse as lib/ledger.js headingKey(): the heading is the entry's identity. */
function headingKey(heading) {
  return heading
    .replace(/^\d{4}-\d{2}-\d{2}\s*·\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Words that carry meaning; drops the connective noise of both languages. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'on', 'for', 'not', 'do',
  'was', 'were', 'be', 'by', 'with', 'that', 'this', 'as', 'at', 'from', 'but', 'so', 'if',
  '的', '了', '在', '是', '我', '和', '与', '这', '那', '把', '被', '就', '都', '也', '又',
]);
function words(text) {
  const latin = text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  const cjk = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const bigrams = [];
  for (const run of cjk) for (let i = 0; i + 2 <= run.length; i += 1) bigrams.push(run.slice(i, i + 2));
  return new Set([...latin, ...bigrams].filter((word) => !STOP.has(word)));
}

const now = entriesOf(current);
const then = entriesOf(backup);
const nowKeys = new Set(now.map((entry) => headingKey(entry.heading)));
const thenKeys = new Set(then.map((entry) => headingKey(entry.heading)));
const nowWords = new Set(now.flatMap((entry) => [...words(entry.heading)]));
const nowText = now.map((entry) => entry.body).join('\n').toLowerCase();

const gone = then.filter((entry) => !nowKeys.has(headingKey(entry.heading)));
const added = now.filter((entry) => !thenKeys.has(headingKey(entry.heading)));

const out = [];
out.push(`# retired-entries-audit`);
out.push(`- current:  ${current} — ${now.length} entries`);
out.push(`- compared: ${backup} — ${then.length} entries`);
out.push(`- identity: heading key (date stripped, folded), the same collapse lib/ledger.js uses`);

out.push('');
out.push(`## counts`);
out.push(`- entries present then and gone now: **${gone.length}**`);
out.push(`- entries added since: ${added.length}`);
out.push(`- net: ${then.length} → ${now.length}`);

out.push('');
out.push(`## survived anyway — a "gone" heading whose distinctive words are still here`);
// The decisive test: a retirement that only renamed an entry leaves its content behind.
let strong = 0;
let weak = 0;
for (const entry of gone) {
  const headingWords = [...words(entry.heading)];
  const inHeadings = headingWords.filter((word) => nowWords.has(word));
  const inBodies = headingWords.filter((word) => nowText.includes(word));
  const marker = inBodies.length >= 4 ? 'STRONG' : inBodies.length >= 1 ? 'weak' : 'clean';
  if (marker === 'STRONG') strong += 1;
  if (marker === 'weak') weak += 1;
  if (marker !== 'clean') {
    out.push(`- [${marker}] ${entry.heading.slice(0, 90)}`);
    out.push(`    heading words still in current headings: ${inHeadings.length ? inHeadings.join(', ') : '(none)'}`);
    out.push(`    words still present in current bodies: ${inBodies.length}${inBodies.length ? ` → ${inBodies.slice(0, 6).join(', ')}` : ''}`);
  }
}
if (strong + weak === 0) out.push('- (none — every retired heading left no trace in the current ledger)');

out.push('');
out.push(`## verdict`);
out.push(`- ${gone.length} heading(s) compare as retired; ${strong} still look like live content (STRONG), ${weak} mention a surviving word incidentally (weak).`);
out.push(`- the claim "the machine section got lighter" is supported exactly to the degree that STRONG is 0.`);
out.push(`- a heading with ZERO distinctive words is invisible to this test — read the list above, do not trust the count alone.`);

console.log(out.join('\n'));
