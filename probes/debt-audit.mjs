/**
 * Audit the mode's *documentation-derived claims* against the code and preset
 * they describe.
 *
 * This exists because the recurring failure in this project was not broken code
 * but stale derived prose: INSTALL.md described a 5-row group while the preset
 * had 6, and budget-report.md claimed "29 checks, 27 passed" while the probe it
 * described reported 29/29. Prose drifts silently; a check does not.
 *
 * Every assertion reads the claim out of the document AND the fact out of the
 * source, then compares. Run in any channel (read-only is enough).
 *   & '<node>' 'E:\tools\DSH\.dsh-probe\debt-audit.mjs'
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HARNESS_EXE, PKG_DIR, PROBES_DIR } from './paths.mjs';


const PROBE = PROBES_DIR;
const checks = [];
const check = (id, name, ok, evidence) => checks.push({ id, name, ok: ok === true, evidence });

const read = (p) => fs.readFileSync(p, 'utf8');
const preset = read(path.join(PKG_DIR, 'cordis.patch.yml'));
const install = read(path.join(PKG_DIR, 'INSTALL.md'));
const design = read(path.join(PKG_DIR, 'DESIGN.md'));
const generator = read(path.join(PROBES_DIR, 'build-preset.mjs'));
// The generated budget report is read tolerantly: it is a build artifact, and a
// channel that cannot write the package must produce a *failed* check with the
// regeneration command, not an exception that hides the other twelve.
const REPORT_JSON = path.join(PROBES_DIR, 'budget-report.json');
const REPORT_MD = path.join(PROBES_DIR, 'budget-report.md');
const mtime = (p) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return undefined;
  }
};
const reportMd = fs.existsSync(REPORT_MD) ? read(REPORT_MD) : '';
const reportJson = (() => {
  try {
    return JSON.parse(read(REPORT_JSON));
  } catch {
    return undefined;
  }
})();

// --- the preset's real contents ---------------------------------------------
/**
 * The preset without its comments.
 *
 * Rows are counted by matching `- id: …` followed by `name:`, and the gate row
 * carries an eight-line comment that explains the ordering — a comment whose own
 * text names both rows. Counting that as a row inflated every count by one and
 * made "INSTALL.md says 8, the preset has 7" look like a document bug (measured
 * 2026-10-02, D1/D5). Comments are not rows.
 */
const presetCode = preset
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');
const groupBody = presetCode.slice(presetCode.indexOf('- id: code-memory'), presetCode.indexOf('- id: tool-ask-user'));
const groupRows = [...groupBody.matchAll(/- id: (code-[a-z-]+)\n\s+name: '([^']+)'/g)].map((m) => ({
  id: m[1],
  name: m[2],
}));
const groupFiles = groupRows.map((r) => r.name);
/**
 * Rows of the whole preset, at any depth and any indentation.
 *
 * `groupRows` above is scoped to the `code-memory` slice because the documents
 * quote *that* group's size. But this mode also mounts one row of its own inside
 * a built-in group — `code-compact-gate`, a child of `compaction` and deliberately
 * ordered before `compaction-basic` so its `agent/pre-step` handler runs first.
 * A check that only looked at the code-memory slice reported that module as
 * "registered nowhere" (measured 2026-10-02, P1), so "is this file a plugin row?"
 * is asked against the whole preset, not one group.
 */
