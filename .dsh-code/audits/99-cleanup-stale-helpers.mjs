/**
 * Removes the three helper scripts my probes USED to write next to themselves.
 *
 * The probes now create their helper in `os.tmpdir()` (see the global pit recorded
 * 2026-10-04: a `code_verify` command cannot create a file inside an existing
 * workspace subdirectory), so these three are dead weight left by the first version
 * of probes 09/10/11. Written as a file rather than inline because `node -e '…'`
 * loses its quotes to PowerShell — the recorded pit I hit while trying to do this
 * inline.
 *
 *   <node> .dsh-code\audits\99-cleanup-stale-helpers.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const stale = ['09b-race-child.mjs', '10b-race-bigfile-child.mjs', '11b-holder.mjs'];

for (const name of stale) {
  const target = path.resolve(HERE, name);
  // Refuse anything that is not exactly <audits>/<name>: the deletion below must be
  // provably aimed at the three files this script names.
  if (path.dirname(target) !== HERE || path.basename(target) !== name) {
    console.log(`SKIP (path check failed): ${target}`);
    continue;
  }
  if (!fs.existsSync(target)) {
    console.log(`absent already: ${name}`);
    continue;
  }
  try {
    fs.rmSync(target, { force: true });
    console.log(`removed: ${name} (${fs.existsSync(target) ? 'STILL THERE' : 'gone'})`);
  } catch (error) {
    console.log(`FAILED: ${name} -> ${error.code}`);
  }
}
