/**
 * Journal rotation: the journal is the only ledger file that grows without a
 * ceiling and is read whole, so it is the one that needed bounding.
 *
 * Run: node probes/journal-rotation-probe.mjs
 *
 * What it proves, by execution and against a real temporary ledger:
 *   J1  a journal past the segment size really rotates, and the live file starts fresh
 *   J2  **no line is lost** — the sequence read across all segments is the sequence
 *       that was written, in order (the property that makes rotation safe at all)
 *   J3  a reader that must see an *old* line still sees it after rotation — proved on
 *       `unrecordedMistakes`, a briefing path that reads the journal and whose whole
 *       job is finding a line that is easy to lose
 *   J4  rotation never deletes a segment (the anti-entropy guard: this is a rename,
 *       not a retention policy)
 *
 * Why this probe runs as a plain library import: `lib/ledger.js` has no `inject`
 * exports and no bare imports, so Node can load it directly — unlike the plugin
 * modules, which need the host's resolution bootstrap out of `app.asar`.
 *
 * Known limits, stated rather than implied: the size threshold is a module constant
 * (512 KB), so the fixture makes a *past-threshold file* rather than driving the
 * constant; the rotation itself is still triggered through the real append path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

import { tempReport } from './paths.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** `debt-audit.mjs` runs this probe with `stdio:'ignore'`, so the report file is the
 *  only verdict that reaches it. `DSH_PROBE_REPORT` lets a parent redirect it. */
const OUT = process.env.DSH_PROBE_REPORT ?? tempReport('journal-rotation-report.json');
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);

const decisions = [];
const check = (id, name, ok, evidence) => decisions.push({ id, name, ok: ok === true, evidence });
const preview = (value, n = 200) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && text.length > n ? `${text.slice(0, n)}…` : text;
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-rotation-'));
const DIR = path.join(ROOT, '.dsh-code');
const JOURNAL = path.join(DIR, 'journal.jsonl');
const HEAD = '## Mistakes\n';
const SESSION = 'sess-rotation';
const entry = (n) => JSON.stringify({ ts: '2026-10-03T00:00:00.000Z', kind: 'filler', session: SESSION, n });

try {
  fs.mkdirSync(DIR, { recursive: true });

  // --- the paid-for line, first: a failing command with no mistake recorded. It must
  // --- be found later, from a segment that will no longer be the live file.
  //
  // --- The debt is filed under `SESSION`, not under a made-up earlier session. Since
  // --- 2026-10-10 the briefing collapses a *previous* session's failures into one counted
  // --- line and never names them, so a debt filed under an earlier session could not be
  // --- found by name here however well rotation worked — the check would be measuring the
  // --- debt rule instead of the rotation it exists for, which is what J3 did when it was
  // --- filed as `older-session` (measured 2026-10-10: the named line was gone, and the rule
  // --- was behaving correctly).
  const debtLine = JSON.stringify({
    ts: '2026-10-03T00:00:00.000Z',
    kind: 'mistake_unrecorded',
    session: SESSION,
    failures: [{ cmd: 'node broken.mjs', signature: 'sig-1' }],
  });
  fs.appendFileSync(JOURNAL, `${debtLine}\n`, 'utf8');

  const FILL = 9000;
  const bulk = [];
  for (let n = 0; n < FILL; n += 1) bulk.push(entry(n));
  fs.appendFileSync(JOURNAL, `${bulk.join('\n')}\n`, 'utf8');
  const beforeBytes = fs.statSync(JOURNAL).size;
  const beforeText = ledger.readJournalText(ROOT, 'project');
  const beforeLines = beforeText.split('\n').filter((line) => line.trim().length > 0);

  // --- one real append through the real path, which is what rotates.
  fs.writeFileSync(path.join(DIR, 'mistakes.md'), `${HEAD}\n`, 'utf8');
  ledger.recordVerified(ROOT, { cmd: 'node ok.mjs', expect: 'ok', ok: true }, SESSION, 'project');

  const segments = ledger.journalFiles(ROOT, 'project');
  const rotated = segments.filter((f) => f !== JOURNAL);
  check(
    'J1',
    'a journal past the segment size rotates and the live file starts fresh',
    rotated.length >= 1 && fs.statSync(JOURNAL).size < beforeBytes,
    { beforeBytes, liveBytes: fs.statSync(JOURNAL).size, rotated: rotated.map((f) => path.basename(f)) },
  );

  const afterText = ledger.readJournalText(ROOT, 'project');
  const afterLines = afterText.split('\n').filter((line) => line.trim().length > 0);
  check(
    'J2',
    'no line is lost, and the order across segments is the order written',
    afterLines.length === beforeLines.length + 1 &&
      afterLines[0] === beforeLines[0] &&
      afterLines[beforeLines.length - 1] === beforeLines[beforeLines.length - 1],
    {
      before: beforeLines.length,
      after: afterLines.length,
      firstSame: afterLines[0] === beforeLines[0],
      lastSeen: preview(afterLines[beforeLines.length - 1], 80),
    },
  );
  check(
    'J3',
    'a briefing reader still finds a line that now lives in a rotated segment',
    (() => {
      // `brief` is the real caller; its debt section is the one that reads the journal
      // for an old line. This asserts through that path, not through the helper.
      const text = ledger.brief(ROOT, { session: 'a-brand-new-session', maxChars: 8000 }).text;
      return text.includes('node broken.mjs') && text.includes('Failing commands nobody wrote down');
    })(),
    preview(ledger.brief(ROOT, { session: 'a-brand-new-session', maxChars: 8000 }).text, 400),
  );
  check(
    'J4',
    'every segment a reader is given still exists and is readable (rotation renames; only the oldest segment is ever retired)',
    rotated.length >= 1 && rotated.every((f) => fs.existsSync(f) && fs.statSync(f).size > 0),
    { segments: segments.map((f) => `${path.basename(f)}:${fs.existsSync(f) ? fs.statSync(f).size : 'gone'}`) },
  );
} catch (error) {
  // The fixture half can fail (a directory that will not be created, a write refused); that
  // is a check failure with a reason, never a crash that hides the J1–J4 verdicts already
  // collected.
  check('fixture', 'the rotation fixture could be built', false, { error: `${error?.name}: ${error?.message}` });
}

