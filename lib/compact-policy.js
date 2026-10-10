/**
 * The compaction gate's policy, as pure functions — no imports, no host, no side effects.
 *
 * This file exists because of a defect that survived two user reports. The gate's 35 probe
 * checks all drove *stubs* (they had to: importing the plugin under plain `node` fails on
 * `@deepseek-ai/schemastery`), so every check proved the policy was self-consistent and
 * none could see the number that actually decided the outcome — the line the **engine**
 * compacts on. It took reading real session logs (2026-10-10) to see that the engine's
 * line was *below* the gate's ask line, so the card never appeared at all.
 *
 * Splitting the arithmetic out is the structural half of that lesson: the policy is now
 * importable and testable by a plain-node probe, so a probe can compare the gate's line
 * with the engine's instead of only with itself.
 *
 * The plugin row (`compact-gate.js`) keeps the host I/O: reading `tokenMeter`, `llm` and
 * `userQuestions`, holding the step, and appending notices.
 */

/** The warning line's fallback, when the preset declares nothing. */
export const WARN_RATIO = 0.65;
/**
 * The ask line's fallback, and *only* the fallback.
 *
 * The mounted policy is whatever `cordis.patch.yml` declares. These constants decide what
 * happens when `apply` is handed no validated config at all (a unit test, an embedding).
 */
export const GATE_RATIO = 0.8;
/** How much more occupancy buys another question after a `keep going`. */
export const MARGIN_RATIO = 0.05;
/** Foreground wait for the human, in milliseconds; the gate falls open after it. */
export const ASK_TIMEOUT_MS = 120000;
/** Marks every notice this gate emits, so a log can tell its output from its source. */
export const NOTICE_MARKER = '[code-compact-gate]';
/** Sentinel for "the gate's own deadline fired", distinct from any answer a service can return. */
export const TIMED_OUT = Symbol('code-compact-gate deadline');

/**
 * The engine's *capacity* line, mirrored so the gate can ask before it fires.
 *
 * Read out of the installed engine on 2026-10-10
 * (`node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js`, functions
 * `resolveCompactSpec:124-147` and `reservedCompletionTokens:757-758`):
 *
 *     messageBudget   = contextWindow − reservedCompletionTokens
 *     pressureBudget  = messageBudget − headroomTokens
 *     thresholdTokens = floor(min(contextWindow × thresholdRatio, pressureBudget))
 *
 * with `thresholdRatio = .8` (`DEFAULT_THRESHOLD_RATIO:15`), `headroomTokens = 65536`
 * (`:63`), and `reservedCompletionTokens = session.requestHeader()?.config.maxTokens
 * ?? info.defaultMaxTokens ?? 0` — the adapter supplies `defaultMaxTokens`
 * (`dsh-llm-deepseek/lib/index.js:514`), so at request time the second term is usually the
 * *smaller* one and the real line is under 80%.
 *
 * This is the defect the gate shipped with. It asked at `window × gateRatio` (0.75) while
 * the engine compacts at `window × 0.8` **clamped down by that subtraction** — measured
 * 2026-10-10 on this host: 124 session logs, the gate's card asked **zero** times, the only
 * two traces were 60% warnings, and the one session that compacted with the gate mounted
 * was compacted at 68.22% (682,185 of 1,000,000) with the ask line never reached. A gate
 * whose line sits above the engine's is a gate that never speaks.
 */
export const ENGINE_THRESHOLD_RATIO = 0.8;
export const ENGINE_HEADROOM_TOKENS = 65536;
/**
 * How long before the engine's line the human must be asked.
 *
 * Not a decoration: "let me continue" does **not** suppress the engine (the handler returns
 * into the same waterfall the engine is next in), so a card shown *on* the engine's line
 * buys a decision whose consequence arrives immediately. Asked this far ahead, the human
 * has room to finish the thought or to write the handover — the option this gate exists to
 * offer. 30,000 tokens is about one long step of this project's real traffic.
 */
export const ENGINE_MARGIN_TOKENS = 30000;
/**
 * Never ask below this share of the window: an absurd reservation (a model priced at a tiny
 * context, a `maxTokens` larger than the window) must not turn every step into a card.
 */
