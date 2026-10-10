/**
 * Compaction-gate probe: does `lib/compact-gate.js` hold the step at the right
 * occupancy, ask the right question, and — the part that matters most — fall
 * open whenever it cannot ask?
 *
 * Run (the module imports bare `@deepseek-ai/*`, so the host's resolution
 * bootstrap is required):
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & '<install>\DeepSeek Harness.exe' --expose-internals '<pkg>\probes\compact-gate-probe.mjs'
 *
 * Checks, by item:
 *   P  the pure policy: warn / ask / granted boundaries, the margin after a
 *      grant, and recovery when the session comes back down
 *   W  the warning stage: one notice per crossing, delivered on the step, and
 *      re-armed only after occupancy drops back under `warnRatio`
 *   G  the gate stage: the question is asked *before* the step runs and carries
 *      this session's numbers; `Let me continue` holds the engine off without
 *      holding the step; `Write the handover` appends the closing instruction;
 *      `Compact now` neither blocks nor annotates
 *   F  fail-open: timeout, no answerer, unrecognised answer, unmeasurable
 *      occupancy and a throwing meter all reach the engine
 *   R  the regression that gives the gate its timing: the engine this mode
 *      installs still defaults to the same 80% the gate asks at, and the preset
 *      still mounts this row *above* `compaction-basic`
 *
 * The report lands in the OS temp dir (see LESSONS: a probe that writes the
 * workspace cannot run in the confined channel), plus one JSON line on stdout.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ASAR, LIB_DIR, PKG_DIR, installResolution, tempReport } from './paths.mjs';

const ASAR_DSH = path.join(ASAR, 'dsh');
// `DSH_PROBE_REPORT` lets a parent with no stdout pipe read the verdict (see
// `acceptance-probe.mjs` for why that matters to `debt-audit.mjs`).
const OUT = process.env.DSH_PROBE_REPORT ?? tempReport('compact-gate-report.json');
const CONTEXT_WINDOW = 100000;
const decisions = [];
const check = (id, item, name, ok, evidence) => decisions.push({ id, item, name, ok: ok === true, evidence });
const preview = (value, n = 400) => {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return String(text ?? '').length > n ? `${String(text).slice(0, n)}…` : String(text ?? '');
};

await installResolution();
const gate = await import(pathToFileURL(path.join(LIB_DIR, 'compact-gate.js')).href);

// --------------------------------------------------------------------- fixtures
const sessionFor = (id) => ({
  id,
  header: { cwd: os.tmpdir() },
  requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
});
const agentFor = (id) => ({ session: sessionFor(id), options: { provider: 'p', model: 'm' } });

/** A cordis-ish context: captures handlers, resolves services by name. */
function makeCtx(services = {}) {
  const handlers = new Map();
  const logs = [];
  const ctx = {
    handlers,
    logs,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    get(name) {
      return services[name];
    },
    logger: {
      info: (message) => logs.push({ level: 'info', message: String(message) }),
      warn: (message) => logs.push({ level: 'warn', message: String(message) }),
    },
  };
  return ctx;
}

function fakeCtx({ totalTokens = 65000, contextWindow = CONTEXT_WINDOW, modelInfo, answer, askError, meterThrows } = {}) {
  const asked = [];
  const info = modelInfo ?? { context: { contextWindow } };
  const services = {
    tokenMeter: {
      measure() {
        if (meterThrows === true) throw new Error('meter exploded');
        return { totalTokens, surfaceTokens: totalTokens };
      },
    },
    llm: { resolveModelInfo: async () => info },
    userQuestions: {
      async askTimed(request, callId, timeoutMs) {
        asked.push({ request, callId, timeoutMs });
        if (askError !== undefined) throw askError;
        return answer;
      },
    },
  };
  const ctx = makeCtx(services);
  ctx.asked = asked;
  return ctx;
}

/**
 * Drive the registered `agent/pre-step` handlers as the host waterfall does:
 * `next(patch)` merges `messages` into the payload the next handler sees, and the
 * chain ends on the loop's own `{ kind: 'enter', messages }` fallback.
 */
