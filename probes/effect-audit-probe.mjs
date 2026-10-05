/**
 * Effect audit: did the mechanisms *produce* anything, and what did the gate cost?
 *
 * Why this exists (2026-10-05): this repository has 44 probes and every one of them
 * answers "is the mechanism doing what I said it does". None answered "did it produce
 * value". The starting readings that made that a gap rather than a philosophy:
 * 37/67 command-side `trigger:` entries have never been hit, 33/79 file-side ones have
 * never matched an edit, the cross-project promotion yield is 0, `compact-gate` has never
 * crossed its real line in a `code`-preset session, and 3 `files:` pointers name files
 * that no longer exist. The project's own working habit says it plainly — *a green
 * harness is not a green product* — and it had applied that rule to its tools and never
 * to itself.
 *
 * WHAT THIS FILE OWNS — the part of the effect question that had no owner:
 *
 *   1. Gate cost: how many turns closed with "code changed and no evidence recorded",
 *      and did those debts ever get settled. The source is `kind:'unverified'` journal
 *      entries, which `lib/ledger.js`'s `recordUnverified` (line 2040) writes
 *      **unconditionally** — unlike the gate's opt-in `DSH_CODE_GATE_JOURNAL` trace,
 *      which has never been switched on: there is no gate-journal data file on this disk,
 *      only `probes/gate-journal-probe.mjs`, so the finer "was this notice delivered"
 *      question is unanswerable historically.
 *   2. The shape of that cost at session level: which sessions ended with debts, and how
 *      concentrated the debt is.
 *
 * WHAT THIS FILE DOES NOT OWN — and deliberately does not recompute:
 *
 *   - **liveness**, which is `probes/pit-liveness.mjs`'s: a `trigger:` that does not
 *     compile or that its own `triggerSample` does not match, a `files:` path that names
 *     no file, a trigger no recorded command has ever matched, a file-keyed entry that
 *     has never matched an edit, and the cross-project promotion candidates. This project
 *     has already paid for "two owners of one number drifting apart", so the report
 *     carries a pointer (`ownership.liveness`) instead of a second count — and `E4`
 *     asserts that pointer exists *and* that no key of this report recomputes it. If the
 *     two ever disagree, that is a defect to report, not two numbers to publish.
 *   - **net context cost per turn/session**, which has algorithms but no cross-session
 *     aggregation: `probes/context-cost.mjs` prices the newest session and
 *     `probes/mode-cost.mjs` prices 24 of them, both as reports. This audit does not
 *     claim it; `measurements.context_cost` says so on its face, with the reason, rather
 *     than publishing a number from a third reader of the session logs.
 *
 * The `state` field on an `unverified` entry is the existing contract this audit rests
 * on and must never collapse: `"none"` (the turn ran no command at all) and `"ran"` (a
 * command ran, but nothing recorded its exit code or output) are two different debts, and
 * the writer has allowed `state` to be absent for long enough that the absent case is a
 * third bucket rather than a zero.
 *
 * Read-only, and bounded on purpose: it never writes the journal or the ledger, and it
 * reads at most `SEGMENTS_PER_SCOPE` journal segments per scope — the bound is a declared
 * field of the report (`reading`, pinned by `E7`), because an audit that does not state
 * what it read is itself a mechanism whose cost nobody ever verified.
 *
 * Plain Node only: `lib/ledger.js` imports just `./pattern-matcher.js`, so no Electron and
 * no host resolution are involved. `debt-audit.mjs` runs this file as a child with
 * `stdio: 'ignore'` (a confined channel refuses a piped child), so the verdict travels in
 * the `-report.json` below — whose name is the one `debt-audit.mjs:451` derives from this
 * filename, not a second convention. Stdout keeps working, because the real numbers are
 * the point of the exercise.
 *
 * Run: node probes/effect-audit.mjs [--no-real]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PKG_DIR, tempReport } from './paths.mjs';

const ledger = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'ledger.js')).href);

/**
 * How many journal segments one scope may be read from, newest first.
 *
 * `JOURNAL_KEEP` is 8 and rotation renames rather than deletes, so the newest 8 segments
 * are the newest 9 including the live file — which is every segment that exists on this
 * host today, so the bound costs nothing yet still holds if a pathological writer makes
 * more. It is a *declared* bound (repeated in the report, pinned by `E7`) because the
 * alternative is an audit whose own read cost nobody can name.
 */
const SEGMENTS_PER_SCOPE = 8;
/** How many sessions the distribution keeps as whole rows before counting the rest. */
const TOP_SESSIONS = 5;
/**
 * The diagnostic switch, read once here rather than parked on the global object.
 *
 * The first version wrote `globalThis.__DIAG_STATE = process.argv.includes('--diag-state')`
 * at the point of use, which puts a diagnostic switch in a namespace shared with every other
 * module in the realm — something else can read it, and something else can flip it. A switch
 * that governs *this* file's tracing is this file's business. Defined before `classifyDebts`
 * so the trace inside that function and the block further down read the same answer.
 */
const DIAG = process.argv.includes('--diag-state');
/** Matches `debt-audit.mjs:451`: `file.replace(/-probe\.mjs$/, '') + '-report.json'`. */
const OUT = process.env.DSH_PROBE_REPORT ?? tempReport('effect-audit-report.json');

const checks = [];
const check = (id, name, ok, evidence) => checks.push({ id, name, ok: ok === true, evidence });
const preview = (value, n = 260) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text === undefined || text === null ? String(text) : text.length > n ? `${text.slice(0, n)}…` : text;
};

// ------------------------------------------------------------------- fixtures
/**
 * The discovery line, printed before anything else runs.
 *
 * `os.tmpdir()` is a *per-command* directory in a confined channel (the pit is recorded:
 * each run gets a different `%TEMP%`), so a report written to the default path is gone by
 * the time the next command looks for it, and the machine ledger this audit reads through
 * `DSH_CODE_GLOBAL_DIR` may resolve somewhere entirely unlike `~/.dsh-code`. Both facts
 * change how a failure here has to be read, so both are printed rather than assumed.
 */
if (process.argv.includes('--paths')) {
  console.log(`tmpdir       : ${os.tmpdir()}`);
  console.log(`package      : ${PKG_DIR}`);
  console.log(`globalDir()  : ${ledger.globalDir()}`);
  console.log(`DSH_CODE_GLOBAL_DIR: ${process.env.DSH_CODE_GLOBAL_DIR ?? '(unset)'}`);
  console.log(`report path  : ${OUT}`);
  // Inlined rather than reached through the helper below, which is a `const` declared
  // further down: this block runs before it, and a `const` in that position is a temporal
  // dead zone, not a hoisted function.
  for (const [scope, dir] of [
    ['project', PKG_DIR],
    ['global', ledger.globalDir()],
  ]) {
    console.log(`${scope.padEnd(7)} project root: ${dir}`);
    for (const file of ledger.journalFiles(dir, scope)) console.log(`        segment ${file}`);
  }
  process.exit(0);
}

