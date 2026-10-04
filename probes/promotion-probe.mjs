/**
 * Cross-project promotion: the reporting half of the `scope="global"` decision.
 *
 * Run: node probes/promotion-probe.mjs
 *
 * The design's own test for which ledger a fact belongs in is "would this bite you
 * again in a **different** project on this host". Nothing measured that until now:
 * `pit-liveness.mjs` could replay a trigger against recorded commands, but only inside
 * one project, so a rule that bit in three repositories looked exactly like one that bit
 * three times in one. `code-pit-guard` now journals every real hit with the `root` it
 * happened in, and `crossProjectTriggers` (in `lib/ledger.js`) reports the ones that
 * crossed a project boundary.
 *
 * This calls that function directly rather than spawning `pit-liveness.mjs`: a child
 * process with piped stdio is refused in a confined channel (`EPERM: spawn`, measured
 * 2026-10-03), and the report is not what needs testing — the scan is.
 *
 * The negative half matters as much as the positive one. A report that fired on "the
 * same rule was hit twice" would cry wolf on every repeat inside a single repository,
 * and a prompt ignored by habit is worse than no prompt.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { tempReport } from './paths.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** `debt-audit.mjs` runs this probe with `stdio:'ignore'`, so the report file is the
 *  only verdict that reaches it. `DSH_PROBE_REPORT` lets a parent redirect it. */
const OUT = process.env.DSH_PROBE_REPORT ?? tempReport('promotion-report.json');

const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);

const decisions = [];
const check = (id, name, ok, evidence) => decisions.push({ id, name, ok: ok === true, evidence });
const preview = (value, n = 300) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && text.length > n ? `${text.slice(0, n)}…` : text;
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-'));
const alpha = path.join(ROOT, 'alpha');
const beta = path.join(ROOT, 'beta');
const solo = path.join(ROOT, 'solo');

const SHARED = '## 2026-10-01 · the shell mangles a piped byte array';
const LOCAL = '## 2026-10-02 · this repo only';

/** One project with a `trigger_hit` journal; `roots` decides which projects it claims. */
const seed = (root, roots, headings) => {
  const dir = path.join(root, '.dsh-code');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mistakes.md'), '# Mistakes\n', 'utf8');
  const lines = [];
  for (const heading of headings) {
    for (const claimed of roots) {
      lines.push(
        JSON.stringify({
          ts: '2026-10-03T00:00:00.000Z',
          kind: 'trigger_hit',
          session: 's',
          root: claimed,
          heading,
          source: path.join(dir, 'mistakes.md'),
          cmd: 'Set-Content x.txt',
        }),
      );
    }
  }
  fs.appendFileSync(path.join(dir, 'journal.jsonl'), `${lines.join('\n')}\n`, 'utf8');
};

try {
  seed(alpha, [alpha, beta], [SHARED]);
  seed(beta, [beta], [SHARED, LOCAL]);
  seed(solo, [solo, solo], [SHARED]);

  const promotions = ledger.crossProjectTriggers([alpha, beta, solo]);
  const shared = promotions.find((rule) => rule.heading === SHARED);
  const local = promotions.find((rule) => rule.heading === LOCAL);

  check(
    'P1',
    'a rule that fired in two different projects is reported as a promotion candidate',
    shared !== undefined,
    { promotions: promotions.map((r) => `${r.heading} <- ${r.roots.length}`) },
  );
  check(
    'P2',
    'the candidate carries the distinct project roots, not a repeat count',
    shared !== undefined && shared.roots.length === 2 && shared.roots.includes(alpha) && shared.roots.includes(beta),
    { roots: shared?.roots },
  );
  check(
    'P3',
    'a rule whose hits are all from one project is NOT promoted — a repeat is not a second project',
    local === undefined,
    { leaked: local },
  );
  check(
    'P4',
    'repeats inside one project collapse to one root, so they cannot manufacture a candidate',
    shared !== undefined && !shared.roots.includes(solo),
    { roots: shared?.roots },
  );
  check(
    'P5',
    'sibling discovery finds ledgers next to this one and never returns the project itself',
    (() => {
      const found = ledger.siblingProjects(alpha);
      return found.includes(beta) && found.includes(solo) && !found.includes(alpha);
    })(),
    { found: ledger.siblingProjects(alpha).map((p) => path.basename(p)) },
  );
  check(
    'P6',
    'a project with no trigger hits contributes nothing (no hits is not one hit)',
    ledger.crossProjectTriggers([]).length === 0,
    { empty: ledger.crossProjectTriggers([]) },
  );
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
fs.writeFileSync(
  OUT,
  `${JSON.stringify({ failed: failed.map((d) => `${d.id} ${d.name}`), passed: decisions.filter((d) => d.ok).length, total: decisions.length }, null, 2)}\n`,
  'utf8',
);
if (failed.length > 0) process.exitCode = 1;
