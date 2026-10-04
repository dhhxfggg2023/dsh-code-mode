/**
 * Does a REFUSED `code_record` still create a ledger?
 *
 * `apply` calls `initLedger(cwd, sessionId, scope)` before any per-kind validation, so a call
 * that is then rejected — a `mistake` with no `cause`, a `progress` with no `title`, a
 * terminal `maxChars`-style typo — has already created all five ledger files and journaled an
 * `init`. The visible cost: `code_brief` stops answering "No ledger yet", so the next session
 * believes this project has a ledger when nothing in it was ever recorded (tool-surface audit
 * F5, 2026-10-04).
 *
 * Every write goes to a throwaway root; nothing here touches a real ledger.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIB_DIR, installResolution } from '../../probes/paths.mjs';

await installResolution();
process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'refused-global-'));

const module = await import(pathToFileURL(path.join(LIB_DIR, 'tool-record.js')).href);
const registered = [];
module.apply(
  { tools: { register: (def) => registered.push(def) }, systemPrompt: { section: () => {} }, on: () => () => {} },
  undefined,
);
const tool = registered.find((def) => def.name === 'code_record');

const attempt = async (label, args) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refused-proj-'));
  const before = fs.existsSync(path.join(root, '.dsh-code'));
  let error;
  try {
    await tool.execute(args, { name: 'code_record', arguments: args, agent: { session: { id: 'refused', header: { cwd: root } } } });
  } catch (thrown) {
    error = String(thrown?.message ?? thrown).slice(0, 120);
  }
  const after = fs.existsSync(path.join(root, '.dsh-code'))
    ? fs.readdirSync(path.join(root, '.dsh-code')).sort()
    : [];
  return { label, refused: error !== undefined, error, ledgerBefore: before, created: after };
};

const rows = [];
// Each of these must be REFUSED, and a refusal must leave no ledger behind.
rows.push(await attempt('mistake without cause', { kind: 'mistake', symptom: 's', fix: 'f' }));
rows.push(await attempt('progress without title', { kind: 'progress', note: 'orphan note' }));
rows.push(await attempt('decision without body', { kind: 'decision', title: 't' }));
rows.push(await attempt('unknown kind', { kind: 'nonsense', note: 'x' }));
rows.push(await attempt('progress with global scope', { kind: 'progress', title: 't', scope: 'global' }));
// The control: a valid call MUST create the ledger.
rows.push(await attempt('CONTROL valid project record', { kind: 'project', patch: { stack: 'fixture' } }));

console.log(JSON.stringify(rows, null, 2));
const refusedWithLedger = rows.filter((row) => row.refused && row.created.length > 0);
const controlMadeLedger = rows.find((row) => row.label.startsWith('CONTROL'))?.created.length > 0;
console.log(`\nrefusals that still created a ledger: ${refusedWithLedger.length} of ${rows.filter((r) => r.refused).length}`);
console.log(`control created a ledger: ${controlMadeLedger}`);
