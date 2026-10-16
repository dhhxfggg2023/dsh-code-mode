import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { brief, briefFull, digest, globalDir, ledgerDir, ledgerRoot, noteBriefShape, noteSessionStart } from './ledger.js';

/** Occupancy as a whole percent. Local because nothing else here needs it. */
const percent = (ratio) => `${Math.round(ratio * 100)}%`;

export const name = 'code-brief';
export const inject = ['tools'];

export const Config = z.object({
  /** Briefings longer than the model will read are worse than no briefing. */
  maxChars: z.number().default(4000),
  /** Show where the ledger is and how full the window is, at the top of every brief. */
  runtime: z.boolean().default(true),
});

/**
 * Where the ledger is, and how much room is left — the two facts about itself that a session
 * otherwise cannot see.
 *
 * Both were paid for on 2026-10-10. The user asked "when this conversation reaches ~65%, does
 * the compaction card appear?", and answering it took two purpose-written probes: nothing in
 * the conversation said that the session was at 5% of a 1,000,000-token window, and nothing
 * said where its ledger had been moved to. The plugins knew both numbers the whole time —
 * `tokenMeter`, `llm.resolveModelInfo`, `lib/ledger.js` — the agent simply had no channel to
 * them, and the strings that *did* mention a directory still said `.dsh-code`, which after the
 * migration is a path that no longer exists.
 *
 * The compaction half of this line is gone (2026-10-16). It used to say whether automatic
 * compaction was on, and it read that out of `lib/compaction.js` — a module that also carried a
 * restatement of billion-context's fold arithmetic. The user's ruling was that this mode must not
 * carry special-purpose support for another plugin, so that module and the cache reader beside it
 * were deleted; what survives is the one fact that belongs to this session, its own occupancy.
 *
 * Never throws and never awaits anything unbounded: a brief that fails is worse than no brief,
 * and the meter/adapter are services this file does not own.
 */
/**
 * One line about whether the briefing moved under this session, or nothing when it cannot be said.
 *
 * Deliberately two facts and no advice: "the ledger moved" is what this measures, and the
 * `lib/`-edit half of prefix movement already has an owner (`restartPending`, whose notice is
 * rendered as a notice above). A line that claimed to know the KV cache had been invalidated
 * would be claiming a fact about the host that nothing here can see.
 */
function prefixShapeLine(shape) {
  if (shape === undefined) return undefined;
  if (shape.previous === undefined) {
    return shape.recorded === true
      ? `- briefing shape: ${shape.chars} chars, and this is the session's first brief — there is nothing to compare it against yet`
      : undefined;
  }
  return shape.recorded === true
    ? `- briefing shape: CHANGED since the last brief (${shape.previous.chars} → ${shape.chars} chars): the ledger moved under this session, so a fact read at the start may have been replaced since — and if a \`lib/\` edit is also waiting for a restart, that is the notice above`
    : `- briefing shape: unchanged since the last brief (${shape.chars} chars)`;
}

async function runtimeBlock(ctx, exec, dirs, shape) {
  const bullets = [`- ledger \`${dirs.ledger}\` · machine ledger \`${dirs.machine}\``];
  const shapeLine = prefixShapeLine(shape);
  if (shapeLine !== undefined) bullets.push(shapeLine);
  const session = exec?.agent?.session;
  let tokens;
  try {
    tokens = Number(ctx.get?.('tokenMeter')?.measure?.(session)?.totalTokens);
  } catch {
    tokens = undefined;
  }
  if (!Number.isFinite(tokens) || tokens <= 0) {
    bullets.push('- this session: the token meter reported nothing, so no occupancy is shown');
    return `## Runtime\n${bullets.join('\n')}`;
  }
  const show = (label, value) => `${label} ${value.toLocaleString()}`;
  bullets.push(`- ${show('this session', tokens)} tokens`);
  // The routed window, read exactly where the engine reads it
  // (`session.requestHeader().config.maxTokens ?? info.defaultMaxTokens`); an unknown one means
  // no fraction can be stated, which is said rather than guessed.
  let window;
  try {
    const header = session?.requestHeader?.();
    const config = header?.config ?? header?.header?.config;
    const info = await ctx.get?.('llm')?.resolveModelInfo?.(config?.provider, config?.model);
    window = Number(info?.context?.contextWindow);
  } catch {
    /* an adapter that cannot price the model leaves no window to be a fraction of */
  }
  if (!Number.isFinite(window) || window <= 0) {
    bullets[0] = `${bullets[0]}\n- model window unknown, so no line can be compared against ${tokens.toLocaleString()} tokens`;
    return `## Runtime\n${bullets.join('\n')}`;
  }
  const ratio = tokens / window;
  return `## Runtime\n${bullets.join('\n')}\n- this session is at ${percent(ratio)} of ${window.toLocaleString()} tokens`;
}

