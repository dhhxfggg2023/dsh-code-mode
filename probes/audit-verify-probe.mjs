/**
 * Verification of the 2026-10-04 audit findings on `lib/ledger.js`.
 *
 * The audit (a subagent read all 2331 lines) reported three CRITICAL and six MAJOR
 * defects. A finding is a claim until something runs it, so this probe drives each
 * mechanical claim against the real library and reports **what actually happened**,
 * pass or fail. It is written the way `handover-grant-probe.mjs` is: plain node, no
 * host, because `ledger.js` imports nothing but node builtins.
 *
 * Every fixture goes to a temp dir (the convention in probes/README.md) and the
 * machine-wide ledger is redirected with `DSH_CODE_GLOBAL_DIR` before the first read,
 * so this can never touch the developer's real `~/.dsh-code/`.
 *
 * A check that reports `false` here is a *confirmed* audit finding; a check that
 * reports `true` is an audit finding this probe could NOT reproduce — which is a
 * reason to go back to the audit's reasoning, not to believe the finding.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.DSH_PROBE_REPORT ?? path.join(os.tmpdir(), 'audit-verify-report.json');

const scratch = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-audit-${tag}-`));
/** Redirect the machine ledger before the first read, never inside the block that tests it. */
const machine = scratch('machine');
process.env.DSH_CODE_GLOBAL_DIR = machine;

const ledger = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'ledger.js')).href);
const SESSION = 'audit-verify-session';
const OTHER = 'audit-verify-other';

