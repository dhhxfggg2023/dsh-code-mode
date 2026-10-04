/**
 * Audit probe 09 — the merge path rewrites mistakes.md from a snapshot and does not
 * take the lock the append path uses, so a concurrent append is discarded.
 *
 *   lib/ledger.js:625  appendLocked()  — used by the append path (`appendBlock`)
 *   lib/ledger.js:1378 writeFileAtomic() — used by the merge path, no lock at all
 *
 * Two child processes run the real `recordMistake`: one on the merge path (a repeat
 * of a known pit) and one appending a brand-new pit. The new pit's `avoid` rule is
 * then looked for in the file. A positive control runs two appends at once.
 *
 *   <node> .dsh-code\audits\09-merge-race.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);
const NODE = process.execPath;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit09-'));

const CHILD = path.join(os.tmpdir(), 'audit09b-race-child.mjs');
fs.writeFileSync(
  CHILD,
  `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const PKG = process.env.AUDIT_PKG;
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);
const [mode, dir, tag, out, nowait] = process.argv.slice(2);
process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit09-global-'));
// Rendezvous: both processes boot (the slow, noisy part), then release into the
// library call within ~1 ms of each other, so the interleaving under test is the
// library's own read->write window rather than node's start-up jitter.
const ready = path.join(dir, 'ready-' + tag);
fs.writeFileSync(ready, '1', 'utf8');
const until = Date.now() + 30000;
while (nowait !== 'nowait' && Date.now() < until) {
  const peers = fs.readdirSync(dir).filter((n) => n.startsWith('ready-'));
  if (peers.length >= 2) break;
  await new Promise((r) => setTimeout(r, 1));
}
const callStart = Date.now();
const symptom = mode === 'merge' ? 'alpha known pit repeated' : 'beta NEWPIT-' + tag + ' symptom';
const written = ledger.recordMistake(
  dir,
  { symptom, cause: 'race cause', fix: 'race fix', avoid: mode === 'merge' ? 'keep the alpha rule' : 'NEVER-DROP-' + tag, files: 'lib/ledger.js' },
  'audit-09',
);
fs.writeFileSync(out, JSON.stringify({ mode, tag, merged: written.merged, recurred: written.recurred, callMs: Date.now() - callStart }), 'utf8');
`,
  'utf8',
);

/** A mistakes.md with one mergeable pit plus filler, at a chosen size. */
const build = (tag, bytes) => {
  const dir = path.join(tmp, tag);
  fs.mkdirSync(path.join(dir, '.dsh-code'), { recursive: true });
  const parts = ['# Mistakes', '', '## 2026-10-01 · alpha-known-pit-repeated', '- symptom: alpha known pit repeated', '- cause: alpha cause', '- fix: alpha fix', '- files: lib/ledger.js', '- do not repeat: keep the alpha rule'];
  let size = parts.join('\n').length;
  let i = 0;
  while (size < bytes) {
    const block = `\n\n## 2026-10-01 · filler-${i}-${'f'.repeat(60)}\n- symptom: filler ${i} ${'g'.repeat(80)}\n- cause: filler cause ${i}\n- fix: filler fix ${i}\n- avoid: filler rule ${i} ${'r'.repeat(60)}`;
    parts.push(block);
    size += block.length;
    i += 1;
  }
  fs.writeFileSync(path.join(dir, '.dsh-code', 'mistakes.md'), `${parts.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, '.dsh-code', 'journal.jsonl'), '', 'utf8');
  return { dir, entries: parts.length - 1, bytes: size };
};

const waitExit = (child) => new Promise((resolve) => child.on('exit', (code) => resolve(code)));

const runPair = async (label, { dir, modeA, modeB }) => {
  const outA = path.join(dir, 'out-a.json');
  const outB = path.join(dir, 'out-b.json');
  const started = Date.now();
  const a = spawn(NODE, [CHILD, modeA, dir, 'A', outA], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, AUDIT_PKG: PKG } });
  const b = spawn(NODE, [CHILD, modeB, dir, 'B', outB], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, AUDIT_PKG: PKG } });
  await Promise.all([waitExit(a), waitExit(b)]);
  const written = fs.readFileSync(path.join(dir, '.dsh-code', 'mistakes.md'), 'utf8');
  const kept = modeB === 'merge' ? true : written.includes('NEVER-DROP-B');
  const readOut = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { merged: null, callMs: null });
  const recurred = Number(/- recurred: (\d+)/.exec(written)?.[1] ?? 0);
  return { label, wallMs: Date.now() - started, a: readOut(outA), b: readOut(outB), appendedPitSurvived: kept, recurred, fileBytes: written.length };
};

console.log('=== probe 09: merge path vs a concurrent append (rendezvous release) ===');
const small = build('small', 60 * 1024);
const large = build('large', 1200 * 1024);
console.log(`fixtures: small=${small.entries} entries/${small.bytes} B, large=${large.entries} entries/${large.bytes} B`);

// How long does each side take on its own, once booted?
const isolated = (dir, mode) => {
  const out = path.join(dir, `out-solo-${mode}.json`);
  const started = Date.now();
  spawnSync(NODE, [CHILD, mode, dir, `solo-${mode}`, out, 'nowait'], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, AUDIT_PKG: PKG } });
  return { wall: Date.now() - started, ...JSON.parse(fs.readFileSync(out, 'utf8')) };
};
const soloLarge = build('solo-large', 1200 * 1024);
const mergeSolo = isolated(soloLarge.dir, 'merge');
const appendSolo = isolated(soloLarge.dir, 'append');
console.log(`   alone (after boot): merge call=${mergeSolo.callMs} ms, append call=${appendSolo.callMs} ms`);
console.log(`   => the merge holds its read->rename window for ~${mergeSolo.callMs} ms; the append finishes inside ~${appendSolo.callMs} ms`);

const results = [];
for (let round = 1; round <= 3; round += 1) {
  const fixture = build(`round-${round}-large`, 1200 * 1024);
  results.push(await runPair(`large merge||append ${round}`, { dir: fixture.dir, modeA: 'merge', modeB: 'append' }));
}
for (let round = 1; round <= 2; round += 1) {
  const fixture = build(`round-${round}-small`, 60 * 1024);
  results.push(await runPair(`small merge||append ${round}`, { dir: fixture.dir, modeA: 'merge', modeB: 'append' }));
}
for (let round = 1; round <= 2; round += 1) {
  const fixture = build(`round-${round}-mergemerge`, 1200 * 1024);
  results.push(await runPair(`large merge||merge ${round}`, { dir: fixture.dir, modeA: 'merge', modeB: 'merge' }));
}
const control = build('control', 1200 * 1024);
results.push(await runPair('CONTROL append||append', { dir: control.dir, modeA: 'append', modeB: 'append' }));

for (const row of results) {
  console.log(
    `   ${row.label.padEnd(24)} A:merged=${String(row.a.merged ?? '-').padStart(5)} call=${String(row.a.callMs).padStart(4)}ms  B:merged=${String(row.b.merged ?? '-').padStart(5)} call=${String(row.b.callMs).padStart(4)}ms | B's pit survived: ${String(row.appendedPitSurvived).padStart(5)} | recurred in file: ${row.recurred} | file ${row.fileBytes} B`,
  );
}
const mergeAppend = results.filter((row) => row.label.includes('merge||append'));
const lost = mergeAppend.filter((row) => !row.appendedPitSurvived);
const mergeMerge = results.filter((row) => row.label.includes('merge||merge'));
console.log(`\nSUMMARY`);
console.log(`   merge||append pairs whose appended pit was DISCARDED: ${lost.length}/${mergeAppend.length}`);
console.log(`   merge||merge pairs: two repeats recorded, file says recurred=${mergeMerge.map((r) => r.recurred).join(',')} (two increments would be 2)`);
console.log(`   append||append control lost anything: ${!results.at(-1).appendedPitSurvived}`);
if (lost.length > 0) {
  const file = path.join(tmp, 'round-1-large', '.dsh-code', 'mistakes.md');
  const sample = fs.readFileSync(file, 'utf8');
  console.log(`   sample file: ${file}`);
  console.log(`   contains "NEVER-DROP-B": ${sample.includes('NEVER-DROP-B')};  contains the merged alpha rule: ${sample.includes('keep the alpha rule')}`);
}
console.log(`fixtures kept for inspection under ${tmp}`);
