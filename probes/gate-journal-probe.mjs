/**
 * Gate debug-journal probe: makes the gate's decision chain replayable.
 *
 * The gate has one layer no other probe reaches — what a *real* turn did inside
 * the real host. `gate-probe.mjs` drives the event chain with stubs, and the one
 * time the live path was measured it went through instrumentation that was then
 * deleted, so nothing could reproduce it (HANDOVER, "仍未做的"). With
 * `DSH_CODE_GATE_JOURNAL` pointing at a file, the gate writes every decision it
 * makes to that file as JSONL; this probe pins that behaviour in both directions:
 * silent by default, complete when asked, and never the reason a turn fails.
 *
 * The module imports bare `@deepseek-ai/*`, so `installResolution()` comes first —
 * the same bootstrap every probe that imports `lib/*.js` needs.
 *
 *   & '<node>' '<pkg>\probes\gate-journal-probe.mjs'
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIB_DIR, tempReport, installResolution } from './paths.mjs';

const OUT = tempReport('gate-journal-report.json');
const checks = [];
const check = (id, name, ok, evidence) => checks.push({ id, name, ok: ok === true, evidence });

await installResolution();
const gate = await import(pathToFileURL(path.join(LIB_DIR, 'gate-verify.js')).href);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-journal-'));
const journal = path.join(root, 'gate-journal.jsonl');
const session = 'sess-gate-journal';
const agent = { session: { id: session, header: { cwd: root } } };

const stubCtx = () => {
  const handlers = [];
  return {
    handlers,
    on: (event, fn) => {
      handlers.push({ event, fn });
      return () => {};
    },
  };
};
const handlerFor = (ctx, event) => {
  const found = ctx.handlers.filter((h) => h.event === event).map((h) => h.fn);
  return found[found.length - 1];
};
const execFor = (name, args) => ({ name, arguments: args, agent });
const postExecute = (ctx, exec) => handlerFor(ctx, 'tools/post-execute')(exec, { content: [] }, async () => {});
const preStep = (ctx, payload, next = async () => ({ messages: [{ id: 'base' }] })) => handlerFor(ctx, 'agent/pre-step')(payload, next);
const turnStopping = (ctx, payload) => handlerFor(ctx, 'agent/turn-stopping')(payload);

const readJournal = () =>
  fs.existsSync(journal)
    ? fs
        .readFileSync(journal, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
    : [];

const drive = async () => {
  const ctx = stubCtx();
  gate.apply(ctx, {});
  await postExecute(ctx, execFor('edit', { file_path: path.join(root, 'src', 'a.js') }));
  await postExecute(ctx, execFor('pwsh', { command: 'node --test' }));
  for (let i = 0; i < 3; i += 1) await postExecute(ctx, execFor('read', { file_path: 'x' }));
  await preStep(ctx, { turn: 1, step: 9, messages: [], agent });
  await turnStopping(ctx, { turn: 1, agent });
  return ctx;
};

// --- silent unless asked ------------------------------------------------------
delete process.env.DSH_CODE_GATE_JOURNAL;
let threwWithoutSwitch = null;
try {
  await drive();
} catch (error) {
  threwWithoutSwitch = String(error?.message ?? error);
}
check(
  'J1',
  'with no DSH_CODE_GATE_JOURNAL the gate writes nothing and still never throws',
  threwWithoutSwitch === null && !fs.existsSync(journal),
  { threw: threwWithoutSwitch, journalExists: fs.existsSync(journal) },
);

// --- complete when asked ------------------------------------------------------
process.env.DSH_CODE_GATE_JOURNAL = journal;
await drive();
const entries = readJournal();
const events = entries.map((entry) => entry.event);
const runEntry = entries.find((entry) => entry.event === 'run');
const noticeEntry = entries.find((entry) => entry.event === 'notice');
const stoppingEntry = entries.find((entry) => entry.event === 'turn-stopping');
check(
  'J2',
  'every decision the gate made is in the journal, in order',
  ['edit', 'run', 'notice', 'notice-delivered', 'turn-stopping'].every((event) => events.includes(event)) &&
    events.indexOf('edit') < events.indexOf('run') &&
    events.indexOf('notice') < events.indexOf('notice-delivered') &&
    events.indexOf('notice-delivered') < events.indexOf('turn-stopping'),
  { events },
);
check(
  'J3',
  'the run entry records what ran and whether it counted as proof',
  runEntry?.command === 'node --test' && runEntry?.proof === false && runEntry?.source === 'code-gate' && typeof runEntry?.ts === 'string',
  { runEntry },
);
check(
  'J4',
  'the notice entry names which rule fired and why',
  noticeEntry?.kind === 'unrecorded-evidence' && noticeEntry?.patience >= 1 && noticeEntry?.edits === 1,
  { noticeEntry },
);
check(
  'J5',
  'the turn-stopping entry states the evidence state and whether a debt was written',
  stoppingEntry?.state === 'ran' && stoppingEntry?.debt === true && stoppingEntry?.ranProof === 0,
  { stoppingEntry },
);

// A `code_verify` run flips the state, and the turn then closes with no debt.
fs.rmSync(journal, { force: true });
const ctxProof = stubCtx();
gate.apply(ctxProof, {});
await postExecute(ctxProof, execFor('edit', { file_path: path.join(root, 'src', 'b.js') }));
await postExecute(ctxProof, execFor('code_verify', { cmd: 'node --test' }));
await turnStopping(ctxProof, { turn: 1, agent });
const proofEntries = readJournal();
check(
  'J6',
  'a proof-tool run is recorded as proof and closes the turn with debt:false',
  proofEntries.some((entry) => entry.event === 'run' && entry.proof === true) &&
    proofEntries.some((entry) => entry.event === 'turn-stopping' && entry.state === 'proved' && entry.debt === false),
  { entries: proofEntries.map(({ event, proof, state, debt }) => ({ event, proof, state, debt })) },
);

// --- a broken trace must never break the turn ---------------------------------
fs.rmSync(journal, { force: true });
fs.mkdirSync(journal); // a directory where a file is expected: every append must fail
let threwWithBrokenTrace = null;
try {
  await drive();
} catch (error) {
  threwWithBrokenTrace = String(error?.message ?? error);
}
check(
  'J7',
  'an unwritable trace path is swallowed, so the gate still cannot break a turn',
  threwWithBrokenTrace === null,
  { threw: threwWithBrokenTrace },
);

delete process.env.DSH_CODE_GATE_JOURNAL;
fs.rmSync(root, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
fs.writeFileSync(OUT, JSON.stringify({ checks, failed: failed.map((c) => `${c.id} ${c.name}`) }, null, 2), 'utf8');
console.log(JSON.stringify({ passed: checks.length - failed.length, total: checks.length, failed: failed.map((c) => `${c.id} ${c.name}`) }));
process.exitCode = failed.length === 0 ? 0 : 1;
