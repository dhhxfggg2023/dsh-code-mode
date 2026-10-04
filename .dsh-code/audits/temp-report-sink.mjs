/**
 * A report sink for audit probes whose report path is hard-coded next to themselves.
 *
 * Why it exists. `.dsh-code/audits/probe-compact-open.mjs` and
 * `probe-budget-shapes.mjs` write their verdict to
 * `.dsh-code/audits/<probe>.out.json` — a workspace sub-directory, which the
 * `code_verify` channel cannot write (measured in this repo; see `probes/README.md`
 * and the ledger pit about writing into an existing sub-directory). A probe whose
 * verdict only exists in a path the caller cannot read is a verdict nobody has, and
 * editing the audit's own probes is not this task's business, so the caller redirects
 * the write instead:
 *
 *     node --import ./.dsh-code/audits/temp-report-sink.mjs <probe>.mjs
 *
 * with `DSH_TEMP_REPORT_DIR` naming a fresh directory under `$env:TEMP`. Every write
 * whose destination is exactly this directory is sent to that directory under the
 * same basename (and the redirection is named on stderr). Anything else — including
 * any write this hook cannot understand — is passed through to the real
 * `fs.writeFileSync`, because a sink that can break the probe it is measuring is
 * worse than no sink: the caller proves the redirect happened by finding the report
 * in a directory that did not exist before the run.
 *
 * Inert without `DSH_TEMP_REPORT_DIR`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AUDIT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SINK = process.env.DSH_TEMP_REPORT_DIR;

if (typeof SINK === 'string' && SINK.length > 0) {
  const realWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function writeFileSync(file, ...rest) {
    try {
      const target = path.resolve(String(file));
      if (path.dirname(target) === AUDIT_DIR) {
        const redirected = path.join(SINK, path.basename(target));
        realWriteFileSync.call(fs, redirected, ...rest);
        process.stderr.write(`[report-sink] ${path.basename(target)} -> ${redirected}\n`);
        return undefined;
      }
    } catch {
      /* an argument this hook cannot read is the real call's business, not ours */
    }
    return realWriteFileSync.call(fs, file, ...rest);
  };
}