async function preStep(ctx, payload, fallback = (seen) => ({ kind: 'enter', messages: seen.messages ?? [] })) {
  const handlers = ctx.handlers.get('agent/pre-step') ?? [];
  let index = 0;
  const run = (current) => {
    if (index >= handlers.length) return Promise.resolve(fallback(current));
    const handler = handlers[index++];
    return Promise.resolve(handler(current, (patch) => run(patch === undefined ? current : { ...current, ...patch })));
  };
  return { decision: await run(payload) };
}

const noticesOf = (decision) =>
  (Array.isArray(decision?.messages) ? decision.messages : []).map((message) =>
    (Array.isArray(message?.content) ? message.content : []).map((block) => block?.text ?? '').join('\n'),
  );

/** Mount the gate the way the preset does, and return its context. */
function mount(config, options) {
  const ctx = fakeCtx(options);
  gate.apply(ctx, config);
  return ctx;
}

// ------------------------------------------------------- P: the pure policy
{
  /**
   * P1 tests the *library's* fallback, not the product's policy.
   *
   * The two are different on purpose, and conflating them is exactly what hid the real
   * failure: until 2026-10-03 this check compared the gate's library default with the
   * engine's default (0.8 vs 0.8), two copies of one number agreeing with each other,
   * while real sessions peaked at 79.86% and the gate never fired once. The mounted
   * boundary is whatever `cordis.patch.yml` declares — R5/R6 above hold it below the
   * ceiling real sessions reach — and this fallback only applies when `apply` is called
   * with no validated config at all (a unit-test or embedding path).
   */
  const limits = gate.resolveLimits(undefined);
  check(
    'P1',
    'pure',
    "with no validated config the library falls back to the engine's own 80%, warning ahead of it (the mounted policy comes from the preset: see R5/R6)",
    limits.warnRatio === 0.65 && limits.gateRatio === 0.8 && limits.marginRatio === 0.05,
    limits,
  );
  check(
    'P2',
    'pure',
    'a gate configured below the warning is raised to it, never below',
    gate.resolveLimits({ warnRatio: 0.7, gateRatio: 0.5 }).gateRatio === 0.7,
    gate.resolveLimits({ warnRatio: 0.7, gateRatio: 0.5 }),
  );
  const fresh = { warned: false, granted: undefined };
  check(
    'P3',
    'pure',
    'below warn is quiet, at warn it warns, at the gate it asks',
    gate.decideStage(0.5, limits, fresh) === 'quiet' &&
      gate.decideStage(0.65, limits, fresh) === 'warn' &&
      gate.decideStage(0.8, limits, fresh) === 'ask',
    [gate.decideStage(0.5, limits, fresh), gate.decideStage(0.65, limits, fresh), gate.decideStage(0.8, limits, fresh)],
  );
  const granted = { warned: true, granted: 0.8 };
  const stage = (value) => gate.decideStage(value, limits, granted);
  check(
    'P4',
    'pure',
    'a grant covers its own occupancy and the margin itself, and not the step past it',
    stage(0.84) === 'granted' && stage(0.85) === 'granted' && stage(0.855) === 'ask',
    {
      results: [stage(0.84), stage(0.85), stage(0.855)],
      // The reason the boundary is compared at a fixed precision rather than
      // with `<`: the human's own arithmetic is not exact in binary.
      naiveSum: 0.8 + 0.05,
    },
  );
  check(
    'P5',
    'pure',
    'a grant is a budget to spend, not a permanent exemption: a jump past the margin asks again',
    gate.decideStage(0.95, limits, { warned: true, granted: 0.76 }) === 'ask' &&
      gate.decideStage(0.805, limits, { warned: true, granted: 0.76 }) === 'granted' &&
      gate.decideStage(0.81, limits, { warned: true, granted: undefined }) === 'ask',
    [
      gate.decideStage(0.95, limits, { warned: true, granted: 0.76 }),
      gate.decideStage(0.805, limits, { warned: true, granted: 0.76 }),
      gate.decideStage(0.81, limits, { warned: true, granted: undefined }),
    ],
  );
  const occupancy = gate.occupancyOf({ totalTokens: 75000 }, CONTEXT_WINDOW);
  check(
    'P6',
    'pure',
    'occupancy is the ratio the engine prices, and an unknown window is no ratio',
    occupancy.ratio === 0.75 && gate.occupancyOf({ totalTokens: 75000 }, undefined) === undefined,
    { ratio: occupancy.ratio, withoutWindow: gate.occupancyOf({ totalTokens: 75000 }, undefined) ?? null },
  );
  const question = gate.gateQuestion(0.8, limits, 80000, CONTEXT_WINDOW);
  check(
    'P7',
    'pure',
    'the card carries the numbers and exactly the three options, in order',
    question.options.length === 3 &&
      question.options[0].label === '现在压缩' &&
      question.options[1].label === '让我继续' &&
      question.options[2].label === '写交接' &&
      question.question.includes('80%') &&
      question.question.includes('80,000'),
    { header: question.header, question: question.question, options: question.options.map((o) => o.label) },
  );
  const labels = question.options.map((option) => option.label);
  check(
    'P8',
    'pure',
    'an answer is read by index first, by label second, and anything else is no answer',
    gate.chosenAction({ answers: ['Write the handover', undefined, undefined] }, labels) === 2 &&
      gate.chosenAction({ answers: [1, undefined, undefined] }, labels) === 1 &&
      gate.chosenAction({ answers: [{ selected: ['Let me continue'] }, undefined, undefined] }, labels) === 1 &&
      gate.chosenAction({ answers: ['something else', undefined, undefined] }, labels) === -1 &&
      gate.chosenAction({}, labels) === undefined,
    {
      byLabel: gate.chosenAction({ answers: ['Write the handover'] }, labels),
      byIndex: gate.chosenAction({ answers: [1] }, labels),
      bySelected: gate.chosenAction({ answers: [{ selected: ['Let me continue'] }] }, labels),
      unknown: gate.chosenAction({ answers: ['something else'] }, labels),
      missing: gate.chosenAction({}, labels) ?? null,
    },
  );
}

