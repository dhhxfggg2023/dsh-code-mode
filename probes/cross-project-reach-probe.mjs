/**
 * cross-project-reach-probe — is the "no promotion candidates" verdict a tested distinction?
 *
 * What this closes (task item 3, from the 2026-10-05 restart gate): `crossProjectTriggers`
 * keeps a rule only when its hits span **two or more** projects. The audit concluded that
 * condition was structurally unsatisfiable here — one ledged project, `~/.dsh/projects`
 * missing — and `pit-liveness` was changed to print **UNREACHABLE, not empty** so the report
 * would stop reading like a negative result.
 *
 * Two things were still wrong, and this file found the second one:
 *
 *   1. On this machine the *reachable* branch had never executed. "The verdict distinguishes
 *      the two cases" was a claim about code nobody had run — the same defect shape as the
 *      compaction gate's fabricated 100,000-token window. This probe drives both branches.
 *   2. **The UNREACHABLE verdict was false.** Running it printed four promotion candidates
 *      whose two "projects" were `E:\projects\dsh-code-mode` and `E:/projects\dsh-code-mode`:
 *      one directory, two spellings. `crossProjectTriggers` does `roots.add(entry.root)` on the
 *      raw string (`lib/ledger.js:1242`), and a set cannot see that its members are one project.
 *      So the condition is not unsatisfiable — it is satisfied *spuriously*, which is worse,
 *      because a phantom becomes a recommendation.
 *
 * Checks, with the control in each direction:
 *   R1 the scan runs and reports structured reachability at all.
 *   R2 the fold is what separates a phantom from a real promotion: the raw scan reports
 *      phantoms, no promotion in the folded list rests on a single distinct root, and folding
 *      never invents a root (`distinctRoots <= rootsScanned`).
 *   R3 the raw scan does report phantoms — if this ever becomes 0, the fold is either working
 *      in the library or the journal stopped disagreeing with itself; either way R2/R4's premise
 *      must be re-derived rather than assumed.
 *   R4 no promotion survives folding on a single root, and every promotion names ≥2 — the two
 *      directions of the same invariant.
 *   R5 control, other direction: with a second ledged root actually scanned, `reachable` is
 *      true and the verdict is no longer UNREACHABLE.
 *
 * **Re-derived 2026-10-16, and why.** R2/R4 used to assert the machine's *population* —
 * `reachable: false` with exactly one distinct root, and therefore an empty promotion list.
 * That premise was true when this was written (2026-10-06: one ledged project) and is not any
 * more: `siblingProjects` also scans `projectStoreDir()`, and the 2026-10-10 migration left
 * real siblings there, so the same run now reports **7** distinct roots and 43 promotions. The
 * fold itself did not change — `phantomPromotions` is still 4, so it has not moved into
 * `crossProjectTriggers`. What was stale was the assertion, not the behaviour, and the checks
 * now measure the fold (which is what this probe is for) instead of the machine's inventory.
 * `R5` is the control that keeps the "reachable" branch exercised either way.
 *
 * Run: `node probes/cross-project-reach-probe.mjs`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = path.join(repo, 'probes', 'pit-liveness.mjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-probe-'));
const fixture = path.join(root, 'a-second-ledged-project');
fs.mkdirSync(path.join(fixture, '.dsh-code'), { recursive: true });
// A ledger file is what makes a directory count as "ledged" for the promotion scan.
fs.writeFileSync(
  path.join(fixture, '.dsh-code', 'mistakes.md'),
  '## 2026-01-01 · fixture pit for the reach probe\n- trigger: probe-fixture-never-matches\n- do not repeat: nothing; this fixture exists only to give the scan a second ledged root\n',
  'utf8',
);

/**
 * A fixture that carries **both** cases in its own journal, so the fold can be measured without
 * the developer's real ledger being the premise.
 *
 * `R2`/`R3`/`R4` used to read the phantom count off the scan of *this repository*, which made
 * them a statement about whatever the local journal happened to contain: measured 2026-10-16,
 * `node probes/debt-audit.mjs` redirects `DSH_CODE_GLOBAL_DIR` to a scratch dir, the real
 * siblings disappeared from `siblingProjects()`, the phantom count went to 0 and both checks
 * went red — in the audit's channel only. A check is only a check if it is hermetic against the
 * machine it happens to run on (the rule this repository wrote down after `guard-probe`'s
 * redirect landed inside the block it was testing). So the fixture supplies the evidence:
 *
 *   - `PHANTOM-RULE` is hit in `E:/x/one` and `E:\x\one` — one directory, two spellings, which
 *     the raw scan calls cross-project and the fold must collapse to a single root.
 *   - `REAL-RULE` is hit in `E:/x/one` and `E:/x/two` — two genuinely distinct roots, which must
 *     survive the fold as a promotion.
 *
 * Both land in one journal, so a single `--roots <fixture>` run exercises the fold in both
 * directions at once, on any machine.
 */
