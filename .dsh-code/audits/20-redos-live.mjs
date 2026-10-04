/**
 * Audit 20 — is the unbounded-regex hazard (ledger-core audit F2) still live today?
 *
 * The audit measured a 34-character topic never returning through the real `brief()`
 * and left `pit-guard.js`'s trigger test labelled *unverified*. This probe re-measures
 * both on the current code, with the damaging call isolated in a child process that is
 * killed on a deadline, so a regression costs seconds instead of the session.
 *
 * Run:  node .dsh-code\audits\20-redos-live.mjs            (harness)
 *       node .dsh-code\audits\20-redos-live.mjs --child A  (one measurement)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const SELF = fileURLToPath(import.meta.url);
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);
const GUARD = path.join(PKG, 'lib', 'pit-guard.js');

process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit20-global-'));

const CHILD_DEADLINE_MS = 15000;

/** How long `new RegExp(pattern).test(subject)` takes here, or 'timeout'. */
function measureHere(pattern, subject, budgetMs) {
  const started = Date.now();
  const timer = setTimeout(() => {
    console.log(`   [!] ${subject.length}-char subject still running after ${budgetMs} ms`);
    process.exit(9);
  }, budgetMs);
  timer.unref?.();
  const hit = new RegExp(pattern, 'i').test(subject);
  clearTimeout(timer);
  return { ms: Date.now() - started, hit };
}

if (process.argv[2] === '--child') {
  const mode = process.argv[3];
  if (mode === 'A') {
    console.log(JSON.stringify(measureHere('(a+)+$', `${'a'.repeat(34)}!`, CHILD_DEADLINE_MS)));
  }
  if (mode === 'B') {
    // The real `brief({topic})` path, with a fixture pit that carries the pattern.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit20-'));
    ledger.initLedger(dir, 'audit-20');
    ledger.recordMistake(
      dir,
      {
        symptom: `${'a'.repeat(34)}! — a fixture symptom long enough to be searched for`,
        cause: 'fixture',
        fix: 'fixture',
        avoid: 'never mind',
        trigger: '(a+)+$',
        files: 'lib/ledger.js',
      },
      'audit-20',
    );
    const started = Date.now();
    const text = ledger.brief(dir, { topic: `${'a'.repeat(34)}!`, theme: 'dark', width: 80, maxChars: 4000 });
    console.log(JSON.stringify({ ms: Date.now() - started, chars: String(text ?? '').length }));
  }
  if (mode === 'C') {
    // pit-guard's pre-execute path: a recorded trigger tested against a command line.
    const source = fs.readFileSync(GUARD, 'utf8');
    const compiled = [...source.matchAll(/new RegExp\(([^)]*)\)/g)].map((m) => m[1].trim());
    console.log(JSON.stringify({ compiledSites: compiled }));
    console.log(JSON.stringify(measureHere('(a+)+$', `run ${'a'.repeat(34)}!`, CHILD_DEADLINE_MS)));
  }
  process.exit(0);
}

const runChild = (mode) => {
  const started = Date.now();
  const result = spawnSync(process.execPath, [SELF, '--child', mode], {
    encoding: 'utf8',
    timeout: CHILD_DEADLINE_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const elapsed = Date.now() - started;
  const killed = result.error?.code === 'ETIMEDOUT' || result.signal !== null;
  return {
    mode,
    elapsed,
    killed,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').split('\n')[0] ?? '',
  };
};

console.log('=== A: `new RegExp("(a+)+$", "i").test(34 a\'s + "!")` — the primitive the audit measured ===');
const inProcess = measureHere('(a+)+$', 'a'.repeat(22) + '!', 8000);
console.log(`   22-char subject: ${inProcess.ms} ms (in this process; 34 chars is what hangs)`);

console.log('\n=== B/C: the two call sites, each isolated by a child-process deadline ===');
for (const mode of ['A', 'B', 'C']) {
  const r = runChild(mode);
  const verdict = r.killed ? `STILL HANGS (killed at ${CHILD_DEADLINE_MS} ms)` : `returned in ${r.elapsed} ms`;
  console.log(`   [${mode}] ${verdict}`);
  if (r.out) console.log(`        ${r.out.slice(0, 300)}`);
  if (r.err) console.log(`        stderr: ${r.err.slice(0, 200)}`);
}

console.log('\n=== D: does the write side refuse a nested quantifier? (the audit says it only checks compilability) ===');
const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit20-')), 'write');
fs.mkdirSync(dir, { recursive: true });
ledger.initLedger(dir, 'audit-20');
let accepted = 'no';
try {
  const written = ledger.recordMistake(
    dir,
    { symptom: 'fixture with a pathological trigger', cause: 'c', fix: 'f', avoid: 'a', trigger: '(a+)+$', files: 'x.js' },
    'audit-20',
  );
  accepted = `yes (entry written: ${written.entry === true})`;
} catch (error) {
  accepted = `no — refused: ${String(error?.message ?? error).slice(0, 120)}`;
}
console.log(`   recordMistake(trigger="(a+)+$") -> ${accepted}`);

console.log('\n=== E: the trigger matcher pit-guard actually uses, if it is not a naked RegExp ===');
const guardSource = fs.readFileSync(GUARD, 'utf8');
for (const line of guardSource.split('\n')) {
  if (/RegExp|trigger/i.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//')) {
    console.log(`   ${line.trim().slice(0, 150)}`);
  }
}