// ------------------------------------------------- W: the warning stage, once
{
  const ctx = mount(undefined, { totalTokens: 66000 });
  const agent = agentFor('sess-warn');
  const first = await preStep(ctx, { agent, messages: [], turn: 1, step: 1, signal: { aborted: false } });
  const second = await preStep(ctx, { agent, messages: [], turn: 1, step: 2, signal: { aborted: false } });
  const first2 = noticesOf(first.decision);
  check(
    'W1',
    'warn',
    'the warning rides the step once and does not hold it',
    first.decision.kind === 'enter' && first2.length === 1 && first2[0].includes('[code-compact-gate]'),
    { kind: first.decision.kind, notices: first2.length, nextCalls: first.nextCalls },
  );
  check(
    'W2',
    'warn',
    'the second step over the same threshold is silent',
    noticesOf(second.decision).length === 0,
    { notices: noticesOf(second.decision).length },
  );
  const meter = ctx.get('tokenMeter');
  meter.measure = () => ({ totalTokens: 30000 });
  await preStep(ctx, { agent, messages: [], turn: 2, step: 1, signal: { aborted: false } });
  meter.measure = () => ({ totalTokens: 66000 });
  const again = await preStep(ctx, { agent, messages: [], turn: 3, step: 1, signal: { aborted: false } });
  check(
    'W3',
    'warn',
    'dropping back below warnRatio re-arms the warning for the next crossing',
    noticesOf(again.decision).length === 1,
    { notices: noticesOf(again.decision).length, memory: gate.gateMemory(agent) },
  );
  const warnings = noticesOf(again.decision);
  check(
    'W4',
    'warn',
    'the warning names the occupancy, the window and how far the gate is',
    warnings.length === 1 && warnings[0].includes('66%') && warnings[0].includes('100,000') && warnings[0].includes('80%'),
    warnings,
  );
}

