/**
 * Can the compaction gate's decision logic be driven *without* the host?
 *
 * Why this exists (2026-10-03): the real probe, `compact-gate-probe.mjs`, has to
 * import the host's resolution bootstrap out of `app.asar` (`paths.mjs:118-141`),
 * which needs the Electron binary with asar support. In a confined session channel
 * that binary does not run at all, so `compact-gate-probe.mjs` cannot be executed
 * there — which is exactly the situation in which someone changes the gate and
 * wants to know whether they broke it.
 *
 * `lib/compact-gate.js` imports only two bare specifiers (`@deepseek-ai/schemastery`
 * and `@deepseek-ai/dsh-llm`), so both can be stubbed and the module's real
 * `agent/pre-step` handler driven by plain Node. That is what this file proves:
 * the *whole* handover decision — the margin it takes, the warning it re-arms, the
 * instruction it emits, and the step it releases — measured by execution, in a
 * channel where the full probe cannot run.
 *
 * Run: node probes/handover-grant-probe.mjs
 *
 * What it deliberately does NOT cover (that is `compact-gate-probe.mjs`'s job, and
 * those checks still only run in an unrestricted terminal): the pure-policy
 * boundaries, warn/ask/grant recovery, the fail-open paths, the engine's own 0.8
 * constant, and the preset wiring that puts this row above `compaction-basic`.
 * This is a reachable probe, not a replacement for the unreachable one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { tempReport } from './paths.mjs';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Where the verdict goes. `debt-audit.mjs` runs this probe with `stdio:'ignore'`,
 *  so its stdout is unreadable in a confined channel and the report file is the only
 *  verdict that reaches the audit. `DSH_PROBE_REPORT` lets a parent redirect it. */
const OUT = process.env.DSH_PROBE_REPORT ?? tempReport('handover-grant-report.json');

// --------------------------------------------------------------------- stubs
/** Chainable stand-in for schemastery's `z.object`/`z.boolean()/...`: any member
 *  that is callable returns the same chainable, so `.default(...)` works and
 *  `.shape` exposes the declared key set for the config-surface check below. */
function chainable(keys = undefined) {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'shape' && keys !== undefined) return keys;
      return () => chainable(keys);
    },
  });
}

const schemastery = {
  object: (shape) => chainable(shape),
  boolean: () => chainable(),
  number: () => chainable(),
  string: () => chainable(),
  optional: () => chainable(),
};

/** Mirrors the real `createUserMessage` shape closely enough to read the notice back. */
const createUserMessage = ({ content, source }) => ({ role: 'user', content, source });

