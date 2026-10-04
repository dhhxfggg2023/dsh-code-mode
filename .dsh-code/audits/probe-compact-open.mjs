/**
 * AUDIT PROBE C — every path out of `lib/compact-gate.js`'s pre-step handler.
 *
 * The gate's contract is "every path that cannot ask releases the step". This drives
 * the REAL registered `agent/pre-step` handler (the three services stubbed, the
 * handler and its decision logic untouched) over each dependency failure the file
 * claims to survive, and reports which paths release the step, which stay held, and
 * what the gate's memory looks like afterwards.
 *
 * Run: node .dsh-code/audits/probe-compact-open.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function chainable(keys = undefined) {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'shape' && keys !== undefined) return keys;
      return () => chainable(keys);
    },
  });
}
globalThis.__stubs = {
  schemastery: {
    object: (shape) => chainable(shape),
    boolean: () => chainable(),
    number: () => chainable(),
    string: () => chainable(),
    array: () => chainable(),
    optional: () => chainable(),
  },
  createUserMessage: ({ content, source }) => ({ role: 'user', content, source }),
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: `stub:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'stub:@deepseek-ai/schemastery') return { format: 'module', shortCircuit: true, source: 'export default globalThis.__stubs.schemastery;' };
    if (url === 'stub:@deepseek-ai/dsh-llm') return { format: 'module', shortCircuit: true, source: 'export const createUserMessage = globalThis.__stubs.createUserMessage;' };
    return nextLoad(url, context);
  },
});

const gate = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'compact-gate.js')).href);

const WINDOW = 100000;
const MOUNTED = { warnRatio: 0.6, gateRatio: 0.75, marginRatio: 0.05, askTimeoutMs: 120000, enabled: true };
const results = [];
const record = (id, name, outcome, evidence = {}) => results.push({ id, name, outcome, evidence });

let agentSeq = 0;
const newAgent = () => ({
  session: {
    id: `audit-open-${(agentSeq += 1)}`,
    header: { cwd: process.cwd() },
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  },
});

const NO_ANSWER = Symbol('no userQuestions service');

/** Mount the real gate on a stub ctx and expose the handler it registers. */
function mount({ totalTokens = 82000, meter, llm, questions = NO_ANSWER, logger } = {}) {
  const handlers = [];
  const asked = [];
  const logs = [];
  const ctx = {
    asked,
    logs,
    handlers,
    on(event, handler) {
      if (event === 'agent/pre-step') handlers.push(handler);
    },
    get(name) {
      if (name === 'tokenMeter') {
        if (meter === 'missing') return undefined;
        if (meter === 'throws') return { measure: () => { throw new Error('meter exploded'); } };
        if (meter === 'empty') return { measure: () => ({}) };
        return { measure: () => ({ totalTokens: ctx.tokens ?? totalTokens }) };
      }
      if (name === 'llm') {
        if (llm === 'missing') return undefined;
        if (llm === 'throws') return { resolveModelInfo: async () => { throw new Error('adapter down'); } };
        if (llm === 'nowindow') return { resolveModelInfo: async () => ({}) };
        if (llm === 'never') return { resolveModelInfo: () => new Promise(() => {}) };
        return { resolveModelInfo: async () => ({ context: { contextWindow: WINDOW } }) };
      }
      if (name === 'userQuestions') {
        if (questions === NO_ANSWER) return undefined;
        return {
          askTimed: async (request, callId, timeoutMs) => {
            asked.push({ callId, timeoutMs });
            if (typeof questions === 'function') return questions();
            return questions;
          },
        };
      }
      return undefined;
    },
    logger: logger ?? { info: (message) => logs.push(`info ${message}`), warn: (message) => logs.push(`warn ${message}`) },
  };
  gate.apply(ctx, MOUNTED);
  return ctx;
}

/**
 * One step: run the registered handler with a merging `next()` (the model the
 * package's own probes use), raced against the clock so "held" is observable.
 */
