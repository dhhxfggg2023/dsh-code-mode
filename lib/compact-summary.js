/**
 * The compaction checkpoint, **derived from the ledger** instead of written by a model.
 *
 * Why this exists (2026-10-10). Compaction was the most expensive thing this mode did, and the
 * measurement says so: one compaction on this machine produced a single request with
 * `uncached=637,706, cached=24,448` — the whole conversation re-sent at full price — while a
 * fresh conversation's first request costs `uncached=17,394`. The reason is structural: the
 * engine's default summarizer *calls a model with the entire history as its input*, and then the
 * replacement rewrites the prefix, so the next request re-reads everything after the change.
 *
 * The user's instruction (2026-10-10): "不要把海量上下文拿去给模型压缩了，每次快到上下文就给我
 * 自动写好转接文档……在这个对话把转接文档给模型". That is exactly the right shape here, because
 * this project already derives the handover from the ledger — `ledger.handover()` renders "what
 * is next" and "what to avoid" from records that are already on disk (T1, pinned by
 * `handover-derive-probe` N1-N7). Feeding that in as the checkpoint means:
 *
 *   - **no model call at all** while compacting — the cost of forgetting collapses to the size
 *     of the handover;
 *   - **deterministic and bounded**: the same ledger derives the same checkpoint, and its size
 *     does not grow with the conversation;
 *   - **the ledger is the memory**, which is the whole reason it exists.
 *
 * How it attaches. The installed engine documents `summarize()` as "the sole subclass
 * customization hook" and dispatches it dynamically (`regionDependencies()` binds
 * `summarize: (input, owner, abort) => this.summarize(...)`, so a subclass override is honored at
 * event time). This module is that subclass: the preset mounts **it** on the `compaction-basic`
 * row instead of the built-in module, and everything else — the durable surface replacement, the
 * tool-pairing safety, the checkpoint framing, `compactNow`/`compactIfNeeded`, the `auto` switch —
 * stays the engine's own code. Nothing here re-implements a replace.
 *
 * What it must return: `{ summary: [text blocks] }`, which the engine wraps in its own
 * preamble and `***` checkpoint tags (`frameSummary`) and turns into the replacement user
 * message. It then refuses the replacement unless the framed summary is **smaller** than the span
 * it shadows ("summary is not smaller than the shadowed content") — a checkpoint derived from the
 * ledger is a few thousand characters against hundreds of thousands of tokens, so that guard is
 * satisfied by construction for any real reset; it is only reachable if someone compacts a
 * conversation smaller than the handover itself.
 *
 * **There is no fallback any more, and that is the instruction (2026-10-10).** The user's words:
 * 「编程模式需要把所有能将大量上下文拿去一下子压缩的禁止了，因为我已经打算用转接文档代替了」. The
 * fallback this file used to take — the engine's own model-written summary when the ledger had
 * nothing — was the last path in this mode that handed a whole conversation to a model to be
 * compressed in one shot, and it was reachable from **all three** ways a reset starts: the
 * `/compact` command, the gate's line, and the danger-band `compactIfNeeded`. It is gone.
 *
 * What replaces it is a checkpoint that *says* the ledger was empty. The middle is still gone —
 * that is what a reset is — but nothing pretends to summarise it, and the session is told the one
 * action that makes the next checkpoint derived. The cost is stated rather than hidden: in a
 * project with no ledger, a reset now discards the middle with nothing carried forward. That is
 * the trade the instruction asks for, against the thing this project measured at
 * `uncached=637,706` for a single model compaction.
 *
 * `DSH_CODE_MODEL_COMPACTION=allow` is the break-glass, in the same shape as the pit guard's
 * `DSH_CODE_PIT_HARD=0`: the ban can be lifted for one process without editing this file. Nothing
 * sets it, and `probes/no-model-compaction-probe.mjs` pins both directions — that the ban holds by
 * default, and that the switch is what the ban is *made of* rather than a comment.
 */

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { handover } from './ledger.js';

export const name = 'code-handover-compaction';
/** Inherited, not restated: the base class owns which services this engine needs. */
export const inject = BasicCompactionEngine.inject;
/** The engine's own schema — `thresholdRatio`, `headroomTokens`, `retainRatio`, `auto`, … */
export const Config = BasicCompactionEngine.Config;

/**
 * How much of the derived handover a checkpoint may carry, in characters.
 *
 * Larger than the briefing's own budget on purpose: this text *replaces* hundreds of thousands of
 * tokens, so a few extra kilobytes are free, and a checkpoint that has to be re-derived from the
 * ledger on the next step is worse than one that arrived complete. Still bounded, because a
 * checkpoint is read on every subsequent request.
 */
const CHECKPOINT_CHARS = 12000;

/**
 * The line that turns a ledger excerpt into an instruction the continuing model can act on.
 *
 * The engine already prepends its own `PREAMBLE` ("This is an automatically generated checkpoint
 * condensing an earlier span…"), so this does not repeat that. What it adds is the one thing the
 * preamble cannot know: **where the memory actually is**, and that the middle is gone rather than
 * summarised. A model that treats a lost middle as something it merely skimmed will restate it
 * confidently and wrongly, which is the failure this project has recorded more than once.
 */
const INJECT_HEAD = [
  'This checkpoint is the project ledger\'s own handover, injected verbatim — it was derived from files on disk, not written by a model from this conversation.',
  '',
  'Two consequences, both important:',
  '- **The middle of this conversation is gone, not summarised.** Treat anything you remember about it as a claim to re-check, never as a fact you established.',
  '- **`code_brief` is the memory now.** Call it before continuing: it returns the project\'s commands, the task in flight, the decisions already made, the mistakes already paid for, and the machine-wide facts that hold on this host.',
  '',
].join('\n');

