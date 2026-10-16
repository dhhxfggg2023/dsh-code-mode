/**
 * Does the pit guard's `files:` side write the hit it claims to write?
 *
 * `probes/README.md` and `lib/pit-guard.js:334-343` say the file side records a
 * `file_hit` journal event "in the same pass as the notice, so the two can never
 * disagree", and that this is what finally gave the wider half of the ledger (31 of 35
 * pits here are file-keyed) a liveness statistic.
 *
 * Measured 2026-10-04 on the real ledger: `journal.jsonl` + its rotated segment hold
 * 16 `trigger_hit` events and **not one** `file_hit`, while notices for file-keyed pits
 * demonstrably fired in the same session. So the two DO disagree — a notice arrived and
 * left no statistic. This probe asks why, by driving the two halves a real edit drives:
 *
 *   A  `journalEvent(..., 'project')` on its own — does the write land at all?
 *   B  the exact query the guard runs for an edit — `refersTo` semantics against the
 *      real `mistakes.md` — so a token that fails to match is visible as such.
 *
 * Plain node: `lib/ledger.js` imports nothing but builtins, and `refersTo` is small
 * enough to reproduce exactly rather than import (it is private).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-filehit-${tag}-`));
const machine = scratch('machine');
const ledger = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'ledger.js')).href);
/**
 * This project's *real* `mistakes.md`, resolved before the fixture override below.
 *
 * This probe proves that the `files:` tokens the real ledger records still match the real edits,
 * so it has to read the real ledger — while its own writes must land in a scratch machine
 * ledger. Resolving it after `DSH_CODE_GLOBAL_DIR` was redirected sent it looking for this
 * project inside the scratch store (`<scratch>/projects/dsh-code-mode-56290bea/mistakes.md`,
 * ENOENT), and the hardcoded `<repo>/.dsh-code/mistakes.md` it used before that is an ENOENT
 * since the ledger moved into the store (2026-10-10). Capture the path once, from the resolver,
 * while the environment still describes this machine.
 */
const realMistakes = ledger.ledgerPath(PKG_DIR, 'mistakes');
process.env.DSH_CODE_GLOBAL_DIR = machine;
const SESSION = 'filehit-probe';

const results = [];
const check = (id, name, ok, evidence) => results.push({ id, name, ok: ok === true, evidence });

// --- A: does a plain journalEvent write into the project journal? -------------
{
  const root = scratch('journal');
  ledger.initLedger(root, SESSION);
  let threw = null;
  try {
    ledger.journalEvent(root, { kind: 'file_hit', session: SESSION, root, heading: 'PROBE-HEADING', target: 'probe/target.js' }, 'project');
  } catch (error) {
    threw = `${error?.name}: ${error?.message}`;
  }
  const file = path.join(root, '.dsh-code', 'journal.jsonl');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  check(
    'A1',
    'journalEvent(..., "project") writes a file_hit line into the project journal',
    threw === null && text.includes('PROBE-HEADING'),
    { threw, journalChars: text.length, tail: text.split('\n').slice(-2).join('\n').slice(0, 300) },
  );
}

// --- B: the guard's own matcher against the real mistakes.md ------------------
// Reproduced exactly from lib/pit-guard.js:108-137 (private there).
const normPath = (value) =>
  String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
const editTargetOf = (value, cwd) => {
  const raw = value.trim().replace(/\\/g, '/');
  const absolute = /^[a-z]:\//i.test(raw) || raw.startsWith('/') ? raw : `${String(cwd ?? '').replace(/\\/g, '/')}/${raw}`;
  return normPath(absolute);
};
const refersTo = (target, token) => {
  const raw = String(token ?? '').trim().replace(/^[`"'([]+|[`"'),.\]]+$/g, '');
  if (raw.length === 0 || raw.length < 3) return false;
  const withLine = raw.replace(/:\d+(?:-\d+)?$/, '');
  const p = normPath(withLine);
  if (p.length === 0) return false;
  if (target === p) return true;
  return target.endsWith(`/${p}`);
};

{
  const mistakes = fs.readFileSync(realMistakes, 'utf8');
  const tokens = [];
  for (const line of mistakes.split('\n')) {
    if (!/^\[?"?files:/.test(line.trim()) && !line.trim().startsWith('- files:')) continue;
    const value = line.trim().replace(/^-?\s*files:\s*/, '').replace(/^\[|\]$/g, '');
    for (const part of value.split(',')) {
      const cleaned = part.trim().replace(/^["'[]+|["'\]]+$/g, '');
      if (cleaned.length > 0) tokens.push(cleaned);
    }
  }
  // The exact edits this session's pit notices fired for.
  const edits = [
    ['E:\\projects\\dsh-code-mode\\lib\\tool-record.js', 'E:\\projects\\dsh-code-mode'],
    ['E:\\projects\\dsh-code-mode\\lib\\recite.js', 'E:\\projects\\dsh-code-mode'],
    ['lib/ledger.js', 'E:\\projects\\dsh-code-mode'],
    ['probes/bug-scan.mjs', 'E:\\projects\\dsh-code-mode'],
  ];
  const report = edits.map(([edited, cwd]) => {
    const target = editTargetOf(edited, cwd);
    const matched = tokens.filter((token) => refersTo(target, token));
    return { edited, target, matchedTokens: matched.slice(0, 6), matchedCount: matched.length };
  });
  const anyMatched = report.some((r) => r.matchedCount > 0);
  check(
    'B1',
    'a real edit target matches at least one recorded `files:` token (otherwise the file side can never fire)',
    anyMatched,
    { tokensFound: tokens.length, report },
  );
}

for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.id} ${r.name}${r.ok ? '' : `  <- ${JSON.stringify(r.evidence).slice(0, 600)}`}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed, failed=[${failed.map((r) => r.id).join(', ')}]`);
process.exit(failed.length === 0 ? 0 : 1);
