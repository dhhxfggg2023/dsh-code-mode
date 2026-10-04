/**
 * AUDIT PROBE D — the gate's own deadline (audit F5) and the fail-open paths that
 * could themselves throw (audit F6).
 *
 * Why this probe exists next to `probe-compact-open.mjs`. That probe mounts the gate
 * with the *mounted* `askTimeoutMs` (120000 ms) and observes each step for 250–400 ms,
 * so for a dependency that never settles it can only ever report `held` — which is the
 * defect, not the repair: after the gate enforces its own bound, C8/C9 there still read
 * `held`, because 120000 ms is longer than the probe's window. This probe drives the
 * SAME real handler with a deadline short enough to observe (200 ms), prints the elapsed
 * time of the release, and keeps one CONTROL (D5) that shows the bound really is the
 * configured `askTimeoutMs` and not a new constant: with the mounted 120000 ms the same
 * never-settling answerer is still pending at 400 ms.
 *
 * The stub models the host's waterfall (`cordis/src/events.ts:237` —
 * `const next = () => { const cb = cbs.shift() ?? inner; return cb(...args) }`):
 * **`next` takes no parameters**, and **the listener's return value is the step's
 * decision**. The merging form (`next(patch)`) is what let `next({ messages })` look
 * like delivery for a month; see `probes/handover-grant-probe.mjs:152-190`.
 *
 * Run: node .dsh-code/audits/probe-gate-deadline.mjs
 * Report: `$DSH_PROBE_REPORT`, else next to this file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.env.DSH_PROBE_REPORT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe-gate-deadline.out.json');

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

const results = [];
const check = (id, name, ok, evidence = {}) => results.push({ id, name, ok: ok === true, evidence });

// A late rejection out of a dependency the gate has already given up on must not become
// an unhandled rejection (D10) — the whole point is that nothing escapes the handler.
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(String(reason)));

const WINDOW = 100000;
let agentSeq = 0;
const newAgent = () => ({
  session: {
    id: `audit-deadline-${(agentSeq += 1)}`,
    header: { cwd: process.cwd() },
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  },
});

/**
 * Mount the real gate on a stub context. `askTimeoutMs` is the whole point of this
 * probe, so it is a parameter here rather than a fixture constant.
 * @param options.questions - `undefined` (no service), a value, or a `() => Promise`.
 * @param options.llm - `{ context: { contextWindow } }` unless `'never'`/`'throws'`.
 */
function mount({ askTimeoutMs, totalTokens = 82000, questions, llm, logger } = {}) {
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
      if (name === 'tokenMeter') return { measure: () => ({ totalTokens }) };
      if (name === 'llm') {
        if (llm === 'never') return { resolveModelInfo: () => new Promise(() => {}) };
        if (llm === 'throws') return { resolveModelInfo: async () => { throw new Error('adapter down'); } };
        return { resolveModelInfo: async () => ({ context: { contextWindow: WINDOW } }) };
      }
      if (name === 'userQuestions') {
        if (questions === undefined) return undefined;
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
    logger:
      logger ?? {
        info: (message) => logs.push(`info ${message}`),
        warn: (message) => logs.push(`warn ${message}`),
      },
  };
  gate.apply(ctx, { warnRatio: 0.6, gateRatio: 0.75, marginRatio: 0.05, askTimeoutMs, enabled: true });
  return ctx;
}

/**
 * One step through the registered handler, as the host drives it: `next` parameterless,
 * the listener's return value is the decision, and a hold window makes "never released"
 * observable rather than hanging the probe.
 */
