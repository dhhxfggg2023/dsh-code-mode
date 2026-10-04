/**
 * Read-only diagnostic: what does `restartPending()` actually see on the real project?
 *
 * Motivation (2026-10-04): the project journal, live file plus its rotated segment, holds
 * **zero** `"kind":"restart_pending"` events while holding 16 `"kind":"trigger_hit"`. The
 * mode's restart notice (`lib/ledger.js:904-939`) is built entirely from that event, and
 * `lib/pit-guard.js:326-333` is the only writer of it. So either the writer never fires, or
 * `restartPending()` is finding something the event count does not show.
 *
 * This does not write anything and does not call `code_brief`, because `code_brief` appends
 * a `session_start` — which would settle the very state being inspected.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ledger = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'ledger.js')).href);

const cwd = PKG_DIR;
const pending = ledger.restartPending(cwd);
console.log(
  JSON.stringify(
    {
      cwd,
      ledgerDir: ledger.ledgerDir(cwd),
      restartPending: pending ?? null,
      // The comparison the writer performs, reproduced: does an edit to this package's
      // own lib file satisfy it?
      writerCheck: {
        targetNormalised: path.join(cwd, 'lib', 'ledger.js').replace(/\\/g, '/').toLowerCase(),
        comparedAgainst: `${cwd}${path.sep}`,
        matches: path.join(cwd, 'lib', 'ledger.js').replace(/\\/g, '/').toLowerCase().startsWith(`${cwd}${path.sep}`),
      },
    },
    null,
    2,
  ),
);
