/**
 * Strict UTF-8 check for the files this session edited.
 *
 * A lossy re-encode does not break anything visibly: an em dash becomes `?` and a
 * character becomes U+FFFD, and node runs the file anyway. `debt-audit`'s E1 covers
 * the whole shipped tree, but it cannot run here (it spawns Electron probes), so
 * this is the reachable half of the same check for the files just touched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  '.gitignore',
  'HANDOVER.md',
  'TESTING.md',
  'lib/recite.js',
  'lib/ledger.js',
  'lib/pit-guard.js',
  'lib/tool-brief.js',
  'lib/tool-record.js',
  'probes/README.md',
  'probes/debt-audit.mjs',
  'probes/journal-rotation-probe.mjs',
  'probes/write-rule-probe.mjs',
  'probes/brief-full-probe.mjs',
  'probes/promotion-probe.mjs',
  'probes/syntax-check.mjs',
  'probes/utf8-check.mjs',
];

let invalid = 0;
let missing = 0;
for (const rel of FILES) {
  const full = path.join(PKG, rel);
  // A listed file that no longer exists is reported, not fatal: a scratch file removed
  // by hand is the expected end of one, and crashing the check on it would make the
  // list itself feel riskier to edit than to leave stale.
  if (!fs.existsSync(full)) {
    missing += 1;
    console.log(`missing  ${rel} (not on disk; drop it from FILES)`);
    continue;
  }
  const bytes = fs.readFileSync(full);
  const text = bytes.toString('utf8');
  const lossy = text.includes('\uFFFD') || !Buffer.from(text, 'utf8').equals(bytes);
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (lossy || bom) {
    invalid += 1;
    console.log(`INVALID ${rel} :: ${lossy ? 'not strict UTF-8' : 'BOM present'}`);
  } else {
    console.log(`utf8-ok ${rel} (${bytes.length} bytes)`);
  }
}
const checked = FILES.length - missing;
console.log(`\n${checked - invalid}/${checked} valid strict UTF-8 (no BOM), invalid=[${invalid}]${missing === 0 ? '' : `, missing=${missing}`}`);
if (invalid > 0) process.exitCode = 1;