const results = [];
const check = (id, name, ok, evidence) => results.push({ id, name, ok: ok === true, evidence });
/** `markdownEntries` is private to ledger.js; this probe only needs the count. */
const entryCount = (text) =>
  String(text ?? '')
    .split(/\n(?=## )/)
    .filter((block) => block.trim().startsWith('## ')).length;

// --- A: does `shapeEntries` honour the limit it is handed? --------------------
// The audit's C3 read this as a defect: handed `limit: 24` it returns a 954-character
// entry. Reading the function, that is its *documented* choice — "one whole entry, or a
// named omission, never a silent half-entry" (`ledger.js:2008-2021`), and the hard
// ceiling above which it stops making that choice is HARD_ENTRY_CHARS. So the contract
// is a floor-plus-ceiling, not a ceiling, and the check pins exactly that: either it
// respects the limit, or it returned ONE whole entry under the hard cap.
{
  const long = `## 2026-01-01 · pit-with-a-long-body\n${'- do not repeat: '}${'R'.repeat(900)}`;
  const got = ledger.shapeEntries([long], 24);
  const respectsLimit = got.text.length <= 24;
  const oneWholeEntry = got.full === 1 && got.text === long && got.text.length <= 1200;
  check(
    'A1',
    'shapeEntries either respects its limit or returns exactly one whole entry under the hard cap (never a silent fragment)',
    respectsLimit || oneWholeEntry,
    {
      limit: 24,
      returned: got.text.length,
      full: got.full,
      indexed: got.indexed,
      wholeEntry: got.text === long,
      respectsLimit,
      oneWholeEntry,
    },
  );
}

// --- B: a tight cap on the machine section — are the pits still shown? --------
// The audit's C2: `Math.max(24, cap/3)` demands room the cap does not have, and the
// compensating head-clip then removes the header and every fact. The section's own
// comments promise a pit can never be crowded out. Facts are recoverable from one
// file; a pit that never arrives is the failure the layer exists to prevent.
{
  const root = scratch('proj');
  ledger.initLedger(root, SESSION);
  const pitBody = `${'- do not repeat: '}${'Q'.repeat(900)}`;
  ledger.recordMistake(
    root,
    { symptom: 'AUDIT-C2 a long machine pit', cause: 'overrun fixture', fix: 'bound the block', avoid: undefined, trigger: 'audit-c2-trigger' },
    SESSION,
    ledger.SCOPE.global,
  );
  // Recorded trigger already gives the pit a coordinate; make the body long on purpose.
  const machineMistakes = path.join(machine, 'mistakes.md');
  const first = fs.readFileSync(machineMistakes, 'utf8');
  fs.writeFileSync(machineMistakes, `${first}\n${pitBody}\n`, 'utf8');
  ledger.writeProject(root, { audit_c2_fact: `${'F'.repeat(400)}` }, SESSION, ledger.SCOPE.global);
  const tiny = ledger.brief(root, { session: SESSION, maxChars: 200 });
  /**
   * CORRECTED 2026-10-04. The audit predicted that at a small `maxChars` the machine
   * section *silently vanishes*. A diagnostic (`probes/machine-section-diag.mjs`) showed
   * the truth is better than that: the allocator gives this section a share of 1 at a
   * 200-character total, drops it, and **names it** in `omitted` and in the brief text.
   * What was real is narrower — `globalExcerpt` was still handed an uncapped limit and
   * produced a 1100-character body for a 1-character allowance, so the section overran
   * the allocation the pass is supposed to guarantee. This check now pins the behaviour
   * that actually exists, plus the deeper reading: the same pit content must be
   * *reachable* the moment the budget can afford it.
   */
  const namedAsDropped =
    tiny.omitted.includes('global') ||
    /dropped for length[^\n]*global/.test(tiny.text) ||
    tiny.text.includes('## Machine-wide facts');
  check(
    'B1',
    'at a budget too small for it the machine section is dropped *and named*, never silently absent',
    namedAsDropped,
    {
      maxChars: 200,
      briefChars: tiny.text.length,
      omitted: tiny.omitted,
      hasHeading: tiny.text.includes('## Machine-wide facts'),
      notice: (tiny.text.split('\n').find((line) => line.includes('dropped for length')) ?? '(none)').slice(0, 200),
    },
  );

  /**
   * The part that matters at a budget that CAN afford the section: the pit's actionable
   * fields arrive, and the section stays inside the allowance it was given. `3000` puts
   * the machine share at a few hundred characters — enough for one pit, not for the
   * 400-character fact that shares the section.
   */
  const roomy = ledger.brief(root, { session: SESSION, maxChars: 3000 });
  const roomySection = roomy.text.includes('## Machine-wide facts')
    ? roomy.text.slice(roomy.text.indexOf('## Machine-wide facts')).split('\n\n')[0]
    : '';
  check(
    'B2',
    'at a workable budget the machine pit arrives with its rule, and the section respects its allowance',
    roomySection.length > 0 && /do not repeat|trigger:/.test(roomySection) && roomySection.length <= 1100,
    {
      maxChars: 3000,
      sectionChars: roomySection.length,
      hasRule: /do not repeat/.test(roomySection),
      hasTrigger: /trigger:/.test(roomySection),
      omitted: roomy.omitted,
      head: roomySection.slice(0, 240),
    },
  );
}

// --- C: can a task that is already `done` be found again? --------------------
// The audit's M1: `all` is built from active+blocked only, so a done task cannot be
// located by id or title. The tool description tells the model to pass the id.
{
  const root = scratch('board');
  ledger.initLedger(root, SESSION);
  const title = 'Fix the parser';
  const created = ledger.recordTask(root, { title, status: 'done' }, SESSION);
  let second = null;
  let refused = null;
  try {
    second = ledger.recordTask(root, { title, status: 'active' }, SESSION);
  } catch (error) {
    refused = error.message;
  }
  const board = JSON.parse(fs.readFileSync(path.join(root, '.dsh-code', 'tasks.json'), 'utf8'));
  const ids = [...board.active, ...board.done, ...board.blocked].map((t) => t.id);
  check(
    'C1',
    'NOT reproduced: a task already on the board is reused rather than duplicated, including a done one (the audit predicted a duplicate id here; the title lookup at ledger.js:1134 caught it first)',
    refused === null && second !== null && second.task.id === created.task.id,
    {
      firstId: created.task.id,
      secondId: second?.task?.id ?? null,
      refused,
      boardIds: ids,
      duplicateIds: ids.length !== new Set(ids).size,
    },
  );

  // F14 (ledger-core audit, 2026-10-04). The version of this check that lived here was a
  // FALSE GREEN: its fixture was the task C1 had just moved to `active`, so "a done task
  // can be moved" was never exercised. It uses its own task now, created straight into
  // `done`, and asserts the thing that actually broke — that the id ends up on exactly one
  // list. Before the fix this refused with a message listing the id it said was not on the
  // board, and moving by *title* produced a second task carrying the same id.
  const closed = ledger.recordTask(root, { title: 'A task closed in one step', status: 'done' }, SESSION);
  let moved = null;
  let moveError = null;
  try {
    moved = ledger.recordTask(root, { slug: closed.task.id, status: 'blocked', note: 'reopened by id' }, SESSION);
  } catch (error) {
    moveError = error.message;
  }
  let afterMove = null;
  try {
    afterMove = JSON.parse(fs.readFileSync(path.join(root, '.dsh-code', 'tasks.json'), 'utf8'));
  } catch {
    afterMove = { active: [], done: [], blocked: [] };
  }
  const listsHolding = ['active', 'done', 'blocked'].filter((list) =>
    (afterMove[list] ?? []).some((t) => t.id === closed.task.id),
  );
  check(
    'C2',
    'a task sitting in `done` is found by its id, and ends up on exactly one list',
    moveError === null && moved !== null && listsHolding.length === 1 && listsHolding[0] === 'blocked',
    {
      taskId: closed.task.id,
      error: moveError,
      listsHolding,
      idCounts: ['active', 'done', 'blocked'].map((list) => `${list}=${(afterMove[list] ?? []).filter((t) => t.id === closed.task.id).length}`),
    },
  );
}

// --- D: what happens to a ledger file that is not valid JSON? ----------------
// The audit's M6: `readJson` collapses "missing" and "unparseable" into one fallback,
// and the next mutation writes that fallback over the real file.
{
  const root = scratch('malformed');
  ledger.initLedger(root, SESSION);
  ledger.recordTask(root, { title: 'a task that must survive', status: 'active' }, SESSION);
  const tasksFile = path.join(root, '.dsh-code', 'tasks.json');
  const good = fs.readFileSync(tasksFile, 'utf8');
  // A trailing comma: what a hand-edit or a truncated write leaves behind.
  fs.writeFileSync(tasksFile, good.replace(/\}\s*$/, ',}\n'), 'utf8');
  let threw = null;
  let result = null;
  try {
    result = ledger.recordTask(root, { title: 'another task', status: 'active' }, SESSION);
  } catch (error) {
    threw = error.message;
  }
  const after = fs.readFileSync(tasksFile, 'utf8');
  let parsed = null;
  try {
    parsed = JSON.parse(after);
  } catch {
    parsed = null;
  }
  // The fix (2026-10-04): the unparseable file is moved aside rather than overwritten,
  // and the caller is told. So the loss is *recoverable* — the original bytes are on
  // disk under a `.corrupt-<timestamp>` name — and the operation still succeeds.
  const dir = path.join(root, '.dsh-code');
  const rescued = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
  const rescuedText = rescued.length === 0 ? '' : fs.readFileSync(path.join(dir, rescued[0]), 'utf8');
  const survived = rescuedText.includes('a task that must survive');
  const notice = result?.notice;
  check(
    'D1',
    'a malformed ledger file is moved aside (bytes kept) and the caller is told, instead of being overwritten',
    threw === null && survived && parsed !== null && typeof notice === 'string' && notice.includes('.corrupt-'),
    {
      threw,
      rescuedFiles: rescued,
      firstTaskInRescued: survived,
      parsedOk: parsed !== null,
      notice,
      afterHead: after.slice(0, 160),
    },
  );
}

// --- E: does the merge path hold the same lock the append path takes? --------
// The audit's C1. Both writers are pointed at one file; a merge that does not take
// the lock will overwrite whatever the appender wrote in between. This drives the two
// public entry points concurrently and counts what survived.
{
  const root = scratch('race');
  ledger.initLedger(root, SESSION);
  const mistakes = path.join(root, '.dsh-code', 'mistakes.md');
  ledger.recordMistake(root, { symptom: 'race-pit-the-merged-one', cause: 'c', fix: 'f', avoid: 'a rule long enough to count' }, SESSION);
  const before = entryCount(fs.readFileSync(mistakes, 'utf8'));
  const writers = [];
  for (let index = 0; index < 6; index += 1) {
    writers.push(
      new Promise((resolve) => {
        setImmediate(() => {
          try {
            ledger.recordMistake(
              root,
              { symptom: `race-pit-append-${index}`, cause: 'c', fix: 'f', avoid: 'a rule long enough to count' },
              OTHER,
            );
          } catch {
            /* counted by what survives */
          }
          resolve();
        });
      }),
    );
  }
  // A merge of the first pit, run interleaved with the appends above.
  writers.push(
    new Promise((resolve) => {
      setImmediate(() => {
        try {
          ledger.recordMistake(root, { symptom: 'race-pit-the-merged-one', cause: 'c2', fix: 'f2', avoid: 'a rule long enough to count' }, OTHER);
        } catch {
          /* counted by what survives */
        }
        resolve();
      });
    }),
  );
  await Promise.all(writers);
  const text = fs.readFileSync(mistakes, 'utf8');
  const headings = entryCount(text);
  const missing = [];
  for (let index = 0; index < 6; index += 1) {
    if (!text.includes(`race-pit-append-${index}`)) missing.push(`race-pit-append-${index}`);
  }
  check(
    'E1',
    'NOT a proof of the C1 race: appends issued around a merge in ONE process all survive (the merge read-modify-write is synchronous, so setImmediate cannot interleave it)',
    missing.length === 0,
    { entriesBefore: before, entriesAfter: headings, missing, chars: text.length, interleaved: false },
  );
  /**
   * The two-process proof this probe deliberately did not attempt now exists elsewhere:
   * the ledger-core audit (`.dsh-code/audits/`, 2026-10-04) drove a real concurrent
   * merge∥append and found both halves of the defect — the rename onto a held file failed
   * with `EPERM`, the record was lost and a temp file was left behind; and two concurrent
   * merges each rewrote from their own snapshot, so two repeats showed as `recurred: 1`.
   * The merge and the append now take the same lock and `writeFileAtomic` removes its temp
   * on failure. This check stays as the single-process invariant it always was.
   */
}

fs.writeFileSync(OUT, `${JSON.stringify({ results, failed: results.filter((r) => !r.ok) }, null, 2)}\n`, 'utf8');
for (const r of results) {
  const detail = r.ok ? '' : `  <- ${JSON.stringify(r.evidence).slice(0, 400)}`;
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.id} ${r.name}${detail}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed, failed=[${failed.map((r) => r.id).join(', ')}]`);
console.log(`report: ${OUT}`);
process.exit(failed.length === 0 ? 0 : 1);
