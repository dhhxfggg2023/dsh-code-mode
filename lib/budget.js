import { statSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';

/**
 * Context budget for large-project work: keep giant payloads out of the prompt.
 *
 * Two halves, because they catch different things:
 *
 * 1. **Prevention** (`tools/pre-execute`): a whole-file `read` of a file larger
 *    than `maxReadBytes` is refused *before* it runs, with the size and the way
 *    to proceed in the reason. A 2 MB source file is ~500k tokens — one call
 *    like that can cost more than the rest of the session, and it rides along in
 *    every later request.
 * 2. **Mitigation** (`tools/post-execute`): anything whose model-visible text is
 *    longer than `maxResultChars` (a JSON dump, a log, a web page, a third-party
 *    tool's output) is replaced by its head and tail plus a note. This is
 *    deterministic — no model call — and it is what the built-in pruner does,
 *    except that the built-in one only runs once compaction has triggered, which
 *    on a large-window model can be hundreds of thousands of tokens later.
 *
 * Neither half blocks a call that a human would consider reasonable, and both
 * are configurable off.
 */

export const name = 'code-budget';

const DEFAULT_READ_TOOLS = ['read'];
const DEFAULT_MAX_READ_BYTES = 262144;
const DEFAULT_MAX_RESULT_CHARS = 24000;
const DEFAULT_HEAD_CHARS = 12000;
const DEFAULT_TAIL_CHARS = 4000;
const DEFAULT_MARKER = '[code-budget]';
/** Rough room reserved for the drop note and separators inside `maxResultChars`. */
const NOTE_RESERVE = 320;

export const Config = z.object({
  /** Turn the budget off without unmounting the tools. */
  enabled: z.boolean().default(true),
  /** Tools whose whole-file reads are size-checked. */
  readTools: z.array(z.string()).default(DEFAULT_READ_TOOLS),
  /** Refuse a whole-file read above this many bytes; 0 disables prevention. */
  maxReadBytes: z.number().default(DEFAULT_MAX_READ_BYTES),
  /** Trim any model-visible result above this many characters; 0 disables trimming. */
  maxResultChars: z.number().default(DEFAULT_MAX_RESULT_CHARS),
  /** Characters kept from the start of an over-budget result. */
  headChars: z.number().default(DEFAULT_HEAD_CHARS),
  /** Characters kept from the end of an over-budget result. */
  tailChars: z.number().default(DEFAULT_TAIL_CHARS),
});

function resolveLimits(config) {
  return {
    readTools: new Set(config?.readTools ?? DEFAULT_READ_TOOLS),
    maxReadBytes: Number.isFinite(config?.maxReadBytes) ? config.maxReadBytes : DEFAULT_MAX_READ_BYTES,
    maxResultChars: Number.isFinite(config?.maxResultChars) ? config.maxResultChars : DEFAULT_MAX_RESULT_CHARS,
    headChars: Number.isFinite(config?.headChars) ? config.headChars : DEFAULT_HEAD_CHARS,
    tailChars: Number.isFinite(config?.tailChars) ? config.tailChars : DEFAULT_TAIL_CHARS,
  };
}

function readTarget(args) {
  const value = args?.file_path ?? args?.path ?? args?.target;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isTextBlock(block) {
  return block?.type === 'text' && typeof block.text === 'string';
}

function textChars(content) {
  let total = 0;
  for (const block of Array.isArray(content) ? content : []) if (isTextBlock(block)) total += block.text.length;
  return total;
}

function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * How much of `budget` each end of the text gets.
 *
 * The declared `headChars` and `tailChars` are a preference; the cap is the requirement.
 * When the cap cannot hold both, the two ends are scaled down by the same factor instead
 * of letting the head consume the whole budget: the note below promises the reader a head
 * *and* a tail, and any config whose `headChars` reaches `maxResultChars - NOTE_RESERVE`
 * used to keep a head only while still saying "kept the head and the tail". Measured
 * 2026-10-04 (audit F7, `.dsh-code/audits/probe-budget-shapes.mjs` G5): with
 * `{maxResultChars: 500, headChars: 300, tailChars: 100}` the kept text was 396 chars of
 * head plus note, and the last line of the result was nowhere in it. When both ends are
 * declared and the budget can hold two characters, both survive (`head` 135 / `tail` 45
 * for that config); a degenerate end (`tailChars: 0`) still gets nothing, exactly as
 * before, and the note says which ends were actually kept.
 */
function splitBudget(headChars, tailChars, budget) {
  const head = Math.max(0, headChars);
  const tail = Math.max(0, tailChars);
  const declared = head + tail;
  if (declared === 0 || declared <= budget) {
    const keptHead = Math.min(head, budget);
    return { head: keptHead, tail: Math.min(tail, Math.max(0, budget - keptHead)) };
  }
  const headShare = head > 0 && budget > 0 ? Math.max(1, Math.floor((budget * head) / declared)) : 0;
  // A one-character tail is worth more than a one-character head here: the note's job is
  // to tell the reader where the rest of the text went, and a tail is what shows the text
  // continues. Only reachable when `budget` is 1.
  const keptHead = Math.min(headShare, Math.max(0, budget - (tail > 0 && budget - headShare < 1 ? 1 : 0)));
  return { head: keptHead, tail: Math.max(0, budget - keptHead) };
}

/** The truthful half of the note: which ends of the text the reader is actually looking at. */
function keptEndsNote(ends) {
  if (ends.head > 0 && ends.tail > 0) return 'kept the head and the tail';
  if (ends.tail > 0) return 'kept the tail only';
  if (ends.head > 0) return 'kept the head only';
  return 'kept neither end';
}

/**
 * Keep a head slice from the start of the text and a tail slice from its end,
 * dropping only the middle, and leave every non-text block exactly where it was.
 * Allocation walks the blocks left-to-right for the head and right-to-left for
 * the tail, so a single-block log still keeps both ends and a degenerate
 * `tailChars: 0` cannot resurrect the whole block.
 * @param content - the model-visible content blocks.
 * @param limits - head/tail budget plus the overall cap.
 * @returns replacement blocks, or undefined when nothing textual needs trimming.
 */
function trimContent(content, limits) {
  const blocks = Array.isArray(content) ? content : [];
  const texts = blocks.map((block) => (isTextBlock(block) ? block.text : ''));
  const total = texts.reduce((sum, text) => sum + text.length, 0);
  if (total <= limits.maxResultChars) return undefined;

  // The note and the `…` separators live outside the head/tail slices, so reserve
  // room for them: otherwise a cap just above headChars + tailChars is overshot.
  const budget = Math.max(0, Math.min(limits.maxResultChars - NOTE_RESERVE, limits.headChars + limits.tailChars));
  const ends = splitBudget(limits.headChars, limits.tailChars, budget);
  let remaining = ends.head;
  const keepHead = texts.map((text) => {
    const take = Math.min(text.length, remaining);
    remaining -= take;
    return take;
  });
  remaining = Math.max(0, budget - keepHead.reduce((sum, take) => sum + take, 0));
  const keepTail = new Array(blocks.length).fill(0);
  for (let index = blocks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const available = texts[index].length - keepHead[index];
    const take = Math.min(Math.max(0, available), remaining);
    keepTail[index] = take;
    remaining -= take;
  }

  const kept = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!isTextBlock(block)) {
      kept.push(block);
      continue;
    }
    const text = block.text;
    const head = text.slice(0, keepHead[index]);
    const tail = keepTail[index] > 0 ? text.slice(text.length - keepTail[index]) : '';
    if (head.length === 0 && tail.length === 0) continue;
    if (head.length + tail.length >= text.length) {
      kept.push(block);
      continue;
    }
    kept.push({
      ...block,
      text: head.length === 0 ? tail : tail.length === 0 ? head : `${head}\n…\n${tail}`,
    });
  }

  const dropped = Math.max(0, total - budget);
  kept.push({
    type: 'text',
    text:
      `\n${DEFAULT_MARKER} dropped ${dropped.toLocaleString()} of ${total.toLocaleString()} characters ` +
      // The note describes the reduction that was actually made: "kept the head and the
      // tail" was false for every config where the head filled the whole budget (F7). With
      // a cap too small to hold two characters it now says so instead of claiming both.
      `(${keptEndsNote(ends)}). Narrow the call — offset/limit, a grep, a smaller range, or a filter — ` +
      `to see the part you actually need; do not re-run it the same way.`,
  });
  return kept;
}

