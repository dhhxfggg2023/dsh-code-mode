/**
 * Verify the four gate/budget repairs from `.dsh-code/audits/gate-budget-audit.md`
 * (F5, F6, F7, F8) and print ONE final line: `ALL-VERIFIED` or `HAS-PROBLEMS`.
 *
 * Exits non-zero when anything is red. Run it from a channel that can spawn:
 *
 *   & 'E:\tools\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' `
 *       '.dsh-code\audits\verify-gate-budget-fixes.mjs'
 *
 * Three environment facts shape this script, each of them measured in this repo:
 *
 *  1. **A probe's verdict is read from its report file, never from its stdout.** The
 *     `code_verify` channel does not forward the Electron child's stdout (ledger pit
 *     `the-documented-acceptance-command-through-code_verify-record`), so a parent that
 *     judges a probe by what it printed records a green probe as a false failure.
 *  2. **Children are spawned with an *inherited* stdout, not a pipe.** In a confined
 *     channel a piped child never starts (status `null`, empty output, 1 ms) while
 *     `stdio: 'inherit'` works — ledger pit
 *     `code_verify-通道里跑一个会在自己旁边写辅助脚本的探针`.
 *  3. **Every report is pointed at `$env:TEMP`.** The two audit probes hard-code their
 *     report next to themselves in `.dsh-code/audits/`, which the `code_verify` channel
 *     cannot write; `temp-report-sink.mjs` (a preload) sends that one write into a fresh
 *     temp directory instead, and the probes that already honour `DSH_PROBE_REPORT` —
 *     including `probes/budget-probe.mjs`, which does so as part of this repair — are
 *     pointed at it directly. Every run gets its OWN fresh directory, so a report from an
 *     earlier run can never be read as this run's verdict.
 *
 * `probe-compact-open.mjs` is run twice. Plain, it is the audit's own probe with the
 * mounted `askTimeoutMs` (120000 ms) and a 250–400 ms observation window, so C8/C9 can
 * only read `held` even after the repair — that is the window, not the defect. The second
 * run compresses timers of a second or more by 1000 (`scale-long-timers.mjs`), which is
 * the deadline the gate arms and nothing else, and there C8/C9 must read `released`. The
 * direct proof of F5 is `probe-gate-deadline.mjs`, which drives the same real handler with
 * a 200 ms bound (and keeps the mounted value as its control).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AUDIT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(AUDIT_DIR, '..', '..');
const SINK_URL = pathToFileURL(path.join(AUDIT_DIR, 'temp-report-sink.mjs')).href;
const SCALE_URL = pathToFileURL(path.join(AUDIT_DIR, 'scale-long-timers.mjs')).href;
const OUT = process.env.DSH_VERIFY_REPORT ?? path.join(os.tmpdir(), 'verify-gate-budget-fixes.json');

function firstExisting(candidates, fallback) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && fs.existsSync(candidate)) return candidate;
  }
  return fallback;
}
const NODE_EXE = firstExisting(
  [
    process.env.DSH_NODE,
    'E:\\tools\\DSH\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe',
    process.execPath,
  ],
  'node',
);
const HARNESS_EXE = firstExisting([process.env.DSH_EXE, 'E:\\tools\\DSH\\DeepSeek Harness.exe'], undefined);

const problems = [];
const rows = [];

/**
 * One probe run: fresh report directory, inherited stdio, verdict read from the file.
 * @param options.preloads - absolute file URLs passed as `--import` (sink, clock scaling).
 * @param options.env - extra environment for the child.
 * @param options.reportName - the file the probe is expected to leave in the fresh dir.
 */