const phantomDir = path.join(root, 'phantom-and-real');
fs.mkdirSync(path.join(phantomDir, '.dsh-code'), { recursive: true });
fs.writeFileSync(
  path.join(phantomDir, '.dsh-code', 'mistakes.md'),
  '## 2026-01-01 · phantom-and-real fixture\n- trigger: probe-fixture-never-matches\n- do not repeat: nothing; this fixture only supplies trigger_hit records\n',
  'utf8',
);
const hits = [
  { heading: 'PHANTOM-RULE', root: 'E:/x/one' },
  { heading: 'PHANTOM-RULE', root: 'E:\\x\\one' },
  { heading: 'REAL-RULE', root: 'E:/x/one' },
  { heading: 'REAL-RULE', root: 'E:/x/two' },
];
fs.writeFileSync(
  path.join(phantomDir, '.dsh-code', 'journal.jsonl'),
  `${hits
    .map((hit, index) =>
      JSON.stringify({
        ts: `2026-01-01T00:00:0${index}.000Z`,
        session: 'sess-reach-fixture',
        kind: 'trigger_hit',
        heading: hit.heading,
        source: 'fixture',
        root: hit.root,
        cmd: 'probe-fixture-never-matches',
      }),
    )
    .join('\n')}\n`,
  'utf8',
);

/**
 * Run pit-liveness and read its `--json` report back **through a file the probe writes**.
 *
 * `--json` rather than the prose because the verdict is then a field, not a paragraph to be
 * pattern-matched. `--report` rather than capturing the child's stdout because capturing it
 * failed three ways on this host (2026-10-06): `spawnSync` with `stdio: 'pipe'` returned
 * immediately with nothing, and `cmd /c "… > file"` produced a 0-byte file — the confined
 * channel does not give a child a pipe worth reading. A probe that writes its own report
 * removes the capture from the design instead of working around it. The child's own stdio is
 * `ignore`, so nothing is piped at all.
 */
function runReport(extraRoots) {
  const log = path.join(root, `report-${extraRoots === undefined ? 'base' : 'extra'}.json`);
  const args = [probe, '--json', '--report', log];
  if (extraRoots !== undefined) args.push('--roots', extraRoots);
  const result = spawnSync(process.execPath, args, { cwd: repo, stdio: 'ignore', timeout: 180000 });
  const raw = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  return { status: result.status, raw, parsed };
}

const base = runReport(undefined);
const extra = runReport(fixture);
const foldRun = runReport(phantomDir);

