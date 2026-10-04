import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

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

/** The engine's own default, so the gate asks while the answer still matters. */
const WARN_RATIO = 0.65;
/**
 * The library's fallback, and *only* the fallback.
 *
 * The mounted policy is whatever `cordis.patch.yml` declares, and that is deliberately
 * not this number: the preset asks at 0.75 with the warning at 0.6, because a line at
 * 0.8 sits above the ceiling real sessions reach — measured 2026-10-03 over 90 recorded
 * sessions, all of them resolving a 1,000,000-token window, 28 peaking in the 75-80%
 * band, the biggest prompt ever recorded at 798,563 tokens, and this gate never once
 * asked. Anyone changing behaviour changes the preset; these constants only decide what
 * happens when `apply` is handed no validated config at all (a unit test, an embedding).
 */
const GATE_RATIO = 0.8;
const MARGIN_RATIO = 0.05;
const ASK_TIMEOUT_MS = 120000;
const NOTICE_MARKER = '[code-compact-gate]';
/** Sentinel for "the gate's own deadline fired", distinct from any answer a service can return. */
const TIMED_OUT = Symbol('code-compact-gate deadline');

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

/** Percent for a human, without pretending to a precision the meter does not have. */
export function percent(ratio) {
  return `${Math.round(ratio * 100)}%`;
}

/** Tokens left before the gate line, or undefined when capacity is unknown. */
export function remainingTokens(measurement, contextWindow, gateRatio) {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  return Math.max(0, Math.floor(contextWindow * gateRatio) - measurement);
}

/** Inlined so the gate still works when `apply` is called without validated config. */
export function resolveLimits(config) {
  const read = (value, fallback) => (Number.isFinite(value) ? value : fallback);
  const warnRatio = Math.max(0, read(config?.warnRatio, WARN_RATIO));
  const gateRatio = read(config?.gateRatio, GATE_RATIO);
  return {
    enabled: config?.enabled !== false,
    warnRatio,
    // A gate below the warning line would hold a step before it ever warned,
    // which is a configuration mistake rather than a policy: warn first.
    gateRatio: Math.max(gateRatio, warnRatio),
    marginRatio: Math.max(0, read(config?.marginRatio, MARGIN_RATIO)),
    askTimeoutMs: Math.max(1, read(config?.askTimeoutMs, ASK_TIMEOUT_MS)),
  };
}

/**
 * The whole policy as a pure function of the numbers, so a probe can drive it
 * without a host.
 *
 * @param ratio - occupancy as a fraction of the routed context window.
 * @param limits - resolved `warnRatio`/`gateRatio`/`marginRatio`.
 * @param memory - `{ warned, granted }` for this agent object.
 * @returns `'quiet'`, `'warn'`, `'ask'` or `'granted'`.
 */
export function decideStage(ratio, limits, memory) {
  if (ratio >= limits.gateRatio) {
    // A grant covers the occupancy it was given plus the margin, compared at a
    // millionth of the ratio. The rounding is load-bearing, not cosmetic: in
    // binary floating point `0.8 + 0.05` is `0.8500000000000001`, so a plain `<`
    // refuses to ask again until 86% after a human agreed to 85%. Measured
    // 2026-10-02 by compact-gate-probe P4/P5.
    const millionths = (value) => Math.round(value * 1e6);
    if (
      memory?.granted !== undefined &&
      millionths(ratio) <= millionths(memory.granted) + millionths(limits.marginRatio)
    ) {
      return 'granted';
    }
    return 'ask';
  }
  if (ratio >= limits.warnRatio && memory?.warned !== true) return 'warn';
  return 'quiet';
}

/** The one-off notice that lets a human finish on purpose rather than by accident. */
export function warningText(ratio, limits, measurement, contextWindow) {
  const left = remainingTokens(measurement, contextWindow, limits.gateRatio);
  return `${NOTICE_MARKER} context is at ${percent(ratio)} of the window (${measurement.toLocaleString()}${Number.isFinite(contextWindow) && contextWindow > 0 ? ` of ${contextWindow.toLocaleString()}` : ''} tokens).${
    left === undefined
      ? ''
      : ` At ${percent(limits.gateRatio)} — about ${left.toLocaleString()} tokens away — this session stops compressing on its own and asks instead.`
  } If this piece of work is close to done, it is cheaper to finish it or to write the handover now than to have the middle of it summarised away. If it is not close to done, keep working; this warning fires once.`;
}

/** The closing instruction appended when the human chooses the handover. */
export function handoverText(ratio) {
  return `${NOTICE_MARKER} the human chose to stop and hand over rather than compact (context at ${percent(ratio)}).

Write the handover now, before any further exploration.

**Scope it to what the next session cannot re-derive.** The ledger already carries the rest:
- how the project runs → \`project.json\`; the task in flight → \`tasks.json\` (\`kind="progress"\`);
- choices already made **and why** → \`decisions.md\`; what already failed → \`mistakes.md\`;
- what was run and what it printed → \`journal.jsonl\`.
Anything that fits those belongs in the ledger through \`code_record\` — not restated here.

**Include only:**
- the task in flight as a coordinate — which files, which commands, what is half-applied;
- what is finished and how it was verified, and what is finished but **unverified** (the distinction is the point);
- what is known broken or half-done, and the next concrete step;
- cautions the next session would otherwise walk into;
- facts the ledger does not already carry.

**Do not include:**
- a summary of this conversation, or a narrative of how you got here;
- approaches you tried and rejected — one line is enough, and only if it stops a repeat;
- tool output, command transcripts or file contents the next session can read for itself;
- token counts, restatements of the task title, or anything you are speculating about.

A handover is not a summary of the session; it is the part of it that is not yet in the ledger. Keep it proportional to that: if you find yourself narrating, stop and write the fact to the ledger instead.

Put it where the next session will find it: the project ledger through \`code_record\` (\`kind="progress"\` for the task in flight, \`kind="mistake"\` for what went wrong, \`kind="decision"\` for a choice the next session must not re-litigate) and \`HANDOVER.md\` for the prose a human reads. Then stop and say plainly what you did not verify. This session continues under its full context for now — the gate will not ask again until occupancy grows by another few percent — so the handover is the point at which a *new* conversation takes over rather than this one being summarised: say so, and let the human open it. Whatever this session forgets, the ledger is what survives.`;
}