async function step(ctx, agent, holdMs = 1500) {
  const started = Date.now();
  let settled = false;
  const outcome = { kind: 'held', elapsedMs: undefined, messages: [], error: undefined };
  const run = (index) => {
    if (index >= ctx.handlers.length) return Promise.resolve({ kind: 'enter', messages: [] });
    const next = () => run(index + 1);
    return Promise.resolve(ctx.handlers[index]({ agent, turn: 1, step: 1, signal: {}, messages: [] }, next));
  };
  const promise = run(0)
    .then((decision) => {
      settled = true;
      outcome.kind = 'released';
      outcome.elapsedMs = Date.now() - started;
      outcome.decision = decision;
      outcome.messages = (decision?.messages ?? []).flatMap((message) => (message?.content ?? []).map((part) => part?.text ?? ''));
      return outcome;
    })
    .catch((error) => {
      settled = true;
      outcome.kind = 'threw';
      outcome.elapsedMs = Date.now() - started;
      outcome.error = `${error?.name}: ${error?.message}`;
      outcome.messages = [`${error?.name}: ${error?.message}`];
      return outcome;
    });
  await Promise.race([promise, new Promise((resolve) => setTimeout(resolve, holdMs))]);
  if (!settled) outcome.kind = 'held';
  return outcome;
}

const never = () => new Promise(() => {});
const logText = (ctx) => ctx.logs.join('\n');

// ---------------------------------------------------------------- D0: the surface
check(
  'D0',
  'the real handler mounts and `askTimeoutMs` is still the configured key',
  typeof gate.apply === 'function' && gate.resolveLimits({ askTimeoutMs: 200 }).askTimeoutMs === 200,
  { keys: Object.keys(gate.Config?.shape ?? {}), limits: gate.resolveLimits({ askTimeoutMs: 200 }) },
);

// ------------------------------------------- D1/D2/D6: the ask, bounded by itself
{
  const ctx = mount({ askTimeoutMs: 200, questions: never });
  const agent = newAgent();
  const outcome = await step(ctx, agent);
  check(
    'D1',
    'an answerer that never settles releases the step (the gate enforces its own askTimeoutMs)',
    outcome.kind === 'released',
    { outcome: outcome.kind, elapsedMs: outcome.elapsedMs, asked: ctx.asked.length, error: outcome.error },
  );
  check(
    'D2',
    'the release is the deadline firing, not an immediate give-up: it happens after the bound and settles soon after',
    outcome.kind === 'released' && outcome.elapsedMs >= 150 && outcome.elapsedMs <= 1500,
    { elapsedMs: outcome.elapsedMs, bound: 200 },
  );
  check(
    'D6',
    'the deadline is still told to the answerer (the gate no longer *depends* on it being honoured)',
    ctx.asked.length === 1 && ctx.asked[0].timeoutMs === 200,
    { asked: ctx.asked },
  );
  check(
    'D3',
    'the timeout is logged, by name, on the releasing path',
    /nobody answered within 200 ms/.test(logText(ctx)),
    { logs: ctx.logs.slice(0, 3) },
  );
  check(
    'D4',
    'the step is released with no notice and no grant: a timeout is not an answer',
    outcome.messages.length === 0 && gate.gateMemory(agent).granted === undefined,
    { messages: outcome.messages.length, memory: gate.gateMemory(agent) },
  );
}

// ---------------------------------------------- D7: the model lookup is bounded too
{
  const ctx = mount({ askTimeoutMs: 200, llm: 'never', questions: { answers: [] } });
  const outcome = await step(ctx, { session: { id: 'sess-deadline-llm', header: { cwd: process.cwd() }, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } });
  check(
    'D7',
    'an llm.resolveModelInfo that never settles releases the step before the question is asked',
    outcome.kind === 'released' && ctx.asked.length === 0,
    { outcome: outcome.kind, elapsedMs: outcome.elapsedMs, asked: ctx.asked.length, logs: ctx.logs.slice(0, 2) },
  );
}

// ------------------------------------- D8: an answer that arrives after the deadline
{
  const late = { answers: [{ id: 'code-compact-gate', selected: ['Let me continue'] }] };
  const ctx = mount({
    askTimeoutMs: 200,
    questions: () => new Promise((resolve) => setTimeout(() => resolve(late), 900)),
  });
  const agent = newAgent();
  const outcome = await step(ctx, agent, 2000);
  check(
    'D8',
    'an answer that arrives after the deadline is not acted on (no grant, no notice)',
    outcome.kind === 'released' && outcome.elapsedMs < 700 && gate.gateMemory(agent).granted === undefined && outcome.messages.length === 0,
    { outcome: outcome.kind, elapsedMs: outcome.elapsedMs, granted: gate.gateMemory(agent).granted, messages: outcome.messages.length },
  );
}

