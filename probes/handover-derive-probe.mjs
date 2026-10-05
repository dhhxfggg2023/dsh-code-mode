/**
 * Does a handover derive itself — out of the ledger, and out of nothing else?
 *
 * Why this exists (2026-10-05): the compaction gate's third option used to ask the
 * model to *write* the whole handover. T1 replaces that with a bounded view that
 * `lib/ledger.js` derives from records already on disk, and the requirement is narrow
 * enough to be checkable, which is why it is checked here rather than argued in prose:
 *
 *   - two sections, "what is next" and "what to avoid", and nothing else;
 *   - the proved kept apart from the unproved;
 *   - no conversation narrative anywhere in it;
 *   - bounded, and empty-safe;
 *   - read-only.
 *
 * Every check has a control, because each of them would otherwise be satisfied by a
 * function that returns the empty string: "no narrative in the output" is trivially
 * true of `''`, and "the ledger is byte-identical" is trivially true of a no-op. So
 * `N3a` proves the narrative detector can go red, `N3b` proves it goes red when a
 * narrative is actually present, `N7b` proves the byte comparison sees a real write,
 * and `N2b`/`N6b` prove the two derived distinctions are computations rather than
 * fixed decoration.
 *
 * Plain Node is enough: `lib/ledger.js` imports only `./pattern-matcher.js`, so no host
 * resolution and no Electron binary are involved. That matters here — `debt-audit.mjs`
 * runs this file itself with `stdio: 'ignore'` (a confined channel refuses a piped
 * child), so the verdict has to travel in a report file rather than on stdout.
 *
 * Run: node probes/handover-derive-probe.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { LIB_DIR, PKG_DIR, tempReport } from './paths.mjs';

const ledger = await import(pathToFileURL(path.join(LIB_DIR, 'ledger.js')).href);

/** Where the verdict goes: `debt-audit.mjs` reads this exact default name in temp. */
const OUT = process.env.DSH_PROBE_REPORT ?? tempReport('handover-derive-report.json');

const SESSION = 'sess-handover-derive';
/** The session that left the debt. It must differ from `SESSION`, or the readers skip it. */
const EARLIER = 'sess-earlier';

const checks = [];
const check = (id, name, ok, evidence) => checks.push({ id, name, ok: ok === true, evidence });
const preview = (value, n = 240) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text === undefined || text === null ? String(text) : text.length > n ? `${text.slice(0, n)}…` : text;
};

/**
 * The narrative detector, and the reason it is a named function rather than an inline
 * regex: `N3` uses it on the derived text and `N3a`/`N3b` use it on text that *does*
 * contain a summary of the conversation. A detector that cannot fail is not a check.
 *
 * The words are the ones a *conversation summary* uses and a view of structured ledger
 * entries has no reason to contain: names for the two speakers, the Chinese for a
 * heated aside, and the phrase a handover written from memory reaches for.
 */
const NARRATIVE_MARKERS = [
  '用户说',
  '用户要求',
  '用户强调',
  '用户吐槽',
  '你说过',
  '气话',
  'the user said',
  'the user asked',
  'you said',
  'as requested',
  'this conversation',
  'conversation summary',
];
const narrativeHits = (text) => {
  const haystack = String(text ?? '').toLowerCase();
  return NARRATIVE_MARKERS.filter((marker) => haystack.includes(marker.toLowerCase()));
};
/** A paragraph of exactly the kind the derived view must never contain. */
const NARRATIVE_SAMPLE =
  'The user said the previous summary was 气话 and asked me to stop writing one; as requested, this conversation is summarised below.';

