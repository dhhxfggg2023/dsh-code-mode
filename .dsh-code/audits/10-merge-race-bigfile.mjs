/**
 * Audit probe 10 — the merge path's rewrite is not serialized with anything.
 *
 * Probe 09 could not lose an append at ledger sizes (merge window ~3-8 ms, release
 * jitter ~15 ms on Windows). This probe widens the window the honest way — with a
 * large mistakes.md (the "10 MB hand-editable file" case) — and then releases the
 * appender *inside* the merge's read->rename window. The appender reads the file
 * back after its own call to prove its line reached the disk; the parent then looks
 * for that line in the final file.
 *
 *   <node> .dsh-code\audits\10-merge-race-bigfile.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);
const NODE = process.execPath;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit10-'));

const CHILD = path.join(os.tmpdir(), 'audit10b-race-bigfile-child.mjs');
fs.writeFileSync(
  CHILD,
  `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const PKG = process.env.AUDIT_PKG;
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);
const [mode, dir, tag, out, delayRaw] = process.argv.slice(2);
process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit10-global-'));
const file = path.join(dir, '.dsh-code', 'mistakes.md');
fs.writeFileSync(path.join(dir, 'ready-' + tag), '1', 'utf8');
const spin = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (Number(delayRaw) >= 0) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (fs.readdirSync(dir).filter((n) => n.startsWith('ready-')).length >= 2) break;
    spin(0.2);
  }
}
const releaseAt = Date.now();
if (Number(delayRaw) > 0) spin(Number(delayRaw));
const symptom = mode === 'merge' ? 'alpha known pit repeated' : 'beta NEWPIT-' + tag + ' symptom';
const before = fs.statSync(file).size;
let written;
let error;
try {
  written = ledger.recordMistake(
    dir,
    { symptom, cause: 'race cause', fix: 'race fix', avoid: mode === 'merge' ? 'keep the alpha rule' : 'NEVER-DROP-' + tag, files: 'lib/ledger.js' },
    'audit-10',
  );
} catch (thrown) {
  error = String((thrown && (thrown.code || thrown.name)) || 'Error') + ': ' + String((thrown && thrown.message) || thrown).slice(0, 120);
}
const after = fs.statSync(file).size;
// Did MY entry reach the disk at the moment my own call returned?
const sawOwnLine = fs.readFileSync(file, 'utf8').includes(mode === 'merge' ? 'keep the alpha rule' : 'NEVER-DROP-' + tag);
fs.writeFileSync(
  out,
  JSON.stringify({ mode, tag, merged: written?.merged, recurred: written?.recurred, error, startOffsetMs: releaseAt - Number(process.env.T0 ?? releaseAt), callMs: Date.now() - releaseAt, before, after, sawOwnLine }),
  'utf8',
);
`,
  'utf8',
);

/** 24 MB of entries: ~73k blocks, so the merge's read->parse->write window is ~0.1-0.5 s. */
const buildHuge = (tag, bytes) => {
  const dir = path.join(tmp, tag);
  fs.mkdirSync(path.join(dir, '.dsh-code'), { recursive: true });
  const parts = ['# Mistakes', '', '## 2026-10-01 · alpha-known-pit-repeated', '- symptom: alpha known pit repeated', '- cause: alpha cause', '- fix: alpha fix', '- files: lib/ledger.js', '- do not repeat: keep the alpha rule'];
  // The header + the mergeable entry must actually be IN the file (an earlier run of
  // this probe appended only the filler chunks, so `priorIndex` was -1 and the merge
  // path never ran at all — a probe bug that would have read as "no lost update").
  fs.writeFileSync(path.join(dir, '.dsh-code', 'mistakes.md'), parts.join('\n'), 'utf8');
  let size = parts.join('\n').length;
  let i = 0;
  const chunk = [];
  while (size < bytes) {
    const block = `## 2026-10-01 · filler-${i}-${'f'.repeat(40)}\n- symptom: filler ${i} ${'g'.repeat(60)}\n- cause: filler cause ${i}\n- fix: filler fix ${i}\n- avoid: filler rule ${i} ${'r'.repeat(40)}`;
    chunk.push(block);
    size += block.length + 2;
    i += 1;
    if (chunk.length >= 2000) {
      fs.appendFileSync(path.join(dir, '.dsh-code', 'mistakes.md'), `\n\n${chunk.join('\n\n')}`, 'utf8');
      chunk.length = 0;
    }
  }
  if (chunk.length > 0) fs.appendFileSync(path.join(dir, '.dsh-code', 'mistakes.md'), `\n\n${chunk.join('\n\n')}`, 'utf8');
  fs.writeFileSync(path.join(dir, '.dsh-code', 'journal.jsonl'), '', 'utf8');
  return { dir, entries: i, bytes: fs.statSync(path.join(dir, '.dsh-code', 'mistakes.md')).size };
};

