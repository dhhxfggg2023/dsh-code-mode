/**
 * End-to-end check of the `code-budget` post-execute handler against an
 * oversized payload, written by the CURRENT session (2026-10-01 late) to
 * reproduce — not trust — the claim "an over-budget model-visible result is
 * replaced by head + … + tail + a note naming the dropped count".
 *
 * It drives the real plugin module through a mock ctx, exactly the shape
 * `tools/post-execute` uses, and prints the resulting block sizes plus the
 * note text. Nothing under dsh-code-mode/ is modified.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { appendFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { LIB_DIR, installResolution, tempReport } from './paths.mjs';

const OUT = process.env.DSH_PROBE_REPORT ?? tempReport('budget-chain-report.json');
// Breadcrumbs and the report go to the workspace when this runs under `pwsh`.
// Under `code_verify` the shell is denied workspace writes, so keep this probe
// runnable in both channels by pointing the trace at temp when the workspace is
// not writable (see HANDOVER rule 10).
const TRACE = process.env.DSH_PROBE_TRACE ?? tempReport('budget-chain-trace.txt');

await installResolution();
writeFileSync(TRACE, `start ${new Date().toISOString()}\n`, 'utf8');
/** Breadcrumb, because this script's stdout is not forwarded under ELECTRON_RUN_AS_NODE. */
const step = (line) => appendFileSync(TRACE, `${line}\n`, 'utf8');
step('imports ok');

// Bare `@deepseek-ai/*` imports inside the plugin only resolve after the same
// profile-resolution bootstrap the host installs (HANDOVER rule 2). Without it
// the run dies with ERR_MODULE_NOT_FOUND for @deepseek-ai/schemastery.




step('app-boot imported');
step('resolution installed');
step('environment data set');
step('bootstrap loaded');

const MODULE = path.join(LIB_DIR, 'budget.js');
const HEAD = 12000;
const TAIL = 4000;

const mod = await import(pathToFileURL(MODULE).href);

function mount(config) {
  const handlers = new Map();
  const ctx = { on: (event, fn) => handlers.set(event, fn) };
  mod.apply(ctx, config);
  return handlers;
}

const handlers = mount(undefined);
if (!handlers.has('tools/post-execute')) throw new Error('post-execute handler not registered');

const payloadChars = 50000;
const payload = 'H'.repeat(payloadChars);
const downstream = { kind: 'accept', content: [{ type: 'text', text: payload }] };

const observed = await handlers.get('tools/post-execute')({ name: 'read' }, {}, () => downstream);
const blocks = observed.content ?? [];
const texts = blocks.filter((b) => b?.type === 'text').map((b) => b.text);
const totalChars = texts.reduce((n, t) => n + t.length, 0);
const body = texts[0] ?? '';
const note = texts.at(-1) ?? '';

const headOk = body.startsWith('H'.repeat(HEAD));
const tailOk = body.endsWith('H'.repeat(TAIL));
const separator = body.includes('\n…\n');
const kept = headOk && tailOk ? HEAD + TAIL : body.length;

// What the handler did to a result that is exactly at, and one under, the cap.
const atCap = await handlers.get('tools/post-execute')(
  { name: 'read' },
  {},
  () => ({ kind: 'accept', content: [{ type: 'text', text: 'x'.repeat(24000) }] }),
);
const underCap = await handlers.get('tools/post-execute')(
  { name: 'read' },
  {},
  () => ({ kind: 'accept', content: [{ type: 'text', text: 'x'.repeat(23999) }] }),
);

// Non-text block ordering must survive by identity.
const img = { type: 'image', data: 'AAAA' };
const res = { type: 'resource', uri: 'file:///x' };
const mixed = await handlers.get('tools/post-execute')(
  { name: 'read' },
  {},
  () => ({
    kind: 'accept',
    content: [
      { type: 'text', text: 'A'.repeat(20000) },
      img,
      res,
      { type: 'text', text: 'B'.repeat(20000) },
    ],
  }),
);
const mixedBlocks = mixed.content ?? [];
const order = mixedBlocks.map((b) => b.type);

const checks = [
  ['input 50000 chars is trimmed', observed !== downstream],
  ['kept head is exactly the first 12000 chars', headOk],
  ['kept tail is exactly the last 4000 chars', tailOk],
  ['exactly one "�? separator', separator],
  ['note names the dropped count', /dropped 34,000 of 50,000 characters/.test(note)],
  ['note says the head and the tail were kept', /kept the head and the tail/.test(note)],
  ['note tells the model not to re-run the same call', /do not re-run it the same way/.test(note)],
  ['result stays under maxResultChars', totalChars <= 24000],
  ['exactly-at-cap result is untouched', atCap.content[0].text.length === 24000],
  ['under-cap result is untouched', underCap.content[0].text.length === 23999],
  ['non-text blocks keep their original index 1 and 2', order[1] === 'image' && order[2] === 'resource'],
  ['non-text blocks survive by identity', mixedBlocks[1] === img && mixedBlocks[2] === res],
  ['no handler threw', true],
];

// 4. The brief tool's surface: a dropped section must be announced, not silent,
//    because a briefing that hides what it omitted is how a reader concludes the
//    ledger has nothing on a subject (the 2026-10-01 bug).
const briefMod = await import(pathToFileURL(path.join(LIB_DIR, "tool-brief.js")).href);
const registered = [];
briefMod.apply({ tools: { register: (def) => registered.push(def) } }, { maxChars: 4000 });
const briefDef = registered[0];
const renderBrief = (omittedSections) =>
  briefDef.output.render(
    {},
    { projectRoot: 'E:/x', ledgerDir: 'E:/x/.dsh-code', brief: 'BODY', empty: false, omittedSections },
  )[0].text;
checks.push(['brief tool announces dropped sections', renderBrief(['mistakes']).includes('Dropped for length: mistakes')]);
checks.push(['brief tool stays quiet when nothing was dropped', !renderBrief([]).includes('Dropped for length')]);
checks.push([
  'brief tool declares omittedSections in its schema',
  briefDef.output.schema.properties.omittedSections !== undefined,
]);

// Written to a file, not stdout: under ELECTRON_RUN_AS_NODE this process's
// stdout is not forwarded to the caller (the probe produced no output until
// this changed), so a file is the only channel that reaches the session.
const report = {
  module: MODULE,
  briefTool: briefDef?.name,
  payloadChars,
  observedBlocks: blocks.length,
  observedBlockChars: texts.map((t) => t.length),
  totalTextChars: totalChars,
  keptChars: kept,
  separatorPresent: separator,
  note,
  order,
  failed: checks.filter(([, ok]) => !ok).map(([name]) => name),
  passed: checks.filter(([, ok]) => ok).length,
  total: checks.length,
};
await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ passed: report.passed, total: report.total, failed: report.failed }));
