import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
// The ledger's own readers. Imported rather than re-implemented: `readTasks` owns the board's
// shape (including normalising a board whose lists disagree with their statuses) and `ledgerRoot`
// owns "which project is this session in".
import { ledgerRoot, readTasks } from './ledger.js';

export const name = 'code-recite';

/**
 * How many steps apart the ledger recitation repeats, when the preset says nothing.
 *
 * Six is a budget decision, not a measurement: a shorter interval spends tokens on every step of
 * the longest sessions, and a longer one lets the tail drift past the point where a recitation
 * still does anything. `0` switches it off.
 *
 * Declared above `Config` rather than next to the listener that reads it, because `Config` is
 * evaluated at **mount**: a `const` declared further down the file is still in its temporal dead
 * zone there, and the whole row then fails to import — `ReferenceError: Cannot access
 * 'RECITE_EVERY_STEPS' before initialization`. Measured on 2026-10-11, when this listener lived in
 * the compaction gate's file and its first probe run hit exactly that.
 */
const RECITE_EVERY_STEPS = 6;

export const Config = z.object({
  /** Turn the recitation off without unmounting the row. */
  enabled: z.boolean().default(true),
  /** How many steps apart the recitation is repeated; 0 switches it off. */
  reciteEverySteps: z.number().default(RECITE_EVERY_STEPS),
});

const state = new WeakMap();

function memoryOf(agent) {
  let record = state.get(agent);
  if (record === undefined) {
    record = { steps: 0 };
    state.set(agent, record);
  }
  return record;
}

/**
 * The board, said again — and nothing else.
 *
 * Read-only, and derived entirely from records: the ledger's own `readTasks` owns the board's
 * shape, so this asks it rather than parsing `tasks.json` a second time.
 *
 * It names the work, not the conversation. A session whose board has drifted gets told to move the
 * task rather than told what it has been doing, because nothing on this path *can* know the latter:
 * there is no conversation here to summarise.
 */
export function recitation(agent) {
  const cwd = ledgerRoot({ agent });
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
  const board = readTasks(cwd);
  const active = Array.isArray(board?.active) ? board.active : [];
  if (active.length === 0) return undefined;
  const named = active.slice(0, 2).map((task) => `"${String(task?.title ?? task?.id ?? 'untitled')}"`);
  const rest = active.length > named.length ? ` (+${active.length - named.length} more in flight)` : '';
  return createUserMessage({
    content: [
      {
        type: 'text',
        text: `Ledger recitation (derived from tasks.json, not from this conversation): in flight — ${named.join(', ')}${rest}. If that is no longer what you are doing, move the task with code_record(kind="progress") before you continue: a board that has drifted from the work is worse than no board.`,
      },
    ],
    source: {
      kind: 'code-recite',
      form: 'notice',
      summary: `recitation: ${active.length} task(s) in flight`,
    },
  });
}

/**
 * The ledger recitation: what this session is working on, said again a few steps later.
 *
 * Borrowed from Manus's recitation lesson — rewriting `todo.md` so the goal stays in recent
 * attention — and bounded to the one thing this file can derive honestly: the board. It is not a
 * summary of the conversation and cannot become one, because this listener has no access to a
 * conversation, exactly like `handover()`. That is what keeps "no narrative" structural instead of
 * a rule someone has to remember.
 *
 * It appends to the decision the rest of the waterfall produced rather than passing the message to
 * `next()`: the whole point of a recitation is recency, and a line that lands above three other
 * notices is not recent. It holds nothing and blocks nothing, and an exception is swallowed — a
 * turn must never end over a reminder.
 *
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return;
  const every = Number(config?.reciteEverySteps ?? RECITE_EVERY_STEPS);
  if (!Number.isFinite(every) || every <= 0) return;

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    let recite;
    try {
      if (agent !== undefined && agent !== null) {
        const memory = memoryOf(agent);
        memory.steps += 1;
        if (memory.steps % every === 0) recite = recitation(agent);
      }
    } catch {
      recite = undefined;
    }
    const decision = await next();
    if (recite === undefined || !Array.isArray(decision?.messages)) return decision;
    return { ...decision, messages: [...decision.messages, recite] };
  });
}