// -------------------------------------------------- G: the gate stage and its answers
{
  const ctx = mount(undefined, { totalTokens: 82000, answer: { answers: ['Let me continue', undefined, undefined] } });
  const agent = agentFor('sess-gate-continue');
  const asked = await preStep(ctx, { agent, messages: [], turn: 1, step: 1, signal: { aborted: false } });
  check(
    'G1',
    'gate',
    'the question is asked before the step, with this session\'s numbers and a foreground wait',
    ctx.asked.length === 1 &&
      ctx.asked[0].request.questions[0].id === 'code-compact-gate' &&
      ctx.asked[0].request.questions[0].question.includes('82%') &&
      ctx.asked[0].timeoutMs === gate.HUMAN_WAIT_MS,
    { calls: ctx.asked.length, timeoutMs: ctx.asked[0]?.timeoutMs, question: ctx.asked[0]?.request.questions[0].question },
  );
  check(
    'G2',
    'gate',
    '"Let me continue" lets the step run untouched and grants the occupancy',
    asked.decision.kind === 'enter' && noticesOf(asked.decision).length === 0 && gate.gateMemory(agent).granted === 0.82,
    { memory: gate.gateMemory(agent), notices: noticesOf(asked.decision).length },
  );
  const quiet = await preStep(ctx, { agent, messages: [], turn: 1, step: 2, signal: { aborted: false } });
  check(
    'G3',
    'gate',
    'within the margin the gate does not ask again',
    ctx.asked.length === 1 && noticesOf(quiet.decision).length === 0,
    { calls: ctx.asked.length },
  );
  ctx.get('tokenMeter').measure = () => ({ totalTokens: 88000 });
  const again = await preStep(ctx, { agent, messages: [], turn: 1, step: 3, signal: { aborted: false } });
  check(
    'G4',
    'gate',
    'growing past the margin asks again',
    ctx.asked.length === 2 && again.decision.kind === 'enter',
    { calls: ctx.asked.length, memory: gate.gateMemory(agent) },
  );

  const handover = mount(undefined, { totalTokens: 82000, answer: { answers: ['Write the handover', undefined, undefined] } });
  const handoverAgent = agentFor('sess-gate-handover');
  const decided = await preStep(handover, { agent: handoverAgent, messages: [], turn: 1, step: 1, signal: { aborted: false } });
  const text = noticesOf(decided.decision)[0] ?? '';
  check(
    'G5',
    'gate',
    '"Write the handover" appends the closing instruction to the step instead of holding it',
    decided.decision.kind === 'enter' &&
      text.includes('Write the handover now') &&
      text.includes('code_record') &&
      text.includes('HANDOVER.md') &&
      text.includes('82%'),
    { kind: decided.decision.kind, instruction: preview(text, 220) },
  );
  check(
    'G6',
    'gate',
    'the handover instruction is labelled as the human\'s choice, not as the tool\'s own initiative',
    decided.decision.messages.at(-1)?.source?.kind === 'code-compact-gate' &&
      decided.decision.messages.at(-1)?.source?.form === 'instruction',
    decided.decision.messages.at(-1)?.source,
  );
  // The handover decision is about the rest of the session, not about one step:
  // it takes the same margin as "let me continue", so a human who has already
  // answered is not shown the card twice. Before 2026-10-03 this branch cleared
  // `granted`, so the very next step asked again. The fixture above measures 82,000
  // of a 100,000 window, so the grant is 0.82 — assert the value it was granted at,
  // not merely that it is set.
  check(
    'G7',
    'gate',
    '"Write the handover" takes the margin, so the next step does not ask again',
    gate.gateMemory(handoverAgent).granted === 0.82 && gate.gateMemory(handoverAgent).warned === false,
    { memory: gate.gateMemory(handoverAgent), measured: 0.82 },
  );
  const afterHandover = await preStep(handover, { agent: handoverAgent, messages: [], turn: 1, step: 2, signal: { aborted: false } });
  check(
    'G8',
    'gate',
    'within the handover\'s margin the step runs untouched: one decision, one card',
    handover.asked.length === 1 && afterHandover.decision.kind === 'enter' && noticesOf(afterHandover.decision).length === 0,
    { asked: handover.asked.length, kind: afterHandover.decision.kind, notices: noticesOf(afterHandover.decision).length },
  );
  // Re-arming `warned` is what keeps the handover from going silent: past the margin
  // the engine's own line is the next thing to arrive, and it must be announced.
  handover.get('tokenMeter').measure = () => ({ totalTokens: 90000 });
  const engineEdge = await preStep(handover, { agent: handoverAgent, messages: [], turn: 1, step: 3, signal: { aborted: false } });
  const edgeWarnings = noticesOf(engineEdge.decision);
  check(
    'G9',
    'gate',
    'past the margin the handover still warns once before the window runs out, rather than going silent',
    edgeWarnings.length === 1 && edgeWarnings[0].includes('[code-compact-gate]') && edgeWarnings[0].includes('90%'),
    { warnings: edgeWarnings.length, notice: preview(edgeWarnings[0], 160) },
  );

  const compact = mount(undefined, { totalTokens: 82000, answer: { answers: ['Compact now', undefined, undefined] } });
  const compactAgent = agentFor('sess-gate-compact');
  const passed = await preStep(compact, { agent: compactAgent, messages: [], turn: 1, step: 1, signal: { aborted: false } });
  check(
    'G7',
    'gate',
    '"Compact now" neither holds the step nor annotates it, and is handed to the engine',
    passed.decision.kind === 'enter' && noticesOf(passed.decision).length === 0 && compact.asked.length === 1,
    { kind: passed.decision.kind, notices: noticesOf(passed.decision).length, logs: compact.logs.map((l) => l.message) },
  );
}