/**
 * What replaces the middle when the ledger has nothing to say.
 *
 * It does not pretend to be a summary: it says the middle is gone, says why nothing replaced it,
 * and names the one action that makes the *next* checkpoint derived and free. `code_brief` is
 * named as the memory because that is true even here — in a project with no ledger it answers
 * exactly that, which is the honest thing for the session to see rather than a confident narrative.
 */
const EMPTY_HEAD = [
  'This checkpoint could NOT be derived from a project ledger, and this mode is not allowed to write one with a model.',
  '',
  'What that means:',
  '- **The middle of this conversation is gone, and nothing replaced it.** Treat anything you remember about that span as a claim to re-check, never as a fact you established.',
  '- **`code_brief` is the memory now.** Call it before continuing; in a project with no ledger it will say so, and that is the state to fix.',
  '- **Record the ledger so the next checkpoint is free**: `code_record(kind="project", patch={commands:{…},stack:"…",layout:"…"})`, then tasks, decisions and mistakes as they happen. The next reset then carries the ledger\'s own handover instead of this notice, at no model cost.',
  '',
].join('\n');

/**
 * Whether a checkpoint may ever be written by a model again.
 *
 * Read once, at import, on purpose: this is a property of the process, not of a call.
 */
const MODEL_COMPACTION = process.env.DSH_CODE_MODEL_COMPACTION;

export class HandoverCompactionEngine extends BasicCompactionEngine {
  /**
   * `auto` is **configuration's** again, as of 2026-10-11 — this class no longer overrides it.
   *
   * What this constructor used to do, and why it stopped. From 2026-10-10 to 2026-10-11 it forced
   * `auto: false` here, because the user's instruction that day was scoped ("只需要我的编程模型做到
   * 这些就行了，别改其他模式的") and configuration could not express that scope: the profile patch is
   * a **global** layer applied after every bundle layer and overriding by row id, while
   * `compaction-basic` is the id *every* preset uses — so a `false` written there silenced
   * *standard*, *ptc* and *minimal* as well. Measured: before the constructor, the switch lived in
   * `C:\Users\dhhxfggg\.dsh\profiles\desktop\cordis.patch.yml` and did exactly that.
   *
   * On 2026-10-11 the user withdrew the instruction that made the force necessary: automatic
   * compaction already existed, they had been the one to switch it off, and 「这条路我觉得不对，所以
   * 不搞了」 — so it comes back. Forcing `false` here would now be the *same* defect in the opposite
   * direction: the preset's own `auto` would be a declaration nothing enforces, which is precisely
   * what the comment on this row in `cordis.patch.yml` warns a reader about.
   *
   * The lesson is kept because it is still true and still costs money to rediscover: `auto` is
   * scoped per preset only because this module is mounted on this preset's row. Any preset that
   * mounts **this** module inherits whatever the `auto` key on its row says; every other preset
   * mounts `@deepseek-ai/dsh-compaction-basic` and keeps the built-in behaviour, whichever way the
   * profile layer is set. That is why the value belongs in the preset, and why nothing here needs to
   * restate it.
   */
  constructor(ctx, config = {}) {
    super(ctx, config);
  }

  /**
   * Return the ledger-derived handover as the checkpoint's summary blocks.
   *
   * Three outcomes, and the third one is the point of this file's 2026-10-10 rewrite:
   *   1. the ledger has something to say — its handover *is* the checkpoint, at no model cost;
   *   2. the ledger is empty or unreadable — the checkpoint says so, and still costs no model call;
   *   3. `DSH_CODE_MODEL_COMPACTION=allow` — the engine's own summarizer, deliberately reachable
   *      only through that switch.
   *
   * @param input - the replayed conversation prefix the engine would otherwise send to a
   *   summarizer. Deliberately unused on paths 1 and 2: not reading it is what makes them free.
   * @param agent - supplies the session, whose `header.cwd` names the project whose ledger to read.
   * @param signal - unused here; forwarded to the engine on the break-glass path only.
   * @returns `{ summary }` — text blocks, per the engine's contract.
   */
  async summarize(input, agent, signal) {
    const cwd = agent?.session?.header?.cwd;
    let derived;
    let why;
    try {
      derived = handover(cwd, { session: agent?.session?.id, maxChars: CHECKPOINT_CHARS });
    } catch (error) {
      // A ledger that cannot be read is not a reason to fail a compaction — and, since the
      // 2026-10-10 instruction, not a reason to call a model either. It is a reason to say which
      // of the two happened, because "no ledger" and "unreadable ledger" need different fixes.
      derived = undefined;
      why = `the ledger could not be read (${error?.message ?? error})`;
    }
    const text = typeof derived?.text === 'string' ? derived.text.trim() : '';
    if (derived !== undefined && derived.empty !== true && text.length > 0) {
      return { summary: [{ type: 'text', text: `${INJECT_HEAD}${text}` }] };
    }
    if (MODEL_COMPACTION === 'allow') return super.summarize(input, agent, signal);
    const state = why ?? 'it holds nothing to carry forward, or this project has no ledger yet';
    return {
      summary: [{ type: 'text', text: `${EMPTY_HEAD}- the ledger was read at \`${cwd ?? 'an unknown directory'}\`: ${state}.` }],
    };
  }
}

export default HandoverCompactionEngine;
