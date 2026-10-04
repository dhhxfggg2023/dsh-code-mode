/**
 * Audit probe 01 — a `tasks.json` that PARSES but is not a board.
 *
 * Read paths only: every fixture lives in os.tmpdir(), the real ledger is only
 * read for a shape census. Imports the real lib/ledger.js by relative path (it
 * has no bare @deepseek-ai/* specifiers, so plain node is enough).
 *
 *   <node> .dsh-code\audits\01-tasks-json-parseable-malformed.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);

// Hermetic: never let the developer's real machine ledger reach a fixture brief.
process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit01-global-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit01-'));
const SESSION = 'audit-01';

const variants = [
  ['valid control', '{"version":1,"active":[{"id":"t1","title":"T","status":"active","notes":[]}],"done":[],"blocked":[]}'],
  ['null document', 'null'],
  ['string document', '"oops"'],
  ['number document', '42'],
  ['boolean document', 'true'],
  ['array document', '[1,2,3]'],
  ['string inside active', '{"version":1,"active":["oops"],"done":[],"blocked":[]}'],
  ['number inside done', '{"version":1,"active":[],"done":[7],"blocked":[]}'],
  ['object with no status', '{"version":1,"active":[{"title":"x"}],"done":[],"blocked":[]}'],
  ['null inside active', '{"version":1,"active":[null],"done":[],"blocked":[]}'],
];

const call = (fn) => {
  try {
    const value = fn();
    return { threw: false, value };
  } catch (error) {
    return { threw: true, name: error?.name, message: error?.message };
  }
};

const rows = [];
for (const [label, text] of variants) {
  const dir = path.join(tmp, label.replace(/[^a-z0-9]+/gi, '-'));
  fs.mkdirSync(dir, { recursive: true });
  ledger.initLedger(dir, SESSION);
  const file = path.join(dir, '.dsh-code', 'tasks.json');
  fs.writeFileSync(file, `${text}\n`, 'utf8');

  let parses = true;
  try {
    JSON.parse(text);
  } catch {
    parses = false;
  }

  const read = call(() => ledger.readTasks(dir));
  const brief = call(() => ledger.brief(dir, { session: SESSION }).text.length);
  const record = call(() => ledger.recordTask(dir, { title: 'another task' }, SESSION).task.id);
  const sidecars = fs.readdirSync(path.join(dir, '.dsh-code')).filter((name) => name.includes('.corrupt-'));

  rows.push({
    label,
    parsesAsJson: parses,
    readTasks: read.threw ? `${read.name}: ${read.message}` : 'ok',
    brief: brief.threw ? `${brief.name}: ${brief.message}` : `ok (${brief.value} chars)`,
    recordTask: record.threw ? `${record.name}: ${record.message}` : `ok (${record.value})`,
    corruptSidecarWritten: sidecars.length > 0,
  });
}

console.log('=== probe 01: tasks.json that parses but is not a board ===');
console.log(`fixtures: ${tmp}`);
for (const row of rows) {
  console.log(`\n-- ${row.label}  [JSON.parse ok: ${row.parsesAsJson}]`);
  console.log(`   readTasks  : ${row.readTasks}`);
  console.log(`   brief()    : ${row.brief}`);
  console.log(`   recordTask : ${row.recordTask}`);
  console.log(`   .corrupt-* sidecar: ${row.corruptSidecarWritten}`);
}

// Census of the REAL board, read-only: does the 40-per-list cap already bite?
const realTasks = path.join(PKG, '.dsh-code', 'tasks.json');
if (fs.existsSync(realTasks)) {
  const board = JSON.parse(fs.readFileSync(realTasks, 'utf8'));
  console.log('\n=== real board census (read-only) ===');
  for (const key of ['active', 'done', 'blocked']) {
    console.log(`   ${key}: ${Array.isArray(board[key]) ? board[key].length : typeof board[key]}`);
  }
}

const crashes = rows.filter((row) => row.brief.startsWith('Type') || row.readTasks.startsWith('Type'));
console.log(`\nSUMMARY: ${crashes.length}/${rows.length} variants make brief()/readTasks throw a TypeError.`);
console.log(`THROWING VARIANTS: ${crashes.map((row) => row.label).join(' | ')}`);