async function step(ctx, agent, holdMs = 250) {
  let settled = false;
  const outcome = { kind: 'held', messages: [], decision: undefined, error: undefined };
  const run = (index, payload) => {
    if (index >= ctx.handlers.length) return Promise.resolve({ kind: 'enter', messages: payload.messages ?? [] });
    return Promise.resolve(ctx.handlers[index](payload, (patch) => run(index + 1, patch === undefined ? payload : { ...payload, ...patch })));
  };
  const promise = run(0, { agent, turn: 1, step: 1, signal: {}, messages: [] })
    .then((decision) => {
      settled = true;
      outcome.kind = 'released';
      outcome.decision = decision;
      outcome.messages = (decision?.messages ?? []).flatMap((message) => (message?.content ?? []).map((part) => part?.text ?? ''));
      return outcome;
    })
    .catch((error) => {
      settled = true;
      outcome.kind = 'threw';
      outcome.error = `${error?.name}: ${error?.message}`;
      return outcome;
    });
  await Promise.race([promise, new Promise((resolve) => setTimeout(resolve, holdMs))]);
  if (!settled) outcome.kind = 'held';
  return outcome;
}

// ------------------------------------------------------------------ the matrix
{
  const ctx = mount({});
  const outcome = await step(ctx, newAgent());
  record('C1', 'no `userQuestions` service at all', outcome.kind, { asked: ctx.asked.length, logs: ctx.logs.slice(0, 1) });
}

{
  const ctx = mount({
    questions: () => {
      throw Object.assign(new Error('human interaction is unavailable while the calling agent is owned by another live agent'), { code: 'DELEGATED_CALLER' });
    },
  });
  const outcome = await step(ctx, newAgent());
  record('C2', 'askTimed rejects (sub-agent / not-live caller / bad timeout)', outcome.kind, { asked: ctx.asked.length, logs: ctx.logs.slice(0, 1) });
}

{
  const ctx = mount({ questions: { pending: true, callId: 'x' } });
  const outcome = await step(ctx, newAgent());
  record('C3', 'askTimed resolves {pending:true} (the host timed the wait out)', outcome.kind, { logs: ctx.logs.slice(0, 1) });
}

const labels = ['Compact now', 'Let me continue', 'Write the handover'];
for (const [id, label, answer] of [
  ['C4', 'answer {answers:[]}', { answers: [] }],
  ['C5', 'answer names the question but selects nothing (free text)', { answers: [{ id: 'code-compact-gate', selected: [], custom: 'something else' }] }],
  ['C6', 'answer by NUMERIC index inside `selected`', { answers: [{ id: 'code-compact-gate', selected: [2] }] }],
  ['C7', 'answer is null', null],
]) {
  const ctx = mount({ questions: answer });
  const outcome = await step(ctx, newAgent());
  record(id, label, outcome.kind, { chosenAction: gate.chosenAction(answer, labels), logs: ctx.logs.slice(0, 1) });
}

{
  const ctx = mount({ questions: () => new Promise(() => {}) });
  const outcome = await step(ctx, newAgent(), 400);
  record('C8', 'askTimed never settles (an answerer that never answers)', outcome.kind, { asked: ctx.asked.length });
}

{
  const ctx = mount({ llm: 'never', questions: { answers: [{ id: 'code-compact-gate', selected: ['Compact now'] }] } });
  const outcome = await step(ctx, newAgent(), 400);
  record('C9', 'llm.resolveModelInfo never settles (an adapter that hangs)', outcome.kind, { asked: ctx.asked.length });
}

for (const [id, label, services] of [
  ['C10', 'llm.resolveModelInfo rejects', { llm: 'throws', questions: { answers: [] } }],
  ['C11', 'llm returns no contextWindow (window unknown)', { llm: 'nowindow', questions: { answers: [] } }],
  ['C12', 'tokenMeter service missing', { meter: 'missing', questions: { answers: [] } }],
  ['C13', 'tokenMeter.measure throws', { meter: 'throws', questions: { answers: [] } }],
  ['C14', 'tokenMeter returns no totalTokens', { meter: 'empty', questions: { answers: [] } }],
]) {
  const ctx = mount(services);
  const outcome = await step(ctx, newAgent());
  record(id, label, outcome.kind, { asked: ctx.asked.length });
}

// C15 — one warning per crossing, re-armed only when occupancy drops
{
  const agent = newAgent();
  const ctx = mount({ totalTokens: 68000 });
  const first = await step(ctx, agent);
  const second = await step(ctx, agent);
  ctx.tokens = 50000; // dropped below warnRatio: the handler resets memory (lib/compact-gate.js:309-312)
  const below = await step(ctx, agent);
  ctx.tokens = 68000;
  const third = await step(ctx, agent);
  record('C15', 'warn fires once per crossing and re-arms after occupancy drops', 'observed', {
    firstNotices: first.messages.length,
    secondNotices: second.messages.length,
    belowNotices: below.messages.length,
    afterDropNotices: third.messages.length,
    warnedNow: gate.gateMemory(agent).warned,
  });
}