export function apply(ctx, config) {
  const maxChars = config?.maxChars ?? 4000;
  const showRuntime = config?.runtime !== false;
  ctx.tools.register(
    defineTool({
      name: 'code_brief',
      description:
        'Read the ledgers before you explore, plan, or edit: what this project is, how to run it, what task is in flight, what was already decided, and which mistakes were already made here — plus the machine-wide facts that hold in every project on this host. Cheaper than rediscovering any of it. Call it first in a session, and again whenever you resume a task or feel lost.',
      parameters: {
        topic: {
          type: 'string',
          description:
            'Optional subject (a file, module, or failure symptom) used to pull the mistakes that already touch it.',
        },
        full: {
          type: 'boolean',
          description:
            'Lift the per-section division and show every whole entry a section can hold, instead of ranking them and indexing the rest. Use when the discovery line says the ledger holds more than the brief showed and you do not yet know what to search for. Still bounded by the per-section ceilings.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            projectRoot: { type: 'string', required: true },
            ledgerDir: { type: 'string', required: true },
            globalDir: { type: 'string', required: true },
            brief: { type: 'string', required: true },
            empty: { type: 'boolean', required: true },
            /** Sections the character budget dropped; never silently omitted. */
            omittedSections: { type: 'array', items: { type: 'string' }, required: true },
            /** Where the ledger is and how full the window is; '' when switched off. */
            runtime: { type: 'string', required: true },
          },
        },
        render: (_args, value) => {
          const note =
            value.omittedSections.length > 0
              ? `\n**Dropped for length: ${value.omittedSections.join(', ')}.** These sections exist in the ledger but did not fit; read the files in \`${value.ledgerDir}\` (or call code_brief with a smaller \`topic\`) before you assume the ledger has nothing on them.\n`
              : '';
          // Tolerant of a value built by hand: `render` is a pure function of whatever the
          // handler returned, and callers that predate this field pass a partial object
          // (measured 2026-10-10 — `budget-chain-probe` builds one and crashed here).
          const runtime = typeof value.runtime === 'string' && value.runtime.length > 0 ? `\n${value.runtime}\n` : '';
          return [
            { type: 'text', text: `# Ledger brief — ${value.projectRoot}\n${runtime}\n${value.brief}\n${note}` },
          ];
        },
      },
      async execute(args, exec) {
        const cwd = ledgerRoot(exec);
        const sessionId = exec.agent?.session?.id;
        // A real briefing is the moment a session begins, so this is where the start is
        // recorded — which is also what settles a `restart_pending` notice, because a new
        // process is what proves a dormant `lib/` edit has been loaded. It lives here and
        // not in `brief()` because `brief` is a read: a read that writes makes every caller
        // (including every probe fixture) leave records behind.
        if (cwd !== undefined) noteSessionStart(cwd, sessionId, 'project');
        // The budget is spent inside `brief` so no section can be silently cut;
        // this tool only decides how much room it is willing to pay for.
        const result =
          args.full === true
            ? briefFull(cwd, { session: sessionId })
            : brief(cwd, { topic: args.topic, session: sessionId, maxChars });
        // The shape is recorded here, not in `brief()`: a read that writes turns every probe and
        // every caller into a writer, and would let a *read* create the ledger it is reporting
        // the absence of. `noteBriefShape` returns what the comparison needs — whether this shape
        // was already recorded, and what the previous one was — and writes nothing when it repeats.
        const shape =
          cwd === undefined
            ? undefined
            : {
                chars: result.text.length,
                ...noteBriefShape(cwd, sessionId, { digest: digest(result.text), chars: result.text.length }),
              };
        const runtime = showRuntime
          ? await runtimeBlock(ctx, exec, { ledger: ledgerDir(cwd), machine: globalDir() }, shape)
          : '';
        return {
          projectRoot: cwd,
          ledgerDir: ledgerDir(cwd),
          globalDir: globalDir(),
          brief: result.text,
          empty: result.empty,
          omittedSections: result.omitted ?? [],
          runtime,
        };
      },
      presentCall: () => ({ card: 'generic', title: 'Read project ledger', kind: 'read' }),
    }),
  );
}