export const MIN_ASK_RATIO = 0.3;
/**
 * How far ahead of the ask line the one-off warning must stay.
 *
 * On 2026-10-10 the mirrored ask line on this host came out at 64.85% — *below* the preset's
 * 60%-warning-plus-nothing-in-between assumption would allow for, because the engine's line
 * moved down with the request's 256,000-token reservation. With the warning fixed at 60% and
 * the ask at 64.85%, a session could step straight from 59% to 66% and be shown the card with
 * the warning never having fired: the notice that exists to say "the engine is about to
 * compact, finish or hand over" would be skipped exactly when it mattered.
 *
 * So the effective warning line is pulled below the ask line by this much when they would
 * otherwise collide. The configured `warnRatio` stays the declaration; this only decides the
 * case where the declaration and the derived ask line cross.
 */
export const WARN_AHEAD_RATIO = 0.05;
/**
 * Below this share of the window, the mirrored line is not a line — it is the engine's fixed
 * 65,536-token headroom eating a window too small to be measured this way.
 *
 * Measured 2026-10-10 on the fixture the older probe uses: a 100,000-token window with no
 * declared reservation puts the engine's line at 34,464 (34%), because `window − 0 − 65536`
 * is what `min` picks. Deriving an ask line from that would hold a step at 30% of a small
 * window — a card in the middle of ordinary work, which is worse than the defect it fixes.
 * The mirror therefore declines, the configured `gateRatio` stands, and the gate behaves as
 * it did before the mirror existed. Every real session on this host resolves 1,000,000 tokens
 * and is unaffected.
 */
export const MIN_ENGINE_LINE_RATIO = 0.5;
/**
 * How large a one-step drop in occupancy has to be to mean "the engine just compacted".
 *
 * Nothing on this host *announces* a compaction. The gate is the only row that measures every
 * step, so the cliff in the meter is the whole signal — and it is unambiguous in practice: the
 * tool-result pruner trims results by a few thousand tokens, while a compaction replaces the
 * middle of the conversation and lands a drop an order of magnitude larger.
 *
 * This is the half of the compaction story this project was missing. `probes/gate-ahead-of-engine`
 * and the ask/warn path make sure a human is *asked* before the engine fires, and the handover
 * instruction covers the case where the human answers "write the handover". Neither covers the
 * case that actually happened here: the engine fires on its own (no answerer, a deadline, a
 * session nobody is watching) and the model keeps working on a summary it mistakes for memory.
 */
export const COMPACTION_DROP_TOKENS = 100000;

/** Percent for a human, without pretending to a precision the meter does not have. */
export function percent(ratio) {
  return `${Math.round(ratio * 100)}%`;
}

/** Tokens left before a line, or undefined when capacity is unknown. */
export function remainingTokens(measurement, contextWindow, ratio) {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  return Math.max(0, Math.floor(contextWindow * ratio) - measurement);
}

/**
 * Tokens left before the *engine* compacts on its own, or undefined when that line is unknown.
 *
 * This is the number a human at the decision point actually needs. The first version of the
 * card quoted `remainingTokens(..., askRatio)` instead — which is 0 at the very instant the card
 * appears, so the card told the reader "0 tokens remain before the hard ceiling" while the
 * session in fact had the whole 30,000-token margin before anything would be summarised.
 * A card that names the wrong ceiling is the same defect as a card that names the wrong line,
 * and this file exists because of that one (see the header).
 */
export function engineRemainingTokens(measurement, engineThreshold) {
  if (!Number.isFinite(engineThreshold)) return undefined;
  return Math.max(0, Math.floor(engineThreshold) - measurement);
}

/** `1 token` / `2 tokens` — the notice quoted "1 tokens away" before this existed. */
function count(value) {
  return `${value.toLocaleString()} token${value === 1 ? '' : 's'}`;
}

/**
 * Where the engine will compact on its own, in tokens — the arithmetic of
 * `resolveCompactSpec`, run on the same inputs the engine reads.
 *
 * @param contextWindow - capacity the adapter resolves for the routed model.
 * @param reservedCompletionTokens - output tokens one request reserves; 0 when unknown,
 *   which is the conservative direction here (a larger reservation means a lower line,
 *   which the gate answers by asking earlier).
 * @returns the threshold in tokens, or undefined when the window is unknown.
 */
export function engineThresholdTokens(contextWindow, reservedCompletionTokens) {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  const reserved =
    Number.isFinite(reservedCompletionTokens) && reservedCompletionTokens > 0 ? reservedCompletionTokens : 0;
  const messageBudget = contextWindow - reserved;
  const pressureBudget = messageBudget - ENGINE_HEADROOM_TOKENS;
  if (messageBudget <= 0 || pressureBudget <= 0) return undefined;
  return Math.floor(Math.min(contextWindow * ENGINE_THRESHOLD_RATIO, pressureBudget));
}

