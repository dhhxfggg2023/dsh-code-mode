/**
 * Does the *mounted* gate ask at this host's real line — 648,464 (64.85%) — and not at the
 * preset's 750,000 (75%)?
 *
 * The defect this project spent two sessions on was never in the policy: 35 stub checks
 * proved the policy self-consistent while the gate asked at `window × 0.75` and the engine
 * compacts at `min(window × 0.8, window − reserved − 65536)` = 678,464 (67.85%) on this host.
 * A card at 750,000 therefore could not appear, and none ever did across 124 sessions.
 *
 * What is covered elsewhere, and what is not:
 *   - `gate-ahead-of-engine.mjs` pins the *policy* (`lib/compact-policy.js`) against the
 *     engine's arithmetic and replays a recorded session; its A10 reads `lib/compact-gate.js`
 *     as **text** to see that the handler consults the mirrored line (`occupancy.askRatio`,
 *     `decideStage(...askRatio`). Reading text is not running code.
 *   - `handover-grant-probe.mjs` runs the real handler, but on a 100,000-token fixture with no
 *     reservation — a window the mirror deliberately declines, so the line it exercises is the
 *     declared 0.75, not the mirrored 0.6485.
 *
 * So nothing executed the handler on the numbers a real session on this host carries. This
 * probe does, and it reads those numbers off a real session log rather than restating them:
 *
 *     request/context → contextWindow 1,000,000
 *     request/header  → config.maxTokens 256,000   (the adapter's own default, so it holds
 *                                                  whether the header or `defaultMaxTokens`
 *                                                  supplies it)
 *
 * The stub mechanism is the one `handover-grant-probe.mjs` uses: `lib/compact-gate.js` has
 * exactly two bare specifiers, so replacing them lets the module's real `agent/pre-step`
 * handler run under plain node — the channel a normal session actually has.
 *
 * Read-only (report goes to the temp dir). Usage:
 *   node probes/gate-live-line.mjs [--log <session.v4.jsonl.zstd>] [--window N] [--reserved N]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

import { PKG_DIR, sessionLogs, tempReport } from './paths.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const OUT = process.env.DSH_PROBE_REPORT ?? tempReport('gate-live-line-report.json');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// --------------------------------------------------------------------- stubs
/** Chainable stand-in for schemastery, as `handover-grant-probe.mjs` builds it. */
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
const createUserMessage = ({ content, source }) => ({ role: 'user', content, source });

