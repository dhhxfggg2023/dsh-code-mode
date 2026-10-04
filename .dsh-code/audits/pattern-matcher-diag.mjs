/**
 * Does the bounded pattern matcher actually answer, and does it bound the pathological case?
 *
 * `lib/pattern-matcher.js` runs the match in a worker so a runaway expression can be
 * abandoned. The first attempt at this measurement printed `{"boundedMs":49}` — the elapsed
 * time but none of the three fields the script set — which is what serialising an object
 * whose values all came back `undefined` looks like. That is consistent with the worker never
 * replying, so both halves are printed here: what the matcher returns, and what the worker
 * reports when it cannot be created at all.
 *
 * Diagnostic, not a gate: always exits 0.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pattern-diag-'));
const body = `
const { parentPort } = require('node:worker_threads');
let vm;
try { vm = require('node:vm'); } catch (error) { parentPort.postMessage({ stage: 'require-vm', error: String(error && error.message) }); }
parentPort.on('message', (job) => {
  try {
    const context = vm.createContext(Object.create(null));
    const re = vm.runInContext('(' + job.pattern + ')', context);
    parentPort.postMessage({ stage: 'ok', id: job.id, matched: re.test(job.subject) === true });
  } catch (error) {
    parentPort.postMessage({ stage: 'threw', id: job.id, error: String(error && error.message ? error.message : error) });
  }
});
`;

// 1. can a worker with this shape even start here?
const workerReport = await new Promise((resolve) => {
  let worker;
  try {
    worker = new Worker(body, { eval: true });
  } catch (error) {
    resolve({ started: false, error: `${error?.name}: ${error?.message}` });
    return;
  }
  const timer = setTimeout(() => {
    worker.terminate().catch(() => {});
    resolve({ started: true, replied: false, note: 'no reply within 2 s' });
  }, 2000);
  worker.on('message', (message) => {
    clearTimeout(timer);
    worker.terminate().catch(() => {});
    resolve({ started: true, replied: true, message });
  });
  worker.on('error', (error) => {
    clearTimeout(timer);
    resolve({ started: true, replied: false, error: `${error?.name}: ${error?.message}` });
  });
  worker.postMessage({ id: 1, pattern: 'a+b', subject: 'aaab' });
});

// 2. what does the module itself return?
const matcher = await import('file:///E:/projects/dsh-code-mode/lib/pattern-matcher.js');
const ordinary = await matcher.testPattern('Set-Content|Out-File', 'Get-Content a.txt | Set-Content b.txt');
const unrelated = await matcher.testPattern('Set-Content|Out-File', 'pnpm test');

/**
 * A pattern that really does backtrack catastrophically: the inner group matches a variable
 * number of `a`s, the outer group repeats it, and the trailing literal can never be found —
 * so every split of the `a`s is tried. The first version of this check used the audit's
 * `^ (a+)+$`, which is anchored to a literal SPACE and therefore fails in 0 ms: it measured
 * nothing while looking like a measurement.
 */
const vulnerable = '(a+)+X$';
const subject = `${'a'.repeat(28)}`;
const started = Date.now();
const nasty = await matcher.testPattern(vulnerable, subject);
const nastyMs = Date.now() - started;

console.log(
  JSON.stringify(
    {
      workerShape: workerReport,
      ordinary: { matched: ordinary.matched, timedOut: ordinary.timedOut, error: ordinary.error },
      unrelated: { matched: unrelated.matched, timedOut: unrelated.timedOut, error: unrelated.error },
      nasty: { matched: nasty.matched, timedOut: nasty.timedOut, error: nasty.error, ms: nastyMs, pattern: vulnerable, subjectChars: subject.length },
    },
    null,
    2,
  ),
);
fs.rmSync(tmp, { recursive: true, force: true });