// --------------------------------------------------------------------- fixtures
const scratch = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-handover-derive-${tag}-`));
const journalPath = (dir) => path.join(dir, ledger.DIRNAME, ledger.FILES.journal);
const mistakesPath = (dir) => path.join(dir, ledger.DIRNAME, ledger.FILES.mistakes);
const appendJournal = (dir, entry) => fs.appendFileSync(journalPath(dir), `${JSON.stringify(entry)}\n`, 'utf8');

/**
 * The next timestamp no writer in this fixture can produce: one second past the newest
 * line the library just wrote.
 *
 * The ledger's settlement rules compare timestamps (`proof.ts > debt.ts`,
 * `mistake.ts > debt.ts`), so a hand-written fixture timestamp lands either before or
 * after the lines `recordTask`/`recordMistake` write depending on the wall clock — a
 * check that passes at 09:00 and fails at 10:00. Deriving the fixture's timestamps from
 * the journal it just wrote fixes the *order* without freezing the clock.
 */
function nextTimestamp(dir, offsetSeconds = 1) {
  let newest = 0;
  for (const line of fs.readFileSync(journalPath(dir), 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const at = Date.parse(JSON.parse(line).ts);
      if (Number.isFinite(at) && at > newest) newest = at;
    } catch {
      /* a line this fixture cannot read is not the newest one */
    }
  }
  return new Date((newest === 0 ? Date.now() : newest) + offsetSeconds * 1000).toISOString();
}

/**
 * The four journal lines the "next session" half of a handover is derived from: a turn
 * that changed a file and proved nothing, a command that failed and was never written
 * down, a `lib/` change still dormant behind a restart, and — optionally — a later
 * passing verification that *covers* the first one.
 *
 * `withProof` is the control's whole mechanism: the same debt, with one line added,
 * must stop being reported as unproved. Written after every library call so the debts
 * are strictly newer than anything the writers produced (see {@link nextTimestamp}).
 */
function writeDebt(dir, { withProof = false } = {}) {
  const base = nextTimestamp(dir, 1);
  const later = new Date(Date.parse(base) + 1000).toISOString();
  const edit = `write ${path.join(dir, 'lib', 'inflight.js')}`;
  appendJournal(dir, { ts: base, session: EARLIER, kind: 'unverified', turn: 4, state: 'none', cwd: dir, edits: [edit] });
  appendJournal(dir, {
    ts: base,
    session: EARLIER,
    kind: 'mistake_unrecorded',
    turn: 5,
    failures: [{ cmd: 'node probes/broken.mjs', signature: 'ERR_HANDOVER_DERIVE' }],
  });
  appendJournal(dir, { ts: base, session: EARLIER, kind: 'restart_pending', files: [path.join(dir, 'lib', 'ledger.js')] });
  if (withProof) {
    appendJournal(dir, {
      ts: later,
      session: EARLIER,
      kind: 'verified',
      cmd: 'node probes/proves-inflight.mjs',
      cwd: dir,
      expect: 'ok',
      ok: true,
      tail: 'ok',
    });
  }
  return { base, later };
}

/** Two pits, a decided question, and one in-flight task whose notes must not travel. */
function buildRich(dir, { title, note }) {
  ledger.initLedger(dir, SESSION);
  const created = ledger.recordTask(dir, { title, note }, SESSION);
  ledger.recordMistake(
    dir,
    {
      symptom: 'HANDOVER-PIT-ONE a shell pipe that rewrites the file it reads',
      cause: 'the pipe re-encodes the text',
      fix: 'write through node instead',
      files: 'src/one.js',
      avoid: 'do not rewrite text through that shell pipe',
    },
    SESSION,
  );
  ledger.recordMistake(
    dir,
    {
      symptom: 'HANDOVER-PIT-TWO a flag that changes meaning between versions',
      cause: 'the flag was repurposed',
      fix: 'pass the long form',
      trigger: 'handover-never-matches-this',
      avoid: 'do not pass the short form of that flag',
    },
    SESSION,
  );
  ledger.recordDecision(
    dir,
    { title: 'HANDOVER-DECIDED the first one', body: 'the decision body', alternatives: 'the rejected option' },
    SESSION,
  );
  return created;
}

/** Every `## ` heading of one ledger markdown file, in file order. */
const headingsOf = (file) => {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('## '))
      .map((line) => line.slice(3).trim());
  } catch {
    return [];
  }
};
const headingWith = (file, needle) => headingsOf(file).find((heading) => heading.includes(needle));
/** One `## ` entry of a ledger markdown file, whole, so a field can be read off it. */
const blockWith = (file, needle) => {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\n(?=## )/)
      .find((block) => block.includes(needle));
  } catch {
    return undefined;
  }
};

