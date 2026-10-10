/**
 * One concurrent ledger writer, for the lock probe.
 *
 * Two sessions can share a project — a second window, a resumed session, a
 * subagent — and every ledger write appends to a file whose whole value is its
 * line structure, so a lost append is silent. `guard-probe.mjs` starts this file
 * several times at once to prove that appends under contention all land.
 *
 * `lib/ledger.js` imports only Node builtins, so a plain `node` child loads it
 * with no host bootstrap — which is what makes a real multi-process race possible
 * here. (A worker thread would not do: threads and spawned children both get
 * fresh module resolution, and the *probe's* own bootstrap needs the Electron
 * binary, so the helpers must stay on the builtin-only path.) The machine ledger
 * it writes through is wherever `globalDir()` resolves — `~/.dsh/code` since
 * 2026-10-10, not the retired `~/.dsh-code` this comment used to name.
 *
 * The file is imported as a module by the probe, so the work runs only when
 * `runOnce` is called or the file is invoked as an entry point.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Append `count` mistakes and `count` journal rows to the ledger at `root`. */
export async function runOnce(root, count, tag = 'writer') {
  const ledger = await import('./../lib/ledger.js');
  // The ledger never assumes its directory exists: creating it is the first
  // write's job, and four writers racing to create it must not be an error.
  ledger.initLedger(root, tag);
  for (let i = 0; i < count; i += 1) {
    ledger.recordMistake(
      root,
      { symptom: `${tag}-${i}`, cause: 'concurrent-writer fixture', fix: 'none', files: `probes/${tag}.mjs` },
      tag,
    );
    ledger.recordUnverified(root, { edits: [`edit ${tag}-${i}.js`], turn: i }, tag);
  }
  return count;
}

/** True when this file is an entry point rather than an imported module. */
function isMain() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const [root, rawCount, tag, outFile] = process.argv.slice(2);
  const count = Number.parseInt(rawCount ?? '0', 10);
  /** Where to leave the verdict, for a channel that refuses to give the parent a pipe. */
  const report = (value) => {
    if (typeof outFile !== 'string' || outFile.length === 0) return;
    try {
      fs.writeFileSync(outFile, JSON.stringify(value), 'utf8');
    } catch {
      /* the parent reports a missing file as its own failure */
    }
  };
  if (typeof root !== 'string' || !Number.isFinite(count) || count <= 0) {
    console.error('usage: ledger-writer.mjs <ledger-root> <count> [tag] [out.json]');
    report({ tag: tag ?? 'writer', status: 'usage' });
    process.exitCode = 2;
  } else {
    /**
     * The report file, not stdout, is the channel that works everywhere.
     *
     * Measured 2026-10-03: this session's sandbox refuses `spawn` with any piped stdio
     * (`EPERM`), so the four-writer race could not run at all and reported itself as
     * skipped in *every* channel available here — the check existed and never executed.
     * A child that writes a file and exits works under the same confinement, which is
     * already how `debt-audit.mjs` reads `guard-report.json` back from its child.
     */
    try {
      await runOnce(root, count, tag ?? 'writer');
      report({ tag: tag ?? 'writer', count, status: 'ok' });
    } catch (error) {
      report({ tag: tag ?? 'writer', status: 'error', message: String(error?.message ?? error) });
      process.exitCode = 1;
    }
  }
}
