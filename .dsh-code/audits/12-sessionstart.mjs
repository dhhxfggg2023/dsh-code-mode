/**
 * Audit probe 12 — the "once per process" guard on `noteSessionStart`.
 *
 * lib/ledger.js:1026-1048 says a second briefing must be a no-op inside one process,
 * and the guard is `last.processBoot === currentBoot`. `processBootTime()`
 * (lib/ledger.js:1012-1017) recomputes `new Date(Date.now() - process.uptime() * 1000)`
 * on every call, so this probe asks whether that value is actually the same across two
 * calls in one process — i.e. whether the guard can hold at all.
 *
 * Run:  $env:ELECTRON_RUN_AS_NODE='1'; & '<install>\DeepSeek Harness.exe' .dsh-code/audits/12-sessionstart.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { installResolution, PKG_DIR } from '../../probes/paths.mjs';

process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit12-global-'));
await installResolution();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Exactly the expression in lib/ledger.js:1016. */
const bootNow = () => new Date(Date.now() - Number(process.uptime()) * 1000).toISOString();

const results = [];
const record = (id, claim, outcome, evidence) => {
  results.push({ id, claim, outcome, evidence });
  console.log(`${outcome === 'PASS' ? 'ok  ' : outcome === 'FAIL' ? 'BAD ' : '--  '} ${id} ${claim}`);
  if (evidence !== undefined) console.log(`       ${JSON.stringify(evidence)?.slice(0, 900)}`);
};

// 1. Is the identity value stable across two calls in one process?
const b1 = bootNow();
await sleep(5);
const b2 = bootNow();
await sleep(5);
const b3 = bootNow();
record(
  'guard:boot-value-stable',
  'the process identity the guard compares is the same on two calls in one process',
  b1 === b2 && b2 === b3 ? 'PASS' : 'FAIL',
  { b1, b2, b3, distinct: new Set([b1, b2, b3]).size },
);

// 2. Does a repeated code_brief append a journal line anyway?
const mod = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'tool-brief.js')).href);
const registered = [];
mod.apply(
  { registered, tools: { register: (d) => registered.push(d) }, systemPrompt: { section: () => {} }, on: () => () => {} },
  undefined,
);
const briefTool = registered.find((d) => d.name === 'code_brief');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit12-project-'));
fs.mkdirSync(path.join(root, '.dsh-code'), { recursive: true });
fs.writeFileSync(path.join(root, '.dsh-code', 'journal.jsonl'), '');
fs.writeFileSync(path.join(root, '.dsh-code', 'project.json'), JSON.stringify({ version: 1, commands: { test: 'npm test' } }));
fs.writeFileSync(path.join(root, '.dsh-code', 'mistakes.md'), '# Mistakes\n');
const exec = () => ({ name: 'code_brief', arguments: {}, agent: { session: { id: 'audit12-session', header: { cwd: root } } } });
const starts = () =>
  fs
    .readFileSync(path.join(root, '.dsh-code', 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('"kind":"session_start"')).length;

const counts = [];
let lastText = '';
for (let call = 0; call < 4; call += 1) {
  const value = await briefTool.execute({}, exec());
  lastText = value.brief;
  counts.push(starts());
  await sleep(5);
}
record(
  'guard:one-line-per-process',
  'four code_brief calls in one process leave one session_start line',
  counts.at(-1) === 1 ? 'PASS' : 'FAIL',
  { sessionStartLinesAfterEachCall: counts, lines: fs.readFileSync(path.join(root, '.dsh-code', 'journal.jsonl'), 'utf8').split('\n').filter((l) => l.trim().length > 0) },
);

// 3. What the reader sees: the journal section of the brief.
const journalSection = lastText.split('## Recent ledger entries')[1]?.split('\n## ')[0] ?? '(absent)';
record(
  'guard:brief-journal-section',
  'the brief\'s journal section is not filled with duplicate session_start rows',
  (journalSection.match(/session_start/g) ?? []).length <= 1 ? 'PASS' : 'FAIL',
  { journalSection: journalSection.trim(), sessionStartRows: (journalSection.match(/session_start/g) ?? []).length },
);

console.log('\n--------------------------------------------------------------');
const bad = results.filter((r) => r.outcome === 'FAIL');
console.log(`${results.length - bad.length}/${results.length} checks did not FAIL; failing ids: ${bad.map((r) => r.id).join(', ') || '(none)'}`);
const report = JSON.stringify({ probe: '12-sessionstart', results }, null, 2);
const durable = path.join(PKG_DIR, '.dsh-code', 'audits', 'report-12-sessionstart.json');
try {
  fs.writeFileSync(durable, `${report}\n`, 'utf8');
  console.log(`report: ${durable}`);
} catch (error) {
  console.log(`report (workspace not writable: ${error.code})`);
}