globalThis.__gateLiveStubs = { schemastery, createUserMessage };
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: `stub:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'stub:@deepseek-ai/schemastery') {
      return { format: 'module', shortCircuit: true, source: 'export default globalThis.__gateLiveStubs.schemastery;' };
    }
    if (url === 'stub:@deepseek-ai/dsh-llm') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const createUserMessage = globalThis.__gateLiveStubs.createUserMessage;',
      };
    }
    return nextLoad(url, context);
  },
});

const gate = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'compact-gate.js')).href);
const policy = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'compact-policy.js')).href);

// --------------------------------------------------------------------- live inputs
/** Session logs are a concatenation of independently compressed zstd frames. */
function decode(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 4 || !buf.subarray(0, 4).equals(MAGIC)) return buf.toString('utf8');
  const offsets = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offsets.push(i);
    i += 4;
  }
  const parts = [];
  for (let k = 0; k < offsets.length; k += 1) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(offsets[k], k + 1 < offsets.length ? offsets[k + 1] : buf.length)));
    } catch {
      /* a torn tail frame is not a reason to lose the log */
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

/**
 * The two numbers the gate is fed, taken from a real log — the newest one in this project's
 * session directory unless `--log` names one.
 */
function liveInputs() {
  const explicit = flag('--log');
  const candidate =
    explicit ?? sessionLogs().find((entry) => /--E-projects-dsh-code-mode--/i.test(entry.path))?.path;
  const fromFlags = { window: Number(flag('--window')), reserved: Number(flag('--reserved')) };
  if (candidate === undefined) return { ...fromFlags, source: 'flags (no session log found)' };
  let text;
  try {
    text = decode(candidate);
  } catch (error) {
    return { ...fromFlags, source: `flags (${candidate} unreadable: ${error?.message ?? error})` };
  }
  let window;
  let reserved;
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    const data = frame?.data ?? {};
    if (frame?.type === 'request/context') {
      const value = Number(data.contextWindow);
      if (Number.isFinite(value) && value > 0) window = value;
    }
    if (frame?.type === 'request/header') {
      const config = data.header?.config ?? data.config ?? data;
      const value = Number(config?.maxTokens);
      if (Number.isFinite(value) && value > 0) reserved = value;
    }
  }
  return {
    window: Number.isFinite(fromFlags.window) ? fromFlags.window : window,
    reserved: Number.isFinite(fromFlags.reserved) ? fromFlags.reserved : reserved,
    source: candidate,
  };
}

// --------------------------------------------------------------------- reporting
const results = [];
const check = (id, name, ok, evidence) => results.push({ id, name, ok: Boolean(ok), evidence });
const preview = (value, n = 300) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > n ? `${text.slice(0, n)}…` : text;
};

const LIVE = liveInputs();
const WINDOW = LIVE.window;
const RESERVED = LIVE.reserved;
const MOUNTED = { warnRatio: 0.6, gateRatio: 0.75, marginRatio: 0.05, askTimeoutMs: 120000, enabled: true };

check(
  'L1',
  'the window and the reservation come from a real session log on this host',
  Number.isFinite(WINDOW) && WINDOW > 0 && Number.isFinite(RESERVED) && RESERVED > 0,
  { source: LIVE.source, window: WINDOW ?? null, reserved: RESERVED ?? null },
);

/** The gate's own occupancy for one measurement, through the mounted module. */
const occupancyAt = (tokens) => gate.occupancyOf({ totalTokens: tokens }, WINDOW, RESERVED, MOUNTED.gateRatio);
const ASK_RATIO = occupancyAt(1)?.askRatio;
const ENGINE_TOKENS = occupancyAt(1)?.engineThreshold;
// `round`, not `floor`: `askTokens / window` is the same division the handler performs, so
// driving the handler at exactly this integer compares two bit-identical doubles and the line
// is `>=` rather than "just short of".
const ASK_TOKENS = Number.isFinite(ASK_RATIO) ? Math.round(ASK_RATIO * WINDOW) : undefined;

check(
  'L2',
  'the mounted module derives the mirrored line from those two numbers: ask 648,464 below engine 678,464',
  ASK_TOKENS === 648_464 && ENGINE_TOKENS === 678_464 && ASK_RATIO < MOUNTED.gateRatio,
  {
    askTokens: ASK_TOKENS ?? null,
    askRatio: Number.isFinite(ASK_RATIO) ? Number(ASK_RATIO.toFixed(6)) : null,
    askPercent: Number.isFinite(ASK_RATIO) ? policy.percent(ASK_RATIO) : null,
    engineTokens: ENGINE_TOKENS ?? null,
    engineRatio: ENGINE_TOKENS === undefined ? null : Number((ENGINE_TOKENS / WINDOW).toFixed(6)),
    declaredGateRatio: MOUNTED.gateRatio,
    gapTokens: ASK_TOKENS === undefined || ENGINE_TOKENS === undefined ? null : ENGINE_TOKENS - ASK_TOKENS,
  },
);

// ------------------------------------------------------- drive the real handler
const agentFor = (id) => ({
  session: {
    id,
    header: { cwd: PKG_DIR },
    // What the host hands back at request time: the recorded frame nests it under `header`.
    requestHeader: () => ({ header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: RESERVED } } }),
  },
});

/** A context good enough for the handler, with the adapter reporting the live window. */
function mount({ totalTokens, answer }) {
  const ctx = {
    asked: [],
    logs: [],
    handler: undefined,
    tokens: totalTokens,
    get(name) {
      if (name === 'tokenMeter') return { measure: () => ({ totalTokens: ctx.tokens }) };
      if (name === 'llm') {
        return { resolveModelInfo: async () => ({ context: { contextWindow: WINDOW }, defaultMaxTokens: RESERVED }) };
      }
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

/**
 * One step, modeled on the host's waterfall: `next` takes no parameters, the listener's
 * return value is the decision, and the gate appends its messages to the object `next()`
 * returned (see `handover-grant-probe.mjs` H6/H7 for why both details are load-bearing).
 */
const step = (ctx, agent) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const inner = { messages: [] };
    const next = () => {
      settled = true;
      return inner;
    };
    Promise.resolve(ctx.handler({ agent, signal: { aborted: false }, messages: [] }, next))
      .then((returned) => resolve({ kind: 'enter', payload: returned === undefined ? inner : returned }))
      .catch(reject);
    setImmediate(() => {
      if (!settled) resolve({ kind: 'hold' });
    });
  });
const notices = (decision) =>
  (decision.payload?.messages ?? []).flatMap((message) =>
    (message?.content ?? []).filter((part) => part?.type === 'text').map((part) => part.text),
  );

// L3 — at the line, the card is asked, and it quotes the mirrored number.
const atAgent = agentFor('sess-live-at-line');
const atCtx = mount({ totalTokens: ASK_TOKENS, answer: { answers: [0, undefined, undefined] } });
gate.apply(atCtx, MOUNTED);
const atStep = await step(atCtx, atAgent);
const question = atCtx.asked[0]?.request?.questions?.[0];
const questionText = String(question?.question ?? '');
check(
  'L3',
  'at 648,464 tokens the real handler asks, and the card quotes the line rather than 75%',
  atCtx.asked.length === 1 &&
    atStep.kind === 'enter' &&
    questionText.includes('648,464') &&
    questionText.includes('of 1,000,000 tokens') &&
    questionText.includes(policy.percent(ASK_RATIO)) &&
    !questionText.includes('75%'),
  {
    asked: atCtx.asked.length,
    step: atStep.kind,
    id: question?.id ?? null,
    header: question?.header ?? null,
    question: preview(questionText, 400),
    logs: atCtx.logs,
  },
);
check(
  'L4',
  'the card offers the three options in the contract order (the answer is read back by index)',
  Array.isArray(question?.options) &&
    question.options.map((option) => option.label).join('|') === 'Compact now|Let me continue|Write the handover',
  { options: question?.options?.map((option) => option.label) ?? null },
);

// L5 — one token below the line, no card: the warning is what fires there, and it names the
// same line. This is the boundary that makes L3 the line and not an accident of the fixture.
const belowAgent = agentFor('sess-live-below-line');
const belowCtx = mount({ totalTokens: ASK_TOKENS - 1, answer: { answers: [0, undefined, undefined] } });
gate.apply(belowCtx, MOUNTED);
const belowStep = await step(belowCtx, belowAgent);
const belowNotices = notices(belowStep);
check(
  'L5',
  'one token below the line nothing is asked, and the one-off warning names 65% as the ask line',
  belowCtx.asked.length === 0 &&
    belowNotices.length === 1 &&
    belowNotices[0].includes('[code-compact-gate]') &&
    belowNotices[0].includes(policy.percent(ASK_RATIO)) &&
    gate.gateMemory(belowAgent).warned === true,
  { asked: belowCtx.asked.length, notices: belowNotices.length, notice: preview(belowNotices[0] ?? '', 300) },
);

// L6 — the control: the pre-fix line could not have fired at that occupancy, so L3 is
// evidence about the mirror and not about the fixture being generous.
check(
  'L6',
  'control: the pre-fix 0.75 line sits above 648,464, so it could not have asked there',
  ASK_TOKENS < MOUNTED.gateRatio * WINDOW,
  { askTokens: ASK_TOKENS, preFixTokens: Math.round(MOUNTED.gateRatio * WINDOW) },
);

// L7 — the same line through the adapter's own default, for the steps where the request
// header declares no reservation: `header.maxTokens ?? info.defaultMaxTokens`.
{
  const viaDefault = gate.occupancyOf({ totalTokens: 1 }, WINDOW, RESERVED, MOUNTED.gateRatio)?.askRatio;
  const withoutHeader = (() => {
    const agent = agentFor('sess-live-default-reservation');
    agent.session.requestHeader = () => ({ header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } });
    const ctx = mount({ totalTokens: ASK_TOKENS, answer: { answers: [0, undefined, undefined] } });
    gate.apply(ctx, MOUNTED);
    return step(ctx, agent).then(() => ctx);
  })();
  const ctx = await withoutHeader;
  check(
    'L7',
    'with no reservation in the header, the adapter default supplies the same line',
    viaDefault === ASK_RATIO && ctx.asked.length === 1,
    { askRatio: Number.isFinite(viaDefault) ? Number(viaDefault.toFixed(6)) : null, asked: ctx.asked.length },
  );
}

// L8 — a compaction nobody announced. The host raises no event when the engine summarises the
// conversation, so the gate reads the cliff in the meter and tells the session what it lost.
{
  const agent = agentFor('sess-live-compacted');
  const ctx = mount({ totalTokens: 550_000, answer: { answers: [0, undefined, undefined] } });
  gate.apply(ctx, MOUNTED);
  const before = await step(ctx, agent);
  ctx.tokens = 200_000; // the engine replaced the middle of the conversation
  const after = await step(ctx, agent);
  const texts = notices(after);
  check(
    'L8',
    'a one-step drop of 100,000+ tokens is announced, and the session is told to re-read the ledger',
    notices(before).length === 0 &&
      texts.length === 1 &&
      texts[0].includes('[code-compact-gate]') &&
      texts[0].includes('just compacted') &&
      texts[0].includes('code_brief') &&
      after.kind === 'enter',
    { noticesBefore: notices(before).length, noticesAfter: texts.length, notice: preview(texts[0] ?? '', 320) },
  );
  // The control: the pruner trims a few thousand tokens all the time, and that is not a
  // compaction — a gate that announced one on every trim would be noise nobody reads.
  ctx.tokens = 195_000;
  const trimmed = await step(ctx, agent);
  check(
    'L9',
    'control: a small one-step trim is not announced as a compaction',
    notices(trimmed).every((text) => !text.includes('just compacted')),
    { notices: notices(trimmed).length, texts: notices(trimmed).map((text) => preview(text, 120)) },
  );
}

// --------------------------------------------------------------------- verdict
const failed = results.filter((row) => !row.ok);
const report = {
  passed: results.length - failed.length,
  total: results.length,
  failed: failed.map((row) => `${row.id} ${row.name}`),
  live: { source: LIVE.source, window: WINDOW, reserved: RESERVED },
  line: {
    askTokens: ASK_TOKENS,
    askRatio: Number.isFinite(ASK_RATIO) ? Number(ASK_RATIO.toFixed(6)) : null,
    askPercent: Number.isFinite(ASK_RATIO) ? policy.percent(ASK_RATIO) : null,
    engineTokens: ENGINE_TOKENS,
  },
  checks: results,
};
for (const row of results) console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.id} ${row.name}`);
console.log(`\n${report.passed}/${report.total} passed${failed.length === 0 ? '' : ` — failed: ${report.failed.join('; ')}`}`);
console.log(`line: ask ${report.line.askTokens} (${report.line.askPercent}) · engine ${report.line.engineTokens} · live ${WINDOW}/${RESERVED}`);
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`, 'utf8');
process.exitCode = failed.length === 0 ? 0 : 1;
