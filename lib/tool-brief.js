import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { brief, briefFull, globalDir, ledgerDir, ledgerRoot, noteSessionStart } from './ledger.js';
import { declaredGateConfig, effectiveAskLine, engineThresholdTokens, percent, resolveLimits } from './compact-policy.js';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
 * The arithmetic is not restated here: `lib/compact-policy.js` owns it, and the preset's
 * declared ratios are read from the preset itself, so this line cannot disagree with the gate
 * that is actually mounted.
 *
 * Never throws and never awaits anything unbounded: a brief that fails is worse than no brief,
 * and the meter/adapter are services this file does not own.
 */
async function runtimeBlock(ctx, exec, dirs) {
  const bullets = [`- ledger \`${dirs.ledger}\` · machine ledger \`${dirs.machine}\``];
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
  // The routed window and the request's own reservation, read exactly where the engine reads
  // them (`session.requestHeader().config.maxTokens ?? info.defaultMaxTokens`); an unknown one
  // is 0 — the direction that asks earlier rather than later.
  let window;
  let reserved;
  try {
    const header = session?.requestHeader?.();
    const config = header?.config ?? header?.header?.config;
    const info = await ctx.get?.('llm')?.resolveModelInfo?.(config?.provider, config?.model);
    window = Number(info?.context?.contextWindow);
    reserved = Number(config?.maxTokens ?? info?.defaultMaxTokens);
  } catch {
    /* an adapter that cannot price the model leaves no window to be a fraction of */
  }
  if (!Number.isFinite(window) || window <= 0) {
    bullets[0] = `${bullets[0]}\n- model window unknown, so no line can be compared against ${tokens.toLocaleString()} tokens`;
    return `## Runtime\n${bullets.join('\n')}`;
  }
  let declared;
  try {
    declared = declaredGateConfig(fs.readFileSync(path.join(PKG_DIR, 'cordis.patch.yml'), 'utf8'));
  } catch {
    declared = {};
  }
  const limits = resolveLimits(declared);
  const ask = effectiveAskLine(window, Number.isFinite(reserved) ? reserved : 0, limits.gateRatio);
  const engine = engineThresholdTokens(window, Number.isFinite(reserved) ? reserved : 0);
  const ratio = tokens / window;
  const parts = [
    `${show('this session', tokens)} of ${window.toLocaleString()} tokens (${percent(ratio)})`,
    ask === undefined
      ? `the gate asks at ${percent(limits.gateRatio)} (the mirrored line was declined${Number.isFinite(reserved) && reserved > 0 ? `; the request reserves ${reserved.toLocaleString()}` : ''})`
      : `the gate asks at ${Math.round(ask.ratio * window).toLocaleString()} (${percent(ask.ratio)})`,
    engine === undefined ? 'the engine compacts at its own default' : `the engine compacts at ${engine.toLocaleString()} (${percent(engine / window)})`,
  ];
  return `## Runtime\n${bullets[0]}\n- ${parts.join(' · ')}`;
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
        const runtime = showRuntime
          ? await runtimeBlock(ctx, exec, { ledger: ledgerDir(cwd), machine: globalDir() })
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