const scratch = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-effect-audit-${tag}-`));
const ledgerDirOf = (dir) => path.join(dir, ledger.DIRNAME);
const journalOf = (dir) => path.join(ledgerDirOf(dir), ledger.FILES.journal);
/** Every journal segment on disk for one ledger: the live file plus its rotation slots. */
function onDiskSegments(dir) {
  let names;
  try {
    names = fs.readdirSync(ledgerDirOf(dir));
  } catch {
    return [];
  }
  return names
    .filter((name) => name === ledger.FILES.journal || name.startsWith(`${ledger.FILES.journal}.`))
    .filter((name) => !name.endsWith('.lock'))
    .sort();
}
/** The non-empty lines of one segment, straight off disk. */
const segmentLines = (dir, name) =>
  fs
    .readFileSync(path.join(ledgerDirOf(dir), name), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);

/** One line's `kind`, or `undefined` when the line is torn — never a silent zero. */
const kindOf = (line) => {
  try {
    return JSON.parse(line)?.kind;
  } catch {
    return undefined;
  }
};

/** Non-empty lines across every segment, counted straight off disk rather than through the reader. */
const linesOnDisk = (dir) =>
  onDiskSegments(dir).reduce((total, name) => total + segmentLines(dir, name).length, 0);

/**
 * Lines of one `kind` across every segment — the same instrument, filtered by the field the
 * comparison is about.
 *
 * `E1` needs this because a journal legitimately carries entries that are not debts, and the
 * fixture's own `initLedger` call is where they come from: `writeProject` appends
 * `kind:'project'` (`lib/ledger.js:1599`) and then `initLedger` appends `kind:'init'`
 * (`:1630`), so a fresh ledger already has two lines before the fixture writes a debt — in
 * the main fixture that is 13 lines for 7 debts, and in the rotated one 5 lines for the 3
 * debts that live in `.000`. Comparing the debt count against *every* line would therefore
 * be false in any fixture that initialises a ledger, and it is the wrong question anyway:
 * what must equal the file is the `unverified` population, and the raw line count has to be
 * accounted for separately so that a reader which dropped a line cannot hide behind the
 * bookkeeping (`E1` pins both relations).
 */
const kindLinesOnDisk = (dir, kind) =>
  onDiskSegments(dir).reduce(
    (total, name) => total + segmentLines(dir, name).filter((line) => kindOf(line) === kind).length,
    0,
  );
/** Every `.dsh-code` file as `name → exact bytes`: the read-only check's whole instrument. */
function snapshot(dir) {
  const out = {};
  const walk = (current, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(full, `${rel}/`);
      else out[rel] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(ledgerDirOf(dir), '');
  return out;
}
const changedKeys = (before, after) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => before[key] !== after[key]);

/**
 * One debt line, serialised exactly as `recordUnverified` writes it (library line 2040):
 * `ts`, `session`, `kind`, `turn`, `state`, `cwd`, `edits`.
 *
 * Written by hand rather than through that function for one reason that matters: the
 * fixture needs a debt whose `ts` is *earlier* than the proof which covers it, and the
 * library stamps `ts` from the wall clock, so two library calls in one process cannot be
 * ordered apart. E1 also needs deliberate segment placement, which no writer offers.
 */
const appendDebt = (dir, { ts, session, state, edits, cwd, turn = 1 }) =>
  fs.appendFileSync(
    journalOf(dir),
    `${JSON.stringify({
      ts,
      session,
      kind: 'unverified',
      turn,
      ...(state === undefined ? {} : { state }),
      cwd: cwd ?? dir,
      edits,
    })}\n`,
    'utf8',
  );

/** One proof line, the shape `recordVerified` writes (library line 1981). */
const appendProof = (dir, { ts, session, cmd, cwd, ok = true, claimed, tail }) =>
  fs.appendFileSync(
    journalOf(dir),
    `${JSON.stringify({ ts, session, kind: 'verified', cmd, cwd: cwd ?? dir, expect: 'ok', ok, ...(claimed === true ? { claimed: true } : {}), tail })}\n`,
    'utf8',
  );

/** `ts` strings comparable with `>`: one second apart, in the past so nothing races. */
const at = (second) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();

// ------------------------------------------------------------- the measurement
/**
 * One scope's journal, read through the ledger's own segment list.
 *
 * `journalFiles` is imported rather than re-derived because rotation's naming is the one
 * thing a second implementation would get wrong in a way nobody notices: the newest
 * segment is `.000` and the *oldest* is the highest number, so a reader that sorted
 * ascending would report the newest lines as the oldest. A line that is not JSON is
 * counted, never dropped silently — "28 lines, 1 unreadable" is a different report from
 * "29 lines", and a torn last line is ordinary in an append-only file.
 */
function readSegments(dir, { scope, limit = SEGMENTS_PER_SCOPE } = {}) {
  const found = ledger.journalFiles(dir, scope).map((file) => ({
    file,
    name: path.relative(ledgerDirOf(dir), file).split(path.sep).join('/'),
  }));
  // `journalFiles` is oldest-first; truncating from the front keeps the newest `limit`.
  const read = found.slice(Math.max(0, found.length - limit));
  const rows = [];
  const skips = [];
  const perSegment = [];
  // Segments whose bytes were actually read. This, and not the length of the list above,
  // is the only evidence that a journal exists — see `judgeable` below.
  let readable = 0;
  for (const segment of read) {
    let text;
    try {
      text = fs.readFileSync(segment.file, 'utf8');
    } catch {
      skips.push({ segment: segment.name, lines: 0, reason: 'no file at this path' });
      perSegment.push({ ...segment, lines: 0, rows: 0, unverified: 0 });
      continue;
    }
    readable += 1;
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    let kept = 0;
    let unverified = 0;
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        skips.push({ segment: segment.name, lines: 1, reason: 'line is not JSON (torn or malformed)' });
        continue;
      }
      rows.push(record);
      kept += 1;
      if (record?.kind === 'unverified') unverified += 1;
    }
    perSegment.push({ ...segment, lines: lines.length, rows: kept, unverified });
  }
  return {
    scope,
    dir,
    ledgerDir: ledgerDirOf(dir),
    segmentCap: limit,
    segmentsOnDisk: found.map((segment) => segment.name),
    segmentsRead: read.map((segment) => segment.name),
    segmentsReadable: readable,
    perSegment,
    rows,
    skips,
    /**
     * `false` only when no segment could actually be *read*.
     *
     * Not `read.length > 0`, which is what this was: `journalFiles` synthesizes the live
     * path when the ledger directory does not exist (`lib/ledger.js:1030` returns
     * `[ledgerPath(cwd,'journal',scope)]` after a failed `readdirSync`), so the list is
     * never empty and a project with no ledger at all was reported as a **real zero** —
     * "there is no data" printed as "the data says none", which is the one conflation the
     * `state` contract a few lines up forbids and `E5` exists to catch. Being handed a path
     * is not evidence that a file is there; a read that succeeded is.
     */
    judgeable: readable > 0,
    unjudgeable:
      readable === 0
        ? `no journal segment could be read under ${ledgerDirOf(dir)} (looked for ${
            found.map((s) => s.name).join(', ') || '(nothing)'
          }), so nothing here can say whether a turn owed evidence`
        : undefined,
  };
}

/** The targets a proof can cover, mirroring the library's `editTargets` (line 2282). */
function editTargets(edits) {
  const tokens = new Set();
  for (const edit of Array.isArray(edits) ? edits : []) {
    const parts = String(edit ?? '').trim().split(/\s+/);
    const value = parts.at(-1) ?? '';
    const cleaned = value
      .replace(/^[`"'([]+|[`"'),.\]]+$/g, '')
      .replace(/:\d+(?:-\d+)?$/, '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (cleaned.length >= 4) tokens.add(cleaned);
  }
  return [...tokens];
}