// ------------------------------------------------ D9: the CONTROL — the bound is the config
{
  const ctx = mount({ askTimeoutMs: 120000, questions: never });
  const outcome = await step(ctx, { session: { id: 'sess-deadline-control', header: { cwd: process.cwd() }, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }, 400);
  check(
    'D9',
    'CONTROL: with the mounted askTimeoutMs (120000 ms) the same never-settling answerer is still pending at 400 ms — the bound is the configured value, not a new constant',
    outcome.kind === 'held',
    { outcome: outcome.kind, bound: 120000, window: 400 },
  );
}

// -------------------------------------------------- D10: a rejection after the deadline
{
  const ctx = mount({
    askTimeoutMs: 200,
    questions: () => new Promise((_resolve, reject) => setTimeout(() => reject(Object.assign(new Error('too late'), { code: 'LATE' })), 500)),
  });
  const outcome = await step(ctx, newAgent(), 1500);
  await new Promise((resolve) => setTimeout(resolve, 500));
  check(
    'D10',
    'an answerer that rejects after the deadline neither holds the step nor becomes an unhandled rejection',
    outcome.kind === 'released' && unhandled.length === 0,
    { outcome: outcome.kind, elapsedMs: outcome.elapsedMs, unhandled: unhandled.slice(0, 2) },
  );
}

// ------------------------------------------------ D11/D12: F6 — the fail-open paths
{
  const ctx = mount({
    askTimeoutMs: 120000,
    questions: () => {
      throw new Error('no answerer');
    },
    logger: { info: () => {}, warn: () => { throw new Error('logger exploded'); } },
  });
  const outcome = await step(ctx, newAgent());
  check(
    'D11',
    'F6: a logger that throws on the fail-open path cannot break the handler',
    outcome.kind === 'released',
    { outcome: outcome.kind, error: outcome.error },
  );
}

{
  const cyclic = {};
  cyclic.self = cyclic;
  const ctx = mount({ askTimeoutMs: 120000, questions: cyclic });
  const outcome = await step(ctx, newAgent());
  check(
    'D12',
    'F6: an unrecognised answer containing a cycle is logged and released',
    outcome.kind === 'released' && /circular/.test(logText(ctx)) && /unrecognised/.test(logText(ctx)),
    { outcome: outcome.kind, error: outcome.error, logs: ctx.logs.slice(0, 2) },
  );
}

{
  const ctx = mount({ askTimeoutMs: 120000, questions: { answers: [1n] } });
  const outcome = await step(ctx, newAgent());
  check(
    'D13',
    'F6: an unrecognised answer containing a BigInt is logged and released',
    outcome.kind === 'released' && /1n/.test(logText(ctx)) && /unrecognised/.test(logText(ctx)),
    { outcome: outcome.kind, error: outcome.error, logs: ctx.logs.slice(0, 2) },
  );
}

{
  const ctx = mount({ askTimeoutMs: 120000, questions: { answers: [] }, logger: { info: () => { throw new Error('info exploded'); }, warn: () => { throw new Error('warn exploded'); } } });
  const outcome = await step(ctx, newAgent());
  check(
    'D14',
    'F6: a throwing logger on an ordinary path (unrecognised answer, info level) cannot break the handler',
    outcome.kind === 'released',
    { outcome: outcome.kind, error: outcome.error },
  );
}

// ------------------------------------------------------------------------- verdict
const failed = results.filter((entry) => entry.ok !== true);
for (const entry of results) {
  console.log(`${entry.ok === true ? 'ok  ' : 'FAIL'} ${entry.id.padEnd(4)} ${entry.name}`);
  console.log(`       <- ${JSON.stringify(entry.evidence).slice(0, 300)}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed, failed=[${failed.map((entry) => entry.id).join(', ')}]`);
fs.writeFileSync(OUT, `${JSON.stringify({ probe: 'probe-gate-deadline', results, failed: failed.map((entry) => entry.id) }, null, 2)}\n`, 'utf8');
console.log(`report: ${OUT}`);
if (failed.length > 0) process.exitCode = 1;
