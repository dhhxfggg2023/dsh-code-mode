/**
 * Audit probe 11 — what makes `writeFileAtomic`'s rename fail on Windows?
 *
 *   lib/ledger.js:1378  function writeFileAtomic(file, text) {
 *   lib/ledger.js:1379    const temp = `${file}.tmp-${process.pid}`;
 *   lib/ledger.js:1380    fs.writeFileSync(temp, text, 'utf8');
 *   lib/ledger.js:1381    fs.renameSync(temp, file);      <-- no retry, no cleanup, no lock
 *
 * Probe 10 hit `EPERM: operation not permitted, rename ... -> mistakes.md` from this
 * line while another process was appending to the same file. This probe isolates the
 * condition: hold the destination open from another process in a given mode (and, in
 * one case, append in a loop) and then perform exactly what `writeFileAtomic` does.
 * Each case runs in a fresh directory; the temp file is left behind on failure and
 * the probe reports whether it was.
 *
 *   <node> .dsh-code\audits\11-rename-blockers.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit11-'));

const HOLDER = path.join(os.tmpdir(), 'audit11b-holder.mjs');
fs.writeFileSync(
  HOLDER,
  `import fs from 'node:fs';
const [mode, file, ready, done] = process.argv.slice(2);
if (mode === 'loop-append') {
  fs.writeFileSync(ready, '1', 'utf8');
  const until = Date.now() + 4000;
  while (Date.now() < until) fs.appendFileSync(file, 'x'.repeat(200) + '\\n', 'utf8');
} else {
  const fd = fs.openSync(file, mode);
  fs.writeFileSync(ready, '1', 'utf8');
  const until = Date.now() + 4000;
  while (Date.now() < until && !fs.existsSync(done)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  fs.closeSync(fd);
}
`,
  'utf8',
);

const waitExit = (child) => new Promise((resolve) => child.on('exit', () => resolve()));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const cases = [
  ['no holder (control)', undefined],
  ['fs.openSync(file, "r")', 'r'],
  ['fs.openSync(file, "r+")', 'r+'],
  ['fs.openSync(file, "a") — append handle, idle', 'a'],
  ['another process appending in a loop', 'loop-append'],
];

console.log('=== probe 11: does an open handle elsewhere block writeFileAtomic\'s rename? ===');
console.log('   case                                      | rename result | temp file left behind');
for (const [label, mode] of cases) {
  const dir = path.join(tmp, label.replace(/[^a-z0-9]+/gi, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mistakes.md');
  fs.writeFileSync(file, '# Mistakes\n\n## 2026-10-01 · alpha\n- symptom: alpha\n', 'utf8');
  const ready = path.join(dir, 'ready');
  const done = path.join(dir, 'done');
  let holder;
  if (mode !== undefined) {
    holder = spawn(NODE, [HOLDER, mode, file, ready, done], { stdio: ['ignore', 'ignore', 'inherit'] });
    const until = Date.now() + 10000;
    while (!fs.existsSync(ready) && Date.now() < until) sleep(2);
  }
  // exactly what writeFileAtomic does
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, '# Mistakes\n\n## 2026-10-01 · alpha\n- symptom: alpha\n- recurred: 1\n', 'utf8');
  let result;
  try {
    fs.renameSync(temp, file);
    result = 'OK';
  } catch (error) {
    result = `${error.code}: ${error.message.slice(0, 60)}`;
  }
  const tempLeft = fs.existsSync(temp);
  console.log(`   ${label.padEnd(40)} | ${result.padEnd(13)} | ${tempLeft}`);
  if (holder !== undefined) {
    fs.writeFileSync(done, '1', 'utf8');
    await waitExit(holder);
  }
}
console.log(`\nfixtures kept under ${tmp}`);