/**
 * Path containment by segments, mirroring `isAncestorOrSelf` (line 2155).
 *
 * A segment comparison and not a string prefix, which is the whole point: `/tmp/p1-a` must
 * not read as an ancestor of `/tmp/p1-b`, and the relative/absolute pair (`lib/x.js` versus
 * the absolute project root) has to keep working because `recordVerified` stores an
 * absolute `cwd` while the edit tool's argument is recorded verbatim.
 */
function isAncestorOrSelf(candidate, target) {
  const a = String(candidate ?? '').split('/').filter((part) => part.length > 0 && part !== '.');
  const b = String(target ?? '').split('/').filter((part) => part.length > 0 && part !== '.');
  if (a.length === 0 || b.length === 0) return false;
  const absolute = (value) => /^[a-z]:\//.test(value) || value.startsWith('/');
  if (absolute(candidate) !== absolute(target)) {
    if (!absolute(target)) return false; // a relative target anchors nothing
    const directory = b.slice(0, -1);
    const offset = directory.length - a.length;
    return offset >= 0 && a.every((segment, index) => segment === directory[offset + index]);
  }
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return short.every((segment, index) => segment === long[index]);
}

/** A relative target anchored at the debt's own `cwd`, mirroring `resolveAgainst` (line 2186). */
function resolveAgainst(target, origin) {
  const base = String(origin ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (/^[a-z]:\//.test(target) || target.startsWith('/') || !/^[a-z]:\//.test(base)) return target;
  return `${base}/${target}`;
}

/** Whether one proof covers one edited target, mirroring `proofCoversTarget` (line 2206). */
function proofCoversTarget(proof, target, origin) {
  const resolved = resolveAgainst(target, origin);
  if (resolved.length < 3) return true; // nothing to match on: do not manufacture a debt
  if (typeof proof.cwd === 'string' && proof.cwd.trim().length > 0) {
    const base = proof.cwd
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (base.length > 0 && isAncestorOrSelf(base, resolved)) return true;
  }
  const needle = resolved.split('/').at(-1) ?? '';
  if (needle.length < 4) return false;
  return [proof.cmd, proof.tail].some((text) => typeof text === 'string' && text.toLowerCase().includes(needle));
}

/**
 * The settlement predicate.
 *
 * This mirrors a *subset* of `lib/ledger.js`: `unverifiedExcerpt` (line 2383) and the two
 * path rules it delegates to. It is restated rather than imported because the library
 * exports neither and `lib/` is outside this change's scope — so the restatement carries an
 * obligation instead: `E2` requires this predicate to flip when a covering proof is added,
 * and to *not* flip for a proof that does not cover the edit, or that failed, or that was
 * `claimed`. If it ever diverges from the library, the count here is wrong and this comment
 * is where to look.
 *
 * The empty-target case is the library's own rule (line 2418's `targets.length === 0`):
 * with no addressable target there is nothing for a proof to fail to match, so a later
 * proof settles the debt. An early draft of this file inverted that and would have called
 * a settled debt unsettled for every edit recorded as a bare filename.
 */
function classifyDebts({ rows, scope, laterProofs = true }) {
  const debts = rows.filter((row) => row?.kind === 'unverified');
  const proofs = rows.filter(
    (row) => row?.kind === 'verified' && row.ok === true && row.claimed !== true && typeof row.ts === 'string',
  );
  const stateOf = (debt) => (debt.state === 'none' ? 'none' : debt.state === 'ran' ? 'ran' : 'absent');
  const state = { none: 0, ran: 0, absent: 0 };
  for (const debt of debts) state[stateOf(debt)] += 1;

  const unsettled = [];
  let settled = 0;
  let unresolved = 0;
  for (const debt of debts) {
    const when = typeof debt.ts === 'string' ? debt.ts : '';
    const later = laterProofs ? proofs.filter((proof) => when.length > 0 && proof.ts > when) : [];
    if (later.length === 0) {
      unsettled.push({ ts: when, session: debt.session, state: stateOf(debt), edits: debt.edits ?? [] });
      continue;
    }
    const targets = editTargets(debt.edits);
    if (targets.length === 0 || targets.some((target) => later.some((proof) => proofCoversTarget(proof, target, debt.cwd))))
      settled += 1;
    else unresolved += 1;
  }

  const sessions = new Map();
  for (const debt of debts) {
    const key = typeof debt.session === 'string' ? debt.session : '(no session)';
    const row = sessions.get(key) ?? { session: key, turns: 0, states: { none: 0, ran: 0, absent: 0 } };
    row.turns += 1;
    row.states[stateOf(debt)] += 1;
    sessions.set(key, row);
  }
  const sorted = [...sessions.values()].sort((a, b) => b.turns - a.turns || a.session.localeCompare(b.session));
  const buckets = { '1 turn': 0, '2-3 turns': 0, '4-7 turns': 0, '8+ turns': 0 };
  for (const row of sorted) {
    const key = row.turns === 1 ? '1 turn' : row.turns <= 3 ? '2-3 turns' : row.turns <= 7 ? '4-7 turns' : '8+ turns';
    buckets[key] += 1;
  }

  if (DIAG && scope === 'project') {
    console.log(
      `RETURN debts=${debts.length} state=${JSON.stringify(state)} settled=${settled} unresolved=${unresolved} unsettled=${unsettled.length}`,
    );
  }
  return {
    scope,
    debts: debts.length,
    state,
    settled,
    unresolved,
    unproven_unsettled: unsettled.length,
    /**
     * Every debt has exactly one verdict. Stated because a histogram that loses a debt is
     * the failure mode this whole audit exists to catch, and a fixture pins it.
     */
    verdicts_add_up: settled + unresolved + unsettled.length === debts.length,
    proofs_on_record: proofs.length,
    sessions: {
      distinct: sorted.length,
      turns_buckets: buckets,
      top: sorted.slice(0, TOP_SESSIONS).map((row) => ({ ...row })),
      omitted: Math.max(0, sorted.length - TOP_SESSIONS),
    },
    head: unsettled.slice(0, 3).map((debt) => ({ ts: debt.ts, state: debt.state, edits: debt.edits.slice(0, 2) })),
  };
}

/** The two ledgers this audit reads, in the order they are reported. */
const scopesOf = (projectRoot) => [
  { scope: 'project', dir: projectRoot ?? PKG_DIR },
  { scope: 'global', dir: ledger.globalDir() },
];

/**
 * The whole gate-cost measurement over a pair of ledgers.
 *
 * `laterProofs: false` is the control's mechanism and nothing else: the same rows, with
 * settlement switched off, must report a *larger* unsettled count. That is what makes E2 a
 * comparison rather than a decoration — a predicate that never settles anything satisfies
 * "the debt is unsettled" and fails only here.
 */
function runAudit({ projectRoot, limit = SEGMENTS_PER_SCOPE, laterProofs = true } = {}) {
  const scopes = [];
  for (const { scope, dir } of scopesOf(projectRoot)) {
    const reading = readSegments(dir, { scope, limit });
    scopes.push({
      scope,
      dir: reading.dir,
      ledgerDir: reading.ledgerDir,
      files: onDiskSegments(dir),
      judgeable: reading.judgeable,
      unjudgeable: reading.unjudgeable,
      rows: reading.rows.length,
      rows_unparsed: reading.skips.length,
      skips: reading.skips.slice(0, 3),
      segments: {
        on_disk: reading.segmentsOnDisk,
        read: reading.segmentsRead,
        cap: reading.segmentCap,
        omitted: Math.max(0, reading.segmentsOnDisk.length - reading.segmentsRead.length),
        lines_per_segment: reading.perSegment.map(({ name, lines, rows, unverified }) => ({ name, lines, rows, unverified })),
      },
      debt: reading.judgeable ? classifyDebts({ rows: reading.rows, scope, laterProofs }) : undefined,
    });
  }
  return { limit, later_proofs_considered: laterProofs, scopes };
}

// ------------------------------------------------------------------- fixtures
/**
 * The main fixture: **seven** debts (`state` none 4 / ran 2 / absent 1, all three buckets)
 * and three proofs, plus one failed and one `claimed` proof that are not proofs.
 *
 * Every number in the checks below is written by this block, so `E1`–`E3` compare the
 * report against the file on disk rather than against a literal copied from the report —
 * a hard-coded expectation is how a check stops noticing that its subject changed. The
 * counts those checks pin (`debts`, the three `state` buckets, `proofs_on_record`) are the
 * fixture's own contract: they are literals *because* the fixture is hand-written, and a
 * fixture edit must fail here loudly rather than be followed silently.
 *
 *   sess-a  3 debts (state none/ran/ran)  →  one later proof in the project root covers all
 *                                            three structurally (same `cwd` as the debt)
 *   sess-b  1 debt, no `state`, absolute →  the one debt whose proof is *not* in an
 *                                            ancestor of its `cwd`, so the later proof
 *                                            settles it through the literal basename rule
 *   sess-c  1 debt                       →  the only later proof runs in a sibling dir and
 *                                            names nothing, so the debt stays `unresolved`
 *   sess-d  1 debt, relative target      →  settled because `editTargets` cannot address
 *                                            `tiny.js` (under 4 characters), the library's
 *                                            own empty-target rule
 *   sess-e  1 debt                       →  followed only by a failed proof and a `claimed`
 *                                            one, neither of which settles anything
 */
const main = scratch('main');
ledger.initLedger(main, 'sess-effect-audit');
appendDebt(main, { ts: at(1), session: 'sess-a', state: 'none', edits: [`edit ${path.join(main, 'lib', 'one.js')}`] });
appendDebt(main, { ts: at(2), session: 'sess-a', state: 'ran', edits: [`edit ${path.join(main, 'lib', 'two.js')}`], turn: 2 });
appendDebt(main, { ts: at(3), session: 'sess-a', state: 'ran', edits: [`edit ${path.join(main, 'lib', 'three.js')}`], turn: 3 });
appendDebt(main, { ts: at(4), session: 'sess-b', edits: [`edit ${path.join(main, 'lib', 'four.js')}`] });
appendProof(main, { ts: at(5), session: 'sess-b', cmd: `node ${path.join(main, 'probes', 'proves-one.mjs')}`, cwd: main, tail: 'one.js ok' });
appendDebt(main, { ts: at(6), session: 'sess-c', state: 'none', edits: [`edit ${path.join(main, 'lib', 'five.js')}`], turn: 5 });
appendProof(main, { ts: at(7), session: 'sess-c', cmd: 'node somewhere-else.mjs', cwd: path.join(main, 'other'), tail: 'nothing about that file' });
appendDebt(main, { ts: at(8), session: 'sess-d', state: 'none', edits: ['edit lib/tiny.js'] });
appendProof(main, { ts: at(9), session: 'sess-d', cmd: 'node proves-tiny.mjs', cwd: main, tail: 'tiny.js ok' });
appendProof(main, { ts: at(10), session: 'sess-e', cmd: 'node fails-anyway.mjs', cwd: main, ok: false });
appendProof(main, { ts: at(11), session: 'sess-e', cmd: 'node claimed-only.mjs', cwd: main, claimed: true });
appendDebt(main, { ts: at(12), session: 'sess-e', state: 'ran', edits: [`edit ${path.join(main, 'lib', 'six.js')}`], turn: 6 });

/**
 * What the main fixture left on disk, counted with `fs` and frozen here.
 *
 * Frozen before `E6` appends its own control line, so these are the bytes `E2`–`E4` judge.
 * `unverified` is the number `E1` compares against — it is the population that must equal
 * the debts, read off disk rather than copied out of the report, which is the whole reason
 * `kindLinesOnDisk` exists. `lines` is kept beside it because the two relations together are
 * the receipt: every line on disk is accounted for, and the debts are what the reader saw.
 */
const mainWritten = {
  segments: onDiskSegments(main).length,
  lines: linesOnDisk(main),
  unverified: kindLinesOnDisk(main, 'unverified'),
};
/**
 * The fixture's `state` buckets counted straight off the bytes by this probe.
 *
 * `E3` compares the report's own tally against *this*, not against a literal: the numbers
 * the reader publishes about `state` are only worth something if they agree with the lines
 * that carry the field, and a hand-copied literal would keep agreeing with a reader that
 * stopped looking at the file.
 */
const stateOnDisk = (dir) => {
  const found = { none: 0, ran: 0, absent: 0 };
  for (const row of onDiskSegments(dir).flatMap((name) => segmentLines(dir, name))) {
    let record;
    try {
      record = JSON.parse(row);
    } catch {
      continue;
    }
    if (record?.kind !== 'unverified') continue;
    found[record.state === 'none' ? 'none' : record.state === 'ran' ? 'ran' : 'absent'] += 1;
  }
  return found;
};
const mainStateOnDisk = stateOnDisk(main);
const mainReport = runAudit({ projectRoot: main });
const mainDebt = mainReport.scopes[0].debt;
if (DIAG) {
  console.log(
    'DIAG disk-state  :',
    JSON.stringify(stateOnDisk(main)),
    'unverified=',
    kindLinesOnDisk(main, 'unverified'),
    'lines=',
    linesOnDisk(main),
    'classified=',
    JSON.stringify(mainDebt.state),
    'sess-d=',
    JSON.stringify(
      onDiskSegments(main)
        .flatMap((name) => segmentLines(main, name))
        .map((line) => JSON.parse(line))
        .filter((row) => row.kind === 'unverified' && row.session === 'sess-d')
        .map((row) => [row.session, row.state]),
    ),
  );
}
// TEMP-DIAG
if (DIAG) {
  const raw = fs
    .readFileSync(journalOf(main), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  console.log('DIAG raw kinds   :', raw.map((row) => row.kind).join(','));
  console.log(
    'DIAG raw state   :',
    raw.filter((row) => row.kind === 'unverified').map((row) => `${row.session}=${row.state === undefined ? '(absent)' : row.state}`).join(','),
  );
  console.log('DIAG read rows   :', mainReport.scopes[0].rows, 'perSegment:', JSON.stringify(mainReport.scopes[0].segments.lines_per_segment));
  console.log('DIAG exact rows  :', JSON.stringify(raw.filter((row) => row.kind === 'unverified').map((row) => [row.session, row.state, row.turn, row.ts])));
  console.log('DIAG tally       :', JSON.stringify(mainDebt.state), 'total', mainDebt.debts, 'settled', mainDebt.settled, 'unresolved', mainDebt.unresolved, 'unsettled', mainDebt.unproven_unsettled);
  console.log('DIAG fn source   :', String(classifyDebts).split('\n').slice(0, 8).join(' ~ '));
  console.log('DIAG tally again :', JSON.stringify(mainReport.scopes[0].debt.state), JSON.stringify(mainDebt.state));
  // The same pure function, over rows built here from the same file: if this disagrees with
  // the tally above, the *reader* mutates what it hands to `classifyDebts`.
  const reRows = raw.filter((row) => row.kind === 'unverified');
  {
    const direct = { none: 0, ran: 0, other: 0 };
    const perRow = [];
    for (const row of reRows) {
      if (row.state === 'none') direct.none += 1;
      else if (row.state === 'ran') direct.ran += 1;
      else direct.other += 1;
      perRow.push(`${row.session}:${row.state === 'none' ? 'none' : row.state === 'ran' ? 'ran' : 'other'}`);
    }
    console.log('DIAG direct count:', JSON.stringify(direct), 'perRow:', perRow.join(','));
    console.log(
      'DIAG cps         :',
      reRows
        .map((row) => {
          const raw = row.state;
          const cps = typeof raw === 'string' ? [...raw].map((ch) => ch.codePointAt(0)).join('.') : String(raw);
          return `${row.session}[${typeof raw}|${cps}|eq=${raw === 'none'}]`;
        })
        .join(' '),
    );
  }
  console.log('DIAG reclassify  :', JSON.stringify(classifyDebts({ rows: reRows, scope: 'project' }).state));
  console.log(
    'DIAG row order   :',
    reRows
      .map((row, index) => `${index}:${row.session} raw=${typeof row.state}/${JSON.stringify(row.state)}`)
      .join(' | '),
  );
  console.log('DIAG main rows   :', typeof mainReport.scopes[0].debt, JSON.stringify(mainReport.scopes[0].debt?.state));
  {
    const tally = { none: 0, ran: 0, absent: 0 };
    const keys = Object.keys(mainDebt.state).join('/');
    for (const row of raw.filter((entry) => entry.kind === 'unverified')) {
      tally[row.state === 'none' ? 'none' : row.state === 'ran' ? 'ran' : 'absent'] += 1;
    }
    console.log(
      `DIAG compare mainDebt=${JSON.stringify(mainDebt.state)} keys=${keys} rawTally=${JSON.stringify(tally)} reclassify=${JSON.stringify(classifyDebts({ rows: raw, scope: 'project' }).state)}`,
    );
  }
  const probeRows = [
    { kind: 'unverified', ts: at(1), session: 'x', state: 'none', edits: [] },
    { kind: 'unverified', ts: at(2), session: 'x', state: 'ran', edits: [] },
    { kind: 'unverified', ts: at(3), session: 'x', state: 'none', edits: [] },
  ];
  console.log('DIAG control-cls :', JSON.stringify(classifyDebts({ rows: probeRows, scope: 'project' }).state));
  for (const row of reRows) {
    console.log(`DIAG row ${row.session} raw=${JSON.stringify(row.state)} bucket=${row.state === 'none' ? 'none' : 'ran'}`);
  }
}
const mainControl = runAudit({ projectRoot: main, laterProofs: false }).scopes[0].debt;
/**
 * The library's own reader over the same rows — a second statement about one ledger.
 *
 * It is used as a *shape* check only (does its unverified section exist at all), never as a
 * count: its section is clipped to a budget and starts with a heading, so parsing a number
 * out of it would compare two differently-bounded views. The count comparison is against
 * `fs`, which has no budget.
 */
const librarySays = ledger.brief(main, { session: 'sess-not-in-this-fixture' });
const libraryNamesDebt = librarySays.text.includes('Turns that changed code and ran nothing');

// ---------------------------------------------------------------------- E1
/**
 * The count must equal the file, and it must survive rotation.
 *
 * The second half is the one that can silently destroy this audit: `readJournalText` exists
 * because rotation renames (`.000`, `.001`, …) rather than deletes, so a reader that only
 * opened the live file would report **less** debt the more the project writes — an audit
 * that gets blinder as the evidence grows. The fixture therefore rotates for real: three
 * debts, the file renamed into the first slot, two more debts.
 */
const rot = scratch('rotated');
ledger.initLedger(rot, 'sess-effect-audit');
for (const second of [1, 2, 3]) {
  appendDebt(rot, {
    ts: at(second),
    session: 'sess-rot-old',
    state: second === 1 ? 'none' : 'ran',
    edits: [`edit ${path.join(rot, 'lib', `old${second}.js`)}`],
  });
}
const rotatedName = `${ledger.FILES.journal}.000`;
fs.renameSync(journalOf(rot), path.join(ledgerDirOf(rot), rotatedName));
for (const second of [4, 5]) {
  appendDebt(rot, {
    ts: at(second),
    session: 'sess-rot-new',
    state: 'none',
    edits: [`edit ${path.join(rot, 'lib', `new${second}.js`)}`],
  });
}
const rotReading = runAudit({ projectRoot: rot }).scopes[0];
const rotOnDisk = onDiskSegments(rot);
const rotLines = linesOnDisk(rot);
const rotInRotated = fs
  .readFileSync(path.join(ledgerDirOf(rot), rotatedName), 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0).length;
/**
 * The rotated fixture's two populations, counted with `fs` — the receipt `mainWritten` keeps,
 * for the same reason.
 *
 * `E1`'s question is whether the *debts* the reader aggregated equal the **`unverified`**
 * lines on disk, and a journal legitimately carries lines that are not debts: `initLedger`
 * writes `project` then `init`, so a fresh ledger holds two lines before the fixture writes
 * anything. Comparing a debt count against *every* line is therefore false in any fixture
 * that initialises a ledger — measured 2026-10-05, the rotated fixture reported 5 debts
 * against 7 lines. The raw count stays pinned beside the filtered one rather than replaced
 * by it: together they are the receipt, and a reader that dropped a line cannot agree with
 * itself across both.
 */
const rotWritten = {
  lines: linesOnDisk(rot),
  unverified: kindLinesOnDisk(rot, 'unverified'),
  inRotatedSegment: segmentLines(rot, rotatedName).filter((line) => kindOf(line) === 'unverified').length,
};
/** The rotated fixture's `state` buckets, counted off the bytes by the same instrument E3 uses. */
const rotStateOnDisk = stateOnDisk(rot);
check(
  'E1',
  "the turns aggregated from `kind:'unverified'` equal the lines on disk, including the ones in a rotated segment",
  rotReading.debt !== undefined &&
    rotWritten.unverified === 5 &&
    rotReading.debt.debts === rotWritten.unverified &&
    rotWritten.inRotatedSegment === 3 &&
    // The receipt: every line on disk is accounted for, and the debts are the filtered
    // population — a reader that dropped a line cannot agree with itself across both.
    rotWritten.unverified < rotWritten.lines &&
    rotOnDisk.length === 2 &&
    rotReading.segments.on_disk.length === 2 &&
    rotReading.segments.read.length === 2 &&
    // The report must also agree with itself line by line: the per-segment counts are the
    // receipt for the total, and a segment that contributed lines must show them.
    rotReading.segments.lines_per_segment.reduce((total, row) => total + row.unverified, 0) === rotReading.debt.debts &&
    rotReading.segments.lines_per_segment.find((row) => row.name === rotatedName)?.unverified === 3 &&
    rotReading.rows_unparsed === 0 &&
    // The main fixture's debts are on disk before E6 appends its own control line, so this
    // is the count of what E2–E4 are judging — read back off the file with `fs`, not copied
    // from the report and not a literal, so a reader that dropped a debt cannot agree with
    // itself here. The raw line count is pinned separately below: it is what proves the
    // `unverified` filter is the only difference between the two numbers.
    mainDebt.debts === mainWritten.unverified &&
    mainWritten.unverified < mainWritten.lines &&
    mainReport.scopes[0].rows === mainWritten.lines,
  {
    counted: rotReading.debt?.debts,
    unverifiedOnDisk: rotWritten.unverified,
    allLinesOnDisk: rotWritten.lines,
    inRotatedSegment: rotWritten.inRotatedSegment,
    segmentsOnDisk: rotReading.segments.on_disk,
    segmentsRead: rotReading.segments.read,
    perSegment: rotReading.segments.lines_per_segment,
    mainFixture: {
      counted: mainDebt.debts,
      unverifiedOnDisk: mainWritten.unverified,
      allLinesOnDisk: mainWritten.lines,
      rowsRead: mainReport.scopes[0].rows,
    },
  },
);

// ---------------------------------------------------------------------- E2
/**
 * Settlement, with the control that makes it a comparison.
 *
 * Of the fixture's seven debts, **six** are settled — three of sess-a's structurally (one
 * later proof whose `cwd` is an ancestor of each debt's target), two through the literal
 * basename rule (sess-b and sess-d, neither of which has its proof run in a directory that
 * contains the target), one because its target is unaddressable and the library's own
 * empty-target rule settles it. One is `unresolved`: the only proof later than sess-c's debt
 * runs in a sibling directory and names nothing relevant, which is the half that stops "a
 * later proof exists" from passing as "the debt was proved". One is `unproven_unsettled`:
 * sess-e's debt is followed only by a failed proof and a `claimed` one, so it has no later
 * proofs at all. Then `laterProofs: false` re-reads the same bytes with settlement switched
 * off: nothing may be settled and the unsettled count must be the whole fixture. A
 * predicate that always answers "settled" fails that half; one that always answers
 * "unsettled" fails the six numbers in the first half.
 */
check(
  'E2',
  "control: a later `kind:'verified'` that covers a debt removes it from the unsettled count, and the same comparison can go red",
  mainDebt.settled === 6 &&
    mainDebt.unresolved === 0 &&
    mainDebt.unproven_unsettled === 1 &&
    mainDebt.verdicts_add_up === true &&
    mainDebt.debts === 7 &&
    mainDebt.proofs_on_record === 3 && // the failed and the `claimed` proof are not proofs
    // The control is the same rows with the *later* filter removed, so both of its numbers
    // are pinned against the fixture rather than against one literal: the identical read
    // that settled six must now settle none and leave every debt unsettled.
    mainControl.settled === 0 &&
    mainControl.unresolved === 0 &&
    mainControl.debts === mainDebt.debts &&
    mainControl.proofs_on_record === mainDebt.proofs_on_record &&
    mainControl.unproven_unsettled === mainDebt.debts &&
    libraryNamesDebt === true,
  {
    settled: mainDebt.settled,
    unresolved: mainDebt.unresolved,
    unprovenUnsettled: mainDebt.unproven_unsettled,
    total: mainDebt.debts,
    proofsOnRecord: mainDebt.proofs_on_record,
    control: {
      settled: mainControl.settled,
      unresolved: mainControl.unresolved,
      unsettled: mainControl.unproven_unsettled,
      total: mainControl.debts,
    },
    libraryNamesADebt: libraryNamesDebt,
    unsettledHead: mainDebt.head,
  },
);

// ---------------------------------------------------------------------- E3
/**
 * `state:"none"` and `state:"ran"` are two debts and must never become one number.
 *
 * The gate's writer treats a missing `state` as "not supplied" (line 2049), so folding the
 * absent case into either neighbour would misreport what the gate actually wrote. Both
 * fixtures are tallied straight off the bytes by `stateOnDisk`, and **that** tally is what
 * this check compares against: a hand-copied expectation is how this check spent a whole
 * round being unsatisfiable, because its own comment described a different fixture ("four
 * `none` … two `ran`") from the one the code writes (three and three) and then also demanded
 * `none !== ran`, which those numbers can never satisfy. Pinning each bucket individually
 * against disk is what actually catches a reader that folds `absent` into a neighbour.
 * The absent bucket needs its own fixture, further down, because it is the bucket a reporter
 * is most tempted to fold away.
 */
check(
  'E3',
  'the two debt states are counted apart, and a missing `state` is its own bucket rather than either neighbour',
  mainDebt.state.none === mainStateOnDisk.none &&
    mainDebt.state.ran === mainStateOnDisk.ran &&
    mainDebt.state.absent === mainStateOnDisk.absent &&
    rotReading.debt.state.none === rotStateOnDisk.none &&
    rotReading.debt.state.ran === rotStateOnDisk.ran &&
    rotReading.debt.state.absent === rotStateOnDisk.absent &&
    // Individual buckets catch a fold; this adds that the buckets exhaust the debts, on both
    // the report's tally and the bytes'.
    mainDebt.state.none + mainDebt.state.ran + mainDebt.state.absent === mainDebt.debts &&
    mainStateOnDisk.none + mainStateOnDisk.ran + mainStateOnDisk.absent === mainDebt.debts,
  {
    main: { state: mainDebt.state, onDisk: mainStateOnDisk, total: mainDebt.debts },
    rotated: { state: rotReading.debt.state, onDisk: rotStateOnDisk, total: rotReading.debt.debts },
    note: 'the absent bucket is pinned separately by E3b, because a debt recorded before `state` existed is not the same as one that ran nothing',
  },
);

/**
 * The absent bucket, on its own fixture: a debt with no `state` at all must not be silently
 * counted as `"none"` — that would report a turn that was never asked as a turn that ran
 * nothing, which is the same conflation the two named states exist to prevent.
 */
const stateless = scratch('stateless');
ledger.initLedger(stateless, 'sess-effect-audit');
appendDebt(stateless, { ts: at(1), session: 'sess-old', edits: [`edit ${path.join(stateless, 'lib', 'old.js')}`] });
appendDebt(stateless, { ts: at(2), session: 'sess-old', state: 'none', edits: [`edit ${path.join(stateless, 'lib', 'new.js')}`] });
appendDebt(stateless, { ts: at(3), session: 'sess-old', state: 'ran', edits: [`edit ${path.join(stateless, 'lib', 'newer.js')}`] });
const statelessDebt = runAudit({ projectRoot: stateless }).scopes[0].debt;
check(
  'E3b',
  'a debt with no `state` at all is a third bucket, not silently one of the two',
  statelessDebt.state.absent === 1 &&
    statelessDebt.state.none === 1 &&
    statelessDebt.state.ran === 1 &&
    statelessDebt.debts === 3 &&
    statelessDebt.state.none + statelessDebt.state.ran + statelessDebt.state.absent === statelessDebt.debts,
  { state: statelessDebt.state, total: statelessDebt.debts },
);

// ---------------------------------------------------------------------- E4
/**
 * Ownership is asserted by *field name*, not by the absence of a word in prose.
 *
 * `probes/pit-liveness.mjs` owns liveness, and this project has already paid for two owners
 * of one number drifting apart, so the report must carry a pointer to it — and must not
 * carry a second count. "The text does not say never-seen" would be satisfied by a typo, so
 * this walks the report's own keys and requires the liveness statistics to be absent as
 * keys while the ownership pointer is present, and requires the forbidden list to be able
 * to fire at all.
 */
const FORBIDDEN_KEYS = ['never_seen', 'neverSeen', 'promotion', 'promotions', 'stale_pointer', 'stalePointer', 'blind_files', 'blindFiles'];
function deepKeys(value, out = [], seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    out.push(key);
    deepKeys(child, out, seen);
  }
  return out;
}
const ownership = {
  liveness: {
    owner: 'probes/pit-liveness.mjs',
    read_here: false,
    why: 'it owns the liveness statistics — broken triggers, dead `files:` pointers, triggers never seen, file-keyed entries never matched, cross-project promotion candidates. This audit must not become a second owner of them, so it neither recomputes them nor spawns that probe to quote them.',
  },
  own: [
    "gate cost: turns that closed with code changed and no recorded evidence (`kind:'unverified'`), and which of those debts were settled",
    'session-level distribution of that debt',
  ],
  not_owned_by_this_file: [
    'liveness (see ownership.liveness.owner)',
    'net context cost per turn/session (probes/context-cost.mjs prices one session, probes/mode-cost.mjs prices many; both are reports)',
  ],
};
const ownershipKeys = deepKeys(ownership);
const PROBE_POINTER = /^probes\/(pit-liveness|context-cost|mode-cost)\.mjs$/;
check(
  'E4',
  'liveness is attributed to `pit-liveness` by field name, and no field of this report recomputes it',
  ownership.liveness.owner === 'probes/pit-liveness.mjs' &&
    ownership.liveness.read_here === false &&
    PROBE_POINTER.test(ownership.liveness.owner) &&
    ownership.own.some((line) => /gate cost/.test(line)) &&
    ownershipKeys.filter((key) => FORBIDDEN_KEYS.includes(key)).length === 0 &&
    // The detector has teeth: the same walk over an object that does carry the forbidden
    // statistics must find them, or "absent" is a statement about the walk, not the report.
    deepKeys({ promotions: [{ heading: 'x' }], never_seen: 3 }).filter((key) => FORBIDDEN_KEYS.includes(key)).length === 2,
  {
    owner: ownership.liveness.owner,
    forbiddenPresent: ownershipKeys.filter((key) => FORBIDDEN_KEYS.includes(key)),
    keysWalked: ownershipKeys.length,
    own: ownership.own,
  },
);

// ---------------------------------------------------------------------- E5
/**
 * "No data" and "the data says none" are different sentences.
 *
 * A path holding no journal at all is `unjudgeable` with the reason; an initialised ledger
 * whose journal is empty is a **real zero**. Both are fixtures, and the second has a
 * control: writing one debt into that same ledger must move it off zero, so the zero came
 * from reading the file rather than from a reader that cannot see anything.
 */
const missing = scratch('missing'); // no ledger at all: nothing to read
const missingProject = runAudit({ projectRoot: missing }).scopes[0];
const empty = scratch('empty');
ledger.initLedger(empty, 'sess-effect-audit');
const emptyProject = runAudit({ projectRoot: empty }).scopes[0];
appendDebt(empty, { ts: at(20), session: 'sess-first', state: 'none', edits: [`edit ${path.join(empty, 'lib', 'first.js')}`] });
const filledProject = runAudit({ projectRoot: empty }).scopes[0];
check(
  'E5',
  'an absent journal is `unjudgeable` with a reason while an empty one is a real zero — and that zero can move',
  missingProject.judgeable === false &&
    typeof missingProject.unjudgeable === 'string' &&
    missingProject.unjudgeable.length > 0 &&
    missingProject.debt === undefined &&
    emptyProject.judgeable === true &&
    emptyProject.unjudgeable === undefined &&
    emptyProject.debt.debts === 0 &&
    emptyProject.debt.settled === 0 &&
    emptyProject.debt.state.none === 0 &&
    filledProject.judgeable === true &&
    filledProject.debt.debts === 1 &&
    filledProject.debt.state.none === 1,
  {
    absent: { judgeable: missingProject.judgeable, unjudgeable: preview(missingProject.unjudgeable, 140), debt: missingProject.debt },
    empty: { judgeable: emptyProject.judgeable, debts: emptyProject.debt?.debts, state: emptyProject.debt?.state },
    afterOneLine: { judgeable: filledProject.judgeable, debts: filledProject.debt?.debts, state: filledProject.debt?.state },
  },
);

// ---------------------------------------------------------------------- E6
/**
 * It only reads, and the comparison that says so can see a write.
 *
 * The instrument is a byte snapshot of every file under `.dsh-code`, and the control is the
 * reason it is worth anything: a comparison that reports "unchanged" for a ledger it cannot
 * see would report "unchanged" here too. So one line is appended and the same comparison
 * must go red — on the journal, and the count must rise by exactly one.
 */
const before = snapshot(main);
const duringReport = runAudit({ projectRoot: main });
const after = snapshot(main);
const untouched = changedKeys(before, after);
appendDebt(main, { ts: at(30), session: 'sess-control', state: 'none', edits: [`edit ${path.join(main, 'lib', 'control.js')}`] });
const afterWrite = snapshot(main);
const seenWrite = changedKeys(after, afterWrite);
const controlSawTheLine = runAudit({ projectRoot: main }).scopes[0].debt.debts === duringReport.scopes[0].debt.debts + 1;
check(
  'E6',
  'reading the ledger changes no byte of it, and the same comparison does see a real write',
  untouched.length === 0 &&
    Object.keys(before).length >= 3 &&
    before[ledger.FILES.journal] !== undefined &&
    seenWrite.includes(ledger.FILES.journal) &&
    controlSawTheLine === true,
  {
    files: Object.keys(before),
    changed: untouched,
    controlChanged: seenWrite,
    controlSawTheExtraTurn: controlSawTheLine,
    countedBefore: duringReport.scopes[0].debt.debts,
  },
);

// ---------------------------------------------------------------------- E7
/**
 * The read bound is declared, enforced, and has teeth.
 *
 * Twelve segments are built, each holding exactly one debt. At the declared cap the report
 * must read exactly that many and *say* how many it left (`omitted`); with the cap lowered
 * to two, the count must fall by exactly the number of segments dropped. Without that
 * second half, "8 of 12, omitted 4" would also be printed by a reader that always claims 8
 * and actually reads one.
 */
const cap = scratch('cap');
ledger.initLedger(cap, 'sess-effect-audit');
for (let index = 0; index < 12; index += 1) {
  appendDebt(cap, {
    ts: at(100 + index),
    session: `sess-cap-${index}`,
    state: index % 2 === 0 ? 'none' : 'ran',
    edits: [`edit ${path.join(cap, 'lib', `cap${index}.js`)}`],
  });
  // Leave the last one live, so the fixture has 11 slots plus the live file.
  if (index < 11) {
    fs.renameSync(journalOf(cap), path.join(ledgerDirOf(cap), `${ledger.FILES.journal}.${String(index).padStart(3, '0')}`));
  }
}
const capAudit = runAudit({ projectRoot: cap });
const capDefault = capAudit.scopes[0];
const capTight = runAudit({ projectRoot: cap, limit: 2 }).scopes[0];
check(
  'E7',
  'the report names the files and segments it read and its own bound, and lowering that bound really reads less',
  capDefault.segments.on_disk.length === 12 &&
    capDefault.segments.read.length === SEGMENTS_PER_SCOPE &&
    capDefault.segments.omitted === 12 - SEGMENTS_PER_SCOPE &&
    capDefault.debt.debts === SEGMENTS_PER_SCOPE &&
    capDefault.segments.cap === SEGMENTS_PER_SCOPE &&
    capAudit.limit === SEGMENTS_PER_SCOPE &&
    capTight.segments.read.length === 2 &&
    capTight.debt.debts === 2 &&
    capTight.segments.omitted === 10 &&
    capDefault.debt.debts - capTight.debt.debts === SEGMENTS_PER_SCOPE - 2,
  {
    onDisk: capDefault.segments.on_disk.length,
    readAtDefault: capDefault.segments.read.length,
    countedAtDefault: capDefault.debt.debts,
    omitted: capDefault.segments.omitted,
    readAtCapTwo: capTight.segments.read.length,
    countedAtCapTwo: capTight.debt.debts,
    declared: { segments_per_scope: capAudit.limit, why: preview(capAudit.policy?.why ?? 'declared in the report under `reading`', 120) },
  },
);

// ------------------------------------------------------- real ledgers (report)
/**
 * The measurement this whole audit exists for, over the ledgers on this disk.
 *
 * Never part of the verdict: the real numbers legitimately change as work happens, and a
 * check that went red because the project stopped owing evidence would be a check nobody
 * could keep green. `PKG_DIR` is a project root only when this file is run from the
 * package, which is the documented invocation.
 */
const REAL = process.argv.includes('--no-real') ? undefined : runAudit({ projectRoot: PKG_DIR });

/** The same three axes, with the two that have no owner here named rather than left blank. */
const measurements = {
  gate_cost: {
    owner: 'probes/effect-audit.mjs',
    status: 'measured',
    source: 'journal entries `kind:"unverified"` (the debts) and `kind:"verified"` (the proofs), in both ledgers',
  },
  session_distribution: {
    owner: 'probes/effect-audit.mjs',
    status: 'measured',
    source: 'the same entries, grouped by their `session` field',
  },
  context_cost: {
    owner: 'probes/context-cost.mjs + probes/mode-cost.mjs',
    status: 'not measured here, deliberately',
    reason:
      'the algorithm exists; the cross-session aggregation does not. Reading session logs is a second instrument (zstd frames, `request/context` windows, per-request usage), and adding it to this file would make this audit a second owner of a number two other probes already publish. Naming the gap is the honest form of that; the aggregation is a defined next step, not a claim made here.',
  },
};

/** Every number carries its source file and how it was counted. */
const how =
  "each line is JSON.parse'd; entries with kind===\"unverified\" are the debts (one debt per turn), kind===\"verified\" with ok===true and no `claimed` flag are the proofs. A debt is settled when a proof with a later `ts` covers one of its edit targets — the proof ran in a directory that contains the target, or its command/output tail names the target's basename; with no addressable target, a later proof settles it, which is the library's own rule.";
const evidence = {};
for (const [label, audit] of [
  ['fixture:main', mainReport],
  ['fixture:rotated', runAudit({ projectRoot: rot })],
  ['fixture:segment-cap', capAudit],
  ...(REAL === undefined ? [] : [['real', REAL]]),
]) {
  evidence[label] = audit.scopes.map((entry) => ({
    scope: entry.scope,
    ledger_dir: entry.ledgerDir,
    segments_read: entry.segments.read,
    lines_per_segment: entry.segments.lines_per_segment,
    judgeable: entry.judgeable,
    unjudgeable: entry.unjudgeable,
    debts: entry.debt?.debts,
    state: entry.debt?.state,
    settled: entry.debt?.settled,
    unresolved: entry.debt?.unresolved,
    unproven_unsettled: entry.debt?.unproven_unsettled,
  }));
}
const report = {
  probe: 'probes/effect-audit.mjs',
  owns: ownership.own,
  ownership,
  measurements,
  how_numbers_are_counted: how,
  evidence_by_fixture: evidence,
  reading: {
    segments_per_scope: SEGMENTS_PER_SCOPE,
    newest_first: true,
    segments_named: true,
    why: 'the journal is the only ledger file with no ceiling above it and is read whole by several readers, so rotation renames rather than deletes (JOURNAL_KEEP = 8, 512 KB per segment). This audit reads at most the newest `segments_per_scope` segments per scope, names every file and segment it read, and reports `omitted`. Stated because an audit that does not name what it read is itself a mechanism whose cost nobody verified.',
  },
  fixtures: {
    assertions: checks.length,
    main: { dir: main, segments: mainWritten.segments, lines: mainWritten.lines, written_by: 'this probe, then counted back off disk' },
    rotated: {
      dir: rot,
      segments: rotOnDisk,
      lines: rotLines,
      in_rotated_segment: rotInRotated,
      note: 'the first three debts were renamed into `.000`, so a reader that skipped rotated segments would report 2 instead of 5 — the drift that would make this audit report less the more the project writes',
    },
    segment_cap: { dir: cap, segments: 12, counted_at_default: capDefault.debt.debts, counted_at_cap_two: capTight.debt.debts },
    stateless_state: { dir: stateless, state: statelessDebt.state },
  },
  gate_cost: {
    fixtures: evidence['fixture:main'],
    real: REAL === undefined ? undefined : evidence.real,
  },
};
if (REAL !== undefined) report.real_reading = REAL;

// ------------------------------------------------------------------------ verdict
const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) {
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.id} ${entry.name}${entry.ok ? '' : ` :: ${preview(entry.evidence, 300)}`}`);
}

if (REAL !== undefined) {
  console.log('\n=== real ledgers (measured, never part of the verdict) ===');
  for (const entry of REAL.scopes) {
    if (entry.debt === undefined) {
      console.log(`UNJUDGEABLE ${entry.scope}: ${entry.unjudgeable}`);
      continue;
    }
    const { debt } = entry;
    console.log(
      `${entry.scope.padEnd(7)} ${debt.debts} unverified turn(s) — state none=${debt.state.none} ran=${debt.state.ran} absent=${debt.state.absent}` +
        ` | settled=${debt.settled} | followed-by-a-proof-that-does-not-cover=${debt.unresolved} | never-proven=${debt.unproven_unsettled}`,
    );
    console.log(
      `        read ${entry.segments.read.length}/${entry.segments.on_disk.length} segment(s) ${JSON.stringify(entry.segments.read)}`,
    );
    console.log(
      `        sessions with debt: ${debt.sessions.distinct} — ${Object.entries(debt.sessions.turns_buckets)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')}`,
    );
    for (const row of debt.sessions.top) {
      console.log(`        ${row.session} — ${row.turns} turn(s) (none=${row.states.none} ran=${row.states.ran} absent=${row.states.absent})`);
    }
    for (const head of debt.head) {
      console.log(`        never proven: ${head.ts.slice(0, 16).replace('T', ' ')} state=${head.state} ${head.edits.join(', ')}`);
    }
    if (entry.rows_unparsed > 0) console.log(`        ${entry.rows_unparsed} unreadable line(s): ${preview(entry.skips, 160)}`);
  }
  console.log('liveness is NOT recomputed here — probes/pit-liveness.mjs owns it (report → ownership.liveness)');
  console.log('net context cost is NOT measured here — probes/context-cost.mjs and probes/mode-cost.mjs own those numbers');
}

console.log(`\n${checks.length - failed.length}/${checks.length} passed, failed=[${failed.map((entry) => entry.id).join(', ')}]`);
console.log(`report: ${OUT}`);
fs.writeFileSync(
  OUT,
  `${JSON.stringify({ failed: failed.map((entry) => `${entry.id} ${entry.name}`), passed: checks.length - failed.length, total: checks.length, report }, null, 2)}\n`,
  'utf8',
);
if (failed.length > 0) process.exitCode = 1;
