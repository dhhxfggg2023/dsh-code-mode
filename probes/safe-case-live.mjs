/**
 * safe-case-live — does the guard's field reader get a value off the real ledger lines?
 *
 * The other two probes in this pair are both about *reading the reader*, and each failed in
 * its own way on 2026-10-06 — which is the reason this third one exists:
 *
 *   - `safe-case-parse.mjs` lifted the expression out of `lib/pit-guard.js` by rebuilding it
 *     from a captured template literal. That round trip is lossy for backslashes, and it
 *     reported `no match` on the very shape the guard asks for.
 *   - `field-regex-trace.mjs` printed the pattern through `JSON.stringify`, whose escaping
 *     made a *correct* pattern (`\s`, one backslash) display as `\\s`, and it too reported
 *     `no match`. That reading sent me to "fix" a line of source that was already right.
 *
 * So this file stops trying to reconstruct or display the pattern. It declares the expression
 * exactly as `lib/pit-guard.js` declares it — same source spelling, same template literals —
 * and runs it against the real ledger lines. The verdict is a capture or nothing; there is no
 * intermediate string to be mis-escaped and no echo to be misread.
 *
 * It also asserts the source *still spells it that way*, so the two cannot drift apart
 * silently: if the source changes and this copy does not, that check goes red.
 *
 * Run: `node probes/safe-case-live.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The same two lines as `lib/pit-guard.js`'s `field()`, spelled identically. Deliberately a
 * copy: a copy that is checked against the original is useful, a copy that is *believed* is
 * the defect this file was written to stop repeating.
 */
const fieldExpression = (label) => `^- ${label}\\s*(?:[（(][^\\n]*?[）)])?\\s*[:：]\\s*([^\\n]*)$`;
const readField = (block, labels) => {
  for (const label of String(labels).split('/')) {
    const match = new RegExp(fieldExpression(label), 'm').exec(block);
    if (match !== null && match[1].trim().length > 0) return match[1].trim();
  }
  return undefined;
};

// 1. the source must still spell the expression the way this copy does.
const source = fs.readFileSync(path.join(repo, 'lib', 'pit-guard.js'), 'utf8');
const guardLines = source.split('\n');
const fieldLine = guardLines.find((line) => line.includes('new RegExp(`^- ${label}'));
const sameShape =
  fieldLine !== undefined &&
  fieldLine.includes('[（(][^\\\\n]*?[）)]') &&
  fieldLine.includes('[:：]') &&
  fieldLine.includes('[^\\\\n]*)$');
const callLine = guardLines.find((line) => line.includes('safeCase: field('));

const out = [];
out.push('# safe-case-live');
out.push(`- source line: ${fieldLine === undefined ? 'NOT FOUND' : fieldLine.trim()}`);
out.push(`- call site  : ${callLine === undefined ? 'NOT FOUND' : callLine.trim()}`);
out.push(`- source spells the widened expression: ${sameShape ? 'yes' : 'NO — this copy has drifted'}`);

// 2. the real lines, through the real expression.
const ledgers = [
  { scope: 'project', file: path.join(repo, '.dsh-code', 'mistakes.md') },
  { scope: 'machine', file: path.join(os.homedir(), '.dsh-code', 'mistakes.md') },
];
let total = 0;
let read = 0;
for (const { scope, file } of ledgers) {
  if (!fs.existsSync(file)) continue;
  const blocks = fs.readFileSync(file, 'utf8').split(/\n(?=## )/).filter((block) => block.startsWith('## '));
  const carrying = blocks.filter((block) => /^-\s*(safe case|安全情形)/m.test(block));
  out.push('');
  out.push(`## ${scope}: ${carrying.length} entr(ies) carry a safe case, of ${blocks.length}`);
  for (const block of carrying) {
    total += 1;
    const heading = block.split('\n', 1)[0].slice(3).trim();
    const value = readField(block, 'safe case/安全情形');
    if (value !== undefined) read += 1;
    out.push(`- ${value === undefined ? 'IGNORED' : 'READS  '} ${heading.slice(0, 72)}`);
    if (value !== undefined) out.push(`    → ${value.slice(0, 96)}`);
  }
}

out.push('');
out.push('## verdict');
out.push(`- the guard can read a safe case from **${read} of ${total}** entr(ies) that carry one.`);
out.push('- `pit-guard.js` appends the value to the notice as `- **safe case (check this first):** …`, so a readable line is what the restart checklist promised.');
out.push('- a red `source spells the widened expression` line means this copy is no longer the guard\'s rule; fix the source or this file, never the number below it.');

console.log(out.join('\n'));