function run({ id, file, kind, preloads = [], env = {}, reportName, timeoutMs = 180000, note }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `verify-${id}-`));
  const reportPath = path.join(dir, reportName);
  const isElectron = kind === 'electron';
  const runner = isElectron ? HARNESS_EXE : NODE_EXE;
  const args = [];
  if (isElectron) args.push('--expose-internals');
  for (const preload of preloads) args.push('--import', preload);
  args.push(file);
  const childEnv = {
    ...process.env,
    DSH_PROBE_REPORT: reportPath,
    DSH_TEMP_REPORT_DIR: dir,
    ...env,
  };
  if (isElectron) childEnv.ELECTRON_RUN_AS_NODE = '1';

  let status;
  let error;
  if (runner === undefined) {
    error = `the Electron binary was not found (looked for ${HARNESS_EXE ?? 'E:\\tools\\DSH\\DeepSeek Harness.exe'})`;
  } else {
    const result = spawnSync(runner, args, {
      cwd: PKG_DIR,
      env: childEnv,
      // Inherited, not piped: a confined channel refuses a piped child's stdio and the
      // child never starts (see the header). The verdict is the report file, not this.
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: timeoutMs,
    });
    status = result.status;
    if (result.error !== undefined) error = String(result.error?.message ?? result.error);
    else if (result.signal !== null && result.signal !== undefined) error = `killed by ${result.signal} after ${timeoutMs} ms`;
  }

  let report;
  if (error === undefined) {
    try {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (readError) {
      error = `no readable report at ${reportPath} (${readError?.code ?? readError?.message ?? readError})`;
    }
  }
  return { dir, reportPath, report, status, error, note };
}

// ---------------------------------------------------------------------------- rows

/** F6 + "nothing escapes an agent/pre-step listener", on the audit's own probe. */
function evaluateOpenPlain(run_) {
  const results = run_.report?.results ?? [];
  const threw = results.filter((entry) => entry.outcome === 'threw');
  const held = results.filter((entry) => entry.outcome === 'held');
  const unexpectedHeld = held.filter((entry) => !['C8', 'C9'].includes(entry.id));
  const ok = threw.length === 0 && unexpectedHeld.length === 0 && results.length >= 22;
  return {
    ok,
    detail: `threw=[${threw.map((entry) => entry.id).join(', ')}] held=[${held.map((entry) => entry.id).join(', ')}] checks=${results.length}`,
    reason:
      threw.length > 0
        ? `the handler threw out of ${threw.map((entry) => entry.id).join(', ')}`
        : unexpectedHeld.length > 0
          ? `held outside C8/C9: ${unexpectedHeld.map((entry) => entry.id).join(', ')}`
          : results.length < 22
            ? `only ${results.length} cases ran`
            : undefined,
  };
}

/** F5, measured where the audit probe cannot see it: its own deadline, compressed. */
function evaluateOpenScaled(run_) {
  const results = run_.report?.results ?? [];
  const held = results.filter((entry) => entry.outcome === 'held');
  const threw = results.filter((entry) => entry.outcome === 'threw');
  const ok = held.length === 0 && threw.length === 0 && results.length >= 22;
  return {
    ok,
    detail: `held=[${held.map((entry) => entry.id).join(', ')}] threw=[${threw.map((entry) => entry.id).join(', ')}] checks=${results.length}`,
    reason: ok ? undefined : `still held or throwing: held=[${held.map((e) => e.id).join(', ')}] threw=[${threw.map((e) => e.id).join(', ')}]`,
  };
}

/** F7 and F8, on the audit's own shape probe. */
function evaluateBudgetShapes(run_) {
  const checks = Array.isArray(run_.report) ? run_.report : [];
  const failed = checks.filter((entry) => entry.ok !== true);
  const byId = new Map(checks.map((entry) => [entry.id, entry]));
  const g5 = byId.get('G5');
  const g9 = byId.get('G9');
  const ok = failed.length === 0 && checks.length >= 10 && g5?.ok === true && g9?.ok === true;
  return {
    ok,
    detail: `${checks.length - failed.length}/${checks.length} passed, failed=[${failed.map((entry) => entry.id).join(', ')}] G5=${g5?.ok} G9=${g9?.ok}`,
    reason: ok
      ? undefined
      : `failed=[${failed.map((entry) => entry.id).join(', ')}]${g5?.ok === true ? '' : ' (F7 G5 still red)'}${g9?.ok === true ? '' : ' (F8 G9 still red)'}`,
  };
}