// ------------------------------------------------------------- F: fail-open
{
  const timedOut = mount(undefined, { totalTokens: 82000, answer: { pending: true, callId: 'x' } });
  const timedOutAgent = agentFor('sess-f-timeout');
  const timedOutRun = await preStep(timedOut, { agent: timedOutAgent, messages: [], turn: 1, step: 1, signal: { aborted: false } });
  check(
    'F1',
    'fail-open',
    'an unanswered card falls through to the engine rather than holding the step forever',
    timedOutRun.decision.kind === 'enter' &&
      noticesOf(timedOutRun.decision).length === 0 &&
      timedOut.logs.some((l) => l.message.includes('nobody answered')),
    { kind: timedOutRun.decision.kind, logs: timedOut.logs.map((l) => l.message) },
  );

  const noService = makeCtx({ tokenMeter: { measure: () => ({ totalTokens: 82000 }) }, llm: { resolveModelInfo: async () => ({ context: { contextWindow: CONTEXT_WINDOW } }) } });
  gate.apply(noService, undefined);
  const noServiceRun = await preStep(noService, { agent: agentFor('sess-f-noservice'), messages: [], turn: 1, step: 1, signal: { aborted: false } });
  check(
    'F2',
    'fail-open',
    'no user-questions service at all is a fall-through, not a crash',
    noServiceRun.decision.kind === 'enter' && noService.logs.some((l) => l.level === 'warn'),
    { kind: noServiceRun.decision.kind, logs: noService.logs.map((l) => l.message) },
  );

  const refused = mount(undefined, {
    totalTokens: 82000,
    askError: Object.assign(new Error('no user-questions answerer accepted the request'), { code: 'NO_PROVIDER' }),
  });
  const refusedRun = await preStep(refused, { agent: agentFor('sess-f-noprovider'), messages: [], turn: 1, step: 1, signal: { aborted: false } });
  check(
    'F3',
    'fail-open',
    'a refused request (NO_PROVIDER) falls through with the code named in the log',
    refusedRun.decision.kind === 'enter' && refused.logs.some((l) => l.message.includes('NO_PROVIDER')),
    { kind: refusedRun.decision.kind, logs: refused.logs.map((l) => l.message) },
  );

  const odd = mount(undefined, { totalTokens: 82000, answer: { answers: ['maybe later', undefined, undefined] } });
  const oddRun = await preStep(odd, { agent: agentFor('sess-f-odd'), messages: [], turn: 1, step: 1, signal: { aborted: false } });
  check(
    'F4',
    'fail-open',
    'an unrecognised answer is logged as such and never guessed at',
    oddRun.decision.kind === 'enter' &&
      noticesOf(oddRun.decision).length === 0 &&
      odd.logs.some((l) => l.level === 'warn' && l.message.includes('unrecognised')),
    { kind: oddRun.decision.kind, logs: odd.logs.map((l) => l.message) },
  );

  const unknownWindow = mount(undefined, { totalTokens: 82000, modelInfo: { context: {} } });
  const unknownRun = await preStep(unknownWindow, {
    agent: agentFor('sess-f-nowindow'),
    messages: [],
    turn: 1,
    step: 1,
    signal: { aborted: false },
  });
  check(
    'F5',
    'fail-open',
    'an unknown context window produces no ratio, so no question is asked on a guess',
    unknownRun.decision.kind === 'enter' && unknownWindow.asked.length === 0,
    { kind: unknownRun.decision.kind, asked: unknownWindow.asked.length },
  );

  const broken = mount(undefined, { meterThrows: true });
  const brokenRun = await preStep(broken, { agent: agentFor('sess-f-broken'), messages: [], turn: 1, step: 1, signal: { aborted: false } });
  check(
    'F6',
    'fail-open',
    'a throwing token meter never holds a step',
    brokenRun.decision.kind === 'enter' && broken.asked.length === 0,
    { kind: brokenRun.decision.kind, asked: broken.asked.length },
  );

  const off = mount({ enabled: false }, { totalTokens: 95000 });
  const offRun = await preStep(off, { agent: agentFor('sess-f-off'), messages: [], turn: 1, step: 1, signal: { aborted: false } });
  check(
    'F7',
    'fail-open',
    'disabled means disabled: no question, no notice, whatever the occupancy',
    offRun.decision.kind === 'enter' && off.asked.length === 0 && off.handlers.get('agent/pre-step') === undefined,
    { handlers: off.handlers.get('agent/pre-step')?.length ?? 0 },
  );
}

