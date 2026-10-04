/**
 * Audit probe 11 — edges the first probe could not attribute.
 *
 * Run:  $env:ELECTRON_RUN_AS_NODE='1'; & '<install>\DeepSeek Harness.exe' .dsh-code/audits/11-edges.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { installResolution, PKG_DIR, ASAR } from '../../probes/paths.mjs';

process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit11-global-'));
await installResolution();
const dshTools = await import('@deepseek-ai/dsh-tools');
const utilValues = await import(pathToFileURL(path.join(ASAR, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-util-values', 'lib', 'index.js')).href);
const { validateJsonSchemaValue } = dshTools;
const { snapshotJsonValue, deepFreeze } = utilValues;

const results = [];
const record = (id, claim, outcome, evidence) => {
  results.push({ id, claim, outcome, evidence });
  console.log(`${outcome === 'PASS' ? 'ok  ' : outcome === 'FAIL' ? 'BAD ' : '--  '} ${id} ${claim}`);
  if (evidence !== undefined) console.log(`       ${JSON.stringify(evidence)?.slice(0, 1400)}`);
};
const scratch = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `audit11-${tag}-`));
const execFor = (cwd, args) => ({ name: 'audit', arguments: args, agent: { session: { id: 'audit11-session', header: { cwd } } } });

function harnessOutput(tool, args, value) {
  const detached = snapshotJsonValue(value);
  if (detached === undefined) return { ok: false, stage: 'snapshot', message: 'value is not lossless JSON' };
  const violations = validateJsonSchemaValue(tool.output.schema, detached, 'value');
  if (violations.length > 0) return { ok: false, stage: 'schema', message: violations.join('; ') };
  try {
    const rendered = tool.output.render(args, deepFreeze(detached));
    if (snapshotJsonValue(rendered) === undefined) return { ok: false, stage: 'render-json' };
    return { ok: true, rendered };
  } catch (error) {
    return { ok: false, stage: 'render', message: error.message };
  }
}
async function loadTool(rel, toolName, ctxPatch = {}) {
  const mod = await import(pathToFileURL(path.join(PKG_DIR, rel)).href);
  const registered = [];
  const ctx = { registered, tools: { register: (d) => registered.push(d) }, systemPrompt: { section: () => {} }, on: () => () => {}, ...ctxPatch };
  mod.apply(ctx, undefined);
  return registered.find((d) => d.name === toolName);
}
async function drive(tool, args, cwd) {
  try {
    const value = await tool.execute(args, execFor(cwd, args));
    return { value, contract: harnessOutput(tool, args, value) };
  } catch (error) {
    return { threw: `${error.name}: ${error.message}` };
  }
}

const recordTool = await loadTool('lib/tool-record.js', 'code_record');
const briefTool = await loadTool('lib/tool-brief.js', 'code_brief');

// ================================================== 1. a task that is already done
console.log('\n== 1. kind=progress against a task that is already on the done list ==');
{
  const root = scratch('done');
  fs.mkdirSync(path.join(root, '.dsh-code'), { recursive: true });
  const doneTask = { id: '2026-10-04-already-finished', title: 'Already finished work', status: 'done', notes: [] };
  fs.writeFileSync(path.join(root, '.dsh-code', 'tasks.json'), JSON.stringify({ version: 1, active: [], done: [doneTask], blocked: [] }));

  const byTitle = await drive(recordTool, { kind: 'progress', title: 'Already finished work', status: 'active', note: 'reopening?' }, root);
  const board = JSON.parse(fs.readFileSync(path.join(root, '.dsh-code', 'tasks.json'), 'utf8'));
  record(
    'done:title-creates-a-second-task',
    'a title naming a COMPLETED task is refused instead of silently creating a second task',
    board.active.length === 0 ? 'PASS' : 'FAIL',
    {
      activeIds: board.active.map((t) => t.id),
      doneIds: board.done.map((t) => t.id),
      sameIdOnBothLists: board.active.some((a) => board.done.some((d) => d.id === a.id)),
      summary: byTitle.value?.summary,
    },
  );
  const byId = await drive(recordTool, { kind: 'progress', task: '2026-10-04-already-finished', status: 'active', note: 'reopen by id' }, root);
  record('done:id-cannot-be-moved', 'a completed task can be addressed by id (or the refusal names the reason)', byId.threw === undefined ? 'PASS' : 'NOTE', { threw: byId.threw ?? 'accepted', summary: byId.value?.summary });
  const bySlug = await drive(recordTool, { kind: 'progress', task: 'already-finished', status: 'active' }, root);
  record('done:slug-cannot-be-moved', 'a completed task can be addressed by slug (or the refusal names the reason)', bySlug.threw === undefined ? 'PASS' : 'NOTE', { threw: bySlug.threw ?? 'accepted' });
}

// ============================================ 2. a topic query that matches nothing
console.log('\n== 2. code_brief(topic) when the query matches nothing ==');
{
  const root = scratch('topic');
  fs.mkdirSync(path.join(root, '.dsh-code'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.dsh-code', 'mistakes.md'),
    ['# Mistakes', '', '## 2026-01-01 · a shell that rewrites text', '- symptom: Set-Content stringifies a byte array into decimal digits', '- cause: PowerShell pipeline', '- fix: write through node', '- trigger: Set-Content|Out-File|Add-Content', '- do not repeat: do not write file content with PowerShell', ''].join('\n'),
  );
  fs.writeFileSync(path.join(root, '.dsh-code', 'decisions.md'), '# Decisions\n');
  fs.writeFileSync(path.join(root, '.dsh-code', 'project.json'), JSON.stringify({ version: 1, commands: { test: 'npm test' } }));
  fs.writeFileSync(path.join(root, '.dsh-code', 'tasks.json'), JSON.stringify({ version: 1, active: [], done: [], blocked: [] }));

  for (const topic of ['Set-Content', 'trigger:Set-Content', 'nothing-matches-this-at-all']) {
    const out = await drive(briefTool, { topic }, root);
    const text = out.value?.brief ?? '';
    record(
      `topic:${topic}`,
      `topic=${JSON.stringify(topic)}: the brief says which entries matched (or that none did)`,
      text.includes('## Known mistakes') ? 'PASS' : 'FAIL',
      {
        hasMistakesHeading: text.includes('## Known mistakes'),
        mentionsQuery: text.includes(topic),
        mentionsTrigger: /trigger/i.test(text),
        chars: text.length,
        notices: text.split('\n').filter((l) => l.startsWith('… (') || l.startsWith('This brief is a selection')),
      },
    );
    if (!text.includes('## Known mistakes')) console.log(`       full text of the miss case:\n${text.split('\n').map((l) => `       | ${l}`).join('\n')}`);
  }
}

// ================================ 3. does a read-shaped tool append a journal line?
console.log('\n== 3. code_brief side effects on the journal ==');
{
  const root = scratch('read');
  fs.mkdirSync(path.join(root, '.dsh-code'), { recursive: true });
  fs.writeFileSync(path.join(root, '.dsh-code', 'journal.jsonl'), '');
  fs.writeFileSync(path.join(root, '.dsh-code', 'project.json'), JSON.stringify({ version: 1 }));
  const count = () => fs.readFileSync(path.join(root, '.dsh-code', 'journal.jsonl'), 'utf8').split('\n').filter((l) => l.trim().length > 0);
  await drive(briefTool, {}, root);
  const after1 = count();
  await drive(briefTool, {}, root);
  const after2 = count();
  record('brief:journal-side-effect', 'a repeated code_brief does not append a journal line per call', after2.length <= after1.length ? 'PASS' : 'FAIL', { afterFirstCall: after1.length, afterSecondCall: after2.length, kinds: after2.map((l) => JSON.parse(l).kind) });
}

// ================================== 4. the second write of the same pit (merge path)
console.log('\n== 4. code_record(mistake) twice: the merge path ==');
{
  const root = scratch('merge');
  const args = { kind: 'mistake', symptom: 'A pit recorded twice by the probe for merge testing', cause: 'c', fix: 'f', avoid: 'do not do this because it merges' };
  const first = await drive(recordTool, args, root);
  const second = await drive(recordTool, args, root);
  record('record:merge-shape', 'the merge path returns exactly the declared keys and reports the recurrence', second.contract?.ok === true ? 'PASS' : 'FAIL', { keys: Object.keys(second.value ?? {}), summary: second.value?.summary?.slice(0, 220), mistakesFile: fs.readFileSync(path.join(root, '.dsh-code', 'mistakes.md'), 'utf8').split('\n').filter((l) => /recurred|^## /.test(l)) });
}

// ================================== 5. project.json patch with an empty object
console.log('\n== 5. code_record(kind=project) with an empty patch ==');
{
  const root = scratch('emptypatch');
  const out = await drive(recordTool, { kind: 'project', patch: {} }, root);
  record('record:empty-patch', 'an empty patch is either refused or reports what it did', out.threw === undefined ? 'PASS' : 'NOTE', { threw: out.threw ?? 'accepted', summary: out.value?.summary, keys: Object.keys(out.value ?? {}), contract: out.contract?.ok === false ? out.contract.message : 'accepted' });
}

// ================== 6. a task created done today, then named by title as active
console.log('\n== 6. the same title on the done list and the active list (same-day id collision) ==');
{
  const root = scratch('collide');
  const T = 'A task that was finished the same day';
  const closed = await drive(recordTool, { kind: 'progress', title: T, status: 'done', note: 'finished' }, root);
  const reopened = await drive(recordTool, { kind: 'progress', title: T, status: 'active', note: 'reopened by title' }, root);
  const board = JSON.parse(fs.readFileSync(path.join(root, '.dsh-code', 'tasks.json'), 'utf8'));
  const activeIds = board.active.map((t) => t.id);
  const doneIds = board.done.map((t) => t.id);
  const collide = activeIds.filter((id) => doneIds.includes(id));
  record(
    'done:same-day-id-collision',
    'a completed task named again by title does not put the same id on both the active and done lists',
    collide.length === 0 ? 'PASS' : 'FAIL',
    { closedSummary: closed.value?.summary, reopenedSummary: reopened.value?.summary, activeIds, doneIds, idsOnBothLists: collide },
  );
}

console.log('\n--------------------------------------------------------------');
const bad = results.filter((r) => r.outcome === 'FAIL');
console.log(`${results.length - bad.length}/${results.length} checks did not FAIL; failing ids: ${bad.map((r) => r.id).join(', ') || '(none)'}`);
const report = JSON.stringify({ probe: '11-edges', results }, null, 2);
const durable = path.join(PKG_DIR, '.dsh-code', 'audits', 'report-11-edges.json');
try {
  fs.writeFileSync(durable, `${report}\n`, 'utf8');
  console.log(`report: ${durable}`);
} catch (error) {
  console.log(`report (workspace not writable: ${error.code})`);
}
fs.writeFileSync(path.join(os.tmpdir(), 'audit-11-report.json'), report);
