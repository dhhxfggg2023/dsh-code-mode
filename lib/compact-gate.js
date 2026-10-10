import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  ASK_TIMEOUT_MS,
  ENGINE_MARGIN_TOKENS,
  ENGINE_HEADROOM_TOKENS,
  ENGINE_THRESHOLD_RATIO,
  GATE_RATIO,
  MARGIN_RATIO,
  MIN_ASK_RATIO,
  NOTICE_MARKER,
  TIMED_OUT,
  WARN_AHEAD_RATIO,
  WARN_RATIO,
  chosenAction,
  decideStage,
  effectiveAskLine,
  gateQuestion,
  handoverText,
  percent,
  resolveLimits,
  warningText,
} from './compact-policy.js';
/**
 * Re-exported for the probes that were written against this file's surface before the
 * policy moved out (`compact-gate-probe.mjs` imports both the plugin and its pure
 * functions). The arithmetic itself lives in `compact-policy.js`, which a plain-node
 * probe can import — the point of the split.
 */
export {
  engineThresholdTokens,
  effectiveAskLine,
  resolveLimits,
  decideStage,
  warningText,
  handoverText,
  gateQuestion,
  chosenAction,
  percent,
} from './compact-policy.js';

/**
 * The compaction gate: at the pressure threshold, ask the human instead of
 * compacting silently.
 *
 * Why this exists. The built-in engine (`@deepseek-ai/dsh-compaction-basic`)
 * compacts automatically from `agent/pre-step` whenever the routed request
 * reaches `min(contextWindow × 0.8, messageBudget − headroomTokens)`. That is
 * the right default for a long session and the wrong one at the end of a piece
 * of work: a summary the human did not ask for throws away the exact context the
 * last few edits need, and it is paid for at the worst moment — the remaining
 * 20% was still enough to finish, or enough to write down what finishing needs.
 * Measured on this machine (2026-10-02): `DEFAULT_THRESHOLD_RATIO = .8` at
 * `dsh-compaction-basic/lib/index.js:15`, the trigger at `:839`/`:940`.
 *
 * So: two stages, both on `agent/pre-step`, and this row sits above
 * `compaction-basic` in the preset so its handler runs first.
 *
 * 1. **Warn** (`warnRatio`, default 0.65) — one notice, once per crossing, into
 *    the step's own context. Nothing is blocked; the model can start closing the
 *    loop while there is still a budget to close it with.
 * 2. **Gate** (`gateRatio`, default 0.8, the value the engine itself uses) — the
 *    step is held and the human is asked: compact now, keep going, or write the
 *    handover. `keep going` remembers the occupancy it was granted at and stays
 *    quiet until the ratio grows by `marginRatio` — a question asked every step
 *    is a question the human answers without reading it. `write the handover`
 *    appends the closing instruction to that same step and then takes the same
 *    margin (`memory.granted`), because a handover is a decision about the *rest*
 *    of the session, not about one step: the next step is still over the line, and
 *    asking again would put a card in front of a human who has already said what
 *    they want. The margin expires on its own as occupancy grows, and the engine's
 *    own line is untouched below, so the backstop still arrives if nobody acts.
 *
 *    The handover is also the one place that re-arms the warning: the human chose
 *    "write down what the next session needs", not "never mention the window
 *    again", so the next crossing warns once before the engine compacts.
 *
 * What it deliberately does not do:
 * - It never compacts and never decides for the human. `compact now` is the
 *   engine's own handler doing exactly what it would have done — the gate has no
 *   compaction path of its own, so it cannot produce one the engine would not.
 * - It never holds a step because it could not ask. No answerer, a dead UI, a
 *   timeout, an unrecognised answer or any internal error falls through to the
 *   engine (`fail-open`), because a gate that bricks a turn is worse than the
 *   compaction it prevents.
 * - The handover instruction is a notice, not an enforcement: a model that
 *   ignores notices has ignored a notice, and the ledger is still the durable
 *   half (`code_record`) that survives whatever this turn forgot.
 */

export const name = 'code-compact-gate';

/**
 * No `inject` on purpose, and this is the one place this plugin departs from the
 * house style. `inject` is a mount precondition: a plugin that injects a missing
 * service does not mount at all. Every dependency here is one whose absence must
 * be *survivable* — a session with no `userQuestions` has no answerer, a session
 * whose `llm` cannot price the model has no window to measure — and the whole
 * design is that such a session keeps the engine's ordinary compaction instead of
 * losing the gate's mount. So every dependency is read through `ctx.get` at event
 * time (`tokenMeter`, `llm`, `userQuestions`) and every one of them missing is a
 * fall-through to the engine rather than a failure.
 */

