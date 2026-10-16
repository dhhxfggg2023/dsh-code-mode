#!/usr/bin/env node
/**
 * run-human-walkthrough.mjs — drive the two "human walkthrough" rounds of
 * TESTING.md 场景 3 by hand, without the GUI, and print every observable fact.
 * (TESTING.md lives in the maintenance checkout, not in the published package.)
 *
 * WHY THIS EXISTS: I (the agent in the GUI session) could not run the rounds
 * myself, for two separate reasons, and neither of them is a bug in this
 * preset:
 *   1. No new process can start on this host right now — every command through
 *      the pwsh channel AND through code_verify's shell dies with
 *      exit 3221225794 (0xC0000142, STATUS_DLL_INIT_FAILED) and zero output.
 *      Even `pwd`. So `code_verify` cannot be exercised here at all.
 *   2. A GUI session cannot be opened from inside another GUI session: the
 *      multi-turn walkthrough must be run by a human clicking "new session".
 *
 * This script is the executable half of that walkthrough: it edits a real
 * code-suffix file (round 1: edit and stop), then runs a real verification
 * (round 2: edit again and verify), and checks on disk whether the gate in
 * lib/gate-verify.js recorded the debt and then settled it. Shell commands
 * live here instead of in a session prompt precisely because
 * `node -e "…"` inline from the run-tool channel is a recorded pit on this
 * host (see ~/.dsh-code/mistakes.md, trigger `node\s+(-e|--eval)`).
 *
 * Usage (from anywhere; it only writes inside the repo):
 *   node probes/run-human-walkthrough.mjs
 *   node probes/run-human-walkthrough.mjs --dir "E:\some\other\project"
 *
 * It never touches an existing scratch file's meaning: it rewrites the single
 * exported string. Delete probes/human-walkthrough-scratch.js afterwards.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/** The workspace the rounds act on. Default: a throwaway subdir of this repo. */
function pickWorkspace(argv) {
  const i = argv.indexOf('--dir');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return path.join(REPO, '.walkthrough-workspace');
}

const WS = pickWorkspace(process.argv.slice(2));
const TARGET = path.join(WS, 'scratch-code-target.js');
const LEDGER = path.join(WS, '.dsh-code');

const results = [];
function check(id, label, ok, detail) {
  results.push({ id, label, ok: Boolean(ok), detail });
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log(`[${mark}] ${id}  ${label}`);
  if (detail !== undefined) console.log(`         ${detail}`);
}

function readLedger(name) {
  const p = path.join(LEDGER, name);
  if (!fs.existsSync(p)) return { path: p, text: '', exists: false };
  return { path: p, text: fs.readFileSync(p, 'utf8'), exists: true };
}

/* ---------------------------------------------------------------- round 1 */
console.log(`\n=== round 1 — edit a code-suffix file and run NO command ===`);
console.log(`workspace: ${WS}`);
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(
  TARGET,
  `// round 1 — edited by run-human-walkthrough.mjs, no command may be run for this edit.\n` +
    `const round = 1;\n` +
    `module.exports = { round };\n`,
  'utf8',
);
console.log(`wrote ${TARGET} (suffix .js, so the gate must count it as code)`);

/* ---------------------------------------------------------------- round 2 */
console.log(`\n=== round 2 — edit again, then really verify it ===`);
fs.appendFileSync(TARGET, `// round 2 — this edit is followed by a real, file-related verification.\n`, 'utf8');

// A real command, run for real, that literally names the edited file — so
// whichever way the ledger pairs proofs with debts (ancestor cwd, or the file
// name appearing in the command), this one matches.
const cmd = `${process.execPath} -e "const m=require(process.argv[1]);console.log('ok',JSON.stringify(m))" "${TARGET}"`;
console.log(`$ ${cmd}`);
const run = spawnSync(process.execPath, ['-e', `const m=require(process.argv[1]);console.log('ok',JSON.stringify(m))`, TARGET], {
  cwd: WS,
  encoding: 'utf8',
});
const stdout = (run.stdout || '').trim();
const stderr = (run.stderr || '').trim();
console.log(`exit=${run.status} stdout=${JSON.stringify(stdout)}${stderr ? ` stderr=${JSON.stringify(stderr)}` : ''}`);
check('R2', 'the verification command really ran and printed ok', run.status === 0 && stdout.includes('ok'), `exit=${run.status} stdout=${stdout}`);

/* ------------------------------------------------- what the gate recorded */
console.log(`\n=== what the gate wrote into the workspace ledger ===`);
const journal = readLedger('journal.jsonl');
check('L1', 'the workspace ledger exists at <ws>\\.dsh-code', journal.exists, journal.path);
if (journal.exists) {
  const lines = journal.text.split(/\r?\n/).filter(Boolean);
  console.log(`         ${lines.length} journal line(s)`);
  for (const line of lines) console.log(`         ${line.slice(0, 400)}`);
  const mentionsTarget = journal.text.includes(path.basename(TARGET));
  check('L2', 'the edited file is named in the journal (edit recorded)', mentionsTarget, path.basename(TARGET));
  const debt = /unverified|ran nothing|changed code and ran nothing/i.test(journal.text);
  check('L3', 'the journal carries the "changed code, ran nothing" debt', debt);
  const proof = /"ok"\s*:\s*true|ok:true|verified/i.test(journal.text);
  check('L4', 'the journal carries a later verification record', proof);
}
const brief = readLedger(path.join('..', 'nothing'));
void brief;

console.log(`\n=== summary ===`);
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks ok`);
for (const f of failed) console.log(`  FAIL ${f.id}: ${f.label} — ${f.detail ?? ''}`);

console.log(`
NOTE — this script proves the file-side half (edit → real verification → what
landed in the ledger). It does NOT prove the session-side half, which is the
actual product of 编程模式 and needs the GUI:
  · round 1 must end with the gate notice in the session ("unproven-completion");
  · the next session's code_brief must list the debt under
    "## Turns that changed code and ran nothing";
  · after a matched code_verify, that section must disappear.
Only a human-opened session can show those three lines.`);

process.exit(failed.length === 0 ? 0 : 1);