globalThis.__gateStubs = { schemastery, createUserMessage };
/** The one place this harness can be wrong: if a future library version imports a
 *  third bare specifier, this resolves it to nothing rather than to the wrong
 *  module — H0's config-surface check is what fails loudly in that case. */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: `stub:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'stub:@deepseek-ai/schemastery') {
      return { format: 'module', shortCircuit: true, source: 'export default globalThis.__gateStubs.schemastery;' };
    }
    if (url === 'stub:@deepseek-ai/dsh-llm') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const createUserMessage = globalThis.__gateStubs.createUserMessage;',
      };
    }
    return nextLoad(url, context);
  },
});

// --------------------------------------------------------------------- reporting
const decisions = [];
const check = (id, name, ok, evidence) => decisions.push({ id, name, ok: ok === true, evidence });
const preview = (value, n = 220) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && text.length > n ? `${text.slice(0, n)}…` : text;
};

const gate = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'compact-gate.js')).href);
check(
  'H0',
  'the library parses, and its config surface still carries exactly the preset\'s keys',
  (() => {
    const shape = gate.Config?.shape;
    const declared = shape === undefined ? [] : Object.keys(shape);
    const unknown = declared.filter(
      (key) => !['enabled', 'warnRatio', 'gateRatio', 'marginRatio', 'askTimeoutMs'].includes(key),
    );
    return declared.length === 0 || unknown.length === 0;
  })(),
  { configKeys: Object.keys(gate.Config?.shape ?? {}), exports: Object.keys(gate).slice(0, 6) },
);

// --------------------------------------------------------------------- fixture
const WINDOW = 100000;
const MOUNTED = { warnRatio: 0.6, gateRatio: 0.75, marginRatio: 0.05, askTimeoutMs: 120000, enabled: true };

/** A context good enough for the handler: one token meter, one answerer, one listener. */
function mount({ totalTokens, answer }) {
  const ctx = {
    asked: [],
    logs: [],
    handler: undefined,
    tokens: totalTokens,
    get(name) {
      if (name === 'tokenMeter') return { measure: () => ({ totalTokens: ctx.tokens }) };
      if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: WINDOW } }) };
      if (name === 'userQuestions') {
        return {
          askTimed: async (request, id, timeoutMs) => {
            ctx.asked.push({ request, id, timeoutMs });
            return answer;
          },
        };
      }
      return undefined;
    },
    logger: { info: (m) => ctx.logs.push(`info ${m}`), warn: (m) => ctx.logs.push(`warn ${m}`) },
    on(event, handler) {
      if (event === 'agent/pre-step') ctx.handler = handler;
      return () => {};
    },
  };
  return ctx;
}

const agent = {
  session: {
    id: 'sess-harness',
    header: { cwd: PKG_DIR },
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  },
};

/**
 * What the harness observes about one step, modeled on the host's waterfall
 * (`cordis/src/events.ts:237`):
 *
 *     const next = () => { const cb = cbs.shift() ?? inner; return cb(...args) }
 *
 * Two consequences, and the first version of this stub got both wrong — which is how the
 * probe stayed 12/12 while `lib/compact-gate.js` emitted its notices as
 * `next({ messages: [...] })` and the host discarded every one of them:
 *
 *   1. `next` takes **no parameters**. A listener adds messages by appending them to the
 *      object `next()` returns; anything passed as an argument is dropped.
 *   2. The **listener's return value** is what reaches the step, so the decision to inspect
 *      is the resolved value of the handler's promise — not the object `next()` returned
 *      internally. Reading the latter reports "no messages" for a listener that appended
 *      correctly.
 *
 * `inner` stands in for the engine's own handler ahead of the gate: a step with no messages.
 * A handler that never releases the step resolves `{ kind: 'hold' }` on the next tick.
 */
const step = (ctx) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const inner = { messages: [] };
    const next = () => {
      settled = true;
      return inner;
    };
    Promise.resolve(ctx.handler({ agent, signal: { aborted: false }, messages: [] }, next))
      .then((returned) => {
        // The listener's return value IS the step's decision; `kind` records only whether
        // the step was released at all, which is what H6 asks about.
        resolve({ kind: 'enter', payload: returned === undefined ? inner : returned });
      })
      .catch(reject);
    setImmediate(() => {
      if (!settled) resolve({ kind: 'hold' });
    });
  });

const notices = (decision) =>
  (decision.payload?.messages ?? []).flatMap((message) =>
    (message?.content ?? []).filter((part) => part?.type === 'text').map((part) => part.text),
  );
const textOf = (value) => String(value ?? '');

// ------------------------------------------------------- the changed behaviours
const limits = gate.resolveLimits(MOUNTED);
check('H1', 'the declared config resolves to the preset\'s lines', limits.gateRatio === 0.75 && limits.marginRatio === 0.05, limits);

const ctx = mount({ totalTokens: 82000, answer: { answers: [2, undefined, undefined] } });
gate.apply(ctx, MOUNTED);
const decided = await step(ctx);
if (process.env.DSH_HANDOVER_PROBE_DIAG === '1') {
  console.log('[diag] decided =', JSON.stringify(decided).slice(0, 600));
  console.log('[diag] memory  =', JSON.stringify(gate.gateMemory(agent)));
}
const instruction = textOf(notices(decided)[0] ?? '');
check('H2', '"Write the handover" takes the margin instead of re-asking at the next step', gate.gateMemory(agent).granted === 0.82, {
  memory: gate.gateMemory(agent),
});
check('H3', 'the handover re-arms the one-off warning', gate.gateMemory(agent).warned === false, {
  warned: gate.gateMemory(agent).warned,
});
check('H4', 'the instruction still says where the handover goes', instruction.includes('code_record') && instruction.includes('HANDOVER.md'), {
  instruction: preview(instruction),
});
check(
  'H5',
  'the instruction points at a new conversation rather than at being compacted',
  instruction.includes('conversation') && !/context will be compacted after this step/i.test(instruction),
  { instruction: preview(instruction, 320) },
);
// The instruction has to say what the handover is NOT, or the next model handover
// arrives as a summary of the conversation it just had (asked for 2026-10-03).
check(
  'H9',
  'the instruction forbids summarising the conversation, and points at the ledger for the rest',
  instruction.includes('Do not include') &&
    /conversation/i.test(instruction) &&
    instruction.includes('mistakes.md') &&
    instruction.includes('decisions.md'),
  { instruction: preview(instruction, 300) },
);
check(
  'H10',
  'the instruction carries the cautions the next session would walk into',
  instruction.includes('cautions') && /unverified/i.test(instruction),
  { instruction: preview(instruction, 300) },
);
check(
  'H11',
  'the section names the ledger through code_record, so the durable half is not restated in prose',
  instruction.includes('code_record') && instruction.includes('journal.jsonl'),
  { instruction: preview(instruction, 300) },
);
check(
  'H6',
  'the step is released (never held) and the decision carries the handover instruction as its last message',
  // `'enter'` rather than the old `'annotate'`: the host's waterfall has one release
  // vocabulary, and the instruction is a message appended to the returned decision. The
  // old stub invented a second kind for "released with a payload", which is the same
  // mis-modelling that let `next({messages})` look like delivery.
  decided.kind === 'enter' && decided.payload.messages.at(-1)?.source?.form === 'instruction',
  { kind: decided.kind, source: decided.payload.messages.at(-1)?.source },
);

const second = await step(ctx);
check(
  'H7',
  'within the margin the next step neither asks again nor warns',
  ctx.asked.length === 1 && second.kind === 'enter' && notices(second).length === 0,
  { asked: ctx.asked.length, kind: second.kind, notices: notices(second).length },
);

ctx.tokens = 90000;
const third = await step(ctx);
const edge = notices(third);
check(
  'H8',
  'past the margin — at the engine\'s own line — it warns once instead of going silent',
  edge.length === 1 && edge[0].includes('[code-compact-gate]') && edge[0].includes('90%'),
  { notices: edge.length, notice: preview(edge[0]) },
);

// --------------------------------------------------------------------- verdict
const failed = decisions.filter((d) => !d.ok);
for (const d of decisions) {
  console.log(`${d.ok ? 'ok  ' : 'FAIL'} ${d.id} ${d.name}${d.ok ? '' : ` :: ${preview(d.evidence, 300)}`}`);
}
console.log(`\n${decisions.length - failed.length}/${decisions.length} passed, failed=[${failed.map((d) => d.id).join(', ')}]`);
fs.writeFileSync(OUT, `${JSON.stringify({ failed: failed.map((d) => `${d.id} ${d.name}`), passed: decisions.filter((d) => d.ok).length, total: decisions.length }, null, 2)}\n`, 'utf8');
if (failed.length > 0) process.exitCode = 1;
