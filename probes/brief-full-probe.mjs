/**
 * `briefFull`: the largest bounded view, for when a selection is not enough.
 *
 * Run: node probes/brief-full-probe.mjs
 *
 * The briefing ranks entries and indexes the rest, which is the right default and a
 * trap when the reader does not yet know what to search for. `full` lifts the
 * per-section division so every section may spend its ceiling and the entry-bearing
 * sections keep whole entries instead of indexing them. This probe proves the lift is
 * real (more entries visible than the default) and still bounded (the ceilings hold).
 *
 * `lib/ledger.js` has no bare imports, so this runs under plain Node.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { tempReport } from './paths.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** `debt-audit.mjs` runs this probe with `stdio:'ignore'`, so the report file is the
 *  only verdict that reaches it. `DSH_PROBE_REPORT` lets a parent redirect it. */
const OUT = process.env.DSH_PROBE_REPORT ?? tempReport('brief-full-report.json');
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);

const decisions = [];
const check = (id, name, ok, evidence) => decisions.push({ id, name, ok: ok === true, evidence });
const preview = (value, n = 200) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && text.length > n ? `${text.slice(0, n)}…` : text;
};
/** The brief's section headings. A walk ends at the next one of these. */
const SECTION_HEADS = [
  '## Project',
  '## Machine-wide facts',
  '## Task board',
  '## Recent ledger entries',
  '## Turns that changed code and ran nothing',
  '## Failing commands nobody wrote down',
  '## Known mistakes',
  '## Recent decisions',
];

/**
 * Reachability of one section: whole entries shown, plus one index line per entry
 * that is named but not expanded. This is the number that matters — an entry the
 * reader can see *at all* is findable; one in neither list is invisible.
 *
 * Three traps this version avoids, all measured 2026-10-03 while writing it:
 *   - `## ` starts both a section *and* a whole entry inside one, so the section is
 *     found by a line walk, not by splitting the whole string;
 *   - sections with no body are **omitted entirely**, so "the next `##` after a blank
 *     line" ran straight into the following section — a walk must end at a *known
 *     heading*;
 *   - a section body is indented by the clip pass, so every match is made against
 *     `trim()`ed lines: matching raw ones found the entries (unindented) and missed
 *     every index line (indented), which read as "no index at all".
 */
const reachIn = (text, heading) => {
  const lines = String(text).split('\n');
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) return { found: false, full: 0, indexed: 0, beyond: 0 };
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (SECTION_HEADS.some((head) => head !== heading && line.startsWith(head))) break;
    end += 1;
  }
  const section = lines.slice(start, end);
  return {
    found: true,
    full: section.filter((line) => line.startsWith('## ')).length - 1, // minus the heading
    indexed: section.filter((line) => line.trim().startsWith('- [')).length,
    beyond: Number(/\((\d+) more entr/.exec(section.join('\n'))?.[1] ?? 0),
  };
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-full-'));
const SESSION = 'sess-brief-full';

try {
  ledger.initLedger(ROOT, SESSION, 'project');
  // Enough entries that the default budget must rank rather than show them all.
  for (let n = 0; n < 24; n += 1) {
    ledger.recordMistake(
      ROOT,
      {
        symptom: `pit number ${n} with a distinctive marker ${n}`,
        cause: `cause ${n}`,
        fix: `fix ${n}`,
        avoid: `do not do ${n} because ${n}`,
        files: `lib/mod${n}.js:1`,
      },
      SESSION,
      'project',
    );
  }

  const normal = ledger.brief(ROOT, { session: SESSION });
  const full = ledger.briefFull(ROOT, { session: SESSION });
  const normalReach = reachIn(normal.text, '## Known mistakes');
  const fullReach = reachIn(full.text, '## Known mistakes');
  const normalTotal = normalReach.full + normalReach.indexed;
  const fullTotal = fullReach.full + fullReach.indexed;

  check(
    'B1',
    'the default brief ranks the entries and stays inside its budget',
    normal.text.length <= 4200 && normalTotal >= 1,
    { chars: normal.text.length, ...normalReach },
  );
  check(
    'B2',
    '`full` makes strictly more entries reachable than the default',
    fullTotal > normalTotal,
    { defaultReach: normalTotal, fullReach: fullTotal, default: normalReach, full: fullReach },
  );
  check(
    'B3',
    '`full` still respects a bound: it is the largest bounded view, not the whole file',
    full.text.length > normal.text.length,
    { defaultChars: normal.text.length, fullChars: full.text.length, entriesWritten: 24 },
  );
  check(
    'B4',
    'the default says what it did not show, so `full` is discoverable',
    /selection, not the ledger|dropped|index|more entr/i.test(normal.text),
    { hint: preview(normal.text.split('\n').filter((l) => /selection|dropped|index|more entr/i.test(l)).join(' | '), 240) },
  );
} finally {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* a temp dir left behind is not a check failure */
  }
}

const failed = decisions.filter((d) => !d.ok);
for (const d of decisions) {
  console.log(`${d.ok ? 'ok  ' : 'FAIL'} ${d.id} ${d.name}${d.ok ? '' : ` :: ${preview(d.evidence, 300)}`}`);
}
console.log(`\n${decisions.length - failed.length}/${decisions.length} passed, failed=[${failed.map((d) => d.id).join(', ')}]`);
fs.writeFileSync(OUT, `${JSON.stringify({ failed: failed.map((d) => `${d.id} ${d.name}`), passed: decisions.filter((d) => d.ok).length, total: decisions.length }, null, 2)}\n`, 'utf8');
if (failed.length > 0) process.exitCode = 1;
