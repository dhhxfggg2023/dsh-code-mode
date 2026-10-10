/**
 * entry-parse-trace — why does one fixture entry yield a value for `safe case` but not for
 * `do not repeat`?
 *
 * Written 2026-10-06 while adding the hand-written-safe-case checks to `pit-fire-probe.mjs`.
 * Those checks reported `markerDelivered: true` (the safe case arrived) alongside
 * `ruleDelivered: false` (the entry's own `do not repeat:` did not) **on the same entry**,
 * which no single-expression explanation covers — one field parsed and another did not.
 *
 * This prints what the guard itself can see, in three layers, so the answer is read rather
 * than inferred:
 *
 *   1. every complete `## ` block in the fixture file, **with its byte length and full text** —
 *      including the blocks `initLedger` wrote, which every previous description of this
 *      fixture (mine included) left out;
 *   2. the block count, so "the last entry" can be identified instead of assumed;
 *   3. the guard's own field expression applied to the block that carries the trigger.
 *
 * Argument 1 is the fixture directory; omit it to use the newest `dsh-pitfire-safe-*` dir.
 *
 * Run: `node probes/entry-parse-trace.mjs [fixture-dir]`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = process.argv[2];
const root =
  arg ??
  fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith('dsh-pitfire-safe-'))
    .map((name) => path.join(os.tmpdir(), name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

if (root === undefined || !fs.existsSync(root)) {
  console.log(`no fixture found${arg === undefined ? ' under os.tmpdir()' : `: ${arg}`}`);
  process.exit(0);
}

const file = path.join(root, '.dsh-code', 'mistakes.md');
const text = fs.readFileSync(file, 'utf8');
const blocks = text.split(/\n(?=## )/).map((block) => block.trim()).filter((block) => block.startsWith('## '));

console.log(`# entry-parse-trace — ${file}`);
console.log(`bytes: ${text.length} · complete blocks: ${blocks.length}`);
console.log('');
console.log('## every block, in file order');
blocks.forEach((block, index) => {
  console.log(`--- block ${index} (${block.length} bytes) ---`);
  console.log(block);
});

const heading = (block) => block.split('\n', 1)[0].slice(3).trim();
const fieldExpression = (label) => `^- ${label}\\s*(?:[（(][^\\n]*?[）)])?\\s*[:：]\\s*([^\\n]*)$`;
const readField = (block, labels) => {
  for (const label of String(labels).split('/')) {
    const match = new RegExp(fieldExpression(label), 'm').exec(block);
    if (match !== null && match[1].trim().length > 0) return match[1].trim();
  }
  return undefined;
};

console.log('');
console.log('## the block that carries the trigger, as the guard reads it');
const carrier = blocks.find((block) => readField(block, 'trigger') !== undefined);
if (carrier === undefined) {
  console.log('- no block carries a `trigger:` at all');
} else {
  console.log(`- heading: ${heading(carrier)}`);
  for (const label of ['symptom', 'cause', 'fix', 'trigger', 'do not repeat', 'safe case/安全情形']) {
    console.log(`  ${label.padEnd(22)} → ${JSON.stringify(readField(carrier, label))}`);
  }
  console.log('');
  console.log('## the same block, line by line, with the first 6 code points of each line');
  for (const line of carrier.split('\n')) {
    const codes = [...line.slice(0, 6)].map((char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
    console.log(`  ${JSON.stringify(line.slice(0, 90))}   [${codes}]`);
  }
}
