/**
 * Truncation must not cut a character in half.
 *
 * `truncate` and `clip` slice on raw UTF-16 indices, so a limit landing between the two
 * halves of an astral character (an emoji, a rare CJK glyph) leaves a lone surrogate. That
 * character then travels into the ledger, the briefing and the session log, where it is
 * quoted back and renders as a replacement box — a corruption that survives every later
 * reader, which is the class this project keeps paying for.
 *
 * Measured before the fix: `truncate('\u{1F600}'.repeat(50), 10)` returned
 * `'\u{1F600}\u{1F600}\uD83D'` — one and a half characters.
 *
 * Plain node, no host: `lib/ledger.js` imports only node builtins.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.DSH_PROBE_REPORT ?? path.join(os.tmpdir(), 'truncate-surrogate-report.json');
process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-surrogate-global-'));

const ledger = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'ledger.js')).href);

const results = [];
const check = (id, name, ok, evidence) => results.push({ id, name, ok: ok === true, evidence });

/**
 * Any unpaired surrogate in the string: a high surrogate not followed by a low one, or a low
 * surrogate not preceded by a high one. This is what "cut a character in half" looks like.
 */
const loneSurrogates = (text) => {
  const found = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) found.push(index);
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      const prev = text.charCodeAt(index - 1);
      if (!(prev >= 0xd800 && prev <= 0xdbff)) found.push(index);
    }
  }
  return found;
};

// --- T1: the exact case that was broken ----------------------------------------------
{
  const emoji = '\u{1F600}'.repeat(50);
  const cut = ledger.truncate(emoji, 10);
  const lone = loneSurrogates(cut);
  check(
    'T1',
    'truncate of a long astral-character string leaves no lone surrogate',
    lone.length === 0,
    { limit: 10, chars: cut.length, loneAt: lone, start: JSON.stringify(cut.slice(0, 8)).replace(/\\u/g, 'u') },
  );
}

// --- T2: every limit, not just the convenient one ------------------------------------
// An off-by-one that happens to work at 10 would not be a fix. This walks the limits across
// the boundary where the cut lands mid-pair, for both surrogate kinds (emoji and a CJK
// extension-B glyph) and for a text that is half ASCII, half astral.
{
  const samples = {
    emoji: '\u{1F600}'.repeat(40),
    cjkExtB: '\u{20000}'.repeat(40),
    mixed: `${'a'.repeat(15)}${'\u{1F600}'.repeat(15)}${'b'.repeat(15)}`,
  };
  const failures = [];
  for (const [label, text] of Object.entries(samples)) {
    for (let limit = 1; limit <= 40; limit += 1) {
      const cut = ledger.truncate(text, limit);
      if (loneSurrogates(cut).length > 0) failures.push(`${label}@${limit}`);
    }
  }
  check('T2', 'no limit from 1 to 40 cuts a surrogate pair, in any of three scripts', failures.length === 0, {
    failures: failures.slice(0, 12),
    tried: 3 * 40,
  });
}

// --- T3: the same guard on the clip path ---------------------------------------------
// `clip` is the head-clip used for entry bodies; it had the same raw slice. Reached through
// the library's own export surface if it is exposed, otherwise through the entry-shaping
// path that uses it.
{
  const long = '\u{1F600}'.repeat(60);
  const shaped = ledger.shapeEntries([`## 2026-01-01 · pit\n- symptom: ${long}`], 40);
  const lone = loneSurrogates(shaped.text);
  check('T3', 'entry shaping does not leave a lone surrogate either', lone.length === 0, {
    chars: shaped.text.length,
    loneAt: lone,
  });
}

// --- T4: short input untouched, and ASCII behaves as before --------------------------
// NOTE, measured while writing this: `truncate` is NOT a hard cap. It keeps 60% at the head,
// the rest at the tail, and adds a `… (N chars omitted) …` marker, so the result exceeds
// `limit` by the marker's length. The first version of this check asserted the result fits
// and therefore failed against correct code — the assertion was wrong, not the function. What
// is worth pinning instead: the head is kept, the tail is kept, and nothing is corrupted.
{
  const cut = ledger.truncate('\u{1F600}'.repeat(50), 10);
  const short = ledger.truncate('hello', 10);
  const ascii = ledger.truncate(`${'x'.repeat(80)}TAIL`, 20);
  check(
    'T4',
    'the head and tail survive truncation, short input is returned unchanged, and ASCII still carries its marker',
    cut.length <= 40 &&
      short === 'hello' &&
      ascii.startsWith('x') &&
      ascii.includes('chars omitted') &&
      ascii.endsWith('TAIL') &&
      loneSurrogates(ascii).length === 0,
    {
      emojiChars: cut.length,
      shortUnchanged: short === 'hello',
      asciiEndsWithTail: ascii.endsWith('TAIL'),
      asciiChars: ascii.length,
    },
  );
}

const failed = results.filter((row) => !row.ok);
fs.writeFileSync(OUT, `${JSON.stringify({ passed: results.length - failed.length, total: results.length, failed: failed.map((r) => r.id), results }, null, 2)}\n`, 'utf8');
for (const row of results) {
  console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.id} ${row.name}${row.ok ? '' : `\n       <- ${JSON.stringify(row.evidence).slice(0, 400)}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed, failed=[${failed.map((r) => r.id).join(', ')}]`);
console.log(`report: ${OUT}`);
process.exit(failed.length === 0 ? 0 : 1);
