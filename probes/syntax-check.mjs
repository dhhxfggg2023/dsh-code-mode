/**
 * Syntax gate for the files this session edited.
 *
 * Written as a file on purpose: `node --check` is a false witness for ESM (this
 * repo measured that it exits 0 on broken `.js` because it does not parse as a
 * module), and inline `node -e` with quotes is a recorded pit.
 *
 * `module.SourceTextModule` still parses the source without running it, which is
 * the check that was actually wanted. It exists only under
 * `--experimental-vm-modules`, so the flag is part of the verdict: without it this
 * probe reports **unavailable**, never 14 broken files (measured 2026-10-04 — the
 * README's own rule for the Electron probes, applied here: a check that cannot run
 * must say so instead of dressing a channel limit as a finding about the code).
 *
 * Run it as: `node --experimental-vm-modules probes/syntax-check.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'lib/compact-gate.js',
  // `ledger.js` is the largest module here and the one most edits land in, so a
  // parser that skipped it would miss exactly the file most likely to break.
  'lib/ledger.js',
  'lib/pit-guard.js',
  'lib/tool-record.js',
  'lib/tool-brief.js',
  'probes/compact-gate-probe.mjs',
  'probes/handover-grant-probe.mjs',
  'probes/journal-rotation-probe.mjs',
  'probes/write-rule-probe.mjs',
  'probes/brief-full-probe.mjs',
  'probes/promotion-probe.mjs',
  'probes/pit-liveness.mjs',
  'probes/debt-audit.mjs',
  'probes/utf8-check.mjs',
];

/** The machine-readable shape every probe offers, so a parent reads "could not run". */
function writeReport(passed, failed) {
  const out = process.env.DSH_PROBE_REPORT;
  if (typeof out !== 'string' || out.trim().length === 0) return;
  try {
    fs.writeFileSync(out, `${JSON.stringify({ passed, total: FILES.length, failed }, null, 2)}\n`, 'utf8');
  } catch {
    /* an unwritable report path must not change the verdict */
  }
}

const { SourceTextModule } = vm;
if (typeof SourceTextModule !== 'function') {
  console.error(
    'syntax-check: vm.SourceTextModule is unavailable, so no file was parsed — this is a\n' +
      'missing flag, not a broken file. Verdict: unavailable, never broken.\n' +
      'Run it as: node --experimental-vm-modules probes/syntax-check.mjs',
  );
  writeReport(0, ['unavailable: needs --experimental-vm-modules']);
  process.exitCode = 1;
} else {
  let bad = 0;
  for (const rel of FILES) {
    const full = path.join(PKG, rel);
    try {
      // eslint-disable-next-line no-new
      new SourceTextModule(fs.readFileSync(full, 'utf8'), { identifier: full });
      console.log(`parses  ${rel}`);
    } catch (error) {
      bad += 1;
      console.log(`BROKEN  ${rel} :: ${error.message}`);
    }
  }
  console.log(`\n${FILES.length - bad}/${FILES.length} parsed, broken=[${bad}]`);
  if (bad > 0) process.exitCode = 1;
}