const reach = (result) => result.parsed?.crossProjectReach;
const checks = [
  {
    id: 'R1',
    what: 'the scan runs and reports structured reachability',
    pass: reach(base) !== undefined,
    evidence: reach(base) === undefined ? `no JSON — raw head: ${base.raw.slice(0, 200).replace(/\s+/g, ' ')}` : `rootsScanned=${reach(base).rootsScanned} distinct=${reach(base).distinctRoots} reachable=${reach(base).reachable}`,
  },
  {
    id: 'R2',
    what: 'the fold collapses one directory spelled twice, and leaves two genuinely distinct roots standing',
    pass:
      (foldRun.parsed?.promotions ?? []).some((rule) => rule.heading === 'REAL-RULE') &&
      !(foldRun.parsed?.promotions ?? []).some((rule) => rule.heading === 'PHANTOM-RULE'),
    evidence: `REAL-RULE kept=${(foldRun.parsed?.promotions ?? []).some((rule) => rule.heading === 'REAL-RULE')} PHANTOM-RULE kept=${(foldRun.parsed?.promotions ?? []).some((rule) => rule.heading === 'PHANTOM-RULE')} phantomPromotions=${reach(foldRun)?.phantomPromotions}`,
  },
  {
    id: 'R3',
    what: 'the raw scan does report the phantom (same dir, two spellings) — the premise of the fold',
    pass: (reach(foldRun)?.phantomPromotions ?? 0) === (reach(base)?.phantomPromotions ?? 0) + 1,
    evidence: `phantomPromotions base=${reach(base)?.phantomPromotions} with-fixture=${reach(foldRun)?.phantomPromotions} (the fixture must add exactly one)`,
  },
  {
    id: 'R4',
    what: 'folding never invents a root and never leaves a single-root promotion standing, on this machine too',
    pass:
      (reach(base)?.distinctRoots ?? 0) <= (reach(base)?.rootsScanned ?? 0) &&
      (base.parsed?.promotions ?? []).every((rule) => (rule.roots ?? []).length > 1) &&
      (base.parsed?.promotions?.length ?? -1) ===
        (base.parsed?.promotions ?? []).filter((rule) => (rule.roots ?? []).length > 1).length,
    evidence: `promotions=${base.parsed?.promotions?.length} distinctRoots=${reach(base)?.distinctRoots} rootsScanned=${reach(base)?.rootsScanned} singleRootPromotions=${(base.parsed?.promotions ?? []).filter((rule) => (rule.roots ?? []).length <= 1).length}`,
  },
  {
    id: 'R5',
    what: 'control: with a second ledged root scanned the verdict is NOT unreachable',
    pass: reach(extra)?.reachable === true && reach(extra)?.distinctRoots >= 2,
    evidence: `reachable=${reach(extra)?.reachable} distinctRoots=${reach(extra)?.distinctRoots} roots=${(reach(extra)?.roots ?? []).length}`,
  },
];

const failed = checks.filter((check) => !check.pass);
console.log('# cross-project-reach-probe');
console.log(`project : ${repo}`);
console.log(`fixture : ${fixture}`);
for (const check of checks) {
  console.log(`${check.pass ? 'ok  ' : 'FAIL'} ${check.id} — ${check.what}`);
  console.log(`       ${String(check.evidence).replace(/\s+/g, ' ').slice(0, 240)}`);
}
console.log('');
console.log(`${checks.length - failed.length}/${checks.length} passed${failed.length === 0 ? '' : `, failed=[${failed.map((check) => check.id).join(', ')}]`}`);
console.log('');
console.log('note: the phantom count reaching 0 means the fold moved into `crossProjectTriggers`');
console.log('itself (lib/ledger.js:1242) — then R3/R4 must be re-derived, not deleted.');

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  /* a scratch directory that will not delete is not a failed check */
}

/**
 * The report file `debt-audit` requires of every probe in its `RUNNABLE` list.
 *
 * The audit spawns such a probe with **no arguments** and reads
 * `<os.tmpdir()>/<basename>-report.json` — a probe that exits 0 without writing one is
 * recorded as `reported: false`, which the audit calls a failure ("a probe that exits 0
 * without writing a report proves nothing"). `pit-report.mjs` set the precedent that the
 * argument-less invocation writes the report, and this file follows it. It is written
 * unconditionally rather than only when called by the audit, because a caller that cannot
 * capture stdout needs it anyway — that is how this probe was verified on 2026-10-06.
 */
const reportPath = path.join(os.tmpdir(), 'cross-project-reach-report.json');
try {
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify({ passed: checks.length - failed.length, total: checks.length, failed: failed.map((check) => `${check.id} ${check.what}`), checks }, null, 2)}\n`,
    'utf8',
  );
} catch (error) {
  // A report that cannot be written must fail loudly: the audit would otherwise read a stale
  // one and count it. Same rule as `pit-liveness --report`.
  console.error(`could not write ${reportPath}: ${error.message}`);
  process.exitCode = 1;
}
process.exitCode = failed.length === 0 ? (process.exitCode ?? 0) : 1;
