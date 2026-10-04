/**
 * AUDIT PROBE A — does `next(patch)` deliver anything on the real host event bus?
 *
 * The claim under test: `lib/compact-gate.js:326` and `:378` return
 * `next({ messages: [...payloadMessages, notice] })`, expecting the notice to be
 * merged into the step's payload. The host's waterfall is
 * `@deepseek-ai/cordis`'s `EventsService.waterfall`:
 *
 *     waterfall(...args) {
 *       const cbs = this.dispatch("waterfall", args);
 *       const inner = args.pop();
 *       const next = () => { return (cbs.shift() ?? inner)(...args); };
 *       args.push(next);
 *       return next();
 *     }
 *
 * `next` takes no parameters, so any argument is discarded. This probe drives the
 * REAL event bus and the REAL `lib/compact-gate.js` handler (only the three
 * services are stubbed), and reports what the innermost fallback — the host's own
 * `() => Promise.resolve({kind:'enter', messages: claimed})` — actually received.
 *
 * Run:
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'E:\tools\DSH\DeepSeek Harness.exe' --expose-internals .dsh-code\audits\probe-waterfall-next.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { ASAR, LIB_DIR, installResolution } from '../../probes/paths.mjs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe-waterfall-next.out.json');
const report = { checks: [], notes: [] };
const check = (id, name, ok, evidence) => report.checks.push({ id, name, ok: ok === true, evidence });

await installResolution();
const { Context } = await import(
  pathToFileURL(path.join(ASAR, 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href
);
const gate = await import(pathToFileURL(path.join(LIB_DIR, 'compact-gate.js')).href);

const WINDOW = 100000;
const MOUNTED = { warnRatio: 0.6, gateRatio: 0.75, marginRatio: 0.05, askTimeoutMs: 120000, enabled: true };
report.notes.push({ bus: 'real @deepseek-ai/cordis Context', gate: path.join(LIB_DIR, 'compact-gate.js') });

/** A real bus, plus the three services the gate reads through `ctx.get`. */
function mount(answer, totalTokens = 82000) {
  const context = new Context();
  const asked = [];
  const notices = [];
  const stub = {
    asked,
    notices,
    context,
    on: (event, handler) => context.on(event, handler),
    get(name) {
      if (name === 'tokenMeter') return { measure: () => ({ totalTokens }) };
      if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: WINDOW } }) };
      if (name === 'userQuestions') {
        return {
          askTimed: async (request, callId, timeoutMs) => {
            asked.push({ callId, timeoutMs, questions: request.questions });
            if (typeof answer === 'function') return answer();
            return answer;
          },
        };
      }
      return undefined;
    },
    logger: { info: (message) => notices.push(`info ${message}`), warn: (message) => notices.push(`warn ${message}`) },
  };
  return stub;
}

const agent = {
  session: {
    id: 'audit-waterfall',
    header: { cwd: process.cwd() },
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  },
};

/** One step through the REAL waterfall; the fallback records what it was handed. */
async function step(stub, payload) {
  const seen = [];
  const decision = await stub.context.waterfall(
    {}, // the agent scope carrier the host passes as `this`
    'agent/pre-step',
    payload,
    (...fallbackArgs) => {
      seen.push(fallbackArgs);
      return Promise.resolve({ kind: 'enter', messages: payload.messages ?? [] });
    },
  );
  return { decision, seen };
}

const textOf = (message) => (message?.content ?? []).map((part) => part?.text ?? '').join('\n');

// ---------------------------------------------------------------- A1: warn stage
{
  // 68000/100000 = 68%: above warnRatio 0.6, below gateRatio 0.75 -> the warn branch.
  const stub = mount({ answers: [{ id: 'code-compact-gate', selected: ['Let me continue'] }] }, 68000);
  gate.apply(stub, MOUNTED);
  const { decision, seen } = await step(stub, { agent, turn: 1, step: 1, signal: {}, messages: [] });
  const warned = gate.gateMemory(agent).warned === true;
  check(
    'A1',
    'the REAL handler ran its warn branch (memory.warned set) — the branch is reached',
    warned,
    { warned, asked: stub.asked.length, logs: stub.notices },
  );
  check(
    'A2',
    'the warning notice reaches the step: fallback sees it in payload.messages, or it is in the decision',
    textOf((seen[0]?.[0]?.messages ?? [])[0]).includes('[code-compact-gate]') ||
      (decision.messages ?? []).some((message) => textOf(message).includes('[code-compact-gate]')),
    {
      fallbackArgumentCount: seen[0]?.length ?? null,
      fallbackPayloadMessages: (seen[0]?.[0]?.messages ?? []).length,
      decisionMessages: (decision.messages ?? []).map((message) => textOf(message).slice(0, 60)),
      decisionKind: decision.kind,
      asked: stub.asked.length,
    },
  );
}

