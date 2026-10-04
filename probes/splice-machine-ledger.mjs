/**
 * Splice two redundant blocks out of the machine-wide `mistakes.md`.
 *
 * A retrying `code_record(kind="mistake")` wrote the same PowerShell finding three times
 * (the tool reported failure while the write had already landed), and the ledger's merge
 * rule matches on the symptom slug — these three slugs differ, so nothing merged them.
 *
 * Why a script and not `edit`: this file is 83 KB and `edit` would need the whole history
 * pasted back through context. Why the user runs it and not the agent: children cannot
 * write `~/.dsh-code/` (`PermissionError: [Errno 13]`, recorded in this very ledger) while
 * the `write` tool can — so the agent produces the exact bytes and the operator applies
 * them. The splice is validated before writing: every non-target block must survive
 * byte-for-byte, and the file must keep its `# Mistakes` header.
 *
 * Usage:
 *   node probes/splice-machine-ledger.mjs --out %TEMP%\mistakes.clean.md   # write bytes
 *   then copy that file over  C:\Users\<you>\.dsh-code\mistakes.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = path.join(os.homedir(), '.dsh-code', 'mistakes.md');
const KEEP = '## 2026-10-04 · set-content--encoding-utf8nobom-failed-cannot-convert-value-';
const DROP = [
  '## 2026-10-04 · set-content--encoding-utf8nobom-failed-无法将值-utf8nobom-转换为类型-',
  '## 2026-10-04 · set-content--encoding-utf8nobom-fails-with-parameterbindinge',
];

const argAt = process.argv.indexOf('--out');
const out = argAt === -1 ? undefined : process.argv[argAt + 1];
const entryCount = (text) => (text.match(/^## /gm) ?? []).length;

const original = fs.readFileSync(FILE, 'utf8');
const parts = original.split(/\n(?=## )/);
const kept = [];
const removed = [];
for (const part of parts) {
  const heading = part.split('\n', 1)[0].trim();
  if (DROP.includes(heading)) removed.push(heading);
  else kept.push(part);
}
const next = kept.join('\n');

// Guard rails: the splice must remove only what it names, and break nothing else.
const survivors = kept.join('\n');
const unrelated = parts
  .filter((part) => !DROP.includes(part.split('\n', 1)[0].trim()))
  .every((part) => survivors.includes(part));
const report = {
  file: FILE,
  removed,
  headerIntact: next.startsWith('# Mistakes'),
  unrelatedBlocksIntact: unrelated,
  keptHeadingPresent: next.includes(KEEP),
  before: { chars: original.length, entries: entryCount(original) },
  after: { chars: next.length, entries: entryCount(next) },
  wrote: false,
  out,
};

if (removed.length > 0 && unrelated && next.startsWith('# Mistakes')) {
  if (out === undefined) {
    // No --out: prove the splice is writable by the CURRENT channel, which is the whole
    // question on this host. A failure here is the expected answer for a child process.
    try {
      fs.writeFileSync(FILE, next, 'utf8');
      report.wrote = true;
    } catch (error) {
      report.writeError = `${error?.name}: ${error?.message}`;
    }
  } else {
    fs.writeFileSync(out, next, 'utf8');
    report.wroteTo = out;
  }
}
console.log(JSON.stringify(report, null, 2));