export const Config = z.object({
  /** Turn the gate off without unmounting it. */
  enabled: z.boolean().default(true),
  /** Occupancy that earns the one-off closing notice; 0 disables the warning. */
  warnRatio: z.number().default(WARN_RATIO),
  /** Occupancy that holds the step and asks; below `warnRatio` it is raised to it. */
  gateRatio: z.number().default(GATE_RATIO),
  /** How much more occupancy buys another question after a `keep going`. */
  marginRatio: z.number().default(MARGIN_RATIO),
  /** Foreground wait for the human, in milliseconds; the gate falls open after it. */
  askTimeoutMs: z.number().default(ASK_TIMEOUT_MS),
});

/**
 * What one step needs to know: the occupancy, the window it is a fraction of, and —
 * when the capacity is known — the line the *engine* will compact on.
 *
 * `reservedCompletionTokens` is passed in rather than read here because it must come
 * from the same request header the engine reads, at the same moment; a pure function
 * keeps that visible.
 *
 * @param measurement - `{ totalTokens }` from the token meter.
 * @param contextWindow - the adapter's capacity for the routed model, or undefined.
 * @param reservedCompletionTokens - output tokens one request reserves, or undefined.
 * @param gateRatio - the configured ceiling for the ask line.
 */

export function occupancyOf(measurement, contextWindow, reservedCompletionTokens, gateRatio = GATE_RATIO) {
  const tokens = Number(measurement?.totalTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  const ask = effectiveAskLine(contextWindow, reservedCompletionTokens, gateRatio);
  return {
    measurement: tokens,
    contextWindow,
    ratio: tokens / contextWindow,
    askRatio: ask?.ratio,
    engineThreshold: ask?.engineThreshold,
  };
}

/**
 * The routed window: provider/model from the latest durable request header, the
 * actual capacity from the llm service. An unknown window yields no ratio at
 * all, because a guessed window is a wrong question.
 */
async function measure(ctx, agent, signal, gateRatio) {
  const meter = ctx.get?.('tokenMeter');
  if (meter === undefined || typeof meter.measure !== 'function') return undefined;
  const session = agent?.session;
  if (session === undefined) return undefined;
  let measurement;
  try {
    measurement = meter.measure(session);
  } catch {
    return undefined;
  }
  const tokens = Number(measurement?.totalTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined;

  // The routed config, in either shape the host has handed back: `requestHeader()` returning
  // the config itself, or wrapping it as `{ header: { config } }` — the second is what the
  // recorded `request/header` frame carries (`data.header.config`), measured 2026-10-10.
  // Getting this wrong is not cosmetic: the reservation (`maxTokens: 256000` in that
  // session) is exactly what moves the engine's line from 80% to 67.8%.
  const requestHeader = session.requestHeader?.();
  const header = requestHeader?.config ?? requestHeader?.header?.config;
  const provider = header?.provider ?? agent?.options?.provider;
  const model = header?.model ?? agent?.options?.model;
  if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
    return occupancyOf({ totalTokens: tokens }, undefined, undefined, gateRatio);
  }
  try {
    const llm = ctx.get?.('llm');
    const info =
      typeof llm?.resolveModelInfo === 'function' ? await llm.resolveModelInfo(provider, model, signal) : undefined;
    // The engine's own two inputs, read exactly where it reads them
    // (`dsh-compaction-basic/lib/index.js:757-758`, `:940`): the request's reservation
    // first, the adapter's default second. Both are optional, and an unknown one is 0 —
    // the direction that makes this gate ask *earlier*, never later.
    const reserved = Number(header?.maxTokens ?? info?.defaultMaxTokens);
    return occupancyOf(
      { totalTokens: tokens },
      info?.context?.contextWindow,
      Number.isFinite(reserved) ? reserved : undefined,
      gateRatio,
    );
  } catch {
    // An adapter that cannot price the model leaves no window to be a fraction
    // of, which is the same as unmeasurable: the engine keeps its own default.
    return occupancyOf({ totalTokens: tokens }, undefined, undefined, gateRatio);
  }
}

/** Per-agent gate memory, weak so it dies with the agent. */
const state = new WeakMap();
export function gateMemory(agent) {
  let record = state.get(agent);
  if (record === undefined) {
    record = { warned: false, granted: undefined };
    state.set(agent, record);
  }
  return record;
}

/**
 * Race one dependency call against the gate's own foreground budget.
 *
 * `askTimeoutMs` used to be *told to* the answerer and never enforced here, so whether a
 * step was released depended on the other side honouring it: an answerer that never
 * answers held the step forever, and so did an adapter whose `resolveModelInfo` never
 * settles — the one outcome the contract above rules out. Measured 2026-10-04 by
 * `.dsh-code/audits/probe-compact-open.mjs` (C8 `held`, C9 `held`) and by
 * `.dsh-code/audits/probe-gate-deadline.mjs`, whose D1/D7 flip from `held` to `released`
 * once this bound exists; D9 there is the control — with the mounted 120000 ms the same
 * hang is still pending at the probe's 400 ms window, so the bound is the configured
 * value and not a shorter constant invented here.
 *
 * The timer is `unref`ed and cleared the moment the call settles: a process that mounts
 * the gate with a never-settling dependency must still be able to exit, and the host must
 * not accumulate one pending handle per step.
 */
function withDeadline(call, ms) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref?.();
  });
  return Promise.race([call, expired]).finally(() => clearTimeout(timer));
}

