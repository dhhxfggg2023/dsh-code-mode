import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { brief, briefFull, globalDir, ledgerDir, ledgerRoot, noteSessionStart } from './ledger.js';

export const name = 'code-brief';
export const inject = ['tools'];

export const Config = z.object({
  /** Briefings longer than the model will read are worse than no briefing. */
  maxChars: z.number().default(4000),
});
export function apply(ctx, config) {
  const maxChars = config?.maxChars ?? 4000;
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
          },
        },
        render: (_args, value) => {
          const note =
            value.omittedSections.length > 0
              ? `\n**Dropped for length: ${value.omittedSections.join(', ')}.** These sections exist in the ledger but did not fit; read the files in \`${value.ledgerDir}\` (or call code_brief with a smaller \`topic\`) before you assume the ledger has nothing on them.\n`
              : '';
          return [
            { type: 'text', text: `# Ledger brief — ${value.projectRoot}\n\n${value.brief}\n${note}` },
          ];
        },
      },
      execute(args, exec) {
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
        return Promise.resolve({
          projectRoot: cwd,
          ledgerDir: ledgerDir(cwd),
          globalDir: globalDir(),
          brief: result.text,
          empty: result.empty,
          omittedSections: result.omitted ?? [],
        });
      },
      presentCall: () => ({ card: 'generic', title: 'Read project ledger', kind: 'read' }),
    }),
  );
}
