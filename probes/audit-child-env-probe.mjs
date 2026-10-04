/**
 * Guard for how `debt-audit` reads its children's verdicts (2026-10-04).
 *
 * Found by accident: a caller set `DSH_PROBE_REPORT` — which is exactly what `code_verify`
 * and every wrapper do — and the audit came back 19/23 with R5–R8 red, naming five probes
 * that had all passed. This audit is what the project trusts to say whether its documents
 * still match its code, so a wrong verdict from it costs more than a missing one. Two
 * mechanisms were measured, and both are pinned below:
 *
 *   C2  the children inherited the caller's `DSH_PROBE_REPORT`, which for the five probes
 *       that honour it is where they write — and that same path is the audit's OWN verdict
 *       sink. So they wrote their reports to the audit's sink and their default paths
 *       stayed empty. `guard-probe` is the exception: it hard-codes
 *       `tempReport('guard-report.json')` and ignores the variable.
 *   C1  a fix that pointed the audit's *read* at a private directory per run broke it
 *       outright (five passing probes read as `reported=false`), because two report
 *       conventions exist and the audit cannot unify them from outside. The read must use
 *       each probe's own default name, and the caller's variable must be stripped from the
 *       children instead.
 *
 * The audit is spawned rather than imported, because its behaviour under a caller-set
 * report sink is the subject. Everything is created under one scratch directory and
 * removed after, so `os.tmpdir()` is left as found.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBES = path.join(PKG_DIR, 'probes');
const AUDIT = path.join(PROBES, 'debt-audit.mjs');
const REPORT = process.env.DSH_PROBE_REPORT ?? path.join(os.tmpdir(), 'audit-child-env-report.json');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-child-env-'));

const results = [];
const check = (id, name, ok, evidence) => results.push({ id, name, ok: ok === true, evidence });

/** Run the audit the way a caller with a report sink does, and read its verdict. */
function runAudit(tag) {
  const verdictFile = path.join(scratch, `${tag}.json`);
  const started = Date.now();
  const run = spawnSync(process.execPath, [AUDIT], {
    cwd: PKG_DIR,
    stdio: 'ignore',
    timeout: 240000,
    env: {
      ...process.env,
      DSH_CODE_GLOBAL_DIR: path.join(scratch, `${tag}-global`),
      DSH_PROBE_REPORT: verdictFile,
    },
  });
  let verdict;
  try {
    verdict = JSON.parse(fs.readFileSync(verdictFile, 'utf8'));
  } catch {
    verdict = undefined;
  }
  const runs = verdict?.checks?.find((row) => row.id === 'R5')?.evidence?.runs ?? [];
  return {
    tag,
    exit: run.status,
    ms: Date.now() - started,
    passed: verdict?.passed,
    total: verdict?.total,
    failed: verdict?.failed ?? [],
    childrenChecked: runs.length,
    unreported: runs.filter((row) => row.reported !== true).map((row) => row.file),
  };
}

// --- C2: the mechanism, reproduced rather than described ----------------------------
// With `DSH_PROBE_REPORT` set, a probe that honours it writes to THAT path and its own
// default path stays empty. This is what the audit must not do to its children.
{
  const child = path.join(PROBES, 'promotion-probe.mjs');
  const leaked = path.join(scratch, 'leaked-verdict.json');
  const defaultPath = path.join(os.tmpdir(), 'promotion-report.json');
  try {
    fs.rmSync(defaultPath, { force: true });
  } catch {
    /* absent is the case under test */
  }
  spawnSync(process.execPath, [child], {
    cwd: PROBES,
    stdio: 'ignore',
    timeout: 60000,
    env: { ...process.env, DSH_PROBE_REPORT: leaked },
  });
  const wroteToSink = fs.existsSync(leaked);
  const defaultUntouched = !fs.existsSync(defaultPath);
  check(
    'C2',
    'with DSH_PROBE_REPORT set, a plain-node probe writes to that path and its own default stays empty (the leak the audit must strip)',
    wroteToSink && defaultUntouched,
    { wroteToSink, defaultUntouched, defaultPath },
  );
}

// --- C1: with the sink set, both audits must still see every child -----------------
const first = runAudit('c1-first');
const second = runAudit('c1-second');
const green = (row) =>
  row.exit === 0 && row.passed === row.total && row.childrenChecked >= 9 && row.unreported.length === 0;
check(
  'C1',
  'with DSH_PROBE_REPORT set, two consecutive audits both report all nine children and agree on the full count',
  green(first) && green(second),
  { first, second },
);

// --- C3: the hard-coded child is the trap a "tidy" read path falls into -------------
check(
  'C3',
  "guard-probe's report is found even under a caller-set sink (it ignores DSH_PROBE_REPORT, so the audit must read its own default name)",
  first.unreported.includes('guard-probe.mjs') === false &&
    second.unreported.includes('guard-probe.mjs') === false &&
    first.childrenChecked >= 9,
  { firstUnreported: first.unreported, firstChildrenChecked: first.childrenChecked },
);

// --- C4: the audit's own verdict is what the caller's path holds --------------------
check(
  'C4',
  "the caller's path holds the audit's own verdict (a child cannot overwrite it)",
  first.passed !== undefined && second.passed !== undefined && first.total === second.total && second.failed.length === 0,
  { firstPassed: first.passed, firstTotal: first.total, secondPassed: second.passed, secondTotal: second.total, secondFailed: second.failed },
);

fs.rmSync(scratch, { recursive: true, force: true });

const failed = results.filter((row) => !row.ok);
fs.writeFileSync(REPORT, `${JSON.stringify({ results, failed: failed.map((row) => row.id) }, null, 2)}\n`, 'utf8');
for (const row of results) {
  console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.id} ${row.name}`);
  if (!row.ok) console.log(`     ${JSON.stringify(row.evidence).slice(0, 600)}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed, failed=[${failed.map((row) => row.id).join(', ')}]`);
console.log(`report: ${REPORT}`);
process.exit(failed.length === 0 ? 0 : 1);