/** The question card. The answer is read back by index, so this order is the contract. */
export function gateQuestion(ratio, limits, measurement, contextWindow) {
  const left = remainingTokens(measurement, contextWindow, limits.gateRatio);
  return {
    id: 'code-compact-gate',
    header: 'Context is at the compaction threshold',
    question:
      `This session has reached ${percent(ratio)} of its context window (${measurement.toLocaleString()}${
        Number.isFinite(contextWindow) && contextWindow > 0 ? ` of ${contextWindow.toLocaleString()}` : ''
      } tokens). Compressing now summarises the middle of the conversation away; not compressing spends the last of the window. ` +
      `${left === undefined ? '' : `${left.toLocaleString()} tokens remain before the hard ceiling. `}What should this session do?`,
    options: [
      { label: 'Compact now', description: 'Summarise now, as the session would have done on its own.' },
      {
        label: 'Let me continue',
        description: `Keep the full context; ask again after another ${percent(limits.marginRatio)} of occupancy.`,
      },
      {
        label: 'Write the handover',
        description: 'Write down what the next session needs, then open it as a new conversation.',
      },
    ],
  };
}

/**
 * Which option the human chose, by index first: the labels above are ours and in
 * our order, so an index is the one reading that cannot be wrong. A label (or a
 * nested `selected` label) is accepted as a fallback for a UI that answers by
 * text; anything else is "no answer" rather than a guess.
 */
export function chosenAction(result, options) {
  const first = Array.isArray(result?.answers) ? result.answers[0] : undefined;
  if (first === undefined || first === null) return undefined;
  if (typeof first === 'number' && Number.isInteger(first) && first >= 0 && first < options.length) return first;
  const inner = Array.isArray(first?.selected) ? first.selected[0] : undefined;
  const raw =
    typeof first === 'string'
      ? first
      : [inner, first?.label, first?.value, first?.answer, first?.id].find((value) => typeof value === 'string');
  if (typeof raw !== 'string') return undefined;
  const exact = options.indexOf(raw);
  if (exact >= 0) return exact;
  const needle = raw.trim().toLowerCase();
  return options.findIndex((option) => option.toLowerCase() === needle);
}

/** What one step needs to know: the occupancy, and the window it is a fraction of. */
export function occupancyOf(measurement, contextWindow) {
  const tokens = Number(measurement?.totalTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  return { measurement: tokens, contextWindow, ratio: tokens / contextWindow };
}

/**
 * The routed window: provider/model from the latest durable request header, the
 * actual capacity from the llm service. An unknown window yields no ratio at
 * all, because a guessed window is a wrong question.
 */
async function measure(ctx, agent, signal) {
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

  const config = session.requestHeader?.()?.config;
  const provider = config?.provider ?? agent?.options?.provider;
  const model = config?.model ?? agent?.options?.model;
  if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
    return occupancyOf({ totalTokens: tokens }, undefined);
  }
  try {
    const llm = ctx.get?.('llm');
    const info =
      typeof llm?.resolveModelInfo === 'function' ? await llm.resolveModelInfo(provider, model, signal) : undefined;
    return occupancyOf({ totalTokens: tokens }, info?.context?.contextWindow);
  } catch {
    // An adapter that cannot price the model leaves no window to be a fraction
    // of, which is the same as unmeasurable: the engine keeps its own default.
    return occupancyOf({ totalTokens: tokens }, undefined);
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
      occupancy = await withDeadline(measure(ctx, agent, signal), limits.askTimeoutMs);
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
      if (occupancy.ratio < limits.warnRatio) {
        memory.warned = false;
        memory.granted = undefined;
      }
      stage = decideStage(occupancy.ratio, limits, memory);
    } catch {
      /* a broken measurement is never a reason to hold a step */
      return next();
    }
    if (stage === 'granted' || stage === 'quiet') return next();

    const { measurement, contextWindow, ratio } = occupancy;
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
            content: [{ type: 'text', text: warningText(ratio, limits, measurement, contextWindow) }],
            source: { kind: 'code-compact-gate', form: 'notice', summary: `context at ${percent(ratio)} of the window` },
          }),
        ],
      };
    }

    // The gate itself: ask before the step runs, so the step runs under the
    // answer rather than being explained after the fact.
    const question = gateQuestion(ratio, limits, measurement, contextWindow);
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
        `${NOTICE_MARKER} human kept the context at ${percent(ratio)}; the next question comes after ${percent(ratio + limits.marginRatio)}`,
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
      // TEMP DIAG (removed in the same session): why is the appended instruction absent?
      if (process.env.DSH_COMPACT_GATE_DIAG === '1') {
        console.error(
          `[gate-diag] action=2 decisionType=${typeof decision} hasMessages=${String(Array.isArray(decision?.messages))} keys=${JSON.stringify(Object.keys(decision ?? {}))}`,
        );
      }
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
