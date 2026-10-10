/**
 * journal-shape — what is actually in a `journal.jsonl`.
 *
 * Written 2026-10-06 because a PowerShell read of `~/.dsh-code/journal.jsonl` reported
 * 99 lines of which **72 did not parse as JSON**, and the read path in `lib/ledger.js`
 * filters out exactly those lines (`catch { return null }` then `.filter(Boolean)`).
 * So the question this answers is not "is the file broken" but "**what is the read side
 * silently dropping**". A journal that is half unreadable looks identical to a journal
 * that is simply smaller.
 *
 * It is a reader: it never writes. Argument 1 is the journal path (default: this
 * project's). `--head` also prints the first 300 characters of each unparsable line, so
 * the shape of the loss can be named instead of assumed.
 *
 * Run: `node probes/journal-shape.mjs [path] [--head]`
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const showHead = args.includes('--head');
// The default target is this project's *resolved* journal: `<repo>/.dsh-code/journal.jsonl`
// stopped existing when the ledger moved into the machine's store, so this diagnostic reported
// "no journal at …" about a repository whose journal was a few directories away.
const target =
  args.find((arg) => !arg.startsWith('--')) ??
  (await import('../lib/ledger.js')).ledgerPath(path.resolve(here, '..'), 'journal');
const resolved = target.startsWith('~') ? path.join(os.homedir(), target.slice(1)) : target;

if (!fs.existsSync(resolved)) {
  console.log(`no journal at ${resolved}`);
  process.exit(0);
}

const raw = fs.readFileSync(resolved, 'utf8');
const lines = raw.split('\n');
const trailing = lines.pop(); // last element after the final \n
const out = [];
out.push(`# journal-shape — ${resolved}`);
out.push(`bytes: ${raw.length} · lines: ${lines.length}${trailing === '' ? ' (+ trailing newline)' : ` · unterminated tail: ${JSON.stringify(trailing.slice(0, 80))}`}`);
out.push(`byte order marks: utf8=${raw.charCodeAt(0) === 0xfeff} first bytes=${JSON.stringify(raw.slice(0, 3))}`);

const good = [];
const bad = [];
lines.forEach((line, index) => {
  if (line.trim().length === 0) return;
  try {
    good.push({ index, value: JSON.parse(line) });
  } catch (error) {
    bad.push({ index, line, error: String(error.message) });
  }
});

out.push('');
out.push(`## parseable: ${good.length} · unparsable: ${bad.length} · blank: ${lines.filter((l) => l.trim() === '').length}`);
const kinds = new Map();
for (const { value } of good) kinds.set(value.kind ?? '(no kind field)', (kinds.get(value.kind ?? '(no kind field)') ?? 0) + 1);
out.push('kinds among parseable lines:');
for (const [kind, count] of [...kinds].sort((a, b) => b[1] - a[1])) out.push(`  ${String(count).padStart(5)}  ${kind}`);

if (bad.length > 0) {
  out.push('');
  out.push('## unparsable lines — first index, last index, and the error each reports');
  out.push(`- indices: ${bad[0].index} … ${bad[bad.length - 1].index}`);
  const byError = new Map();
  for (const item of bad) byError.set(item.error, (byError.get(item.error) ?? 0) + 1);
  for (const [error, count] of byError) out.push(`  ${String(count).padStart(5)}  ${error}`);
  // A JSONL writer that dies mid-line leaves one long line; a plain-text writer leaves many.
  const lengths = bad.map((item) => item.line.length);
  out.push(`- line lengths: min ${Math.min(...lengths)} · max ${Math.max(...lengths)} · total ${lengths.reduce((a, b) => a + b, 0)}`);
  const startsWith = new Map();
  for (const item of bad) startsWith.set(item.line.slice(0, 1), (startsWith.get(item.line.slice(0, 1)) ?? 0) + 1);
  out.push(`- first characters: ${[...startsWith].map(([c, n]) => `${JSON.stringify(c)}×${n}`).join(' ')}`);
  if (showHead) {
    for (const item of bad.slice(0, 8)) {
      out.push('');
      out.push(`- line ${item.index}: ${JSON.stringify(item.line.slice(0, 300))}`);
    }
  } else {
    out.push('- (run with --head to print the opening characters of each)');
  }
  out.push('');
  out.push('## what the read side does with them');
  out.push('- lib/ledger.js parses each line and filters out the nulls, so these lines are invisible to brief/handover/unrecordedMistakes.');
  out.push('- if they are meant to be journal events, every count built from the journal is short by this many lines.');
}

console.log(out.join('\n'));