/**
 * The one way this handler is allowed to log.
 *
 * Every line below sits on a path whose whole job is to release the step, and an
 * exception thrown out of an `agent/pre-step` listener ends the turn — the opposite of
 * failing open. `ctx.logger` is supplied by whoever built the context, not by this file,
 * so the call is guarded: measured 2026-10-04, a logger that throws on `warn` turned the
 * fail-open path into `Error: logger exploded` (probe C20, and D11/D14 here).
 */
function notify(ctx, level, message) {
  try {
    ctx.logger?.[level]?.(message);
  } catch {
    /* a logger that throws must not turn a fail-open path into a failed turn */
  }
}

/**
 * A one-line description of a value the gate did not recognise, which cannot itself throw.
 *
 * `JSON.stringify(answer ?? null)` was a way to lose the turn: a cyclic answer
 * (`Converting circular structure to JSON`) and a BigInt (`Do not know how to serialize a
 * BigInt`) both threw out of the branch whose whole purpose is to fall open (probes C21,
 * C22, D12, D13) — and the value comes from a service this file does not own.
 */
function describe(value) {
  try {
    const seen = new WeakSet();
    const text = JSON.stringify(value ?? null, (_key, item) => {
      if (typeof item === 'bigint') return `${item}n`;
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[circular]';
        seen.add(item);
      }
      return item;
    });
    return typeof text === 'string' ? text : `[unprintable ${typeof value}]`;
  } catch {
    // `toJSON`, a getter or a proxy can throw: the log line still may not.
    return `[unprintable ${typeof value}]`;
  }
}

