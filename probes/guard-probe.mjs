/**
 * Guard regression probe: the ledger behaviours that were each a real bug.
 *
 * One check per bug the mode actually had, so a regression fails loudly instead
 * of being re-discovered by hand:
 *   A  brief budget: memory sections survive a tight budget; nothing drops silently
 *   B  "done" is evidence-gated: an unverified completion is flagged, a failing
 *      verification does not license it, a passing one does not warn
 *   E  an unverified debt is settled only by a *later* passing verification
 *   F  a task created as done/blocked lands in that list, and a contradictory
 *      board reads back filed by status
 *   G  the machine-wide ledger layer, under the ids it was specified with,
 *      B1-B6 — which the "done" block above also uses (the report prints names too)
 *
 * Plain node is enough (only `lib/ledger.js` is imported):
 *   & '<node>' '<pkg>\probes\guard-probe.mjs'
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { LIB_DIR, PROBES_DIR, tempReport } from './paths.mjs';

const ledger = await import(pathToFileURL(path.join(LIB_DIR, 'ledger.js')).href);
const OUT = tempReport('guard-report.json');
const SESSION = 'sess-guard-probe';
const OTHER = 'sess-earlier';

const checks = [];
const check = (id, name, ok, evidence) => checks.push({ id, name, ok: ok === true, evidence });
/** Body of one `## ` section; sections are joined by a blank line, entries are not. */
const sectionBody = (text, heading) => {
  const at = text.indexOf(heading);
  if (at < 0) return undefined;
  const rest = text.slice(at + heading.length);
  const next = rest.search(/\n\n## |\n\n… \(/);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
};
const scratch = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-guard-${tag}-`));
const dirs = [];
const project = (tag) => {
  const dir = scratch(tag);
  dirs.push(dir);
  ledger.initLedger(dir, SESSION);
  return dir;
};

/**
 * Hermetic against the developer's *real* machine-wide ledger.
 *
 * `~/.dsh-code/` exists on this host, and one pit in it changes every briefing —
 * including the ones the pre-existing A/D/E checks measure. Redirecting it inside
 * the machine block below was too late: those checks ran first, read the real
 * directory, and D1 and E went red the moment the real ledger appeared
 * (2026-10-02, first run after seeding `~/.dsh-code/mistakes.md`). The redirect
 * therefore lives here, before the first `brief`, and the machine block only
 * re-points it at its own fixture.
 */
const realGlobalDir = process.env.DSH_CODE_GLOBAL_DIR;
const hermeticGlobal = scratch('global-hermetic');
dirs.push(hermeticGlobal);
process.env.DSH_CODE_GLOBAL_DIR = hermeticGlobal;

// --- A: the briefing budget keeps the memory, and never omits silently -------
{
  const dir = project('budget');
  ledger.writeProject(dir, { commands: { test: 'pnpm test' }, stack: 'Node 24', notes: `N${'n'.repeat(2000)}` }, SESSION);
  ledger.recordTask(dir, { title: 'Fixture task' }, SESSION);
  for (let i = 0; i < 4; i += 1) {
    ledger.recordMistake(dir, { symptom: `MISTAKE-${i} symptom ${'s'.repeat(300)}`, cause: `cause ${'c'.repeat(200)}`, fix: `fix ${'f'.repeat(200)}`, files: `src/f${i}.js:10`, avoid: `avoid ${'a'.repeat(150)}` }, SESSION);
    ledger.recordDecision(dir, { title: `DECISION-${i}`, body: `body ${'d'.repeat(400)}`, alternatives: `rejected ${'r'.repeat(200)}` }, SESSION);
  }
  fs.appendFileSync(
    path.join(dir, '.dsh-code', 'journal.jsonl'),
    `${JSON.stringify({ ts: '2026-10-01T00:00:00.000Z', session: OTHER, kind: 'unverified', turn: 3, edits: ['write E:\\proj\\src\\important.js'] })}\n`,
  );
  const tight = ledger.brief(dir, { session: SESSION, maxChars: 4000 });
  const roomy = ledger.brief(dir, { session: SESSION, maxChars: 12000 });
  const headings = ['## Project', '## Recent ledger entries', '## Turns that changed code and ran nothing', '## Known mistakes', '## Recent decisions'];
  const keys = { '## Project': 'project', '## Recent ledger entries': 'journal', '## Turns that changed code and ran nothing': 'unverified', '## Known mistakes': 'mistakes', '## Recent decisions': 'decisions' };
  check('A1', 'the brief respects the requested budget', tight.text.length <= 4000, { chars: tight.text.length });
  check('A2', 'with room, every section is present', headings.every((h) => roomy.text.includes(h)), {
    chars: roomy.text.length,
    missing: headings.filter((h) => !roomy.text.includes(h)),
  });
  check(
    'A3',
    'the memory sections still reach the reader on a tight budget',
    /MISTAKE-/.test(sectionBody(tight.text, '## Known mistakes') ?? '') &&
      /DECISION-/.test(sectionBody(tight.text, '## Recent decisions') ?? ''),
    {
      mistakesChars: (sectionBody(tight.text, '## Known mistakes') ?? '').length,
      decisionsChars: (sectionBody(tight.text, '## Recent decisions') ?? '').length,
    },
  );
  const silent = headings.filter((h) => !tight.text.includes(h) && !tight.omitted.includes(keys[h]) && !tight.text.includes(keys[h]));
  check('A4', 'no section disappears without being named', silent.length === 0, { silent, omitted: tight.omitted });
  const debt = sectionBody(tight.text, '## Turns that changed code and ran nothing');
  check('A5', 'a present debt section names the edited file', debt === undefined || debt.includes('important.js'), {
    debt: (debt ?? '').slice(0, 120),
  });
}

// --- A6/A7: an unbounded ledger must still produce a bounded, readable brief --
/**
 * The regression this exists for, measured 2026-10-03: the project ledger held 30
 * entries (29,696 characters) and the machine ledger 77 (80,571) against a briefing
 * budget of 8,900, and the briefing answered with "… (76 older machine-wide pit(s)
 * dropped for length)" — a count of things the reader could neither see nor ask for.
 * A brief that scales with the ledger is not a brief; a brief that hides without a
 * way back is a lossy one.
 */
{
  const dir = project('bounded');
  ledger.writeProject(dir, { commands: { test: 'pnpm test' }, stack: 'Node 24' }, SESSION);
  for (let i = 0; i < 40; i += 1) {
    ledger.recordMistake(
      dir,
      {
        symptom: `BIG-${String(i).padStart(2, '0')} symptom ${'s'.repeat(140)}`,
        cause: `cause ${'c'.repeat(140)}`,
        fix: `fix ${'f'.repeat(140)}`,
        files: `src/big${i}.js`,
        avoid: `do not do BIG-${String(i).padStart(2, '0')} because ${'a'.repeat(60)}`,
      },
      SESSION,
    );
  }
  const brief = ledger.brief(dir, { session: SESSION, maxChars: 4000 });
  const body = sectionBody(brief.text, '## Known mistakes') ?? '';
  // A6: the bound holds no matter how large the ledger is, and the section still
  // names what it could not show instead of silently displaying a subset.
  check(
    'A6',
    'a 40-entry ledger still briefs inside the budget, and the entries it did not show are named',
    brief.text.length <= 4000 &&
      /40 mistake entr/.test(brief.text) &&
      (/- \[/.test(body) || /beyond this list/.test(body)) &&
      body.length <= 1400,
    { chars: brief.text.length, mistakesChars: body.length, indexed: (body.match(/^- \[/gm) ?? []).length, head: body.slice(0, 160) },
  );
  // A7: the way back is real — a query finds an entry the brief could not show,
  // and it comes back complete rather than as an index line.
  const missing = 'BIG-39';
  const found = ledger.brief(dir, { session: SESSION, maxChars: 4000, topic: 'src/big39.js' });
  const foundBody = sectionBody(found.text, '## Known mistakes') ?? '';
  check(
    'A7',
    'a topic query reaches an entry the brief itself could not show, in full',
    foundBody.includes(missing) && foundBody.includes('do not do BIG-39'),
    { query: 'src/big39.js', chars: foundBody.length, sample: foundBody.slice(0, 140) },
  );
}

// --- I: only what matters, and what recurs outranks what is merely new --------
{
  const dir = project('importance');
  const line = (i) => ({
    symptom: `I-${i} symptom ${'s'.repeat(160)}`,
    cause: `cause ${'c'.repeat(120)}`,
    fix: `fix ${'f'.repeat(120)}`,
    avoid: `do not do I-${i} because ${'a'.repeat(60)}`,
  });
  // Four entries that only carry prose (findable by search, but nothing can make
  // them arrive on their own) ...
  for (const i of [1, 2, 3, 4]) ledger.recordMistake(dir, line(i), SESSION);
  // ... and one that carries an executable trigger, recorded first so that
  // "newest wins" cannot be what makes it appear.
  ledger.recordMistake(dir, { ...line(0), trigger: 'I-TRIGGER-PATTERN' }, SESSION);
  const brief = ledger.brief(dir, { session: SESSION, maxChars: 4000 });
  const body = sectionBody(brief.text, '## Known mistakes') ?? '';
  check(
    'I1',
    'a pit that can arrive on its own outranks newer prose-only pits',
    body.includes('I-0') && (body.indexOf('I-0') < body.indexOf('I-4') || !body.includes('I-4')),
    { mistakesChars: body.length, order: body.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3, 12)) },
  );

  // A repeat is not a second entry: it is evidence, and it ranks first.
  const repeat = { symptom: 'I-REPEAT the same pit bites twice', cause: 'same cause', fix: 'same fix', avoid: 'do not repeat this pit because it recurs' };
  ledger.recordMistake(dir, repeat, SESSION);
  ledger.recordMistake(dir, repeat, SESSION);
  const file = fs.readFileSync(path.join(dir, '.dsh-code', 'mistakes.md'), 'utf8');
  const entries = file.split(/\n(?=## )/).filter((b) => b.trim().startsWith('## '));
  check(
    'I2',
    'recording the same pit twice merges it into one entry that says it recurred',
    entries.filter((b) => b.includes('I-REPEAT')).length === 1 && /- recurred: 1/.test(file),
    { entries: entries.length, recurred: /- recurred: (\d+)/.exec(file)?.[1] },
  );
  const afterRepeat = ledger.brief(dir, { session: SESSION, maxChars: 4000 });
  const repeatBody = sectionBody(afterRepeat.text, '## Known mistakes') ?? '';
  check(
    'I3',
    'the recurring pit is shown first, ahead of the triggered one',
    // Compare the rule text, not the slug: the heading has been through `slug()`
    // (`I-REPEAT` -> `i-repeat-the-same-pit-bites-twice`), so asserting on the raw
    // symptom string tested the slug's spelling rather than the ordering. Measured
    // 2026-10-03: the ordering was correct and the check was red.
    repeatBody.includes('do not repeat this pit because it recurs') &&
      (!repeatBody.includes('do not do I-0') ||
        repeatBody.indexOf('do not repeat this pit because it recurs') < repeatBody.indexOf('do not do I-0')),
    { head: repeatBody.slice(0, 120) },
  );

  // The machine ledger must be reachable by a query too — it held 96% of the rules
  // and `topic` searched the project file only (measured 2026-10-03).
  const machine = scratch('global-search');
  dirs.push(machine);
  const previous = process.env.DSH_CODE_GLOBAL_DIR;
  process.env.DSH_CODE_GLOBAL_DIR = machine;
  ledger.initLedger(undefined, SESSION, 'global');
  ledger.recordMistake(
    undefined,
    { symptom: 'MACHINE-ONLY pit about a mangled pipe', cause: 'c', fix: 'f', trigger: 'MACHINE-TRIGGER', avoid: 'do not pipe a byte array because it stringifies' },
    SESSION,
    'global',
  );
  const viaTopic = ledger.brief(dir, { session: SESSION, maxChars: 4000, topic: 'MACHINE-ONLY' });
  check(
    'I4',
    'a topic query reaches the machine-wide ledger, not just the project one',
    viaTopic.text.includes('MACHINE-ONLY') && viaTopic.text.includes('do not pipe a byte array'),
    { found: viaTopic.text.includes('MACHINE-ONLY'), chars: viaTopic.text.length },
  );
  process.env.DSH_CODE_GLOBAL_DIR = previous;

  // Nothing is deleted to make room: the archive stays whole.
  check(
    'I5',
    'bounding the brief never trims the ledger file it reads',
    entries.length === 6 && /I-4/.test(file),
    { entries: entries.length, bytes: file.length },
  );
}

// --- B: "done" must be evidence-gated ---------------------------------------
{
  const unearned = project('done-unearned');
  const task = ledger.recordTask(unearned, { title: 'Fix the parser', status: 'done', note: 'all tests pass' }, SESSION);
  check('B1', 'done with no verification is flagged', /\[!\] marked done with no passing code_verify/.test((task.task.notes ?? []).join(' | ')), {
    notes: (task.task.notes ?? []).join(' | '),
  });

  const failedOnly = project('done-failed');
  ledger.recordVerified(failedOnly, { cmd: 'pnpm test', expect: 'pass', ok: false, tail: '1 failing' }, SESSION);
  const afterFail = ledger.recordTask(failedOnly, { title: 'Fix the failing test', status: 'done' }, SESSION);
  check('B2', 'a failing verification does not license done', /\[!\] marked done/.test((afterFail.task.notes ?? []).join(' | ')), {
    notes: (afterFail.task.notes ?? []).join(' | '),
  });

  const earned = project('done-earned');
  ledger.recordVerified(earned, { cmd: 'pnpm test', expect: 'pass', ok: true, tail: 'ok 12' }, SESSION);
  const ok = ledger.recordTask(earned, { title: 'Fix the other parser', status: 'done', note: 'verified' }, SESSION);
  check('B3', 'done after a passing verification carries no warning', !/\[!\] marked done/.test((ok.task.notes ?? []).join(' | ')), {
    notes: (ok.task.notes ?? []).join(' | '),
  });
}

// --- E: a debt is settled only by later proof that covers it -----------------
// The older rule settled a debt with *any* later passing verification. Measured
// 2026-10-02: `code_verify` without an `expect` only demands exit 0, so a bare
// `echo hi` deleted this whole section and told the next reader the work had been
// proven. Proof must now match the debt's object: same subtree, or the file named
// in the command or its output. Proof that does not match does not delete the
// line either — it is counted and named, because a section that disappears reads
// as a section that was empty.
{
  // Each case builds its own fixture, so the recorded edit path must be derived
  // per case too: a path from one scratch dir can never sit inside another's.
  const debtLine = (ts, cwd, abs) => ({ ts, session: OTHER, kind: 'unverified', turn: 1, cwd, edits: [`write ${abs}`] });
  const proofLine = (ts, okValue, claimed, extra = {}) => ({
    ts,
    session: OTHER,
    kind: 'verified',
    cmd: 'pnpm test',
    expect: 'pass',
    ok: okValue,
    tail: 'x',
    ...(claimed === true ? { claimed: true } : {}),
    ...extra,
  });
  const showsDebt = (lines) => {
    const scratchDir = project('debt');
    const abs = path.join(scratchDir, 'src', 'a.js');
    fs.appendFileSync(path.join(scratchDir, '.dsh-code', 'journal.jsonl'), `${lines(scratchDir, abs).map((e) => JSON.stringify(e)).join('\n')}\n`);
    const brief = ledger.brief(scratchDir, { session: SESSION });
    return { shown: brief.text.includes('Turns that changed code and ran nothing'), brief };
  };
  const cases = [
    [
      'settled by a later passing verification that ran in its subtree',
      (d, abs) => [debtLine('2026-10-01T01:00:00.000Z', d, abs), proofLine('2026-10-01T02:00:00.000Z', true, false, { cwd: d })],
      false,
    ],
    ['NOT settled when the later verification failed', (d, abs) => [debtLine('2026-10-01T01:00:00.000Z', d, abs), proofLine('2026-10-01T02:00:00.000Z', false)], true],
    ['NOT settled by a claimed verification', (d, abs) => [debtLine('2026-10-01T01:00:00.000Z', d, abs), proofLine('2026-10-01T02:00:00.000Z', null, true)], true],
    ['NOT settled by an earlier verification', (d, abs) => [proofLine('2026-10-01T01:00:00.000Z', true), debtLine('2026-10-01T02:00:00.000Z', d, abs)], true],
    ['a fresh debt stays', (d, abs) => [debtLine('2026-10-01T01:00:00.000Z', d, abs)], true],
    [
      'NOT settled by a passing verification that ran somewhere else and named nothing',
      (d, abs) => [debtLine('2026-10-01T01:00:00.000Z', d, abs), proofLine('2026-10-01T02:00:00.000Z', true, false, { cmd: 'echo hi', cwd: 'C:/elsewhere/other' })],
      true,
    ],
    [
      'settled by a proof that names the file, from anywhere',
      (d, abs) => [debtLine('2026-10-01T01:00:00.000Z', d, abs), proofLine('2026-10-01T02:00:00.000Z', true, false, { cmd: 'node --test test/a.js', cwd: 'C:/elsewhere/other' })],
      false,
    ],
  ];
  for (const [name, lines, expected] of cases) {
    const { shown } = showsDebt(lines);
    check('E', name, shown === expected, { expected, observed: shown });
  }
  const { brief } = showsDebt((d, abs) => [debtLine('2026-10-01T01:00:00.000Z', d, abs), proofLine('2026-10-01T02:00:00.000Z', true, false, { cwd: d })]);
  check(
    'E',
    'a settled debt produces no notice of any kind',
    !brief.text.includes('had no entry to show') && !brief.text.includes('dropped for length'),
    { omitted: brief.omitted, emptySections: brief.emptySections, tail: brief.text.slice(-160) },
  );
  // The debt must not vanish; it must be counted and explained.
  const { brief: unmatched } = showsDebt((d, abs) => [
    debtLine('2026-10-01T01:00:00.000Z', d, abs),
    proofLine('2026-10-01T02:00:00.000Z', true, false, { cmd: 'echo hi', cwd: 'C:/elsewhere/other' }),
  ]);
  const unmatchedBody = sectionBody(unmatched.text, '## Turns that changed code and ran nothing') ?? '';
  check(
    'E',
    'a debt no proof covers is counted and named, not deleted',
    unmatchedBody.includes('1 earlier unproven turn(s) are still in') && unmatchedBody.includes('echo hi'),
    { body: unmatchedBody.slice(0, 300) },
  );
}

// --- E2: a failing-command debt needs a mistake about *that* failure ---------
// Same defect, second ledger: any later `kind:"mistake"` used to clear every
// earlier unrecorded failure, so an unrelated lesson silently emptied this
// section too.
{
  const failure = { cmd: 'pnpm test', signature: 'pnpm test → TypeError: cannot read properties of undefined' };
  const showsFailureDebt = (lines) => {
    const scratchDir = project('mistake-debt');
    fs.appendFileSync(path.join(scratchDir, '.dsh-code', 'journal.jsonl'), `${lines.map((e) => JSON.stringify(e)).join('\n')}\n`);
    const brief = ledger.brief(scratchDir, { session: SESSION });
    return sectionBody(brief.text, '## Failing commands nobody wrote down') ?? '';
  };
  const debt = { ts: '2026-10-01T01:00:00.000Z', session: OTHER, kind: 'mistake_unrecorded', turn: 4, failures: [failure] };
  /** A second debt whose command is the one the mistake below actually names. */
  const probeDebt = {
    ts: '2026-10-01T01:00:00.000Z',
    session: OTHER,
    kind: 'mistake_unrecorded',
    turn: 5,
    failures: [{ cmd: 'node probes/guard-probe.mjs', signature: 'boom' }],
  };
  const unrelated = {
    ts: '2026-10-01T02:00:00.000Z',
    session: OTHER,
    kind: 'mistake',
    heading: 'unrelated pit',
    symptom: 'the CSS looked wrong',
    cause: 'stale build',
    fix: 'rebuilt',
  };
  const quotes = {
    ts: '2026-10-01T02:00:00.000Z',
    session: OTHER,
    kind: 'mistake',
    heading: 'pnpm test crash',
    symptom: 'pnpm test failed with TypeError: cannot read properties of undefined',
    cause: 'a missing fixture',
    fix: 'created the fixture',
  };
  const names = {
    ts: '2026-10-01T02:00:00.000Z',
    session: OTHER,
    kind: 'mistake',
    heading: 'probe broke',
    symptom: 'node probes/guard-probe.mjs died',
    cause: 'stale fixture',
    fix: 'fixed it',
  };
  const unrelatedBody = showsFailureDebt([debt, unrelated]);
  check(
    'E2',
    'an unrelated mistake does not clear a failing-command debt',
    unrelatedBody.includes('does not name those commands') && unrelatedBody.includes('journal.jsonl'),
    { body: unrelatedBody.slice(0, 300) },
  );
  check('E2', 'a mistake that quotes the failure settles it', showsFailureDebt([debt, quotes]).trim().length === 0, {
    body: showsFailureDebt([debt, quotes]).slice(0, 200),
  });
  check(
    'E2',
    'a mistake that names the failing command settles it',
    showsFailureDebt([probeDebt, names]).trim().length === 0,
    { body: showsFailureDebt([probeDebt, names]).slice(0, 200) },
  );
  check(
    'E2',
    'a mistake filed against the failing file settles it',
    showsFailureDebt([probeDebt, { ...names, symptom: 'the probe died', files: 'probes/guard-probe.mjs' }]).trim().length === 0,
    { body: showsFailureDebt([probeDebt, { ...names, symptom: 'the probe died', files: 'probes/guard-probe.mjs' }]).slice(0, 200) },
  );
  check(
    'E2',
    'a mistake about another file in the same command does not settle it',
    showsFailureDebt([probeDebt, { ...names, symptom: 'something else broke', cause: 'x', fix: 'y', files: 'lib/budget.js' }])
      .includes('does not name those commands'),
    { body: showsFailureDebt([probeDebt, { ...names, symptom: 'something else broke', cause: 'x', fix: 'y', files: 'lib/budget.js' }]).slice(0, 240) },
  );
}

// --- F: board placement is by status, on write and on read ------------------
{
  const dir = project('board');
  ledger.recordVerified(dir, { cmd: 'pnpm test', expect: 'pass', ok: true, tail: 'ok' }, SESSION);
  const created = ledger.recordTask(dir, { title: 'Finished before it was recorded', status: 'done', note: 'one-shot' }, SESSION);
  const blocked = ledger.recordTask(dir, { title: 'Waiting on a decision', status: 'blocked' }, SESSION);
  const board = ledger.readTasks(dir);
  check(
    'F1',
    'a task created as done lands in done',
    (board.done ?? []).some((t) => t.id === created.task.id) && !(board.active ?? []).some((t) => t.id === created.task.id),
    { active: (board.active ?? []).map((t) => t.id), done: (board.done ?? []).map((t) => t.id) },
  );
  check('F2', 'a task created as blocked lands in blocked', (board.blocked ?? []).some((t) => t.id === blocked.task.id), {
    blocked: (board.blocked ?? []).map((t) => t.id),
  });
  check('F3', 'the briefing never lists a done task as in flight', !/In flight:[\s\S]*\[done\]/.test(ledger.brief(dir, { session: SESSION }).text), {
    boardSection: /## Task board\n([\s\S]*?)(\n\n|$)/.exec(ledger.brief(dir, { session: SESSION }).text)?.[1] ?? '(none)',
  });

  const heal = project('board-heal');
  fs.writeFileSync(
    path.join(heal, '.dsh-code', 'tasks.json'),
    JSON.stringify({
      version: 1,
      active: [{ id: '2026-10-01-already-done', title: 'Already done', status: 'done', notes: [] }],
      done: [],
      blocked: [{ id: '2026-10-01-was-active', title: 'Was active', status: 'active', notes: [] }],
    }),
  );
  const healed = ledger.readTasks(heal);
  check(
    'F4',
    'a contradictory board reads back filed by status',
    (healed.done ?? []).some((t) => t.id === '2026-10-01-already-done') &&
      (healed.active ?? []).some((t) => t.id === '2026-10-01-was-active'),
    { active: (healed.active ?? []).map((t) => t.id), done: (healed.done ?? []).map((t) => t.id) },
  );
}

// --- H: concurrent writers cannot lose an entry -------------------------------
// Two sessions can share a project (a second window, a resumed session, a
// subagent) and every ledger write appends to a file whose whole value is its
// line structure, so a lost append is invisible to the writer and permanent for
// the reader. Four separate processes race here through the same code path the
// tools use, started together so the appends actually overlap.
//
// A confined channel cannot start a child process at all: `spawn` with piped stdio
// dies with `EPERM: spawn` before any check runs (measured 2026-10-02 in the
// `code_verify` channel). That must not take the rest of the probe down with it —
// the same lesson `budget-probe.mjs` paid for when an unwritable fixture directory
// killed a whole run — so the race is guarded and reports the reason it could not
// run. Its two checks always exist, so the count stays 37 in every channel.
{
  const dir = project('concurrent');
  const journalFile = path.join(dir, '.dsh-code', 'journal.jsonl');
  const mistakesFile = path.join(dir, '.dsh-code', 'mistakes.md');
  const WRITERS = 4;
  const PER_WRITER = 25;
  const writerPath = path.join(PROBES_DIR, 'ledger-writer.mjs');
  /** Set when this channel forbids spawning; both H checks then report the reason. */
  let spawnBlocked;
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: WRITERS }, (_value, index) => {
      const tag = `w${index}`;
      const outDir = scratch(`writer-${tag}`);
      dirs.push(outDir);
      const outFile = path.join(outDir, 'writer.json');
      return new Promise((resolve) => {
        let child;
        try {
          child = spawn(process.execPath, [writerPath, dir, String(PER_WRITER), tag, outFile], {
            cwd: PROBES_DIR,
            // `ignore`, never a pipe: a confined channel refuses the pipe and the race
            // would silently never run (measured 2026-10-03 — it reported `skipped` in
            // every channel of this session). The verdict travels in a file instead.
            stdio: 'ignore',
          });
        } catch (error) {
          // Synchronous EPERM: the sandbox refused to start the program at all.
          resolve({ tag, code: -1, stderr: String(error?.message ?? error).slice(0, 200) });
          return;
        }
        const settle = () => {
          let status;
          try {
            status = JSON.parse(fs.readFileSync(outFile, 'utf8'));
          } catch {
            status = undefined;
          }
          resolve({
            tag,
            code: child.exitCode ?? -1,
            status: status?.status,
            reported: status !== undefined,
            stderr: status?.message === undefined ? '' : String(status.message).slice(0, 200),
          });
        };
        // The report file is the completion signal; `exit` confirms the process is gone
        // (its last write may still be in flight when the file appears).
        const deadline = Date.now() + 30000;
        const poll = () => {
          const done = child.exitCode !== null || child.signalCode !== null;
          if (done) {
            settle();
            return;
          }
          if (Date.now() > deadline) {
            try {
              child.kill();
            } catch {
              /* already gone */
            }
            resolve({ tag, code: -1, reported: false, stderr: 'writer did not finish within 30s' });
            return;
          }
          setTimeout(poll, 15);
        };
        child.once('error', (error) => resolve({ tag, code: -1, reported: false, stderr: String(error?.message ?? error).slice(0, 200) }));
        setTimeout(poll, 15);
      });
    }),
  );
  const elapsedMs = Date.now() - started;
  const journalText = fs.readFileSync(journalFile, 'utf8');
  const lines = journalText.split('\n').filter((line) => line.trim().length > 0);
  const parsed = [];
  let torn = 0;
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      torn += 1;
    }
  }
  const unverified = parsed.filter((entry) => entry.kind === 'unverified');
  const mistakesInJournal = parsed.filter((entry) => entry.kind === 'mistake');
  const mistakeFileText = fs.readFileSync(mistakesFile, 'utf8');
  const mistakeBlocks = mistakeFileText.split('\n').filter((line) => line.startsWith('## ')).length;
  const expectedEach = WRITERS * PER_WRITER;
  const spawnRefused =
    results.length > 0 &&
    results.every((result) => result.reported === false && /spawn|EPERM|EACCES/.test(result.stderr ?? ''));
  if (spawnRefused) spawnBlocked = results[0]?.stderr ?? 'unknown reason';
  // A skipped check is not a failing check: in a channel that refuses to spawn,
  // reporting H1/H2 as red would be a lie about the code. It is reported as
  // skipped, on stderr, and counted apart — but never silently, because a green
  // run must not be read as "the concurrency path was checked here".
  const tornNow = torn;
  const childCodes = results.map((result) => result.code);
  if (spawnBlocked !== undefined) {
    checks.push({ id: 'H1', name: 'four concurrent writers lose no entry and never write a torn line', skipped: true, evidence: { skippedBecause: spawnBlocked } });
    checks.push({ id: 'H2', name: 'no lock file is left behind once the writers are done', skipped: true, evidence: { skippedBecause: spawnBlocked } });
    console.error(`guard-probe: H1/H2 NOT RUN — this channel forbids spawning a child process with a pipe (${spawnBlocked})`);
  } else {
    check(
      'H1',
      'four concurrent writers lose no entry and never write a torn line',
      childCodes.every((code) => code === 0) &&
        unverified.length === expectedEach &&
        mistakesInJournal.length === expectedEach &&
        mistakeBlocks === expectedEach &&
        tornNow === 0,
      {
        elapsedMs,
        children: results.map((result) => ({ tag: result.tag, code: result.code, stderr: result.stderr })),
        unverified: unverified.length,
        expectedEach,
        mistakesInJournal: mistakesInJournal.length,
        mistakeBlocks,
        tornLines: tornNow,
      },
    );
    check(
      'H2',
      'no lock file is left behind once the writers are done',
      !fs.existsSync(`${journalFile}.lock`) && !fs.existsSync(`${mistakesFile}.lock`),
      {
        journalLock: fs.existsSync(`${journalFile}.lock`),
        mistakesLock: fs.existsSync(`${mistakesFile}.lock`),
      },
    );
  }
}

// --- D: unchanged behaviour --------------------------------------------------
{
  const dir = project('small');
  ledger.writeProject(dir, { commands: { test: 'pnpm test' }, stack: 'Node 24' }, SESSION);
  const small = ledger.brief(dir, { session: SESSION });
  check('D1', 'a small ledger drops nothing for length', small.omitted.length === 0 && !small.text.includes('dropped for length'), {
    chars: small.text.length,
    omitted: small.omitted,
  });
  const fresh = ledger.brief(scratch('empty'), {});
  dirs.push(fresh === undefined ? '' : '');
  check('D2', 'a fresh project still gets the "start the ledger" answer', fresh.empty === true && fresh.text.includes('No ledger yet'), {
    firstLine: fresh.text.split('\n')[0],
  });
}

// --- G/B1-B6: the machine-wide ("global") ledger layer -----------------------
//   B1 scope routing: the fact lands in the override dir, the project ledger is untouched
//   B2 the briefing carries the machine heading, the pit heading and its trigger
//   B3 a project with no ledger of its own still gets the machine section
//   B4 a machine with no global ledger changes nothing and does not throw
//   B5 a machine section the budget cannot fit is named, never dropped silently
//   B6 a machine project.json fact is rendered as a `- key: value` line, and its
//      empty-valued fields (commands:{}, notes:'') stay unrendered
//
// This block runs last on purpose: every check above must keep seeing the briefing
// as it was before this layer existed, so the override is installed here rather than
// at the top of the file, and removed again before the cleanup below. The pit is
// recorded under SESSION and read back under OTHER: a section filtered by session
// would otherwise make a pass vacuous.
{
  const priorGlobal = process.env.DSH_CODE_GLOBAL_DIR;
  const GLOBAL = ledger.SCOPE.global;
  // The module keeps this heading private, so the probe pins the published wording:
  // a rename is a briefing-contract change and should fail here rather than pass.
  const MACHINE_HEADING = '## Machine-wide facts (true of this host, every project)';
  const root = project('global-project');
  const projectMistakes = path.join(root, '.dsh-code', 'mistakes.md');
  const projectJournal = path.join(root, '.dsh-code', 'journal.jsonl');
  const untouchedBefore = [fs.readFileSync(projectMistakes, 'utf8'), fs.readFileSync(projectJournal, 'utf8')];

  const machine = scratch('global-machine');
  process.env.DSH_CODE_GLOBAL_DIR = machine;
  const SYMPTOM = 'GLOBAL-PIT a pipe rewrite mangles a byte[]';
  const TRIGGER = 'npm (run )?build \\| Set-Content';
  const RULE = 'never pipe build output through PowerShell';
  ledger.initLedger(root, SESSION, GLOBAL);
  ledger.recordMistake(
    root,
    { symptom: SYMPTOM, cause: 'the shell re-encoded the stream', fix: 'write with Node, never Set-Content', trigger: TRIGGER, avoid: RULE },
    SESSION,
    GLOBAL,
  );
  const machineMistakes = fs.readFileSync(path.join(machine, 'mistakes.md'), 'utf8');
  const rows = fs
    .readFileSync(path.join(machine, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const pitHeading = (machineMistakes.split('\n').find((line) => line.startsWith('## ')) ?? '').slice(3).trim();
  const triggerLine = machineMistakes.split('\n').find((line) => line.startsWith('- trigger:')) ?? '(none)';
  const untouchedAfter = [fs.readFileSync(projectMistakes, 'utf8'), fs.readFileSync(projectJournal, 'utf8')];
  check(
    'B1',
    'a global mistake lands in the override dir and leaves the project ledger untouched',
    ledger.globalDir() === path.resolve(machine) &&
      pitHeading.length > 0 &&
      triggerLine === `- trigger: ${TRIGGER}` &&
      machineMistakes.includes(`- symptom: ${SYMPTOM}`) &&
      rows.some((row) => row.kind === 'mistake' && row.scope === GLOBAL && row.symptom === SYMPTOM) &&
      untouchedAfter[0] === untouchedBefore[0] &&
      untouchedAfter[1] === untouchedBefore[1],
    {
      scopeGlobal: GLOBAL,
      globalDir: ledger.globalDir(),
      override: machine,
      pitHeading,
      triggerLine,
      journalRows: rows.map((row) => `${row.kind}${row.scope === undefined ? '' : ` scope=${row.scope}`}`),
      globalFiles: fs.readdirSync(machine).sort(),
      globalTasksJson: fs.existsSync(path.join(machine, 'tasks.json')),
      projectMistakesUnchanged: untouchedAfter[0] === untouchedBefore[0],
      projectJournalUnchanged: untouchedAfter[1] === untouchedBefore[1],
    },
  );

  const withMachine = ledger.brief(root, { session: OTHER });
  check(
    'B2',
    'the briefing carries the machine heading, the pit heading and its trigger',
    withMachine.text.includes(MACHINE_HEADING) &&
      withMachine.text.includes(pitHeading) &&
      withMachine.text.includes(TRIGGER),
    {
      heading: MACHINE_HEADING,
      pitHeading,
      trigger: TRIGGER,
      section: (sectionBody(withMachine.text, MACHINE_HEADING) ?? '(no machine section)').slice(0, 400),
    },
  );

  const bare = ledger.brief(scratch('global-bare'), { session: OTHER });
  check(
    'B3',
    'a project with no ledger still gets the machine section, still saying empty',
    bare.empty === true &&
      bare.text.includes(MACHINE_HEADING) &&
      bare.text.includes(pitHeading) &&
      bare.text.includes('No ledger yet'),
    { empty: bare.empty, firstLine: bare.text.split('\n')[0], chars: bare.text.length, omitted: bare.omitted },
  );

  const missing = path.join(scratch('global-missing'), 'absent');
  let withoutMachine;
  let threw;
  process.env.DSH_CODE_GLOBAL_DIR = missing;
  try {
    withoutMachine = ledger.brief(root, { session: OTHER });
  } catch (e) {
    threw = String(e?.message ?? e);
  }
  process.env.DSH_CODE_GLOBAL_DIR = machine;
  /**
   * The trailing discovery line is dropped, and that is not a concession: it is
   * *supposed* to change when the machine ledger is absent (it stops claiming there are
   * machine-wide pits to go and read). Removing it here is what keeps this check about
   * "nothing else changed" while `hintNamesMachine` / `hintSilentWithoutMachine` below
   * assert the one difference that is intended, in both directions.
   *
   * The comparison is over *lines*, not characters. Measured 2026-10-03: two runs of the
   * same briefing differed by a single trailing separator (one `\n`, one space) at the
   * join where the machine block used to sit, and a whole-document string compare called
   * that a regression. Line-wise comparison asks the question this check is actually
   * about — did any section change? — and trailing whitespace is not a section.
   */
  const strip = (text) =>
    text
      .split('\n\n')
      .filter((part) => !part.startsWith(MACHINE_HEADING))
      .join('\n\n')
      .split('\n')
      .filter((line) => !line.startsWith('This brief is a selection, not the ledger:'))
      .join('\n');
  const lineWise = (text) =>
    text
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .join('\n');
  const withoutText = withoutMachine?.text ?? '';
  check(
    'B4',
    'a machine with no global ledger changes nothing and does not throw',
    threw === undefined &&
      !withoutText.includes(MACHINE_HEADING) &&
      !withoutText.includes(missing) &&
      strip(withMachine.text) !== undefined &&
      lineWise(strip(withMachine.text)) === lineWise(withoutText) &&
      JSON.stringify(withoutMachine?.omitted) === JSON.stringify(withMachine.omitted) &&
      /**
       * The discovery line has to report the machine layer, not just exist.
       *
       * This is the one place the missing machine ledger legitimately changes the text:
       * a reader who is told "there are N pit(s) you cannot see" when there are none
       * would go looking for a file that is not there. Asserted in both directions so
       * neither a hardcoded count nor a silent omission can pass.
       */
      /plus \d+ machine-wide pit/.test(withMachine.text) &&
      !/machine-wide pit/.test(withoutText),
    {
      threw: threw ?? null,
      missing,
      machineSectionGone: !withoutText.includes(MACHINE_HEADING),
      identicalApartFromMachineSection: strip(withMachine.text) === withoutText,
      hintNamesMachine: /plus \d+ machine-wide pit/.test(withMachine.text),
      hintSilentWithoutMachine: !/machine-wide pit/.test(withoutText),
      /**
       * Where the two texts diverge, when they do. Comparing whole documents leaves a
       * reader with "false" and no way to see why; the first divergence plus its context
       * turns a red check into a diagnosis (paid for 2026-10-03, when this check went
       * red twice with no visible reason).
       */
      firstDivergence: (() => {
        const a = strip(withMachine.text);
        const b = withoutText;
        let at = 0;
        while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
        return a === b ? 'none' : { at, withMachine: a.slice(Math.max(0, at - 40), at + 60), withoutMachine: b.slice(Math.max(0, at - 40), at + 60) };
      })(),
      omitted: withoutMachine?.omitted,
      omittedWithMachine: withMachine.omitted,
    },
  );

  const tiny = ledger.brief(root, { session: OTHER, maxChars: 200 });
  const silenced = !tiny.text.includes(MACHINE_HEADING) && !tiny.omitted.includes(GLOBAL) && !tiny.text.includes(GLOBAL);
  check(
    'B5',
    'a machine section the budget cannot fit is named, never dropped silently',
    silenced === false && (!tiny.omitted.includes(GLOBAL) || /dropped for length[^\n]*global/.test(tiny.text)),
    {
      chars: tiny.text.length,
      appears: tiny.text.includes(MACHINE_HEADING),
      omitted: tiny.omitted,
      notice: (tiny.text.split('\n').find((line) => line.includes('dropped for length')) ?? '(none)').slice(0, 240),
    },
  );

  // The other half of `globalExcerpt`, which B1-B5 never reached: the fact lines.
  // The fixture above initialises a machine `project.json` holding only
  // version/createdAt/commands:{}/notes:'' — every one of them skipped by design —
  // so the `- <key>: <value>` renderer could have removed itself unnoticed. A real
  // machine fact is written here under SESSION and read back under OTHER: a
  // mechanism filtered by session must be asserted from someone else's session.
  ledger.writeProject(root, { sandbox: 'B6-MARKER value' }, SESSION, GLOBAL);
  const withFact = ledger.brief(root, { session: OTHER });
  const factSection = sectionBody(withFact.text, MACHINE_HEADING);
  const factLines = (factSection ?? '').split('\n').map((line) => line.trim());
  // Prefix matching, not a literal `- commands:` search: a regression renders the
  // empty object as `- commands: {}`, which the literal string would not match.
  const leakedEmptyFields = factLines.filter((line) => /^- (commands|notes):/.test(line));
  check(
    'B6',
    'a machine fact is rendered as a key/value line while empty fields stay unrendered',
    factSection !== undefined &&
      factLines.includes('- sandbox: B6-MARKER value') &&
      leakedEmptyFields.length === 0 &&
      !(factSection ?? '').includes('- commands:') &&
      !(factSection ?? '').includes('- notes:'),
    {
      wrote: { sandbox: 'B6-MARKER value' },
      writtenUnder: SESSION,
      readUnder: OTHER,
      markerLineShown: factLines.includes('- sandbox: B6-MARKER value'),
      leakedEmptyFields,
      factLines: factLines.filter((line) => line.startsWith('- ') && !line.startsWith('- trigger:')),
      machineProjectJson: ledger.readProject(undefined, GLOBAL),
      section: (factSection ?? '(no machine section)').slice(0, 400),
    },
  );

  // Teeth for the priority rule *inside the facts*: the machine section drops by ranking,
  // never by size. Measured 2026-10-03 on the real machine ledger — 9 facts cost 1,748
  // characters against a 1,100-character ceiling, and the old loop `break`ed on the first
  // fact that did not fit, so the *longest* fact was dropped first while 33-character path
  // facts survived. Size is not importance: the longest fact there is also the most
  // valuable (a measured environment finding). So the ranking must follow recency, and a
  // fact that cannot be shown in full must still be *named* — see the assertion below,
  // which accepts the newest fact either rendered or named (2026-10-04).
  {
    // The fixture mirrors the real ledger's shape — a handful of facts, some very long —
    // rather than twenty short ones, because twenty short facts legitimately *do* fit and
    // would leave the ranking untested (measured 2026-10-03: the first version of this
    // check failed for exactly that reason, not because the ranking was wrong).
    const longValue = `b7_long_value_${'x'.repeat(600)}`;
    // The three facts, and the values they carry, in one place: written in this order so
    // the newest is also the longest (the inverse of the old size-ordered behaviour), and
    // reported below so a red check can be read without re-deriving the fixture.
    const FACTS = {
      b7_older_long: `older_${'y'.repeat(500)}`,
      b7_small_older: 'short older value',
      b7_long_recent: longValue,
    };
    ledger.writeProject(root, { b7_older_long: FACTS.b7_older_long }, SESSION, GLOBAL);
    ledger.writeProject(root, { b7_small_older: FACTS.b7_small_older }, SESSION, GLOBAL);
    ledger.writeProject(root, { b7_long_recent: FACTS.b7_long_recent }, OTHER, GLOBAL);
    const factBrief = ledger.brief(root, { session: OTHER, maxChars: 8000 });
    const section = sectionBody(factBrief.text, MACHINE_HEADING) ?? '';
    const lines = section.split('\n').map((line) => line.trim());
    const named = lines.filter((line) => /^-\s*b7_\w+ \(\d+ chars\)/.test(line));
    /**
     * The newest-and-longest fact is either shown whole **or named** — updated 2026-10-04.
     *
     * This check used to require the full line unconditionally, which was true only while
     * the section let its final head-keep `clip` do the bounding: the newest facts sit
     * first, so they survived and everything after them was cut. That cut silently ate the
     * *named* lines for the older facts — the very guarantee the two-pass fact rendering
     * exists for. `globalExcerpt` now bounds itself: full lines when they fit, otherwise a
     * recency-ordered index, and the newest fact is then reachable by name instead of in
     * full. Demanding the full line would re-assert the behaviour that caused the loss, so
     * the assertion is what the check is actually named for: rendered by recency, and
     * named when it cannot be shown.
     */
    const newestShown = lines.includes(`- b7_long_recent: ${longValue}`);
    const newestNamed = named.some((line) => line.startsWith('- b7_long_recent ('));
    check(
      'B7',
      'the machine section renders a long fact by recency and *names* those it cannot show',
      (newestShown || newestNamed) &&
        (lines.includes('- b7_older_long: ' + `older_${'y'.repeat(500)}`) ||
          lines.includes('- b7_small_older: short older value') ||
          named.length > 0) &&
        (named.length > 0 || section.includes('not even named')) &&
        !/more fact\(s\) dropped for length/.test(section),
      {
        longFactShownInFull: lines.includes(`- b7_long_recent: ${longValue}`),
        named,
        oldMarkerPresent: /more fact\(s\) dropped for length/.test(section),
        // `writeProject` returns `{ file, notice }`, never a record with a timestamp — the
        // old `older.ts` here read `undefined`, so the diagnostic that matters when this
        // check goes red reported nothing. Report the fixture's own sizes instead: this
        // check is about recency and size, not about clocks.
        writtenKeys: Object.entries(FACTS).map(([key, value]) => `${key}(${value.length} chars)`),
        sectionHead: section.slice(0, 320),
      },
    );
  }

  // Teeth for the priority rule inside `globalExcerpt`: facts must never crowd out
  // the pits. Measured 2026-10-02 in a real session — five `- key: value` facts are
  // ~600 characters, they consumed the whole section allowance, and the briefing
  // reported "… (4 older machine-wide pit(s) dropped for length)" with **zero** pits
  // shown: the machine layer was present and said nothing actionable. The facts below
  // are deliberately fat enough to fill the section on their own, so this check fails
  // against an implementation that renders facts first and pits with the leftovers.
  ledger.writeProject(
    root,
    { fat1: 'F'.repeat(200), fat2: 'F'.repeat(200), fat3: 'F'.repeat(200), fat4: 'F'.repeat(200) },
    SESSION,
    GLOBAL,
  );
  const fatBrief = ledger.brief(root, { session: OTHER });
  const fatSection = sectionBody(fatBrief.text, MACHINE_HEADING) ?? '';
  const isFactLine = (line) => /^- [a-z][a-z0-9_-]*: /.test(line);
  const fatLines = fatSection
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));
  /**
   * **A pit is not a fact line, and this check used to be unable to tell.**
   *
   * `isFactLine` matches `^- <key>: `, which is exactly the shape of a pit's own fields
   * (`- symptom: …`, `- do not repeat: …`). Counting "lines that are not facts" therefore
   * counted *zero* whenever a pit was shown, so `pitLinesShown >= 1` could never hold and
   * this check failed permanently. The other half was vacuous for the same reason:
   * `!fatLines.some(isFactLine)` is false as soon as a pit renders, so "names the facts it
   * dropped" was never actually required. Corrected 2026-10-04: the pit is recognised by
   * its own heading and by the section's pit header, never by "not a fact shape".
   */
  const hasPitHeader = /Pits (that are true of this machine|matching)/.test(fatSection);
  const pitEntriesShown = (fatSection.match(/^## /gm) ?? []).length;
  const factLinesShown = fatLines.filter(isFactLine).length;
  check(
    'B8',
    'a section full of facts still shows a pit, and names the facts it dropped',
    fatSection.length > 0 &&
      (hasPitHeader || pitEntriesShown >= 1) &&
      (factLinesShown > 0 || /more fact\(s\) dropped/.test(fatSection) || /not even named/.test(fatSection)),
    {
      sectionChars: fatSection.length,
      hasPitHeader,
      pitEntriesShown,
      factLinesShown,
      namesDroppedFacts: /more fact\(s\) dropped/.test(fatSection) || /not even named/.test(fatSection),
      section: fatSection.slice(0, 400),
    },
  );

  if (priorGlobal === undefined) delete process.env.DSH_CODE_GLOBAL_DIR;
  else process.env.DSH_CODE_GLOBAL_DIR = priorGlobal;
}

// Put the developer's own machine-ledger path back before anything else reads it.
if (realGlobalDir === undefined) delete process.env.DSH_CODE_GLOBAL_DIR;
else process.env.DSH_CODE_GLOBAL_DIR = realGlobalDir;

for (const dir of dirs) if (dir.length > 0) fs.rmSync(dir, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok && c.skipped !== true);
const skipped = checks.filter((c) => c.skipped === true);
const report = {
  failed: failed.map((c) => `${c.id} ${c.name}`),
  passed: checks.filter((c) => c.ok === true).length,
  total: checks.length,
  ...(skipped.length === 0 ? {} : { skipped: skipped.map((c) => `${c.id} ${c.name}`), skippedBecause: skipped[0]?.evidence?.skippedBecause }),
  checks,
};
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(
  JSON.stringify(
    { passed: report.passed, total: report.total, failed: report.failed, ...(skipped.length === 0 ? {} : { skipped: report.skipped }) },
    null,
    2,
  ),
);
process.exitCode = failed.length === 0 ? 0 : 1;