// --------------------------------------- R: the timing this gate is built around
{
  const basicPath = path.join(ASAR_DSH, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib', 'index.js');
  const source = fs.readFileSync(basicPath, 'utf8');
  const threshold = /DEFAULT_THRESHOLD_RATIO = ([\d.]+)/.exec(source);
  // The engine's own default, pinned as the literal it is. Until 2026-10-03 this check
  // compared it with `gate.resolveLimits(undefined).gateRatio` — two library defaults
  // agreeing with each other, which is exactly the pair that hid the real failure: the
  // gate inherited 0.8 from the library, the engine used 0.8, both matched, and real
  // sessions peaked at 79.86% so neither ever ran. A check must assert the number, not
  // confirm that two defaults were copied from the same place.
  check(
    'R1',
    'regression',
    "the installed engine's own default pressure ratio is still the 80% this gate was written against",
    threshold !== null && Number(threshold[1]) === 0.8,
    { engineDefault: threshold?.[1] ?? null },
  );

  const presetPath = path.join(PKG_DIR, 'cordis.patch.yml');
  const preset = fs.readFileSync(presetPath, 'utf8');
  const gateAt = preset.indexOf('id: code-compact-gate');
  const basicAt = preset.indexOf('id: compaction-basic');
  check(
    'R2',
    'regression',
    'the preset mounts the gate before compaction-basic, so its handler runs first',
    gateAt >= 0 && basicAt >= 0 && gateAt < basicAt,
    { gateAt, basicAt, before: gateAt < basicAt, row: preset.slice(gateAt, gateAt + 80).split('\n')[0] },
  );

  /**
   * R5 and R6 exist because R1's old shape let the whole feature sit above real usage.
   *
   * Measured 2026-10-03 over 90 recorded sessions (`probes/gate-chance.mjs`): all of
   * them resolved a 1,000,000-token window, 28 peaked in the 75-80% band, the biggest
   * prompt ever recorded was 798,563 tokens (79.86%), and the gate had never been asked
   * once. So: the line must be inside the band real sessions reach, and it must stay
   * below the engine's own default — a gate at or above the engine's threshold is asked
   * only after the context it exists to protect has already been summarised.
   */
  const declared = (key) => {
    const match = new RegExp(`^\\s+${key}:\\s*([\\d.]+)\\s*$`, 'm').exec(preset);
    return match === null ? undefined : Number(match[1]);
  };
  const declaredGate = declared('gateRatio');
  const declaredWarn = declared('warnRatio');
  // The band real sessions reach. 0.8 is the top of the only band that occurs, and
  // nothing recorded has ever gone above it, so a line at 0.8 or higher is unreachable.
  check(
    'R5',
    'regression',
    'the preset asks below the ceiling real sessions actually reach, not at the engine default',
    declaredGate !== undefined && declaredGate < 0.8 && declaredWarn !== undefined && declaredWarn < declaredGate,
    { declaredGate: declaredGate ?? null, declaredWarn: declaredWarn ?? null, unreachableAtOrAbove: 0.8 },
  );

  /**
   * The declarations must be what the preset is *mounted* with, not just present in the
   * file: `resolveLimits` reads a config object, and a ratio written into the wrong
   * indent level would mount as `undefined` and silently fall back to the library
   * default the measurement just ruled out.
   */
  const gateLimits = gate.resolveLimits({ warnRatio: declaredWarn, gateRatio: declaredGate });
  check(
    'R6',
    'regression',
    'the declared ratios survive resolveLimits as the mounted boundary',
    gateLimits.gateRatio === declaredGate && gateLimits.warnRatio === declaredWarn && gateLimits.enabled,
    { gateLimits, declaredGate: declaredGate ?? null, declaredWarn: declaredWarn ?? null },
  );

  // Ordering inside a YAML list is delivery, not membership: the row has to be a
  // child of the *same* group the engine sits in, or the waterfall never sees it
  // before the engine does. Indentation is the only thing that says which list a
  // row belongs to, and the preset declares `!!js` tags that a generic YAML loader
  // rejects — so the indentation is read here rather than parsed.
  // `includes`, not a regex: every row in a list is indented, so `^- id: x$`
  // matches nothing here (measured — it cost a round trip to notice), and the
  // only thing this line has to identify is the group whose children follow.
  const lines = preset.replace(/\r\n?/g, '\n').split('\n');
  const compIndex = lines.findIndex((line) => line.trim() === '- id: compaction');
  const compIndent = compIndex < 0 ? 0 : /^ */.exec(lines[compIndex])[0].length;
  const children = [];
  for (let index = compIndex + 1; compIndex >= 0 && index < lines.length; index += 1) {
    const row = /^( *)- id: (.+?)\s*$/.exec(lines[index]);
    if (row === null) continue;
    if (row[1].length <= compIndent) break;
    children.push({ id: row[2].trim(), indent: row[1].length });
  }
  const childIds = children.map((entry) => entry.id);
  const gateChild = childIds.indexOf('code-compact-gate');
  const engineChild = childIds.indexOf('compaction-basic');
  check(
    'R4',
    'regression',
    'the gate is a child of the compaction group, ordered before the engine row',
    gateChild >= 0 && engineChild > gateChild && gateAt < basicAt,
    { children: childIds, gateChild, engineChild, compIndex, compIndent },
  );

  const engine = await import(pathToFileURL(basicPath).href);
  check(
    'R3',
    'regression',
    'the engine module the preset names is importable and exposes its default policy',
    typeof engine.default === 'function' || typeof engine.BasicCompactionEngine === 'function',
    { exports: Object.keys(engine) },
  );
}

// ------------------------------------------------------------------- report
const failed = decisions.filter((entry) => entry.ok !== true);
const summary = { total: decisions.length, passed: decisions.length - failed.length, failed: failed.map((entry) => entry.id) };
const report = { startedAt: new Date().toISOString(), contextWindow: CONTEXT_WINDOW, summary, checks: decisions };
try {
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
} catch (error) {
  report.notes = [`report not written: ${error?.message ?? error}`];
}
console.log(
  JSON.stringify({
    probe: 'compact-gate',
    passed: summary.passed,
    total: summary.total,
    failed: summary.failed,
    report: OUT,
  }),
);
for (const entry of decisions) {
  console.log(`${entry.ok === true ? 'PASS' : 'FAIL'} ${entry.id} [${entry.item}] ${entry.name} :: ${preview(entry.evidence, 260)}`);
}
if (failed.length > 0) process.exitCode = 1;
