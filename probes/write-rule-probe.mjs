/**
 * The ledger's two write-side advisories: an entry that is too long to survive a
 * growing ledger, and an entry nothing can find.
 *
 * Run: node probes/write-rule-probe.mjs
 *
 * Why these exist and why they warn instead of refusing: the briefing is bounded by
 * construction, so a ledger outgrows what a briefing can show entirely through *new*
 * entries — which makes the write side the only side that can do anything about it.
 * Both shapes are still recorded, because this project's own standard is that a fact
 * nobody wrote down is the expensive outcome; a short entry that exists beats a long
 * one that was refused. Measured 2026-10-03: 112 entries across two ledgers against a
 * briefing that fits ~4,000–8,900 characters.
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
const OUT = process.env.DSH_PROBE_REPORT ?? tempReport('write-rule-report.json');
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);

const decisions = [];
const check = (id, name, ok, evidence) => decisions.push({ id, name, ok: ok === true, evidence });
const preview = (value, n = 220) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && text.length > n ? `${text.slice(0, n)}…` : text;
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'write-rule-'));
const SESSION = 'sess-write-rule';
const long = 'word '.repeat(400).trim(); // ~2,000 chars: past the 1,600 bar

try {
  // The real caller always runs against an initialized ledger — `code_record` never
  // writes into a bare temp dir — so the fixture creates one the same way.
  ledger.initLedger(ROOT, SESSION, 'project');

  // --- a verbose entry with no coordinate: both advisories, one entry.
  const verbose = ledger.recordMistake(
    ROOT,
    { symptom: 'a very long narrative pit', cause: long, fix: long, avoid: long },
    SESSION,
    'project',
  );
  check(
    'W1',
    'an over-long entry is recorded and reported, not refused',
    fs.existsSync(verbose.file) && typeof verbose.warning === 'string',
    { recorded: fs.existsSync(verbose.file), warning: preview(verbose.warning, 400) },
  );
  check(
    'W2',
    'the report names the length as the reason',
    typeof verbose.warning === 'string' && verbose.warning.includes('unusually long'),
    { warning: preview(verbose.warning, 200) },
  );
  check(
    'W3',
    'an entry with neither `files:` nor `trigger:` is reported as unfindable',
    typeof verbose.warning === 'string' && verbose.warning.includes('No `files:`'),
    { warning: preview(verbose.warning, 300) },
  );

  // --- a short entry WITH a coordinate gets neither advisory: the rule must not
  // --- fire on the shape it is trying to encourage, or it becomes noise.
  const good = ledger.recordMistake(
    ROOT,
    {
      symptom: 'a short pit with a coordinate',
      cause: 'cause',
      fix: 'fix',
      files: 'lib/recite.js:1',
      avoid: 'do not X because Y',
    },
    SESSION,
    'project',
  );
  check(
    'W4',
    'a short entry that carries a coordinate is accepted without a word',
    good.warning === undefined,
    { warning: good.warning },
  );

  // --- the merge path must report too, or a repeat of a verbose pit becomes silent.
  const merged = ledger.recordMistake(
    ROOT,
    { symptom: 'a very long narrative pit', cause: long, fix: long, avoid: long },
    SESSION,
    'project',
  );
  check(
    'W5',
    'a repeat merges into the existing entry and is reported on the same terms',
    merged.merged === true && merged.recurred === 1 && typeof merged.warning === 'string',
    { merged: merged.merged, recurred: merged.recurred, warning: preview(merged.warning, 200) },
  );

  // --- decisions carry the same length bar (they had no advisory at all before).
  const decision = ledger.recordDecision(
    ROOT,
    { title: 'a verbose decision', body: long, alternatives: long },
    SESSION,
    'project',
  );
  check(
    'W6',
    'a over-long decision is reported on the same terms',
    typeof decision.warning === 'string' && decision.warning.includes('unusually long'),
    { warning: preview(decision.warning, 200) },
  );

  // --- and the trigger-hit statistic is readable from the journal it writes to.
  ledger.journalEvent(ROOT, { kind: 'trigger_hit', session: SESSION, heading: '## x', source: 'mistakes.md', cmd: 'node ok' }, 'project');
  const journal = ledger.readJournalText(ROOT, 'project');
  check(
    'W7',
    'a trigger hit lands in the journal as its own event kind',
    journal.includes('"kind":"trigger_hit"') && journal.includes('"cmd":"node ok"'),
    { tail: preview(journal.split('\n').filter((l) => l.includes('trigger_hit')).join('\n'), 200) },
  );

  // --- the file side's hit counter: the wider half of the ledger (31 of 35 pits here are
  // --- file-keyed) had no "has this ever arrived" statistic at all until now.
  ledger.journalEvent(ROOT, { kind: 'file_hit', session: SESSION, root: ROOT, heading: '## a', target: 'lib/a.js' }, 'project');
  ledger.journalEvent(ROOT, { kind: 'file_hit', session: SESSION, root: ROOT, heading: '## a', target: 'lib/a.js' }, 'project');
  ledger.journalEvent(ROOT, { kind: 'file_hit', session: SESSION, root: ROOT, heading: '## b', target: 'lib/b.js' }, 'project');
  const fileHits = ledger.fileHitCounts(ROOT, 'project');
  check(
    'W8',
    'file hits are counted per heading, so the file side finally has a liveness statistic',
    fileHits.get('## a') === 2 && fileHits.get('## b') === 1 && fileHits.get('## never') === undefined,
    { counts: [...fileHits.entries()] },
  );

  // --- restart tracking: a `lib/` edit is dormant until the host restarts, keyed on the
  // --- *process* boot. `brief` is a read and no longer records the start (the tool layer
  // --- does), so this fixture records the starts itself — which is also what makes the
  // --- two boots real rather than simulated by an argument nobody reads.
  ledger.noteSessionStart(ROOT, 'older-session', 'project');
  ledger.noteRestartPending(ROOT, ['E:/pkg/lib/ledger.js'], SESSION);
  const carried = ledger.brief(ROOT, { session: 'same-process', maxChars: 8000 }).text;
  check(
    'W9',
    'a dormant lib/ edit is carried into the briefing of the process that has not loaded it',
    carried.includes('Waiting for a restart'),
    { carried: carried.includes('Waiting for a restart') },
  );
  check(
    'W10',
    'the notice names the file that is dormant, not just that something is',
    carried.includes('ledger.js'),
    { notice: preview(carried.split('\n').find((l) => l.includes('Waiting for a restart')) ?? '', 240) },
  );
  // The same process keeps briefing — and the notice must survive that, or it settles the
  // debt it exists to carry (measured 2026-10-03, on the first version of this).
  const stillCarried = ledger.brief(ROOT, { session: 'same-process-again', maxChars: 8000 }).text;
  check(
    'W11',
    'repeated briefings from the same process do not settle it',
    stillCarried.includes('Waiting for a restart'),
    { carried: stillCarried.includes('Waiting for a restart') },
  );
  // A later *process* than the one that made the edit is what settles it. One process
  // cannot simulate another by calling `noteSessionStart` twice — the per-process guard
  // correctly refuses the second write — so the fixture states the second boot explicitly.
  ledger.noteSessionStart(ROOT, 'fresh-process', 'project', '2026-10-03T06:00:00.000Z');
  const settled = ledger.brief(ROOT, { session: 'fresh-process', maxChars: 8000 }).text;
  check(
    'W12',
    'a session start *after* the dormant edit settles it, because a later process loaded the change',
    !settled.includes('Waiting for a restart'),
    {
      settled: !settled.includes('Waiting for a restart'),
      direct: ledger.restartPending(ROOT),
      order: ledger
        .readJournalText(ROOT, 'project')
        .split('\n')
        .filter((l) => l.includes('session_start') || l.includes('restart_pending'))
        .map((l) => {
          try {
            return JSON.parse(l).kind;
          } catch {
            return 'torn';
          }
        }),
    },
  );
  delete process.env.DSH_CODE_BOOT;
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
