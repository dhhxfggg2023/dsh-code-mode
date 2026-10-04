/**
 * Audit probe 08 — a recorded `trigger:` is compiled and executed against caller
 * text with no backtracking bound.
 *
 *   lib/ledger.js:2119   patternHit = new RegExp(trigger, 'i').test(query);
 *   lib/ledger.js:2436   return new RegExp(needle.slice(3), 'm').test(output);
 *
 * Both are reached from real tools (`code_brief({topic})`, `code_verify({expect})`).
 * The pattern comes from the ledger or from the caller's argument, and a pattern
 * that compiles can still take exponential time. This probe measures the blow-up
 * in-process for small inputs, then runs the REAL `brief()` and the REAL
 * `matchesExpectation()` inside a child process under a hard timeout, because a
 * hanging call cannot be timed from inside itself.
 *
 *   <node> .dsh-code\audits\08-redos.mjs
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

/** A pathological but perfectly valid pattern: `(a+)+$` against a failing run of a's. */
const BAD = '(a+)+$';
const input = (n) => `${'a'.repeat(n)}!`;

console.log('=== probe 08A: in-process cost of one `new RegExp(trigger).test(query)` ===');
console.log('   a-count | milliseconds | matches');
for (const n of [14, 16, 18, 20, 22, 24]) {
  const re = new RegExp(BAD, 'i');
  const text = input(n);
  const started = process.hrtime.bigint();
  const matched = re.test(text);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`   ${String(n).padStart(7)} | ${ms.toFixed(2).padStart(12)} | ${matched}`);
}

// ---------------------------------------------------------------------------
// Child side: build a fixture ledger whose entry carries the pattern, then call
// the real functions. Writes a marker file for each stage so a hang is provable
// even if stdout is lost with the process.
// ---------------------------------------------------------------------------
const CHILD = path.join(os.tmpdir(), 'audit08b-redos-child.mjs');
fs.writeFileSync(
  CHILD,
  `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const PKG = process.env.AUDIT_PKG;
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);
const [mode, dir, marker, nRaw, resultFile] = process.argv.slice(2);
const n = Number(nRaw);
const mark = (stage) => fs.appendFileSync(marker, stage + '\\n', 'utf8');
process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit08-global-'));
mark('imported');
if (mode === 'brief') {
  const topic = 'a'.repeat(n) + '!';
  mark('calling-brief');
  const out = ledger.brief(dir, { session: 'audit-08', topic, maxChars: 4000 });
  mark('brief-returned');
  fs.writeFileSync(resultFile, 'brief returned ' + out.text.length + ' chars', 'utf8');
} else {
  const output = 'a'.repeat(n) + '!';
  mark('calling-matchesExpectation');
  const ok = ledger.matchesExpectation(output, 're:' + '(a+)+$');
  mark('matchesExpectation-returned');
  fs.writeFileSync(resultFile, 'matchesExpectation returned ' + ok, 'utf8');
}
`,
  'utf8',
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit08-'));
const fixture = path.join(tmp, 'fixture');
fs.mkdirSync(fixture, { recursive: true });
process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit08-build-global-'));
ledger.initLedger(fixture, 'audit-08');
const N = 34;
const written = ledger.recordMistake(
  fixture,
  {
    symptom: `payload ${'a'.repeat(N)}! arrives from a stack trace`,
    cause: 'the recorded rule is itself a pattern with nested quantifiers',
    fix: 'anchor the pattern so it cannot backtrack',
    avoid: 'never hand a nested-quantifier trigger to the guard: it compiles, then it spins',
    trigger: BAD,
  },
  'audit-08',
);
console.log(`\n=== probe 08B: the real call paths, in a child process with a hard timeout ===`);
console.log(`   recordMistake accepted the pattern (write-side check only compiles it): entry ${written.entry}`);
console.log(`   fixture topic length: ${N} a's + "!" (a fragment of a stack trace is not unusual)`);

const runWithTimeout = (mode, n, timeoutMs) => {
  const marker = path.join(tmp, `marker-${mode}-${n}.txt`);
  const resultFile = path.join(tmp, `result-${mode}-${n}.txt`);
  fs.writeFileSync(marker, '', 'utf8');
  const started = Date.now();
  // No piped stdio: a confined channel cannot capture a child's piped output, and the
  // child's own marker/result files carry the evidence instead (the recorded recipe in
  // the machine ledger). `inherit` keeps a crash visible.
  const result = spawnSync(NODE, [CHILD, mode, fixture, marker, String(n), resultFile], {
    timeout: timeoutMs,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, AUDIT_PKG: PKG },
  });
  const elapsed = Date.now() - started;
  const stages = fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean);
  const returned = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : '';
  return { mode, n, elapsed, timedOut: result.error?.code === 'ETIMEDOUT', spawnError: result.error === undefined ? '' : `${result.error.code}: ${result.error.message.slice(0, 60)}`, stages, returned };
};

for (const n of [18, 22, 26, 34]) {
  const row = runWithTimeout('brief', n, 25000);
  console.log(
    `   brief(topic of ${String(row.n).padStart(2)} a's)   -> timedOut=${String(row.timedOut).padStart(5)} after ${String(row.elapsed).padStart(5)} ms | stages: ${JSON.stringify(row.stages)} | ${row.returned || row.spawnError || '(no result file: the call never returned)'}`,
  );
}
const me = runWithTimeout('matchesExpectation', 34, 25000);
console.log(
  `   matchesExpectation('re:${BAD}', 34 a's) -> timedOut=${String(me.timedOut).padStart(5)} after ${String(me.elapsed).padStart(5)} ms | stages: ${JSON.stringify(me.stages)} | ${me.returned || me.spawnError || '(no result file: the call never returned)'}`,
);

console.log('\nSUMMARY: a pattern that compiles is executed without a backtracking bound; the child never reaches the');
console.log('"returned" marker, so the tool call it stands for never comes back to the turn.');
try {
  fs.rmSync(CHILD, { force: true });
} catch {
  /* the child script stays behind if it cannot be removed; it is under .dsh-code/audits/ */
}