// C16 — a "let me continue" grant: spent once, re-arms past the margin
{
  const agent = newAgent();
  const answer = { answers: [{ id: 'code-compact-gate', selected: ['Let me continue'] }] };
  const ctx = mount({ totalTokens: 82000, questions: answer });
  const first = await step(ctx, agent);
  const second = await step(ctx, agent);
  ctx.tokens = 88000; // 0.82 + 0.05 = 0.87 < 0.88
  const past = await step(ctx, agent);
  record('C16', 'a grant is spent once, and the question returns past the margin', 'observed', {
    granted: gate.gateMemory(agent).granted,
    askedAfterGrant: ctx.asked.length,
    kinds: [first.kind, second.kind, past.kind],
    notices: [first.messages.length, second.messages.length, past.messages.length],
  });
}

// C17 — the handover: margin taken, warning re-armed, no second card
{
  const agent = newAgent();
  const ctx = mount({ totalTokens: 82000, questions: { answers: [{ id: 'code-compact-gate', selected: ['Write the handover'] }] } });
  const first = await step(ctx, agent);
  const memory = gate.gateMemory(agent);
  const second = await step(ctx, agent);
  record('C17', 'handover: margin taken, warning re-armed, next step does not ask again', 'observed', {
    granted: memory.granted,
    warned: memory.warned,
    askedTotal: ctx.asked.length,
    secondKind: second.kind,
    instructionBuilt: /Write the handover now/.test(first.messages.join('\n')),
  });
}

// C18 — "Compact now"
{
  const agent = newAgent();
  const ctx = mount({ totalTokens: 82000, questions: { answers: [{ id: 'code-compact-gate', selected: ['Compact now'] }] } });
  const outcome = await step(ctx, agent);
  record('C18', '"Compact now" neither annotates nor takes a grant', outcome.kind, {
    notices: outcome.messages.length,
    granted: gate.gateMemory(agent).granted,
    asked: ctx.asked.length,
  });
}

// C19 — two pre-steps in flight for the same agent (re-entrancy)
{
  const agent = newAgent();
  const ctx = mount({
    totalTokens: 82000,
    questions: () => new Promise((resolve) => setTimeout(() => resolve({ answers: [{ id: 'code-compact-gate', selected: ['Let me continue'] }] }), 120)),
  });
  const [a, b] = await Promise.all([step(ctx, agent, 500), step(ctx, agent, 500)]);
  record('C19', 'two pre-steps in flight for the same agent: how many cards?', 'observed', {
    cards: ctx.asked.length,
    callIds: ctx.asked.map((entry) => entry.callId),
    kinds: [a.kind, b.kind],
  });
}

// C20 — the fail-open path when the logger itself throws
{
  const ctx = mount({ questions: () => { throw new Error('no answerer'); }, logger: { info: () => {}, warn: () => { throw new Error('logger exploded'); } } });
  const outcome = await step(ctx, newAgent());
  record('C20', 'fail-open path with a logger that throws', outcome.kind, { error: outcome.error });
}

// C21/C22 — an unrecognised answer the log line cannot serialise
{
  const cyclic = {};
  cyclic.self = cyclic;
  const ctx = mount({ questions: cyclic });
  const outcome = await step(ctx, newAgent());
  record('C21', 'unrecognised answer containing a cycle (JSON.stringify in the warn log)', outcome.kind, { error: outcome.error });
  const ctx2 = mount({ questions: { answers: [1n] } });
  const outcome2 = await step(ctx2, newAgent());
  record('C22', 'unrecognised answer containing a BigInt', outcome2.kind, { error: outcome2.error });
}

for (const entry of results) {
  console.log(`${entry.outcome.padEnd(9)} ${entry.id.padEnd(4)} ${entry.name}\n            ${JSON.stringify(entry.evidence).slice(0, 400)}`);
}
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe-compact-open.out.json');
fs.writeFileSync(OUT, `${JSON.stringify({ mounted: MOUNTED, window: WINDOW, results }, null, 2)}\n`, 'utf8');
console.log(`held=[${results.filter((entry) => entry.outcome === 'held').map((entry) => entry.id).join(', ')}] threw=[${results.filter((entry) => entry.outcome === 'threw').map((entry) => entry.id).join(', ')}]`);
console.log(`report: ${OUT}`);