/** F5 and F6 with the control: the gate's own deadline, at a bound short enough to see. */
function evaluateDeadline(run_) {
  const results = run_.report?.results ?? [];
  const failed = results.filter((entry) => entry.ok !== true);
  const ok = failed.length === 0 && results.length >= 14;
  return {
    ok,
    detail: `${results.length - failed.length}/${results.length} passed, failed=[${failed.map((entry) => entry.id).join(', ')}]`,
    reason: failed.length === 0 ? undefined : `failed=[${failed.map((entry) => entry.id).join(', ')}]`,
  };
}

/** The package's own gate suite: every existing behaviour must still hold. */
function evaluateCompactGate(run_) {
  const summary = run_.report?.summary;
  const ok = summary !== undefined && Array.isArray(summary.failed) && summary.failed.length === 0 && summary.total >= 35;
  return {
    ok,
    detail: `${summary?.passed}/${summary?.total} passed, failed=[${(summary?.failed ?? []).join(', ')}]`,
    reason: ok ? undefined : `failed=[${(summary?.failed ?? []).join(', ')}] or total ${summary?.total} < 35`,
  };
}

/** The package's own budget suite, plus the proof that its report went where the caller can read it. */
function evaluateBudget(run_) {
  const summary = run_.report?.summary;
  // The three artifacts are read as FILES in this row's own fresh directory, not from the
  // report's `artifacts` field: `budget-probe.mjs` writes its JSON report *before* it knows
  // whether the writes succeeded and only puts `artifacts` on the stdout summary line — a
  // verifier that trusted the file's `artifacts` key would call every run artifact-less
  // (measured: `artifacts=undefined` on an otherwise green row). A fresh directory per run
  // is what makes "the file is there" mean "this run wrote it".
  const artifacts = ['budget-report.json', 'budget-log.txt', 'budget-report.md'].map((name) => {
    let size = -1;
    let head = '';
    try {
      size = fs.statSync(path.join(run_.dir, name)).size;
      head = fs.readFileSync(path.join(run_.dir, name), 'utf8').slice(0, 200);
    } catch {
      size = -1;
    }
    return { name, size, head };
  });
  const markdown = artifacts.find((entry) => entry.name === 'budget-report.md');
  const landed =
    artifacts.every((entry) => entry.size > 0) && /Generated by `budget-probe\.mjs`/.test(markdown?.head ?? '');
  const ok = summary !== undefined && Array.isArray(summary.failed) && summary.failed.length === 0 && summary.total >= 29 && landed;
  return {
    ok,
    detail: `${summary?.passed}/${summary?.total} passed, failed=[${(summary?.failed ?? []).join(', ')}] artifacts=${artifacts.map((entry) => `${entry.name}:${entry.size}`).join(' ')}`,
    reason: ok
      ? undefined
      : `${summary?.failed?.length ? `failed=[${summary.failed.join(', ')}]` : ''}${summary?.total >= 29 ? '' : ` total ${summary?.total} < 29`}${landed ? '' : ' the three artifacts did not all land in the caller-named sink'}`,
  };
}

/** The reachable handover probe: the F1 delivery fix must still deliver. */
function evaluateHandover(run_) {
  const report = run_.report;
  const ok = report !== undefined && Array.isArray(report.failed) && report.failed.length === 0 && report.total >= 12;
  return {
    ok,
    detail: `${report?.passed}/${report?.total} passed, failed=[${(report?.failed ?? []).join(', ')}]`,
    reason: ok ? undefined : `failed=[${(report?.failed ?? []).join(', ')}] or total ${report?.total} < 12`,
  };
}