const waitExit = (child) => new Promise((resolve) => child.on('exit', () => resolve()));

const run = async (label, dir, modeA, modeB, delayB) => {
  const t0 = Date.now();
  const outA = path.join(dir, 'out-a.json');
  const outB = path.join(dir, 'out-b.json');
  const env = { ...process.env, T0: String(t0), AUDIT_PKG: PKG };
  const a = spawn(NODE, [CHILD, modeA, dir, 'A', outA, '0'], { stdio: ['ignore', 'ignore', 'inherit'], env });
  const b = spawn(NODE, [CHILD, modeB, dir, 'B', outB, String(delayB)], { stdio: ['ignore', 'ignore', 'inherit'], env });
  await Promise.all([waitExit(a), waitExit(b)]);
  const text = fs.readFileSync(path.join(dir, '.dsh-code', 'mistakes.md'), 'utf8');
  const journal = fs.readFileSync(path.join(dir, '.dsh-code', 'journal.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"mistake"'));
  const readOut = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { error: 'child wrote no result' });
  const tempFiles = fs.readdirSync(path.join(dir, '.dsh-code')).filter((name) => name.includes('.tmp-'));
  return { label, a: readOut(outA), b: readOut(outB), text, journal, tempFiles };
};

console.log('=== probe 10: merge rewrite vs a concurrent append, 24 MB ledger ===');
const big = buildHuge('big', 24 * 1024 * 1024);
console.log(`fixture: ${big.entries} entries, ${(big.bytes / 1048576).toFixed(1)} MB at ${big.dir}`);

// 1. merge alone: how wide is the window?
{
  const out = path.join(big.dir, 'out-solo.json');
  const started = Date.now();
  const solo = spawn(NODE, [CHILD, 'merge', big.dir, 'solo', out, '-1'], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, AUDIT_PKG: PKG } });
  await waitExit(solo);
  const read = JSON.parse(fs.readFileSync(out, 'utf8'));
  console.log(`   merge alone: call=${read.callMs} ms, file ${read.before} -> ${read.after} B (wall ${Date.now() - started} ms)`);
}

// 2. merge || append released 40 ms into the merge's window.
{
  const fixture = buildHuge('big-pair', 24 * 1024 * 1024);
  const row = await run('merge || append(+40ms)', fixture.dir, 'merge', 'append', 40);
  const survived = row.text.includes('NEVER-DROP-B');
  console.log(`\n-- ${row.label}`);
  console.log(`   merge : call=${row.a.callMs} ms  merged=${row.a.merged}  error=${row.a.error ?? 'none'}  wrote ${row.a.before} -> ${row.a.after} B`);
  console.log(`   append: call=${row.b.callMs} ms  error=${row.b.error ?? 'none'}  wrote ${row.b.before} -> ${row.b.after} B`);
  console.log(`   append's own read-back saw its line: ${row.b.sawOwnLine}`);
  console.log(`   final file contains the appended pit: ${survived}`);
  console.log(`   journal lines recording a mistake: ${row.journal.length} (the merge would add one more)`);
  console.log(`   temp files left in the ledger dir: ${JSON.stringify(row.tempFiles)}`);
}

// 3. merge || merge: do both increments survive?
{
  const fixture = buildHuge('big-mergemerge', 24 * 1024 * 1024);
  const row = await run('merge || merge', fixture.dir, 'merge', 'merge', 0);
  const fileRecurred = Number(/- recurred: (\d+)/.exec(row.text)?.[1] ?? 0);
  const journalRecurred = row.journal.map((l) => JSON.parse(l).recurred);
  console.log(`\n-- ${row.label}`);
  console.log(`   merge A: call=${row.a.callMs} ms merged=${row.a.merged} error=${row.a.error ?? 'none'}`);
  console.log(`   merge B: call=${row.b.callMs} ms merged=${row.b.merged} error=${row.b.error ?? 'none'}`);
  console.log(`   file says recurred=${fileRecurred};  journal recorded ${row.journal.length} mistake line(s) with recurred=${JSON.stringify(journalRecurred)}`);
  console.log(`   two repeats recorded, count in the file: ${fileRecurred}  <-- ${fileRecurred === 2 ? 'both kept' : 'count does not reflect two repeats'}`);
  console.log(`   temp files left in the ledger dir: ${JSON.stringify(row.tempFiles)}`);
}
console.log(`\nfixtures kept for inspection under ${tmp}`);
