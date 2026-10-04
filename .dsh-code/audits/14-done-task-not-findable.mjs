/**
 * Audit probe 14 — a task in `done` cannot be located, because `recordTask` builds its
 * candidate list from `active` and `blocked` only.
 *
 *   lib/ledger.js:1188   const all = [...board.active, ...board.blocked];
 *
 * The comment above it (1190-1195) says refusing a task that is "plainly on the board"
 * is "a trap, not a safeguard"; `probes/audit-verify-probe.mjs` C2 asserts "a done task
 * can still be moved by passing its id" — but that probe's fixture left the task in
 * `active` (its C1 call had already moved it there), so the done case was never tested.
 *
 *   <node> .dsh-code\audits\14-done-task-not-findable.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);

process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit14-global-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit14-'));
const SESSION = 'audit-14';

const attempt = (fn) => {
  try {
    return { ok: true, id: fn().task.id };
  } catch (error) {
    return { ok: false, message: error.message };
  }
};
const boardOf = (dir) => {
  const board = JSON.parse(fs.readFileSync(path.join(dir, '.dsh-code', 'tasks.json'), 'utf8'));
  const ids = [...board.active, ...board.done, ...board.blocked].map((t) => t.id);
  return { active: board.active.length, done: board.done.length, blocked: board.blocked.length, ids, duplicates: ids.length !== new Set(ids).size };
};

console.log('=== probe 14: moving/annotating a task that is already `done` ===');
for (const [label, createStatus] of [['created active', 'active'], ['created done', 'done']]) {
  const dir = path.join(tmp, label.replace(/\s+/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  ledger.initLedger(dir, SESSION);
  const created = ledger.recordTask(dir, { title: 'Finish the parser', status: createStatus }, SESSION);
  const byId = attempt(() => ledger.recordTask(dir, { slug: created.task.id, status: 'blocked' }, SESSION));
  const boardAfterId = boardOf(dir);
  const byTitle = attempt(() => ledger.recordTask(dir, { title: 'Finish the parser', status: 'blocked' }, SESSION));
  const boardAfterTitle = boardOf(dir);
  console.log(`\n-- ${label} (id ${created.task.id})`);
  console.log(`   move by id    -> ${byId.ok ? `ok (${byId.id})` : `REFUSED: ${byId.message.slice(0, 130)}`}`);
  console.log(`                    board now active=${boardAfterId.active} done=${boardAfterId.done} blocked=${boardAfterId.blocked} duplicates=${boardAfterId.duplicates}`);
  console.log(`   move by title -> ${byTitle.ok ? `ok (${byTitle.id})` : `REFUSED: ${byTitle.message.slice(0, 130)}`}`);
  console.log(`                    board now active=${boardAfterTitle.active} done=${boardAfterTitle.done} blocked=${boardAfterTitle.blocked} duplicates=${boardAfterTitle.duplicates} ids=${JSON.stringify(boardAfterTitle.ids)}`);
}

const doneDir = path.join(tmp, 'created-done');
console.log('\n--- what the refusal lists as "on the board" ---');
const third = attempt(() => ledger.recordTask(doneDir, { slug: 'no-such-task', status: 'active' }, SESSION));
console.log(`   ${third.ok ? 'ok' : third.message.slice(0, 200)}`);
console.log(`   the done task IS in tasks.json: ${fs.readFileSync(path.join(doneDir, '.dsh-code', 'tasks.json'), 'utf8').includes('Finish the parser')}`);