/** @param ctx - plugin context; listeners are scoped to it and disposed with it. */
export function apply(ctx, config) {
  if (config?.enabled === false) return;
  const limits = resolveLimits(config);

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (limits.maxReadBytes > 0 && limits.readTools.has(String(exec?.name))) {
        const args = exec?.arguments ?? {};
        const ranged = args?.offset !== undefined || args?.limit !== undefined;
        const target = readTarget(args);
        if (!ranged && target !== undefined) {
          const info = statSync(target, { throwIfNoEntry: false });
          if (info !== undefined && info.isFile() && info.size > limits.maxReadBytes) {
            const approxTokens = Math.round(info.size / 4);
            return {
              kind: 'deny',
              reason:
                `${DEFAULT_MARKER} refusing a whole-file read of ${target} (${human(info.size)}, roughly ` +
                `${approxTokens.toLocaleString()} tokens). Read a window instead: pass offset and limit, or grep for ` +
                `the symbol you need and read around the hit. Reading it whole would cost more than the rest of this session.`,
              info: { name: 'CodeBudget', code: 'READ_TOO_LARGE', reason: 'whole-file read above maxReadBytes' },
            };
          }
        }
      }
    } catch {
      /* a broken budget check must never block a call */
    }
    return next();
  });

  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const downstream = await next();
    try {
      if (
        limits.maxResultChars > 0 &&
        downstream?.kind === 'accept' &&
        Array.isArray(downstream.content) &&
        textChars(downstream.content) > limits.maxResultChars
      ) {
        const trimmed = trimContent(downstream.content, limits);
        if (trimmed !== undefined) {
          // The host refuses an accept decision that replaces BOTH `value` and `content`
          // (`dsh-tools/lib/index.js:3515`, read out of the bundle 2026-10-04: `if
          // (Object.hasOwn(decision, "content") && Object.hasOwn(decision, "value")) throw
          // new TypeError("tools/post-execute accept decision cannot replace both value and
          // content")`) and turns that throw into an error result for the call. Spreading
          // `downstream` and adding `content` produced exactly that shape as soon as a
          // downstream listener had supplied `value` (audit F8; measured by
          // `.dsh-code/audits/probe-budget-shapes.mjs` G9: keys ["kind","value","content"]).
          // Reachability is UNPROVEN — no mounted plugin was found returning a
          // value-carrying accept, and `dsh-spill-policy/lib/index.js:239` guards against
          // the pair — so this is defensive. Of the two keys, the trimmed `content` is the
          // one this module's job is about, so `value` is the one that goes; a decision
          // that carried both was already fatal to the host before we touched it.
          const decision = { ...downstream, content: trimmed };
          delete decision.value;
          return decision;
        }
      }
    } catch {
      /* trimming is best-effort; an untrimmed result is not an error */
    }
    return downstream;
  });
}