/** @param ctx - plugin context; listeners are scoped to it and disposed with it. */
export function apply(ctx, config) {
  const limits = resolveLimits(config);
  if (!limits.enabled) return;

  ctx.on('agent/pre-step', async ({ agent, signal, messages: payloadMessages }, next) => {
    let stage;
    let occupancy;
    try {
      occupancy = await withDeadline(measure(ctx, agent, signal, limits.gateRatio), limits.askTimeoutMs);
      if (occupancy === TIMED_OUT) {
        // The model lookup is the first unbounded await on this path: an adapter that
        // never answers prices nothing, and a step held while it hangs is exactly what
        // the contract at the top of this file rules out (probe C9 `held`, D7).
        notify(
          ctx,
          'info',
          `${NOTICE_MARKER} could not price the model within ${limits.askTimeoutMs} ms; falling through to the engine`,
        );
        return next();
      }
      if (occupancy === undefined) return next();
      const memory = gateMemory(agent);
      /**
       * The lines this step is judged against. The ask line is mirrored from the engine's
       * own arithmetic; the warning line is pulled below it when the preset's declaration
       * and the derived line would otherwise cross, because a warning that fires *after* the
       * card is a warning nobody needed (see `WARN_AHEAD_RATIO`).
       */
      const askRatio = Number.isFinite(occupancy.askRatio) ? occupancy.askRatio : limits.gateRatio;
      const warnRatio = Math.max(0, Math.min(limits.warnRatio, askRatio - WARN_AHEAD_RATIO));
      if (occupancy.ratio < warnRatio) {
        memory.warned = false;
        memory.granted = undefined;
      }
      stage = decideStage(occupancy.ratio, { ...limits, warnRatio, askRatio }, memory);
    } catch {
      /* a broken measurement is never a reason to hold a step */
      return next();
    }
    if (stage === 'granted' || stage === 'quiet') return next();

    const { measurement, contextWindow, ratio } = occupancy;
    // The line this step's decision is measured against: the engine-mirrored one when it
    // could be derived, the configured ratio otherwise. Every message below quotes this,
    // so the human is never told a number the gate is not actually using.
    const askRatio = Number.isFinite(occupancy.askRatio) ? occupancy.askRatio : limits.gateRatio;
    const stepLimits = { ...limits, askRatio, engineThreshold: occupancy.engineThreshold };
    const memory = gateMemory(agent);

    // One warning per crossing, never a hold.
    if (stage === 'warn') {
      memory.warned = true;
      // The notice is APPENDED to what the step decided, never passed to `next()`.
      //
      // This host's waterfall builds `next` with no parameters at all
      // (`cordis/src/events.ts:237` — `const next = () => { const cb = cbs.shift() ?? inner;
      // return cb(...args) }` — the original `args`, not the caller's), so `next({messages})`
      // silently discards the patch: the warning was never delivered while the gate still
      // looked alive, because the question below is asked through the question service
      // rather than through the return value. Measured 2026-10-04: across all 110 session
      // logs `code-compact-gate` appears as a message source **0** times, while the two
      // sibling modules that use the append form (`gate-verify.js:275`, `pit-guard.js:495`)
      // appear 1398 and 8 times — the detector works, these two returns did not.
      const decision = await next();
      if (!Array.isArray(decision?.messages)) return decision;
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text: warningText(ratio, stepLimits, measurement, contextWindow) }],
            source: { kind: 'code-compact-gate', form: 'notice', summary: `context at ${percent(ratio)} of the window` },
          }),
        ],
      };
    }

    // The gate itself: ask before the step runs, so the step runs under the
    // answer rather than being explained after the fact.
    const question = gateQuestion(ratio, stepLimits, measurement, contextWindow);
    const questions = ctx.get?.('userQuestions');
    let answer;
    try {
      if (questions === undefined || typeof questions.askTimed !== 'function') throw new Error('no user-questions service');
      // The ask is raced against `limits.askTimeoutMs` rather than trusting the answerer
      // to honour the number it is handed: the parameter made a *request*, this makes a
      // bound. A deadline that fires releases the step and says so (probe C8 `held`
      // before, D1/D2/D3 after; D8 shows that an answer arriving after the deadline is
      // not acted on, and D9 that the bound is this configured value).
      answer = await withDeadline(
        questions.askTimed(
          { questions: [question], agent, signal },
          `code-compact-gate-${Date.now().toString(36)}`,
          limits.askTimeoutMs,
        ),
        limits.askTimeoutMs,
      );
    } catch (error) {
      notify(
        ctx,
        'warn',
        `${NOTICE_MARKER} could not ask (${error?.code ?? error?.message ?? error}); falling through to the engine`,
      );
      return next();
    }
    if (answer === TIMED_OUT) {
      notify(
        ctx,
        'warn',
        `${NOTICE_MARKER} nobody answered within ${limits.askTimeoutMs} ms; falling through to the engine`,
      );
      return next();
    }
    if (answer !== undefined && answer !== null && answer.pending === true) {
      notify(ctx, 'info', `${NOTICE_MARKER} nobody answered within ${limits.askTimeoutMs} ms; falling through to the engine`);
      return next();
    }

    const action = chosenAction(answer, question.options.map((option) => option.label));
    if (action === 1) {
      memory.granted = ratio;
      notify(
        ctx,
        'info',
        `${NOTICE_MARKER} human kept the context at ${percent(ratio)}; the next question comes after ${percent(ratio + stepLimits.marginRatio)}`,
      );
      return next();
    }
    if (action === 2) {
      // Same margin as "let me continue": the human decided how the session ends,
      // and the step after this one is still over the line. Clearing `granted`
      // here would ask a second time about a decision already made.
      memory.granted = ratio;
      // ...but the handover is not permission to stop mentioning the window. Re-arm
      // the one-off warning so the next crossing still says the engine is about to
      // compact — silently letting it happen is the omission this file exists to
      // prevent.
      memory.warned = false;
      // Appended, for the same reason as the warning above: the host's `next` takes no
      // arguments, so the instruction the human just chose was being thrown away. This is
      // the branch that made the whole feature look functional — the card is asked and the
      // answer consumes the margin, so nothing fails; the instruction simply never arrives.
      const decision = await next();
      if (!Array.isArray(decision?.messages)) return decision;
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text: handoverText(ratio) }],
            source: { kind: 'code-compact-gate', form: 'instruction', summary: 'human chose the handover' },
          }),
        ],
      };
    }
    if (action === 0) {
      // The engine's own handler is still ahead of us in this waterfall, so
      // letting the step through *is* "compact now" — at the engine's threshold,
      // with the engine's retention and its own retry policy.
      notify(ctx, 'info', `${NOTICE_MARKER} human chose to compact at ${percent(ratio)}`);
      return next();
    }
    // No recognisable answer is not a decision: fall open and say so, rather
    // than guessing which of the three the human meant.
    notify(ctx, 'warn', `${NOTICE_MARKER} unrecognised answer ${describe(answer)}; falling through to the engine`);
    return next();
  });
}