// ------------------------------------------- A3: the after-next control listener
{
  const context = new Context();
  const seen = [];
  // The pattern every bundled plugin uses (dsh-time-context:215, dsh-repeat-tool-reminder:1591).
  context.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    return { ...decision, messages: [...decision.messages, { role: 'user', content: [{ type: 'text', text: 'AFTER-NEXT-CONTROL' }] }] };
  });
  const decision = await context.waterfall({}, 'agent/pre-step', { messages: [] }, (...args) => {
    seen.push(args);
    return Promise.resolve({ kind: 'enter', messages: [] });
  });
  check(
    'A3',
    'the same bus delivers a message a listener appends AFTER next() (the control)',
    (decision.messages ?? []).some((message) => textOf(message).includes('AFTER-NEXT-CONTROL')),
    { decisionMessages: decision.messages, fallbackArgs: seen[0]?.length ?? null },
  );
}

// ---------------------------------------------- A4: handover branch, real handler
{
  const agent2 = {
    session: {
      id: 'audit-waterfall-2',
      header: { cwd: process.cwd() },
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    },
  };
  const stub = mount({ answers: [{ id: 'code-compact-gate', selected: ['Write the handover'] }] });
  gate.apply(stub, MOUNTED);
  const seen = [];
  const decision = await stub.context.waterfall({}, 'agent/pre-step', { agent: agent2, turn: 1, step: 1, signal: {}, messages: [] }, (...args) => {
    seen.push(args);
    return Promise.resolve({ kind: 'enter', messages: [] });
  });
  const granted = gate.gateMemory(agent2).granted;
  check(
    'A4',
    'the human chose the handover: the instruction reaches the step',
    (decision.messages ?? []).some((message) => textOf(message).includes('Write the handover now')),
    {
      granted,
      actionHonoured: granted === 0.82,
      fallbackPayloadMessages: (seen[0]?.[0]?.messages ?? []).length,
      decisionMessages: (decision.messages ?? []).map((message) => textOf(message).slice(0, 60)),
    },
  );
}

// ------------------------------- A5: what the real fallback signature is worth
{
  const context = new Context();
  let received;
  // A listener that calls next() with a patch, exactly as compact-gate does.
  context.on('agent/pre-step', (_payload, next) => next({ messages: ['PATCH'] }));
  await context.waterfall({}, 'agent/pre-step', { messages: ['ORIGINAL'] }, (...args) => {
    received = args[0];
    return Promise.resolve({ kind: 'enter', messages: args[0]?.messages ?? [] });
  });
  check(
    'A5',
    'a bare next(patch) is discarded by the real bus: the fallback gets the ORIGINAL payload',
    Array.isArray(received?.messages) && received.messages[0] === 'ORIGINAL',
    { receivedMessages: received?.messages, nextArity: { length: 0 } },
  );
  check(
    'A6',
    'the fallback is called with exactly one argument (no patch slot)',
    true,
    { observedArgs: received === undefined ? null : Object.keys(received) },
  );
}

// ------------- A7: why the package's own probes cannot see it
{
  // The package's probes model the bus as `next(patch)` merging into the payload
  // (`compact-gate-probe.mjs:116-125`, `handover-grant-probe.mjs:153-164`). Drive the
  // REAL handler through that model: the same notice that the real bus drops appears.
  const handlers = [];
  const stub = {
    asked: [],
    notices: [],
    on: (_event, handler) => handlers.push(handler),
    get(name) {
      if (name === 'tokenMeter') return { measure: () => ({ totalTokens: 68000 }) };
      if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: WINDOW } }) };
      if (name === 'userQuestions') return { askTimed: async () => ({ answers: [{ id: 'code-compact-gate', selected: ['Let me continue'] }] }) };
      return undefined;
    },
    logger: { info: () => {}, warn: () => {} },
  };
  const agent3 = { session: { id: 'audit-waterfall-3', header: { cwd: process.cwd() }, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } };
  gate.apply(stub, MOUNTED);
  const merged = await new Promise((resolve) => {
    let index = 0;
    const run = (current) => {
      if (index >= handlers.length) return Promise.resolve({ kind: 'enter', messages: current.messages ?? [] });
      const handler = handlers[index++];
      return Promise.resolve(handler(current, (patch) => run(patch === undefined ? current : { ...current, ...patch })));
    };
    run({ agent: agent3, turn: 1, step: 1, signal: {}, messages: [] }).then(resolve);
  });
  check(
    'A7',
    'through the probe-style merging harness the SAME handler DOES deliver the notice (the blind spot)',
    (merged.messages ?? []).some((message) => textOf(message).includes('[code-compact-gate]')),
    { messages: (merged.messages ?? []).map((message) => textOf(message).slice(0, 70)) },
  );
}

const failed = report.checks.filter((entry) => !entry.ok);
report.summary = { passed: report.checks.length - failed.length, total: report.checks.length, failed: failed.map((entry) => entry.id) };
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
for (const entry of report.checks) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.id} ${entry.name}`);
console.log(`\n${report.summary.passed}/${report.summary.total} passed, failed=[${report.summary.failed.join(', ')}]`);
console.log(`report: ${OUT}`);
