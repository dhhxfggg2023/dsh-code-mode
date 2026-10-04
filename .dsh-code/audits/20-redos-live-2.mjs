/**
 * Audit 20b — the reachable form of audit F2.
 *
 * Audit 20 measured the primitive (1288 ms for a 22-character subject) and accidentally
 * measured nothing through `brief()`: it set `DSH_CODE_GLOBAL_DIR` *after* importing the
 * ledger, then printed `entry === true` for a field that holds a heading string, so both
 * "measurements" were artifacts. This probe does the one thing that matters: it puts a
 * recorded `trigger:` in a fixture ledger, then calls the real `brief({topic})` with a
 * topic long enough to matter — in a child process with a deadline, because the failure
 * mode is "never returns".
 *
 * Run:  node .dsh-code\audits\20-redos-live-2.mjs          (harness)
 *       node .dsh-code\audits\20-redos-live-2.mjs --child N   (brief with N a's)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const SELF = fileURLToPath(import.meta.url);
const DEADLINE_MS = 20000;

if (process.argv[2] === '--child') {
  const n = Number(process.argv[3]);
  // Redirect BOTH ledger scopes into a temp home BEFORE the first ledger call, so the
  // measurement never touches the developer's real ledgers.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'audit20b-global-'));
  process.env.DSH_CODE_GLOBAL_DIR = home;
  const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit20b-'));
  ledger.initLedger(dir, 'audit-20b');
  const subject = `${'a'.repeat(n)}!`;
  const written = ledger.recordMistake(
    dir,
    {
      symptom: `fixture symptom carrying the subject ${subject}`,
      cause: 'fixture',
      fix: 'fixture',
      avoid: 'fixture rule',
      trigger: '(a+)+$',
      files: 'lib/ledger.js',
    },
    'audit-20b',
  );
  const started = Date.now();
  const text = ledger.brief(dir, { topic: subject, theme: 'dark', width: 80, maxChars: 4000 });
  console.log(
    JSON.stringify({
      n,
      entryWritten: typeof written.entry === 'string',
      briefMs: Date.now() - started,
      briefChars: String(text ?? '').length,
    }),
  );
  process.exit(0);
}

console.log('=== brief({topic}) with a recorded trigger "(a+)+$", child process, 20 s deadline ===');
for (const n of [14, 18, 22, 26]) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [SELF, '--child', String(n)], {
    encoding: 'utf8',
    timeout: DEADLINE_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = (result.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  const killed = result.error?.code === 'ETIMEDOUT';
  if (killed) {
    console.log(`   ${String(n).padStart(2)} a's -> NEVER RETURNED (killed at ${DEADLINE_MS} ms)`);
  } else if (out) {
    const parsed = JSON.parse(out);
    console.log(
      `   ${String(n).padStart(2)} a's -> returned in ${String(parsed.briefMs).padStart(6)} ms ` +
        `(wall ${Date.now() - started} ms), brief ${parsed.briefChars} chars, entry written: ${parsed.entryWritten}`,
    );
  } else {
    console.log(`   ${String(n).padStart(2)} a's -> no verdict: ${(result.stderr ?? '').split('\n')[0]}`);
  }
}

console.log('\n=== control: the same brief() with a topic that carries no trigger, 26 a\'s ===');
const control = spawnSync(process.execPath, [SELF, '--child', '26'], {
  encoding: 'utf8',
  timeout: DEADLINE_MS,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AUDIT20B_NO_TRIGGER: '1' },
});
console.log(`   control exit=${control.status} out=${(control.stdout ?? '').trim().split('\n').pop()}`);
