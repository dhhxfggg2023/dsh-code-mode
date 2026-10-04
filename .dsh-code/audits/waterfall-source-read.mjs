/**
 * Does the host's waterfall pass a listener's arguments on to `next`?
 *
 * `lib/compact-gate.js` emits its 60% warning and its "write the handover" instruction as
 * `return next({ messages: [...] })`. If the host's waterfall calls
 * `next(...args)` that works; if it calls `next()` with no arguments, the patch is
 * discarded and the notice never reaches the model — while the question is still asked and
 * the answer still consumes the margin, which is why it looks alive.
 *
 * This reads the installed cordis source and reports the `next` construction verbatim. It
 * is a source read, deliberately: the claim is about what the framework does with the
 * argument, and that is one line of code.
 */
import fs from 'node:fs';
import path from 'node:path';

const ASAR = 'E:\\tools\\DSH\\resources\\app.asar';
const cordis = path.join(ASAR, 'dsh', 'node_modules', 'cordis', 'lib', 'index.js');
const source = fs.readFileSync(cordis, 'utf8');
const lines = source.split('\n');

const hits = [];
lines.forEach((line, index) => {
  if (/const next\s*=/.test(line) && /cbs\.shift|inner/.test(line)) hits.push({ line: index + 1, text: line.trim() });
});
console.log('waterfall `next` constructions in cordis:');
for (const hit of hits) console.log(`  :${hit.line}  ${hit.text}`);

// What the arguments are spread from, for context.
const spread = lines.findIndex((line) => /cbs\.shift\(\)/.test(line));
if (spread >= 0) {
  console.log('\ncontext around the first construction:');
  for (let i = Math.max(0, spread - 3); i <= spread + 3; i += 1) console.log(`  :${i + 1}  ${lines[i].trim()}`);
}
console.log(`\nverdict: next takes arguments = ${hits.some((hit) => /next\s*=\s*\(\s*\.\.\./.test(hit.text) || /next\s*=\s*\([^)]*\)/.test(hit.text) && !/next\s*=\s*\(\s*\)/.test(hit.text))}`);