/**
 * The occupancy at which this gate must ask: below the engine's own line by
 * {@link ENGINE_MARGIN_TOKENS}, and never later than the configured `gateRatio`.
 *
 * The `Math.min` with `gateRatio` is a safety ceiling, not the policy: a mirrored line
 * above it would ask later than the preset already asked. The margin is subtracted in
 * *tokens*, not in ratio, because what the human needs is a fixed amount of room to act
 * in, which a fraction of a 1,000,000-token window does not express.
 *
 * @returns `{ ratio, contextWindow, engineThreshold }`, or undefined when the window is
 *   missing — in which case the gate keeps the configured ratio, exactly as it did before
 *   this mirror existed.
 */
export function effectiveAskLine(contextWindow, reservedCompletionTokens, gateRatio = GATE_RATIO) {
  const engineThreshold = engineThresholdTokens(contextWindow, reservedCompletionTokens);
  if (engineThreshold === undefined) return undefined;
  // A window small enough that the engine's fixed headroom decides the line is not priced
  // this way (see MIN_ENGINE_LINE_RATIO): decline the mirror and keep the declared ratio.
  if (engineThreshold < MIN_ENGINE_LINE_RATIO * contextWindow) return undefined;
  const ceiling = Number.isFinite(gateRatio) ? gateRatio : GATE_RATIO;
  const askTokens = Math.min(engineThreshold - ENGINE_MARGIN_TOKENS, Math.floor(contextWindow * ceiling));
  return {
    ratio: Math.max(MIN_ASK_RATIO, askTokens / contextWindow),
    contextWindow,
    engineThreshold,
  };
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
 * The ratios a preset declares for this gate, read out of the preset's own text.
 *
 * One owner for one declaration. This parsing lived in two places before: the gate was
 * *configured* by `cordis.patch.yml` while `probes/gate-ahead-of-engine.mjs` re-derived the
 * declared ratios with its own copy of the same regexes, and anything else that wanted to
 * describe the mounted line (the briefing's runtime line) had no way to ask at all. Two
 * readers of one number is the defect this whole file was extracted for, so the reader lives
 * here and takes the text — no `fs`, no path, no host.
 *
 * @param presetText - the contents of `cordis.patch.yml`, or '' when it could not be read.
 * @returns `{ warnRatio, gateRatio }` with either key absent when the row does not declare it.
 */
export function declaredGateConfig(presetText, rowId = 'code-compact-gate') {
  const text = String(presetText ?? '');
  const at = text.indexOf(`id: ${rowId}`);
  if (at === -1) return {};
  const rest = text.slice(at);
  // The row ends at the next `- id:` line at any indentation; the row's own comments never
  // contain one, so a plain search is enough and does not need the YAML to be parsed.
  const end = rest.slice(1).search(/\n\s*- id:/);
  const row = end === -1 ? rest : rest.slice(0, end + 1);
  const num = (key) => {
    const found = row.match(new RegExp(`${key}:\\s*([0-9]*\\.?[0-9]+)`));
    return found === null ? undefined : Number(found[1]);
  };
  return { warnRatio: num('warnRatio'), gateRatio: num('gateRatio') };
}

/**
 * The whole policy as a pure function of the numbers, so a probe can drive it without a host.
 *
 * `limits.askRatio` is the mounted ask line (see {@link effectiveAskLine}); when it is
 * absent — no window priced yet, or a caller that only resolved the config — the configured
 * `gateRatio` is the line.
 *
 * @param ratio - occupancy as a fraction of the routed context window.
 * @param limits - resolved `warnRatio`/`gateRatio`/`marginRatio`, optional `askRatio`.
 * @param memory - `{ warned, granted }` for this agent object.
 * @returns `'quiet'`, `'warn'`, `'ask'` or `'granted'`.
 */
export function decideStage(ratio, limits, memory) {
  const askRatio = Number.isFinite(limits?.askRatio) ? limits.askRatio : limits.gateRatio;
  if (ratio >= askRatio) {
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
  // The ask line is the engine-mirrored one whenever it could be derived; `gateRatio` is
  // the ceiling, not the answer. Quoting it here is how the notice once promised a
  // question at 75% that the engine's own 72% line pre-empted (2026-10-10).
  const askRatio = Number.isFinite(limits?.askRatio) ? limits.askRatio : limits.gateRatio;
  const left = remainingTokens(measurement, contextWindow, askRatio);
  // The engine's own line, when it could be derived: the warning is the one notice that tells a
  // human what is about to happen, and "the engine compacts at 678,464 (68%)" is the fact that
  // makes the ask line's 64.85% mean something.
  const engineTokens = Number.isFinite(limits?.engineThreshold) ? Math.floor(limits.engineThreshold) : undefined;
  const engineNote =
    engineTokens === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0
      ? ''
      : ` The engine compacts on its own at ${count(engineTokens)} (${percent(engineTokens / contextWindow)}); you have about ${count(engineRemainingTokens(measurement, engineTokens))} left.`;
  return `${NOTICE_MARKER} context is at ${percent(ratio)} of the window (${measurement.toLocaleString()}${
    Number.isFinite(contextWindow) && contextWindow > 0 ? ` of ${contextWindow.toLocaleString()}` : ''
  } tokens).${
    left === undefined
      ? ''
      : ` At ${percent(askRatio)} — about ${count(left)} away — this session stops compressing on its own and asks instead.`
  }${engineNote} If this piece of work is close to done, it is cheaper to finish it or to write the handover now than to have the middle of it summarised away. If it is not close to done, keep working; this warning fires once.`;
}

/** The closing instruction appended when the human chooses the handover. */
export function handoverText(ratio) {  return `${NOTICE_MARKER} the human chose to stop and hand over rather than compact (context at ${percent(ratio)}).

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

/**
 * The one notice the gate adds to a session whose memory has just been replaced by a summary.
 *
 * A compaction is silent and *self-concealing*: the model that continues after one has no way to
 * notice that the middle of its conversation was replaced, so everything it was about to rely on
 * — a decision it made, a command it ran, a failure it worked through — is now a sentence in a
 * summary, indistinguishable from something it established. The ledger is what survives a
 * compaction, and it is one call away; saying so is the whole job of this string.
 */
export function compactedText(before, after) {
  return `${NOTICE_MARKER} this session was just compacted — the window went from ${before.toLocaleString()} to ${after.toLocaleString()} tokens. **What you now hold is a summary, not the memory.** The ledger is unchanged, and it is what survives a compaction: call \`code_brief\` before you continue, and treat anything you remember from the middle of this conversation as a claim to re-check rather than a fact you established.`;
}

/** The question card. The answer is read back by index, so this order is the contract. */
export function gateQuestion(ratio, limits, measurement, contextWindow) {
  const askRatio = Number.isFinite(limits?.askRatio) ? limits.askRatio : limits.gateRatio;
  const left = remainingTokens(measurement, contextWindow, askRatio);
  /**
   * What the human is told is left.
   *
   * The engine's line when it is known — because that is the line whose crossing actually
   * summarises the conversation, and because saying "0 tokens remain" at the instant the card
   * appears reads as an emergency while the session still has the full margin. The ask line's
   * own remainder is the fallback, for a host that could not price the model.
   */
  const engineTokens = Number.isFinite(limits?.engineThreshold) ? Math.floor(limits.engineThreshold) : undefined;
  const engineLeft = engineRemainingTokens(measurement, engineTokens);
  const remainingSentence =
    engineTokens !== undefined
      ? `${count(engineLeft)} remain before the engine compacts on its own (at ${count(engineTokens)}${
          Number.isFinite(contextWindow) && contextWindow > 0 ? ` — ${percent(engineTokens / contextWindow)} of the window` : ''
        }). `
      : left === undefined
        ? ''
        : `${count(left)} remain before the hard ceiling. `;
  return {
    id: 'code-compact-gate',
    header: 'Context is at the compaction threshold',
    question:
      `This session has reached ${percent(ratio)} of its context window (${measurement.toLocaleString()}${
        Number.isFinite(contextWindow) && contextWindow > 0 ? ` of ${contextWindow.toLocaleString()}` : ''
      } tokens). Compressing now summarises the middle of the conversation away; not compressing spends the last of the window. ` +
      `${remainingSentence}What should this session do?`,
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
 * Which option the human chose, by index first: the labels above are ours and in our order,
 * so an index is the one reading that cannot be wrong. A label (or a nested `selected`
 * label) is accepted as a fallback for a UI that answers by text; anything else is "no
 * answer" rather than a guess.
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