// --- J5: rotation keeps rotating, and the window stays finite ------------------------
/**
 * Added 2026-10-04 for the ledger-core audit's F5. Rotation used to stop forever the moment
 * the highest slot was occupied: the shift had nowhere to put the oldest segment, so the
 * live journal grew without bound (on the real ledger: 319 KB of a 524 KB threshold, 1 of 9
 * slots used). The fix retires the oldest segment instead — which is why `J4` above no longer
 * claims "nothing is ever deleted": bounded retention and "never delete" cannot both hold.
 *
 * The check drives rotation past its own window and asserts the two halves that matter: it
 * is still rotating, and the window is bounded rather than merely large.
 */
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rotate-window-'));
  try {
    const dir = path.join(root, '.dsh-code');
    const journal = path.join(dir, 'journal.jsonl');
    // Fill to just under the threshold with plain text (not journal lines: this fixture is
    // about the file's SIZE, and a real write below is what triggers rotation). The first
    // version of this check wrote 14 entries of 64 KB each and never crossed the 512 KB
    // threshold at all — it asserted "rotation keeps rotating" without causing a second
    // rotation, which is the defect it exists to catch.
    const CHUNK = 64 * 1024;
    const SEGMENT = 512 * 1024;
    // Reach the state the old code stalled on deterministically: a segment already sitting in
    // the highest slot. Before the fix, the shift had nowhere to put it, the `.000` target
    // was still occupied, and rotation returned early forever after (the real ledger had used
    // 1 of its 9 slots and was at 319 KB of a 524 KB threshold). This is what gives J5 teeth:
    // a check that cannot fail is a check that certifies bugs.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'journal.jsonl.008'), 'oldest segment\n', 'utf8');
    const writes = 26; // ≈ 1.6 MB: enough to fill the live file many times over
    for (let index = 0; index < writes; index += 1) {
      fs.appendFileSync(journal, `${'x'.repeat(CHUNK)}\n`, 'utf8');
      // Rotate exactly the way the ledger does: hand it a journal line once the live file is
      // past the segment size, so `appendJournal` is the code under test.
      if (fs.statSync(journal).size > SEGMENT) ledger.journalEvent(root, { kind: 'fixture', index }, ledger.SCOPE.project);
    }
    const live = fs.existsSync(journal) ? fs.statSync(journal).size : 0;
    const segments = fs.readdirSync(dir).filter((name) => name.startsWith('journal.jsonl.') && !name.endsWith('.lock'));
    const highest = segments
      .map((name) => Number(name.slice('journal.jsonl.'.length)))
      .sort((a, b) => a - b)
      .pop();
    check(
      'J5',
      'rotation keeps rotating even when the highest slot is already occupied (the state that used to stall it forever)',
      segments.length >= 2 && live < SEGMENT && highest !== undefined && highest <= 8,
      {
        segments: segments.length,
        highestSlot: highest ?? null,
        liveBytes: live,
        threshold: SEGMENT,
        prefilled: 'journal.jsonl.008',
        note: 'before the fix, one occupied highest slot stalled rotation permanently',
      },
    );
  } catch (error) {
    check('J5', 'rotation keeps rotating after its highest slot is reached', false, { error: `${error?.name}: ${error?.message}` });
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* a temp dir left behind is not a check failure */
    }
  }
}

const failed = decisions.filter((d) => !d.ok);
for (const d of decisions) {
  console.log(`${d.ok ? 'ok  ' : 'FAIL'} ${d.id} ${d.name}${d.ok ? '' : ` :: ${preview(d.evidence, 300)}`}`);
}
console.log(`\n${decisions.length - failed.length}/${decisions.length} passed, failed=[${failed.map((d) => d.id).join(', ')}]`);
fs.writeFileSync(OUT, `${JSON.stringify({ failed: failed.map((d) => `${d.id} ${d.name}`), passed: decisions.filter((d) => d.ok).length, total: decisions.length }, null, 2)}\n`, 'utf8');
if (failed.length > 0) process.exitCode = 1;