const plan = [
  {
    id: 'f6-open-plain',
    file: path.join(AUDIT_DIR, 'probe-compact-open.mjs'),
    kind: 'node',
    preloads: [SINK_URL],
    reportName: 'probe-compact-open.out.json',
    evaluate: evaluateOpenPlain,
    note: 'F6: no case may throw out of the handler. C8/C9 stay `held` here by construction: the mounted bound is 120000 ms and this probe watches 250-400 ms (the F5 control for them is the next row).',
  },
  {
    id: 'f5-open-scaled',
    file: path.join(AUDIT_DIR, 'probe-compact-open.mjs'),
    kind: 'node',
    preloads: [SINK_URL, SCALE_URL],
    env: { DSH_SCALE_LONG_TIMERS: '1000' },
    reportName: 'probe-compact-open.out.json',
    evaluate: evaluateOpenScaled,
    note: 'F5: timers >= 1000 ms divided by 1000, so the gate\'s own 120000 ms deadline falls inside the probe\'s window. C8 (never-answering answerer) and C9 (never-settling adapter) must both release.',
  },
  {
    id: 'f7f8-budget-shapes',
    file: path.join(AUDIT_DIR, 'probe-budget-shapes.mjs'),
    kind: 'node',
    preloads: [SINK_URL],
    reportName: 'probe-budget-shapes.out.json',
    evaluate: evaluateBudgetShapes,
    note: 'F7 (G5: an oversized result keeps head AND tail) and F8 (G9: the trimmed decision does not carry both `value` and `content`).',
  },
  {
    id: 'f5f6-deadline',
    file: path.join(AUDIT_DIR, 'probe-gate-deadline.mjs'),
    kind: 'node',
    reportName: 'probe-gate-deadline.out.json',
    evaluate: evaluateDeadline,
    note: 'F5+F6 with controls: D1-D8 the deadline at a 200 ms bound, D9 the control at the mounted 120000 ms, D10 a late rejection, D11-D14 the throwing logger and the unprintable answers.',
  },
  {
    id: 'gate-suite',
    file: path.join(PKG_DIR, 'probes', 'compact-gate-probe.mjs'),
    kind: 'electron',
    reportName: 'compact-gate-report.json',
    evaluate: evaluateCompactGate,
    note: 'every pre-existing gate behaviour (35 checks), through the real host resolution bootstrap.',
  },
  {
    id: 'budget-suite',
    file: path.join(PKG_DIR, 'probes', 'budget-probe.mjs'),
    kind: 'electron',
    reportName: 'budget-report.json',
    evaluate: evaluateBudget,
    note: 'every pre-existing budget behaviour (29 checks) + the three artifacts land in the caller-named sink instead of the package.',
  },
  {
    id: 'handover-suite',
    file: path.join(PKG_DIR, 'probes', 'handover-grant-probe.mjs'),
    kind: 'node',
    reportName: 'handover-grant-report.json',
    evaluate: evaluateHandover,
    note: 'the reachable handover probe (12 checks): the F1 delivery repair must still deliver.',
  },
];

console.log(`node:    ${NODE_EXE}`);
console.log(`harness: ${HARNESS_EXE ?? '(not found)'}`);
console.log(`reports: fresh directory per row under ${os.tmpdir()}`);
console.log('');

for (const entry of plan) {
  const run_ = run(entry);
  let verdict;
  if (run_.error !== undefined) {
    verdict = { ok: false, detail: run_.error, reason: run_.error };
  } else {
    verdict = entry.evaluate(run_);
  }
  const row = {
    id: entry.id,
    file: path.relative(PKG_DIR, entry.file),
    ok: verdict.ok,
    detail: verdict.detail,
    note: entry.note,
    report: run_.reportPath,
    childExit: run_.status,
  };
  rows.push(row);
  if (!verdict.ok) problems.push(`${entry.id} (${row.file}): ${verdict.reason ?? verdict.detail}`);
  console.log(`${verdict.ok ? 'ok     ' : 'PROBLEM'} ${entry.id.padEnd(20)} ${row.detail}`);
  console.log(`        ${entry.note}`);
  console.log(`        report: ${run_.reportPath}${run_.status === undefined ? '' : ` (child exit ${run_.status})`}`);
  console.log('');
}

const verdict = problems.length === 0 ? 'ALL-VERIFIED' : 'HAS-PROBLEMS';
const summary = { verdict, problems, rows, node: NODE_EXE, harness: HARNESS_EXE, at: new Date().toISOString() };
try {
  fs.writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`report: ${OUT}`);
} catch (error) {
  console.error(`[verify] could not write its own report to ${OUT} (${error?.code ?? error?.message})`);
}
if (problems.length > 0) {
  console.log('problems:');
  for (const problem of problems) console.log(`- ${problem}`);
}
console.log(verdict);
process.exitCode = problems.length === 0 ? 0 : 1;