const presetRows = [...presetCode.matchAll(/^(\s*)- id: ([\w-]+)\n\s+name: '([^']+)'/gm)].map((m) => ({
  id: m[2],
  name: m[3],
  indent: m[1].length,
}));
const presetFiles = presetRows.map((r) => r.name);
const libFiles = fs
  .readdirSync(path.join(PKG_DIR, 'lib'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => `${f}`);

check(
  'P1',
  'every lib/*.js is either a registered plugin row or explicitly documented as a library',
  libFiles.every(
    (f) => presetFiles.includes(`dsh-code-mode/lib/${f}`) || new RegExp(`\`lib/${f.replace('.', '\\.')}\`[^\\n]*不能`).test(install),
  ),
  {
    libFiles,
    registered: presetFiles.filter((f) => f.startsWith('dsh-code-mode/')),
    unregistered: libFiles.filter((f) => !presetFiles.includes(`dsh-code-mode/lib/${f}`)),
  },
);
check('P2', 'the code-memory group registers no library module', !groupFiles.includes('dsh-code-mode/lib/ledger.js'), {
  rows: groupRows,
});
check(
  'P2b',
  'every module this mode mounts is documented in INSTALL.md, wherever its row lives',
  presetFiles
    .filter((f) => f.startsWith('dsh-code-mode/lib/'))
    .every((f) => install.includes(f.replace('dsh-code-mode/lib/', ''))),
  {
    missing: presetFiles
      .filter((f) => f.startsWith('dsh-code-mode/lib/'))
      .filter((f) => !install.includes(f.replace('dsh-code-mode/lib/', ''))),
  },
);

// --- INSTALL.md must describe that group exactly ----------------------------
// Tolerant of formatting (bold, punctuation) but not of a wrong number.
const installRowCount = /`code-memory` 组[^0-9]{0,12}(\d+)\s*行/.exec(install)?.[1];
check('D1', 'INSTALL.md states the real number of code-memory rows', Number(installRowCount) === groupRows.length, {
  installSays: installRowCount,
  presetHas: groupRows.length,
});
check(
  'D2',
  'INSTALL.md names every registered module',
  groupFiles.every((f) => install.includes(f.replace('dsh-code-mode/lib/', ''))),
  { missing: groupFiles.filter((f) => !install.includes(f.replace('dsh-code-mode/lib/', ''))) },
);

// --- settled questions must not still read as open --------------------------
// The decision may be recorded in the handover rather than the install guide, so
// read the docs as a set: what matters is that no shipped document still presents
// the Aegis question as open, and that the decision is written down somewhere.
const handover = read(path.join(PKG_DIR, 'HANDOVER.md'));
check(
  'D3',
  'no shipped document still lists the Aegis question as pending, and the decision is recorded',
  !/仍待用户拍板/.test(install) && !/仍待用户拍板/.test(handover) && /activation_mode/.test(install + handover),
  {
    stillPendingInInstall: /仍待用户拍板/.test(install),
    stillPendingInHandover: /仍待用户拍板/.test(handover),
    decisionRecorded: /activation_mode/.test(install + handover),
  },
);
check(
  'D4',
  'INSTALL.md records the two host-side limitations as facts',
  /code_verify.*只读/s.test(install) &&
    /web_fetch/.test(install) &&
    // The original wording blamed the tool; it is a per-host refusal, and the doc
    // must not overstate it (measured 2026-10-01: example.com 200, github.com refused).
    /主机级拒绝|不是工具坏了/.test(install),
  {
    codeVerifyReadOnly: /code_verify.*只读/s.test(install),
    webFetch: /web_fetch/.test(install),
    statesHostLevel: /主机级拒绝|不是工具坏了/.test(install),
  },
);

// --- the generator must not be able to destroy the preset -------------------
check(
  'G1',
  'build-preset.mjs no longer emits lib/ledger.js as a plugin row',
  !/const group = `[\s\S]*lib\/ledger\.js[\s\S]*`;/.test(generator) && !generator.includes("name: 'dsh-code-mode/lib/ledger.js'"),
  { mentionsLedgerAsRow: generator.includes("name: 'dsh-code-mode/lib/ledger.js'") },
);
check(
  'G2',
  'build-preset.mjs has a non-destructive check mode',
  generator.includes('--check') && generator.includes('unexpectedAdditions'),
  { hasCheck: generator.includes('--check') },
);

// --- the group's size, wherever the docs state it ---------------------------
// The recurring drift this file exists for: INSTALL.md described a 5-row group
// while the preset had 6, and DESIGN.md kept saying "code-memory 组（6 行），共 40
// 个嵌套条目" for a day after `code-pit-guard` made it 7 rows and 41 entries —
// with D1 (INSTALL only) still green. Every document that quotes the number is
// now checked against the preset, not just the install guide.
// The counting rule (a row is any `- id:` line at any depth) is build-preset.mjs's
// `entries()`; the audit restates it rather than trusting a copy of the number.
const nestedEntries = [...preset.matchAll(/^( *)- id: /gm)].length;
const rowCountClaim = (text) => /`?code-memory`?\s*组[^0-9]{0,12}(\d+)\s*行/.exec(text)?.[1];
const quotedRows = { 'INSTALL.md': rowCountClaim(install), 'DESIGN.md': rowCountClaim(design), 'HANDOVER.md': rowCountClaim(handover) };
check(
  'D5',
  'every document that quotes the code-memory row count quotes the real one',
  Object.values(quotedRows).every((n) => Number(n) === groupRows.length),
  { presetHas: groupRows.length, documents: quotedRows, missingClaim: Object.entries(quotedRows).filter(([, n]) => n === undefined).map(([f]) => f) },
);
const nestedClaim = /共\s*(\d+)\s*个嵌套条目/.exec(design)?.[1];
check(
  'D6',
  'DESIGN.md states the real number of nested preset entries',
  Number(nestedClaim) === nestedEntries,
  { designSays: nestedClaim, presetHas: nestedEntries },
);

// --- the generated report must agree with the run ---------------------------
const reportSays = /Result: (\d+)\/(\d+) passed/.exec(reportMd);
const reportNumbers = reportJson === undefined ? '(no machine report)' : `${reportJson.summary.passed}/${reportJson.summary.total}`;
check(
  'R1',
  'budget-report.md agrees with budget-report.json',
  reportJson !== undefined &&
    reportSays !== null &&
    Number(reportSays[1]) === reportJson.summary.passed &&
    Number(reportSays[2]) === reportJson.summary.total,
  {
    markdown: reportSays === null ? '(no verdict line)' : `${reportSays[1]}/${reportSays[2]}`,
    json: reportNumbers,
  },
);
check(
  'R2',
  'budget-report.md is marked as generated, not hand-written',
  /Generated by `budget-probe\.mjs`/.test(reportMd),
  { head: reportMd.slice(0, 80) },
);
// Agreement between two artifacts is worthless if both are old: this repo's own
// habit says a green harness is not a green product, and a stale report is how a
// claim outlives the code it described. The report must be at least as new as the
// probe that writes it and the module it describes.
const REGEN = "$env:ELECTRON_RUN_AS_NODE='1'; & '<install>\\DeepSeek Harness.exe' --expose-internals '<pkg>\\probes\\budget-probe.mjs'";
const sources = {
  'probes/budget-probe.mjs': mtime(path.join(PROBES_DIR, 'budget-probe.mjs')),
  'lib/budget.js': mtime(path.join(PKG_DIR, 'lib', 'budget.js')),
};
const reportAt = Math.min(mtime(REPORT_JSON) ?? 0, mtime(REPORT_MD) ?? 0);
const newestSource = Math.max(...Object.values(sources).map((v) => v ?? 0));
const ageDays = (ms, from) => (from === 0 || ms === 0 ? undefined : Math.round(((from - ms) / 86400000) * 10) / 10);
check(
  'R3',
  'the budget report is not older than the probe and the module it describes',
  reportAt > 0 && newestSource > 0 && reportAt >= newestSource,
  {
    report: REPORT_MD,
    reportOlderThanSourcesByDays: ageDays(reportAt, newestSource),
    sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, new Date(v ?? 0).toISOString()])),
    regenerateWith: REGEN,
  },
);
// A document that quotes a number must quote the number the run produced.
const handoverClaim = /budget-probe\.mjs`?\s*\|?\s*(\d+)\s*\/\s*(\d+)/.exec(handover);
check(
  'R4',
  'HANDOVER.md quotes the budget report it points at',
  handoverClaim !== null &&
    reportJson !== undefined &&
    Number(handoverClaim[1]) === reportJson.summary.passed &&
    Number(handoverClaim[2]) === reportJson.summary.total,
  {
    handoverSays: handoverClaim === null ? '(no N/M claim for budget-probe)' : `${handoverClaim[1]}/${handoverClaim[2]}`,
    reportSays: reportNumbers,
  },
);

// --- DESIGN.md must not advertise undelivered work as delivered -------------
check(
  'S1',
  'DESIGN.md still tracks at least one phase as not done (or says so in words)',
  /P4[\s\S]{0,120}(未做|⬜)/.test(design),
  { tail: design.slice(design.indexOf('| P4'), design.indexOf('| P4') + 140) },
);

// --- every shipped text file must be valid UTF-8 -----------------------------
// Measured 2026-10-02: two probe files carried `E2 80 3F` — an em dash whose third
// byte had been replaced by a literal `?` by a lossy decode+re-encode — and a third
// carried U+FFFD where an em dash and an ellipsis used to be. Node runs all three
// happily, because its decoder substitutes the replacement character, so no other
// check here could see the damage; only a reader that refuses invalid bytes could.
// A file the tooling cannot read is a file nobody will dare to edit.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const shippedText = [
  ...fs.readdirSync(path.join(PKG_DIR, 'lib')).filter((f) => f.endsWith('.js')).map((f) => path.join('lib', f)),
  ...fs.readdirSync(PROBES_DIR).filter((f) => /\.(mjs|cjs)$/.test(f)).map((f) => path.join('probes', f)),
  'probes/README.md',
  'DESIGN.md',
  'HANDOVER.md',
  'INSTALL.md',
  'LESSONS.md',
  'TESTING.md',
  'package.json',
  'cordis.patch.yml',
];
const unreadable = [];
for (const relative of shippedText) {
  try {
    strictUtf8.decode(fs.readFileSync(path.join(PKG_DIR, relative)));
  } catch (e) {
    unreadable.push(`${relative}: ${e.message}`);
  }
}
check('E1', 'every shipped text file is valid UTF-8 (no lossy-encode damage)', unreadable.length === 0, {
  files: shippedText.length,
  invalid: unreadable.slice(0, 5),
});

// --- documents must quote the probe results the probes actually report -------
// This is the class R4 covers for one artifact, widened to the numbers every
// document quotes: TESTING.md's "expected" lines, the check counts in the probes
// README table, and HANDOVER's results table. Prose counts drifted here twice
// before anything checked them — TESTING.md said `guard-probe 20/20` when the
// probe had grown to 27, and `debt-audit 11/11` when it had grown to 16 — and a
// stale "expected" line is worse than none: it teaches the reader to distrust a
// green run. Only the probes that run on plain node are executed here, because
// this audit must stay runnable in a channel with no Electron; the Electron ones
// are covered by R3/R4's freshness rule instead.
// Some probes report `{passed,total}`; `check-prompt-section.mjs` prints its own
// shape with a PASS/FAIL verdict and no counts, so only counting probes are here.
//
// The probe is spawned with `stdio: 'ignore'`, not pipes: a confined channel
// refuses to create the pipe, and the failure depends on how the audit itself was
// launched — measured 2026-10-02, the same audit was 22/22 when run bare and 17/22
// when its output was piped through `Select-String`. Nothing needs the child's
// stdout anyway: `guard-probe.mjs` writes `guard-report.json` into the temp dir, so
// the report is read and compared by its own timestamp.
//
// KNOWN GAP, CLOSED 2026-10-03: the Electron probes used to be covered by nothing —
// this audit ran `guard-probe.mjs` only, so `acceptance-probe.mjs` (24), `compact-gate-probe.mjs`
// (32) and `pit-guard-probe.mjs` (24) were numbers kept in sync by hand. That is exactly how
// the 30 -> 32 edit happened by hand earlier that day, and how a real regression in
// `tool-record.js` (a `ReferenceError` that made `code_record` unable to render a mistake)
// stayed invisible: acceptance was quoted as 24/24 while it was really 22/24.
//
// They are now *run*, not trusted. Each probe is here because it satisfies both halves:
// it loads the host's module resolution from the asar without needing a desktop window,
// and it is hermetic once `DSH_CODE_GLOBAL_DIR` points at a scratch dir — verified for all
// three before wiring (24/24, 32/32, 24/24 under redirect, ~1.1s each). `HARNESS_EXE` is
// required; where it is missing (a machine without the harness, a channel that refuses to
// spawn) every Electron probe is recorded as `unavailable` — a state R5 names on its face,
// never a pass.
const ELECTRON_RUNNABLE = ['acceptance-probe.mjs', 'compact-gate-probe.mjs', 'pit-guard-probe.mjs'];
// `handover-grant-probe.mjs` is here rather than above because it stubs the two host
// imports instead of loading resolution from the asar, so plain Node can run it — which
// is the whole reason it exists: `compact-gate-probe.mjs` needs the Electron binary, and
// a confined session channel cannot start that binary at all (measured 2026-10-03: no
// output, empty `$LASTEXITCODE`). It measures by execution the two things that changed
// in the handover branch, where the full probe cannot reach.
//
// The three ledger probes are here for a different reason: they import `lib/ledger.js`
// directly (it has no bare imports), so they can assert journal rotation, the write-side
// advisories and the full brief without a host at all.
//
// NOT in this list, on purpose: `audit-child-env-probe.mjs`. It spawns *this* audit, so
// listing it would make the audit spawn itself — recursion, each level waiting on the
// next. It is run directly, and it is the guard for how this list's verdicts are read.
const RUNNABLE = [
  'guard-probe.mjs',
  'handover-grant-probe.mjs',
  'journal-rotation-probe.mjs',
  'write-rule-probe.mjs',
  'brief-full-probe.mjs',
  'promotion-probe.mjs',
  // Added 2026-10-04 with the two fixes they judge. Both import `lib/` only, so plain Node runs
  // them — and both write the `-report.json` below, which is the contract this list requires.
  // `pattern-budget-probe` is the one that measures the bound actually firing: the pit ledger
  // records that the first version of this cure was "tested" with a pattern that returned in
  // 0 ms, so a probe that only asserts "it did not hang" would repeat that mistake.
  'pattern-budget-probe.mjs',
  'repeat-identity-probe.mjs',
];
const probeRuns = [];
const electronRuns = [];
const harnessAvailable = fs.existsSync(HARNESS_EXE);
for (const file of ELECTRON_RUNNABLE) {
  if (!harnessAvailable) {
    electronRuns.push({ file, unavailable: `no harness binary at ${HARNESS_EXE}` });
    continue;
  }
  // The verdict travels in a file, and the child gets `stdio: 'ignore'`.
  //
  // Not a preference: in a confined channel a spawned child with a piped stdio dies with
  // `EPERM: spawn` *before* the program starts, and the whole audit falls over with it —
  // the recorded pit this block already stepped on once. `DSH_PROBE_REPORT` is the
  // existing mechanism for exactly this (`budget-chain-probe.mjs` has used it since
  // 2026-10-02), so these three probes now offer it too.
  const reportFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'debt-audit-electron-')), 'summary.json');
  const started = Date.now();
  const run = spawnSync(
    HARNESS_EXE,
    ['--expose-internals', path.join(PROBES_DIR, file)],
    {
      cwd: PROBES_DIR,
      stdio: 'ignore',
      timeout: 180000,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_CODE_GLOBAL_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'debt-audit-electron-global-')),
        DSH_PROBE_REPORT: reportFile,
      },
    },
  );
  let summary;
  try {
    const raw = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    // Two report shapes exist among the probes: a flat `{passed,total,failed}` and
    // `compact-gate-probe`'s `{summary:{...}}`. Read both rather than reshaping a probe
    // to satisfy a reader.
    summary = raw.summary === undefined ? raw : { ...raw.summary };
  } catch {
    summary = undefined;
  }
  electronRuns.push({
    file,
    exitCode: run.status,
    ms: Date.now() - started,
    reported: summary !== undefined,
    passed: summary?.passed,
    total: summary?.total,
    skipped: Array.isArray(summary?.skipped) ? summary.skipped.length : 0,
    spawnError: run.error === undefined ? undefined : String(run.error?.code ?? run.error?.message ?? run.error),
    note:
      summary === undefined
        ? `no report at ${reportFile}: the probe did not reach its report step (exit ${String(run.status)})`
        : undefined,
  });
}
probeRuns.push(...electronRuns);
const probesDirForRun = PROBES_DIR;
// The children must not inherit the caller's `DSH_PROBE_REPORT`, because for the probes
// that honour it (all but `guard-probe` below) that variable *is* where they write — and
// the audit's own verdict goes to that same path (`const out = process.env.DSH_PROBE_REPORT`
// at the foot of this file). Measured 2026-10-04: it was passed straight through, so five
// probes wrote their reports to the audit's sink and their default paths stayed empty,
// which is why R5–R8 read 19/23 with R5 naming five probes that had all passed. A
// caller-set path must redirect *this* audit's verdict, never its children's.
const childEnv = { ...process.env };
delete childEnv.DSH_PROBE_REPORT;
delete childEnv.DSH_AUDIT_REPORT;
for (const file of RUNNABLE) {
  // The read path must be the probe's OWN default, not one chosen here. Two conventions
  // exist and the audit cannot unify them from the outside: five of these probes accept
  // `DSH_PROBE_REPORT` (which is how the Electron block above redirects them), while
  // `guard-probe.mjs` hard-codes `tempReport('guard-report.json')` and ignores it.
  // Measured 2026-10-04: pointing this read at a private per-run directory made five
  // *passing* probes read as `reported=false` — the audit asked for a file the child
  // never writes. The fixed name below is the correct one.
  const reportFile = path.join(os.tmpdir(), `${file.replace(/-probe\.mjs$/, '')}-report.json`);
  // Delete it first so the read means "this run". What that removes is the case a previous
  // audit left the file behind: the mtime test below is the only thing that would catch it,
  // and it is the weaker guard of the two.
  try {
    fs.unlinkSync(reportFile);
  } catch {
    /* absent is the normal case */
  }
  const before = Date.now();
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(probesDirForRun, file)], {
    cwd: probesDirForRun,
    stdio: 'ignore',
    timeout: 120000,
    env: { ...childEnv, DSH_CODE_GLOBAL_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'debt-audit-global-')) },
  });
  let report;
  let stale = true;
  try {
    const stat = fs.statSync(reportFile);
    stale = stat.mtimeMs < before; // the file exists but predates this run
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch {
    report = undefined;
  }
  // A `DSH_CODE_AUDIT_DIAG` block lived here on 2026-10-04 and was removed once its four
  // hypotheses were settled. What it measured, kept in prose because it is the reason the
  // code above looks the way it does: a fresh child report lands 45–58 ms after `before`;
  // `os.tmpdir()` resolves identically in parent and child; a child can create and write a
  // file inside a directory its parent made; and `guard-probe` writes `guard-report.json`
  // under `os.tmpdir()` no matter what `DSH_PROBE_REPORT` says.
  probeRuns.push({
    file,
    // `status` is null when the child could not be started at all (a confined
    // channel refuses the pipe: `EPERM: spawn`), so the reason is kept — a bare
    // null tells the reader nothing about whether the probe failed or the channel
    // refused to run it.
    exitCode: run.status,
    spawnError: run.error === undefined ? undefined : String(run.error?.code ?? run.error?.message ?? run.error),
    ms: Date.now() - started,
    reported: report !== undefined && !stale,
    passed: report === undefined || stale ? undefined : report.passed,
    total: report === undefined || stale ? undefined : report.total,
    skipped: report === undefined || stale ? 0 : (report.skipped ?? []).length,
  });
}

/**
 * Whether a document's quoted `N/M` matches what the probe reported.
 *
 * A probe run in a channel that forbids spawning skips its process checks and
 * reports `passed + skipped === total`. The documents quote the full run, so a
 * claim is satisfied when the numbers match outright, or when exactly the skipped
 * checks account for the difference — the skip is named on stderr and in the
 * report either way, so this tolerance cannot hide a broken check.
 * @param claim - `{ passed, total }` as quoted in a document.
 * @param run - the probe's reported result.
 */
function claimMatches(claim, run) {
  if (run.passed === undefined || run.total === undefined) return false;
  if (run.passed === claim.passed && run.total === claim.total) return true;
  return run.passed + (run.skipped ?? 0) === claim.passed && run.total === claim.total;
}
/**
 * Every probe this audit can run must actually run, stay green, and produce a verdict.
 *
 * The `reported` half is not decoration: before 2026-10-03 the Electron probes were not
 * run at all, and this check's own text ("every plain-node probe") admitted it. A probe
 * that exits 0 without writing a report proves nothing — the same lesson as a
 * `code_verify` whose expected output never appeared. `unavailable` is the one honest
 * third state (no harness binary on this machine), and it is named on the check's face
 * rather than counted as a pass.
 */
const failedRuns = probeRuns.filter((run) => {
  if (run.unavailable !== undefined) return false;
  if (run.exitCode !== 0) return true;
  return run.reported === false && run.spawnError === undefined;
});
const unavailableRuns = probeRuns.filter((run) => run.unavailable !== undefined);
check(
  'R5',
  'every probe this audit runs is green and reports its own verdict',
  failedRuns.length === 0,
  {
    runs: probeRuns.map(({ file, exitCode, ms, reported, passed, total, skipped, spawnError, unavailable, note }) => ({
      file,
      exitCode,
      ms,
      reported,
      passed,
      total,
      skipped,
      spawnError,
      unavailable,
      note,
    })),
    unavailable: unavailableRuns.map((run) => `${run.file}: ${run.unavailable}`),
    note:
      failedRuns.length === 0
        ? undefined
        : 'a null exitCode with EPERM means this channel forbids child processes: run the audit through a channel that can spawn them',
  },
);

// TESTING.md is the runbook: its "expected passed N/M" lines must equal what the
// probe reports now.
const testing = read(path.join(PKG_DIR, 'TESTING.md'));
const testingClaims = [];
for (const [, probeFile, passed, total] of testing.matchAll(
  /([a-z-]+-probe\.mjs|debt-audit\.mjs|check-prompt-section\.mjs)[^\n]*?期望[^\n]*?(?:passed\s+)?(\d+)\s*\/\s*(\d+)/g,
)) {
  testingClaims.push({ probeFile, passed: Number(passed), total: Number(total) });
}
const wrongTestingClaims = testingClaims.filter((claim) => {
  const run = probeRuns.find((r) => r.file === claim.probeFile);
  if (run === undefined) return false; // not a probe this audit can run
  return !claimMatches(claim, run);
});
check(
  'R6',
  'TESTING.md quotes the pass counts the probes actually report',
  testingClaims.length >= 2 && wrongTestingClaims.length === 0,
  {
    claims: testingClaims,
    wrong: wrongTestingClaims,
    actual: probeRuns.map(({ file, passed, total, skipped }) => ({ file, passed, total, skipped })),
  },
);

// probes/README.md states a check count per probe; HANDOVER.md states pass/total.
const probesReadme = read(path.join(PROBES_DIR, 'README.md'));
const readmeClaims = [];
for (const [, probeFile, count] of probesReadme.matchAll(/\|\s*`?([a-z-]+-probe\.mjs)`?\s*\|[^|\n]*\|\s*(\d+)\s*\|/g)) {
  readmeClaims.push({ probeFile, count: Number(count) });
}
const wrongReadmeClaims = readmeClaims.filter((claim) => {
  const run = probeRuns.find((r) => r.file === claim.probeFile);
  return run !== undefined && run.total !== claim.count;
});
check(
  'R7',
  'probes/README.md states the check count each probe actually has',
  readmeClaims.length >= 2 && wrongReadmeClaims.length === 0,
  { claims: readmeClaims, wrong: wrongReadmeClaims, actual: probeRuns.map(({ file, passed, total }) => ({ file, passed, total })) },
);

const handoverClaims = [];
for (const [, probeFile, passed, total] of handover.matchAll(/\|\s*`([a-z-]+-probe\.mjs)`\s*\|\s*(\d+)\s*\/\s*(\d+)/g)) {
  handoverClaims.push({ probeFile, passed: Number(passed), total: Number(total) });
}
const wrongHandoverClaims = handoverClaims.filter((claim) => {
  const run = probeRuns.find((r) => r.file === claim.probeFile);
  return run !== undefined && !claimMatches(claim, run);
});
check(
  'R8',
  'HANDOVER.md quotes the pass counts the probes actually report',
  handoverClaims.length >= 2 && wrongHandoverClaims.length === 0,
  { claims: handoverClaims, wrong: wrongHandoverClaims },
);

// The generator prints no N/M, so pin its verdict. Its output is read through a
// pipe when this channel allows one; when it does not (`EPERM: spawn`, which a
// confined channel raises, and which depends on how *this* audit was launched),
// the run is retried with `stdio: 'ignore'` and exit 0 alone is the evidence —
// `build-preset.mjs --check` exits non-zero on a drifted preset, so the claim
// "the preset is intact" still holds, just with less detail.
const runPreset = (mode) =>
  spawnSync(process.execPath, [path.join(PROBES_DIR, 'build-preset.mjs'), '--check'], {
    cwd: PROBES_DIR,
    timeout: 120000,
    ...(mode === 'pipe' ? { encoding: 'utf8' } : { stdio: 'ignore' }),
  });
let presetRun = runPreset('pipe');
const presetPiped = presetRun.error === undefined;
if (!presetPiped) presetRun = runPreset('ignore');
const presetOutput = presetPiped ? `${presetRun.stdout ?? ''}\n${presetRun.stderr ?? ''}` : '';
const presetVerdictMatch = /"verdict"\s*:\s*"([^"]+)"/.exec(presetOutput);
const presetVerdict = presetVerdictMatch === null ? null : presetVerdictMatch[1];
const testingPresetPass = /build-preset\.mjs[^\n]*期望\s*PASS/.test(testing);
check(
  'R9',
  'TESTING.md promises PASS for build-preset, and the preset check agrees',
  presetRun.status === 0 &&
    (presetPiped ? presetVerdict !== null && /every standard entry/.test(presetVerdict) : true) &&
    testingPresetPass,
  {
    exitCode: presetRun.status,
    readThroughAPipe: presetPiped,
    spawnError: presetRun.error === undefined ? undefined : String(presetRun.error?.code ?? presetRun.error),
    verdict: presetVerdict ?? '(not read: the pipe was refused, so exit 0 is the evidence)',
    testingPromisesPass: testingPresetPass,
  },
);

// --- last check: this audit's own count, quoted in TESTING.md ----------------
// It has to run after every other check has run, because `checks.length` is what
// the run prints (measured 2026-10-02: placed earlier, it compared against 17 and
// reported a mismatch that did not exist). This audit cannot run itself — it would
// recurse — and TESTING.md quoted 23 by hand while the file held 21, which is
// exactly the class of drift R6–R8 exist for.
{
  const selfClaims = testingClaims.filter((claim) => claim.probeFile === 'debt-audit.mjs');
  const expected = checks.length + 1; // this check is not in `checks` yet
  check(
    'R10',
    'TESTING.md quotes the number of checks this audit actually runs',
    selfClaims.length > 0 && selfClaims.every((claim) => claim.passed === expected && claim.total === expected),
    { testingSays: selfClaims, runsChecks: expected },
  );
}

const failed = checks.filter((c) => !c.ok);
const report = {
  failed: failed.map((c) => `${c.id} ${c.name}`),
  passed: checks.length - failed.length,
  total: checks.length,
  checks,
};
// The same report-file escape hatch every other probe has, and for the same reason: this
// audit spawns children, so a channel that refuses a piped stdio leaves its stdout
// unreadable — measured 2026-10-03, when a wrapper that spawned this audit got zero bytes
// and could not tell which check had failed. `DSH_PROBE_REPORT` points the verdict at a
// file instead; stdout keeps working exactly as before.
const out = process.env.DSH_PROBE_REPORT ?? process.env.DSH_AUDIT_REPORT;
if (typeof out === 'string' && out.trim().length > 0) {
  try {
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch {
    /* an unwritable report path must not change the verdict */
  }
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