/** Every file under `.dsh-code`, as `name → exact bytes`, for the read-only check. */
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
  walk(path.join(dir, ledger.DIRNAME), '');
  return out;
}
const changedKeys = (before, after) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => before[key] !== after[key]);
/** Total size of one ledger, for "the input is far larger than the bound". */
function ledgerBytes(dir) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  walk(path.join(dir, ledger.DIRNAME));
  return total;
}
/** Every `## ` heading of a rendered handover with the body that follows it. */
function headingBodies(text) {
  const out = [];
  for (const part of String(text ?? '').split(/\n(?=## )/)) {
    const lines = part.split('\n');
    if (!lines[0].startsWith('## ')) continue;
    out.push({ heading: lines[0].trim(), body: lines.slice(1).join('\n').trim() });
  }
  return out;
}
/** Which of two headings a text names first — the assertion every ordering check makes. */
function firstNamed(text, coordinate, prose) {
  const at = (heading) => String(text ?? '').indexOf(heading);
  if (at(coordinate) < 0 || at(prose) < 0) return 'missing';
  return at(coordinate) < at(prose) ? 'coordinate-first' : 'prose-first';
}

// Hermetic against the developer's real `~/.dsh-code/`, as every probe here is: nothing
// in a handover reads the machine ledger, and this keeps it that way if that ever
// changes (`code_brief`'s numbers went red for a day because one probe read the real
// home directory).
process.env.DSH_CODE_GLOBAL_DIR = scratch('global-hermetic');

// ----------------------------------------------------- N1: what is next, derived
const mainDir = scratch('main');
const createdTask = buildRich(mainDir, {
  title: 'N1 inflight task',
  note: `NOTES-MUST-NOT-TRAVEL ${'n'.repeat(600)}`,
});
writeDebt(mainDir);
// A caller's two fields as a real one would be: a sentence each. `N5b` is the check that
// covers what happens when they are not.
const main = ledger.handover(mainDir, {
  session: SESSION,
  nextMove: 'NEXT-MOVE-MARKER finish the handover derivation and sync the docs',
  stoppedBecause: 'STOPPED-MARKER the context bound was reached',
});
const nextAt = main.text.indexOf('## Next');
const avoidAt = main.text.indexOf('## Avoid');

check(
  'N1',
  'an in-flight task reaches `## Next` as its id and its title',
  nextAt === 0 &&
    avoidAt > 0 &&
    main.text.includes(createdTask.task.id) &&
    main.text.includes('N1 inflight task') &&
    main.text.indexOf(createdTask.task.id) < avoidAt,
  { nextAt, avoidAt, id: createdTask.task.id, head: preview(main.text, 400) },
);
check(
  'N1b',
  'control: the task\'s notes do not travel with it',
  !main.text.includes('NOTES-MUST-NOT-TRAVEL'),
  { notesInOutput: main.text.includes('NOTES-MUST-NOT-TRAVEL'), notesStored: createdTask.task.notes.join(' ').length },
);
check(
  'N1c',
  'the two fields no ledger holds arrive verbatim',
  main.text.includes('NEXT-MOVE-MARKER') && main.text.includes('STOPPED-MARKER'),
  { hasNextMove: main.text.includes('NEXT-MOVE-MARKER'), hasStoppedBecause: main.text.includes('STOPPED-MARKER') },
);
check(
  'N1d',
  'a `lib/` change still dormant behind a restart is carried',
  main.text.includes('Dormant until DSH restarts') && main.text.includes('ledger.js'),
  { line: preview((main.text.match(/^- Dormant until DSH restarts.*$/m) ?? [''])[0], 200) },
);

// ---------------------------------- N2: proved and unproved, told apart
const unverifiedAtLabel = main.text.indexOf('Unverified (edited');
const verifiedLine = /^Verified: .*$/m.exec(main.text)?.[0] ?? '';
check(
  'N2',
  'the unproved edits are one labelled block and the proved side is a separate line',
  unverifiedAtLabel > 0 &&
    verifiedLine.length > 0 &&
    main.text.slice(unverifiedAtLabel).includes('inflight.js') &&
    !verifiedLine.includes('inflight.js') &&
    ledger.verifyCount(mainDir) === 0,
  {
    verifiedLine: preview(verifiedLine, 160),
    unverifiedAtLabel,
    label: preview(main.text.slice(unverifiedAtLabel, unverifiedAtLabel + 180), 200),
    proofsOnRecord: ledger.verifyCount(mainDir),
  },
);

const coveredDir = scratch('covered');
buildRich(coveredDir, { title: 'N2b inflight task', note: 'notes' });
writeDebt(coveredDir, { withProof: true });
const covered = ledger.handover(coveredDir, { session: SESSION });
check(
  'N2b',
  'control: one later proof that covers that edit removes the unproved block',
  !covered.text.includes('Unverified (edited') && !covered.text.includes('inflight.js') && ledger.verifyCount(coveredDir) === 1,
  {
    proofsOnRecord: ledger.verifyCount(coveredDir),
    stillLabelledUnproved: covered.text.includes('Unverified (edited'),
    text: preview(covered.text, 300),
  },
);

const failuresAt = main.text.indexOf('Failures nobody wrote down:');
check(
  'N2c',
  'a command that failed and was never written down is carried as its own block',
  failuresAt > 0 && main.text.slice(failuresAt).includes('node probes/broken.mjs'),
  { failuresAt, block: preview(main.text.slice(Math.max(0, failuresAt), Math.max(0, failuresAt) + 200), 240) },
);

// ------------------------------- N3: no conversation narrative, in either direction
const hitsInSample = narrativeHits(NARRATIVE_SAMPLE);
check(
  'N3a',
  'the narrative detector has teeth: it matches a summary of the conversation',
  hitsInSample.length >= 3,
  { hits: hitsInSample, sample: preview(NARRATIVE_SAMPLE, 160) },
);
const hitsInText = narrativeHits(main.text);
check(
  'N3',
  'control: none of those markers appears in the derived handover',
  hitsInText.length === 0,
  { hits: hitsInText, chars: main.text.length },
);
const hitsWhenLeaked = narrativeHits(`${main.text}\n${NARRATIVE_SAMPLE}`);
check(
  'N3b',
  'control: the same detector goes red when a narrative is present',
  hitsWhenLeaked.length >= 3,
  { hits: hitsWhenLeaked },
);

// ------------------------------------------- N4: empty ledgers, and no hollow headings
const pristineDir = scratch('pristine'); // no ledger at all
const emptyDir = scratch('empty');
ledger.initLedger(emptyDir, SESSION);
let emptyThrew;
const emptyResults = [];
for (const [label, dir] of [['no ledger', pristineDir], ['initialised but empty', emptyDir]]) {
  try {
    emptyResults.push({ label, ...ledger.handover(dir, {}) });
  } catch (error) {
    emptyThrew = `${label}: ${error.message}`;
  }
}
check(
  'N4',
  'an empty ledger neither throws nor produces a hollow heading',
  emptyThrew === undefined &&
    emptyResults.length === 2 &&
    emptyResults.every((result) => result.empty === true && result.text === ''),
  { threw: emptyThrew, results: emptyResults.map((r) => ({ label: r.label, empty: r.empty, chars: r.text.length })) },
);

const hollow = [
  ['main', main.text],
  ['covered', covered.text],
].flatMap(([label, text]) => headingBodies(text).filter((entry) => entry.body.length === 0).map((entry) => `${label}: ${entry.heading}`));
check(
  'N4b',
  'no heading in a populated handover is emitted without a body',
  headingBodies(main.text).length > 0 && hollow.length === 0,
  { headings: headingBodies(main.text).map((entry) => entry.heading), hollow },
);

// ------------------------------------------------------------ N5: the bound is real
const bigDir = scratch('big');
ledger.initLedger(bigDir, SESSION);
for (let i = 0; i < 30; i += 1) {
  ledger.recordMistake(
    bigDir,
    {
      symptom: `BIG-${String(i).padStart(2, '0')} a pit with a coordinate ${'s'.repeat(180)}`,
      cause: `cause ${'c'.repeat(180)}`,
      fix: `fix ${'f'.repeat(180)}`,
      files: `src/big${i}.js`,
      avoid: `do not do BIG-${String(i).padStart(2, '0')} because ${'a'.repeat(80)}`,
    },
    SESSION,
  );
}
for (let i = 0; i < 20; i += 1) {
  ledger.recordDecision(bigDir, { title: `BIGDEC-${String(i).padStart(2, '0')}`, body: 'd'.repeat(300), alternatives: 'r'.repeat(150) }, SESSION);
}
for (let i = 0; i < 8; i += 1) ledger.recordTask(bigDir, { title: `BIGTASK-${i}`, note: 'n'.repeat(400) }, SESSION);
writeDebt(bigDir);
const bigBytes = ledgerBytes(bigDir);
const bigBig = { nextMove: `NEXT-MOVE ${'m'.repeat(600)}`, stoppedBecause: `BECAUSE ${'b'.repeat(600)}` };
const bigDefault = ledger.handover(bigDir, { session: SESSION, ...bigBig });
const bigExplicit = ledger.handover(bigDir, { session: SESSION, maxChars: 2000, ...bigBig });
const bigTight = ledger.handover(bigDir, { session: SESSION, maxChars: 30, ...bigBig });
check(
  'N5',
  'the output is really clipped: the default holds, and a tiny bound is honoured exactly',
  // The ledger behind this is far larger than the bound, so "bounded by construction
  // from a small fixture" cannot explain it.
  bigBytes > 20000 &&
    bigDefault.text.length <= 2000 &&
    bigExplicit.text.length <= 2000 &&
    bigDefault.text.length > 1000 &&
    // 30 is below both sections' own floors, so nothing inside the function can produce
    // this number: the last-resort clip is the only thing that can, and losing `## Avoid`
    // is the signature of a cut that fell on the *joined* sections.
    bigTight.text.length === 30 &&
    bigTight.text.includes('## Next') &&
    !bigTight.text.includes('## Avoid'),
  {
    ledgerBytes: bigBytes,
    defaultChars: bigDefault.text.length,
    explicitChars: bigExplicit.text.length,
    tightChars: bigTight.text.length,
    tightTail: preview(bigTight.text, 60),
  },
);

/**
 * The priority inside `## Next`, pinned because it was measured wrong first: with the
 * caller's two fields assembled last, a verbose `nextMove` pushed the *debt* off the end
 * of the section. The only content this text uniquely carries is the caller's two
 * fields; everything else it can lose is re-readable in the journal or the board, and
 * the marker has to say so rather than the loss being silent.
 */
const verbose = ledger.handover(bigDir, {
  session: SESSION,
  maxChars: 1200,
  nextMove: `NEXT-MOVE ${'m'.repeat(600)}`,
  stoppedBecause: `BECAUSE ${'b'.repeat(600)}`,
});
check(
  'N5b',
  'control: a verbose caller cannot push the fields only this text carries off the end, and what is cut is named',
  verbose.text.length <= 1200 && verbose.text.includes('NEXT-MOVE') && verbose.text.includes('BECAUSE') && verbose.text.includes('cut here for length'),
  {
    chars: verbose.text.length,
    hasNextMove: verbose.text.includes('NEXT-MOVE'),
    hasStoppedBecause: verbose.text.includes('BECAUSE'),
    namesTheCut: verbose.text.includes('cut here for length'),
    tail: preview(verbose.text.slice(-160), 200),
  },
);

// ------------------------- N6: what to avoid — coordinate first, decisions one line
const n6aDir = scratch('n6a');
ledger.initLedger(n6aDir, SESSION);
ledger.recordMistake(
  n6aDir,
  {
    symptom: `n6coord a pit that names a file ${'x'.repeat(300)}`,
    cause: 'c'.repeat(200),
    fix: 'f'.repeat(150),
    // `files:` only, deliberately: `trigger:` outranks prose by 100,000 in the ledger's own
    // ranking, so a check built on a trigger would pass without the weaker coordinate
    // ever being exercised.
    files: 'src/n6coord.js',
    avoid: 'do not repeat the n6coord thing',
  },
  SESSION,
);
ledger.recordMistake(
  n6aDir,
  { symptom: 'n6prose a pit with nothing to find it by', cause: 'prose only', fix: 'remember it', avoid: 'do not repeat the n6prose thing' },
  SESSION,
);
for (let i = 0; i < 6; i += 1) {
  ledger.recordDecision(n6aDir, { title: `N6DEC-${i}`, body: 'b'.repeat(120), alternatives: 'r'.repeat(60) }, SESSION);
}
const n6a = ledger.handover(n6aDir, { session: SESSION, maxChars: 4000 });
const coordHeading = headingWith(mistakesPath(n6aDir), 'n6coord');
const proseHeading = headingWith(mistakesPath(n6aDir), 'n6prose');
check(
  'N6',
  'a pit that carries a coordinate is named before a pit that carries none',
  coordHeading !== undefined && proseHeading !== undefined && firstNamed(n6a.text, coordHeading, proseHeading) === 'coordinate-first',
  {
    verdict: coordHeading === undefined || proseHeading === undefined ? 'missing heading' : firstNamed(n6a.text, coordHeading, proseHeading),
    coordAt: n6a.text.indexOf(coordHeading ?? '\u0000'),
    proseAt: n6a.text.indexOf(proseHeading ?? '\u0000'),
    avoid: preview(n6a.text.slice(n6a.text.indexOf('## Avoid')), 400),
  },
);

/**
 * The discriminating pair, and the reason this fixture exists at all.
 *
 * The prose pit is recorded twice, so `recordMistake` merges it and counts `recurred:`
 * — which is the ledger's *own* top-ranked signal (above an executable `trigger:`, above
 * a `files:` name, above recency). Under that order — the order `code_brief` still uses —
 * this prose pit comes first. So a coordinate-first result here cannot be explained by
 * the ledger's ranking, by recency (the coordinate pit is the newer one), or by file
 * order: it can only come from the split this view makes before ranking.
 */
const n6bDir = scratch('n6b');
ledger.initLedger(n6bDir, SESSION);
for (let i = 0; i < 2; i += 1) {
  ledger.recordMistake(
    n6bDir,
    {
      symptom: 'n6prose the pit that recurred with nothing to find it by',
      cause: 'prose only',
      fix: 'remember it',
      avoid: 'do not repeat the recurred prose pit',
    },
    SESSION,
  );
}
ledger.recordMistake(
  n6bDir,
  {
    symptom: `n6coord the newer pit that names a file ${'y'.repeat(200)}`,
    cause: 'c'.repeat(150),
    fix: 'f'.repeat(150),
    files: 'src/n6coord.js',
    avoid: 'do not repeat the newer coordinate thing',
  },
  SESSION,
);
const n6b = ledger.handover(n6bDir, { session: SESSION, maxChars: 4000 });
const coordHeadingB = headingWith(mistakesPath(n6bDir), 'n6coord');
const proseHeadingB = headingWith(mistakesPath(n6bDir), 'n6prose');
const proseBlockB = blockWith(mistakesPath(n6bDir), 'n6prose') ?? '';
const coordBlockB = blockWith(mistakesPath(n6bDir), 'n6coord') ?? '';
/**
 * What the *ledger's own* ranking does with this pair, measured here rather than
 * asserted in a comment: `shapeEntries` is the ranker `code_brief` uses, and on these
 * two entries it puts the prose pit first. So the fixture discriminates — a
 * coordinate-first handover cannot be explained by the ranking it inherits.
 */
const plainRanking = ledger.shapeEntries([proseBlockB, coordBlockB], 4000).text;
/**
 * The teeth half: the same comparison, run on a text where the two names really are in
 * the wrong order. Without it, `N6`/`N6b` would also be satisfied by a comparison that
 * always answers "coordinate-first".
 */
const inverted = `## Avoid\n- [${proseHeadingB}]\n- [${coordHeadingB}]`;
check(
  'N6b',
  "the coordinate wins even against a pit that has recurred — the one case the ledger's own ranking would put prose first — and the comparison can go red",
  /recurred:/.test(proseBlockB) &&
    coordHeadingB !== undefined &&
    proseHeadingB !== undefined &&
    firstNamed(plainRanking, coordHeadingB, proseHeadingB) === 'prose-first' &&
    firstNamed(n6b.text, coordHeadingB, proseHeadingB) === 'coordinate-first' &&
    firstNamed(inverted, coordHeadingB, proseHeadingB) === 'prose-first',
  {
    proseCarriesRecurred: /recurred:/.test(proseBlockB),
    ledgerOwnRanking: firstNamed(plainRanking, coordHeadingB, proseHeadingB),
    verdict: coordHeadingB === undefined || proseHeadingB === undefined ? 'missing heading' : firstNamed(n6b.text, coordHeadingB, proseHeadingB),
    controlVerdict: firstNamed(inverted, coordHeadingB, proseHeadingB),
    avoid: preview(n6b.text.slice(n6b.text.indexOf('## Avoid')), 300),
  },
);

const newestDecision = headingsOf(path.join(n6aDir, ledger.DIRNAME, ledger.FILES.decisions)).at(-1) ?? '';
const oldestDecision = headingsOf(path.join(n6aDir, ledger.DIRNAME, ledger.FILES.decisions))[0] ?? '';
check(
  'N6c',
  'the questions already decided are named on one line each, and the ones left out are counted',
  newestDecision.length > 0 &&
    n6a.text.includes(newestDecision) &&
    !n6a.text.includes(oldestDecision) &&
    /older decision\(s\) in/.test(n6a.text),
  {
    newestDecision: preview(newestDecision, 120),
    oldestNamed: n6a.text.includes(oldestDecision),
    counted: preview((n6a.text.match(/^- … \d+ older decision.*$/m) ?? [''])[0], 120),
  },
);

// --------------------------------------------------------------- N7: it only reads
const readOnlyDir = scratch('readonly');
buildRich(readOnlyDir, { title: 'N7 read-only task', note: 'n'.repeat(500) });
writeDebt(readOnlyDir);
const before = snapshot(readOnlyDir);
ledger.handover(readOnlyDir, { session: SESSION, nextMove: 'read-only probe', stoppedBecause: 'read-only probe' });
const after = snapshot(readOnlyDir);
check(
  'N7',
  'the handover writes nothing: every byte of the ledger is unchanged',
  changedKeys(before, after).length === 0 && Object.keys(before).length >= 5,
  { files: Object.keys(before), changed: changedKeys(before, after) },
);

const beforeWrite = snapshot(readOnlyDir);
ledger.recordTask(readOnlyDir, { title: 'the write the comparison must see' }, SESSION);
const afterWrite = snapshot(readOnlyDir);
const seen = changedKeys(beforeWrite, afterWrite);
check(
  'N7b',
  'control: the same comparison does see a real write',
  seen.includes(ledger.FILES.tasks) && seen.includes(ledger.FILES.journal),
  { changed: seen },
);

// ------------------------------------------------------------------------ verdict
if (process.env.DSH_HANDOVER_DERIVE_DIAG === '1') {
  // What the derived view actually looks like, for a human reading a failure. Off by
  // default: the checks above compare against exact strings, and printing these on every
  // run would bury the verdict.
  for (const [label, text] of [
    ['main', main.text],
    ['covered', covered.text],
    ['n6a', n6a.text],
  ]) {
    console.log(`\n----- ${label} (${text.length} chars) -----\n${text}\n`);
  }
}
if (process.env.DSH_HANDOVER_DERIVE_REAL === '1') {
  /**
   * The same function over this package's *real* ledger.
   *
   * Every check above runs on a fixture, and a green fixture is a statement about the
   * harness. This is the one measurement of the thing itself: how much a real handover
   * costs on this project (which T2 has to budget for when it attaches one to the gate's
   * message). Read-only, off by default, and never part of the verdict — the checks above
   * already decided it.
   */
  const real = ledger.handover(PKG_DIR, {
    session: SESSION,
    nextMove: 'finish T1 and hand the plan to the reviewer',
    stoppedBecause: 'the plan is a review artifact and T2 needs approval',
  });
  console.log(`\n----- real ledger (${real.text.length} chars, empty=${real.empty}) -----\n${real.text}\n`);
}
const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) {
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.id} ${entry.name}${entry.ok ? '' : ` :: ${preview(entry.evidence, 300)}`}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} passed, failed=[${failed.map((entry) => entry.id).join(', ')}]`);
fs.writeFileSync(
  OUT,
  `${JSON.stringify({ failed: failed.map((entry) => `${entry.id} ${entry.name}`), passed: checks.length - failed.length, total: checks.length }, null, 2)}\n`,
  'utf8',
);
if (failed.length > 0) process.exitCode = 1;
