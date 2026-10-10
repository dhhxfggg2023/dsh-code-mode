/**
 * hard-block-audit — which entries can refuse, and what each one claims when it does.
 *
 * Written 2026-10-06 after an **edit** to `lib/ledger.js` was refused by an entry whose
 * trigger is `Remove-Item[^;]*-ErrorAction\s+SilentlyContinue` — a command-line pattern,
 * and an edit has no command line. Two things had to be separated, and reading the cluster
 * notice could not separate them because a cluster prints one truncated line per entry:
 *
 *   1. **Did the edit really match a command trigger?** The notice claimed the
 *      Remove-Item entry refused it. If that entry's trigger cannot match an edit, then the
 *      refusal was attributed to the wrong rule, which is worse than the refusal.
 *   2. **Was the refusal recorded?** `hardDeny` journals a `trigger_block`; the first
 *      refusal in this session did, and the edit refusal did not.
 *
 * It applies each declaring entry's own `trigger:` to the actual text the guard sees for an
 * edit (the edit's target path and content) and prints the verdict per entry, so points 1
 * and 2 become readable facts rather than inferences from a summary line.
 *
 * Run: `node probes/hard-block-audit.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
// This audit's whole output is "which recorded entries can refuse an action". Run against paths
// that are not the ledgers it scans nothing and reports that no entry can refuse — the exact
// false negative it exists to end. Both sides come from the resolver.
import { globalDir, ledgerPath } from '../lib/ledger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const ledgers = [
  { scope: 'project', file: ledgerPath(repo, 'mistakes') },
  { scope: 'machine', file: path.join(globalDir(), 'mistakes.md') },
];

const field = (block, label) => {
  const match = new RegExp(`^- ${label}\\s*(?:[（(][^\\n]*?[）)])?\\s*[:：]\\s*([^\\n]*)$`, 'm').exec(block);
  return match === null ? undefined : match[1].trim();
};

const declaring = [];
for (const { scope, file } of ledgers) {
  if (!fs.existsSync(file)) continue;
  for (const block of fs.readFileSync(file, 'utf8').split(/\n(?=## )/)) {
    if (!block.startsWith('## ')) continue;
    const hard = field(block, 'hard block');
    if (hard === undefined) continue;
    declaring.push({
      scope,
      file,
      heading: block.split('\n', 1)[0].slice(3).trim(),
      hard: Number.parseInt(hard, 10),
      trigger: field(block, 'trigger'),
      files: field(block, 'files'),
    });
  }
}

/** The text an edit presents to the guard, approximated from the tool call it refused. */
const editProbe = {
  target: 'e:/projects/dsh-code-mode/lib/ledger.js',
  content: [
    '    const settled = mistakes.find(',
    "      (mistake) => mistake.ts > when && mistakeSettlesFailures(mistake, failures),",
    '    );',
    "    const later = mistakes.filter((mistake) => mistake.ts > when);",
    "      rows.push(`  → record it: code_record(kind=\"mistake\", …)`);",
  ].join('\n'),
};

const out = [];
out.push('# hard-block-audit');
out.push(`- entries declaring \`hard block:\` anywhere: ${declaring.length}`);
out.push('');
out.push('## each declaring entry, and whether its own trigger can match an edit');
for (const entry of declaring) {
  const re = entry.trigger === undefined ? undefined : new RegExp(entry.trigger, 'i');
  let onTarget = 'n/a (no trigger)';
  let onContent = 'n/a (no trigger)';
  if (re !== undefined) {
    onTarget = re.test(editProbe.target) ? 'MATCH' : 'no';
    onContent = re.test(editProbe.content) ? 'MATCH' : 'no';
  }
  out.push(`- [${entry.scope}] hard block: ${entry.hard} — ${entry.heading.slice(0, 70)}`);
  out.push(`    trigger: ${entry.trigger ?? '(none)'}`);
  out.push(`    files:   ${entry.files ?? '(none)'}`);
  out.push(`    against the edit target path : ${onTarget}`);
  out.push(`    against the edit's own text  : ${onContent}`);
}

out.push('');
out.push('## what a refusal is supposed to leave behind');
const journal = path.join(repo, '.dsh-code', 'journal.jsonl');
// Filter on the parsed `kind`, not on the text: a `verified` event whose captured output
// *quotes* a refusal contains the string `trigger_block` too, and a substring filter counts
// those as refusals. Measured 2026-10-06: this probe reported 13 "events" where the journal
// held 4 — nine of them were copies of a refusal inside the tail of a `code_verify` result.
const events = fs.existsSync(journal)
  ? fs
      .readFileSync(journal, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((event) => event !== null && event.kind === 'trigger_block')
  : [];
out.push(`- \`trigger_block\` events in ${path.relative(repo, journal)}: ${events.length}`);
for (const event of events) {
  out.push(`    hits=${event.hits} declared=${event.declared} target=${JSON.stringify(event.target ?? '')} cmd=${JSON.stringify(String(event.cmd ?? '').slice(0, 90))}`);
}
out.push('');
out.push('## reading');
out.push('- a declaration whose trigger cannot match an edit cannot refuse one on its own trigger; if a cluster attributes an edit refusal to such an entry, the *attribution* is what is wrong.');
out.push('- a refusal that leaves no `trigger_block` event means the ledger cannot answer "has this ever refused anything", which is the exact gap `hardDeny` says it writes that event to close.');

console.log(out.join('\n'));
