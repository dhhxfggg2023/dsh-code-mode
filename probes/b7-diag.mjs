/**
 * B7 diagnostic, driven from a REAL machine ledger snapshot.
 *
 * The earlier attempt at this diagnostic built a small machine ledger (3 facts), which is
 * not the state guard-probe's B7 runs in — that one carries `sandbox` from B6 plus the four
 * `fat1..4` facts, and the difference changes how much room is left for facts. So this
 * takes the actual `project.json`/`mistakes.md` from the machine dir guard-probe used and
 * asks `globalExcerpt` for the same allowance the briefing gives it.
 *
 * Usage: node probes/b7-diag.mjs [machineDir]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] ?? 'C:\\Users\\dhhxfggg\\AppData\\Local\\Temp\\dsh-bkY1Sb\\dsh-guard-global-machine-gKHu3b';

// A fresh machine dir seeded from the snapshot. The `fat1..4` facts are STRIPPED unless
// `--with-fat` is passed: guard-probe writes them *after* B7, so the snapshot taken from a
// finished run contains facts that B7 never saw, and measuring the snapshot as-is measures
// the wrong state (that is what made this diagnostic mislead the first time).
const machine = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-b7diag-'));
const withFat = process.argv.includes('--with-fat');
const project = JSON.parse(fs.readFileSync(path.join(source, 'project.json'), 'utf8'));
for (const key of Object.keys(project)) if (!withFat && /^fat\d+$/.test(key)) delete project[key];
const fatKeys = Object.keys(project).filter((key) => /^fat\d+$/.test(key));
fs.writeFileSync(path.join(machine, 'project.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
for (const name of ['mistakes.md', 'journal.jsonl']) {
  const from = path.join(source, name);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(machine, name));
}
process.env.DSH_CODE_GLOBAL_DIR = machine;
const ledger = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'ledger.js')).href);

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-b7diag-proj-'));
ledger.initLedger(projectRoot, 'b7-other');

const recency = ledger.factRecency(ledger.SCOPE.global);
const excerpt = ledger.globalExcerpt(1100, undefined, recency);
const pitBlockOnly = ledger.globalExcerpt(1100, undefined, new Map());
const brief = ledger.brief(projectRoot, { session: 'b7-other', maxChars: 8000 });

console.log(
  JSON.stringify(
    {
      withFat,
      factKeys: Object.keys(project).filter((k) => !['version', 'createdAt', 'updatedAt', 'commands', 'notes'].includes(k)),
      fatKeysStillPresent: fatKeys,
      recencyEntries: recency.size,
      excerptChars: excerpt?.length,
      excerptHasLongFact: String(excerpt ?? '').includes('b7_long_recent'),
      excerptHasNamed: /-\s*b7_\w+ \(\d+ chars\)/.test(String(excerpt ?? '')),
      excerpt,
    },
    null,
    2,
  ),
);
console.log(`\n--- briefing: heading=${brief.text.includes('## Machine-wide facts')} omitted=${JSON.stringify(brief.omitted)} chars=${brief.text.length}`);
