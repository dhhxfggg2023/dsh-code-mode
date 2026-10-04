import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { appendGateJournal, recordUnverified, readProject } from './ledger.js';

/**
 * The one gate DSH does not already ship: unproven completion.
 *
 * `dsh-repeat-tool-reminder` catches loops and `dsh-fs-observation-policy`
 * catches writing a file that was never read, so this plugin does not repeat
 * either. It watches the remaining hole — a turn that changes files and still
 * reports the work as done — in three halves:
 *
 * 1. In-turn advice: once an edit is `patience` tool calls old with nothing
 *    run, the model gets one notice before its next step (`agent/pre-step`).
 * 2. Durable memory: if the turn ends with edits and nothing run at all, the
 *    fact is appended to the project journal, and the next `code_brief` opens
 *    with it. A turn that is already ending cannot be stopped, so the ledger is
 *    what makes the debt survive — which is the failure this mode exists to
 *    prevent.
 * 3. Evidence, not activity: a shell command that merely *ran* used to count as
 *    proof and silenced the debt entirely. Measured 2026-10-02: `pwsh 'ls'`
 *    after an edit left no journal line at all, so the one place that could
 *    have recorded "a command ran, but nothing was verified" stayed empty. Now
 *    the end of a turn separates the two: `code_verify` (which records its own
 *    exit code and output in the journal) closes the turn silently, while any
 *    other command leaves a debt that says a command ran and nothing was
 *    recorded. Running something is still treated as an honest attempt — that
 *    is why the in-turn notice stays quiet — but the durable ledger keeps the
 *    distinction between "tried" and "proved".
 *
 * All three halves are advisory; nothing here blocks a call, so the gate can
 * never be the reason a legitimate workflow fails.
 */

export const name = 'code-gate';

/** Tool names that change the codebase and therefore owe proof. */
const DEFAULT_EDIT_TOOLS = ['edit', 'write', 'multiedit', 'apply_patch', 'str_replace'];
/** Tool names that count as having run something. */
const DEFAULT_RUN_TOOLS = ['pwsh', 'bash', 'shell', 'code_verify'];
/** The one run tool that also records its own evidence in the journal. */
const DEFAULT_PROOF_TOOLS = ['code_verify'];
/**
 * Editing only these proves nothing executable, so they never create a debt.
 * `.txt` is deliberately absent: plain text is as often a fixture, a golden
 * file, or generated data as it is prose, and those do change behaviour.
 */
const DEFAULT_DOC_EXTENSIONS = ['.md', '.mdx', '.rst'];
/** Tool calls tolerated after an edit, with nothing run, before the notice. */
const DEFAULT_PATIENCE = 3;

export const Config = z.object({
  /** Turn the gate off without unmounting the tools. */
  enabled: z.boolean().default(true),
  editTools: z.array(z.string()).default(DEFAULT_EDIT_TOOLS),
  runTools: z.array(z.string()).default(DEFAULT_RUN_TOOLS),
  /**
   * Run tools whose own output is recorded in the ledger. A turn that used one of
   * these closes without a debt; a turn that used only the others does not.
   */
  proofTools: z.array(z.string()).default(DEFAULT_PROOF_TOOLS),
  /** Set to [] to make prose count as code again. */
  docExtensions: z.array(z.string()).default(DEFAULT_DOC_EXTENSIONS),
  patience: z.number().default(DEFAULT_PATIENCE),
});

/** Per-agent accounting for the current turn; weak so it dies with the agent. */
const state = new WeakMap();

/**
 * What one run means for the durable ledger.
 *  - `none`    — no command ran at all: the original unproven-completion debt.
 *  - `ran`     — a command ran, but through a tool that records no evidence.
 *  - `proved`  — a command ran through `code_verify`, which journals its own
 *                exit code and output, so the turn is answerable from the ledger.
 * @param ranProof - how many proof-tool calls this turn made.
 * @param ranAny - how many run-tool calls this turn made.
 */
function evidenceState(ranProof, ranAny) {
  if (ranProof > 0) return 'proved';
  return ranAny > 0 ? 'ran' : 'none';
}

/** Per-agent accounting for the current turn; weak so it dies with the agent. */
function account(agent) {
  let record = state.get(agent);
  if (record === undefined) {
    record = {
      turn: undefined,
      edits: [],
      ranAny: 0,
      ranProof: 0,
      /** Command lines of the runs, so a notice can name what was run. */
      commands: [],
      sinceEdit: 0,
      warned: false,
      cwd: undefined,
      session: undefined,
    };
    state.set(agent, record);
  }
  return record;
}

/**
 * The command the project itself declares as its test, from the ledger.
 *
 * The generic advice ("run the command that shows it") asks the model to invent a
 * command at the exact moment it believes it is finished — the worst moment to
 * invent one. When the ledger already records `commands.test`, naming it turns
 * the notice into something the model can act on without deciding anything.
 * @param cwd - project root, or undefined when unknown.
 */
function declaredTest(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
  try {
    const command = readProject(cwd)?.commands?.test;
    return typeof command === 'string' && command.trim().length > 0 ? command.trim() : undefined;
  } catch {
    return undefined;
  }
}

function reminder(edits, testCommand) {
  const shown = edits.slice(-4).join(', ');
  return `You changed ${edits.length === 1 ? 'a file' : `${edits.length} files`} in this turn (${shown}) and have run nothing since. A change you did not execute is unproven.

Before you report this work as done or working, run the command that shows it: \`code_verify\` is preferred, because it records the exit code and output in the project ledger.${testCommand === undefined ? '' : ` This project's ledger declares its test as \`${testCommand}\` — that is the command to run.`} If the change genuinely cannot be verified here, say that plainly — an explicit "not verified" is honest, a silent "done" is not.`;
}

/**
 * The notice for a turn that ran something which recorded no evidence.
 *
 * Deliberately separate from {@link reminder}: the action asked for is different
 * (re-run it through `code_verify`), and mixing the two would tell a model that
 * already ran the right command that it had run nothing.
 */
function unrecorded(edits, commands, testCommand) {
  const shown = commands.slice(-3).map((command) => `\`${command}\``).join(', ');
  return `This turn changed ${edits.length === 1 ? 'a file' : `${edits.length} files`} and ran ${commands.length === 1 ? 'a command' : `${commands.length} commands`} (${shown}), but nothing recorded what it printed: a command that ran outside \`code_verify\` leaves no exit code and no output in the ledger, so "it worked" is still only a claim.

Re-run it through \`code_verify\` with the output that proves it${testCommand === undefined ? '' : ` — this project declares its test as \`${testCommand}\``}. If it genuinely cannot be verified here, say so plainly.`;
}

/**
 * Whether a proof tool's call actually proved anything.
 *
 * The tool NAME is not evidence, and neither is `isError` alone. `code_verify` journals its
 * own result, but a call whose expectation did not match (`exit 0, but the expected output
 * never appeared`) or whose command failed (`FAILED (exit 1)`) records nothing that settles a
 * debt — and until 2026-10-04 this gate counted every such call as proof, by name alone, so
 * the turn was filed `proved` and wrote NO `unverified` debt (`gate-verify.js:189-192`;
 * measured by the gate/budget audit, whose probe shows the gate journal writing
 * `"state":"proved","debt":false` for a mismatched verification). The other half of this
 * package already disagreed: `lib/ledger.js` settles a debt only on `ok === true`.
 *
 * The verdict has to be read the way the harness delivers it. A listener receives
 * `{ content: [{ type: 'text', text }], isError }` — structured fields are frequently absent,
 * and the second version of this function read only those and therefore still counted a
 * failing verification as proof. So the text is inspected too, with the two markers
 * `code_verify` prints about itself, plus any exit-code marker the shell tools append.
 *
 * An absent or unreadable result counts as **not** proof, deliberately: this gate's job is to
 * withhold the benefit of the doubt, and a shape it cannot read is not one it can trust.
 * @param result - the run tool's result, as the harness passes it to `tools/post-execute`.
 */
function provedCall(result) {
  if (result === undefined || result === null) return false;
  if (typeof result !== 'object') return false;
  if (result.isError === true) return false;
  if (result.ok === false) return false;
  if (typeof result.exitCode === 'number' && result.exitCode !== 0) return false;
  const text = (Array.isArray(result.content) ? result.content : [])
    .map((block) => (block?.type === 'text' ? block.text : ''))
    .join('\n');
  // `ok false` and `FAILED (exit 1)` are the two ends of a `code_verify` that did not pass;
  // a successful call prints neither. `[exit code: N]` is what the native shell tools append,
  // so the same reading covers a `pwsh` run that someone lists as a proof tool.
  if (/expectation not matched|\bok false\b/i.test(text)) return false;
  if (/\[exit code: (?!0\b)-?\d+\]/i.test(text)) return false;
  return true;
}

/** Inlined so the gate still works when `apply` is called without validated config. */
function resolveLists(config) {
  return {
    editTools: new Set(config?.editTools ?? DEFAULT_EDIT_TOOLS),
    runTools: new Set(config?.runTools ?? DEFAULT_RUN_TOOLS),
    proofTools: new Set(config?.proofTools ?? DEFAULT_PROOF_TOOLS),
    docExtensions: config?.docExtensions ?? DEFAULT_DOC_EXTENSIONS,
  };
}

/** The command line of a run call, for naming what was run in the notice. */
function commandOf(args, tool) {
  const value = args?.cmd ?? args?.command ?? args?.script;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().replace(/\s+/g, ' ').slice(0, 120) : tool;
}

function isDoc(target, docExtensions) {
  if (typeof target !== 'string') return false;
  const lower = target.toLowerCase();
  return docExtensions.some((extension) => typeof extension === 'string' && lower.endsWith(extension.toLowerCase()));
}

/** @param ctx - plugin context; listeners are scoped to it and disposed with it. */
export function apply(ctx, config) {
  if (config?.enabled === false) return;
  const { editTools, runTools, proofTools, docExtensions } = resolveLists(config);
  const patience = Number.isFinite(config?.patience) ? config.patience : DEFAULT_PATIENCE;

  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const agent = exec?.agent;
      if (agent !== undefined && agent !== null) {
        const record = account(agent);
        record.cwd = exec.agent?.session?.header?.cwd ?? record.cwd;
        record.session = exec.agent?.session?.id ?? record.session;
        const tool = typeof exec.name === 'string' ? exec.name : '';
        if (editTools.has(tool)) {
          const target = exec.arguments?.file_path ?? exec.arguments?.path ?? exec.arguments?.target;
          if (!isDoc(target, docExtensions)) {
            record.edits.push(typeof target === 'string' ? `${tool} ${target}` : tool);
            record.sinceEdit = 0;
            record.warned = false;
            appendGateJournal({ event: 'edit', tool, target, edits: record.edits.length, turn: record.turn });
          }
        } else if (runTools.has(tool)) {
          record.ranAny += 1;
          // `result` decides, not the tool name: a `code_verify` whose expectation did not
          // match proves nothing, and counting it left the turn with no debt at all.
          const proved = proofTools.has(tool) && provedCall(result);
          if (proved) record.ranProof += 1;
          else record.commands.push(commandOf(exec.arguments, tool));
          record.sinceEdit = 0;
          appendGateJournal({
            event: 'run',
            tool,
            command: commandOf(exec.arguments, tool),
            proof: proved,
            proofToolButUnproved: proofTools.has(tool) && !proved,
            ranAny: record.ranAny,
            ranProof: record.ranProof,
            turn: record.turn,
          });
        } else if (record.edits.length > 0) {
          record.sinceEdit += 1;
          appendGateJournal({ event: 'other-tool', tool, sinceEdit: record.sinceEdit, turn: record.turn });
        }
      }
    } catch {
      /* the gate must never break a turn */
    }
    return next();
  });

  ctx.on('agent/pre-step', async (payload, next) => {
    let notice;
    try {
      const agent = payload?.agent;
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      if (agent !== undefined && agent !== null) {
        if (messages.some((message) => message?.source?.kind === 'user')) {
          state.delete(agent);
        } else {
          const record = account(agent);
          if (record.turn === undefined) {
            record.turn = payload.turn;
          } else if (record.turn !== payload.turn) {
            record.turn = payload.turn;
            record.edits = [];
            record.ranAny = 0;
            record.ranProof = 0;
            record.sinceEdit = 0;
            record.warned = false;
          }
          const state = evidenceState(record.ranProof, record.ranAny);
          if (record.edits.length > 0 && state !== 'proved' && record.sinceEdit >= patience && !record.warned) {
            record.warned = true;
            appendGateJournal({
              event: 'notice',
              kind: state === 'none' ? 'unproven-completion' : 'unrecorded-evidence',
              edits: record.edits.length,
              commands: record.commands.length,
              sinceEdit: record.sinceEdit,
              patience,
              declaredTest: declaredTest(record.cwd),
              turn: record.turn,
            });
            if (state === 'none') {
              notice = createUserMessage({
                content: [{ type: 'text', text: reminder(record.edits, declaredTest(record.cwd)) }],
                source: {
                  kind: 'code-gate',
                  form: 'notice',
                  summary: `${record.edits.length} edit(s), nothing run`,
                },
              });
            } else {
              // A command ran, but through a tool that records nothing. Saying
              // "you ran nothing" here would be false; the action to ask for is
              // to re-run it where the evidence lands in the ledger.
              notice = createUserMessage({
                content: [{ type: 'text', text: unrecorded(record.edits, record.commands, declaredTest(record.cwd)) }],
                source: {
                  kind: 'code-gate',
                  form: 'notice',
                  summary: `${record.edits.length} edit(s), ${record.commands.length} command(s) with no recorded evidence`,
                },
              });
            }
          }
        }
      }
    } catch {
      notice = undefined;
    }
    const decision = await next();
    if (notice === undefined || !Array.isArray(decision?.messages)) return decision;
    appendGateJournal({ event: 'notice-delivered', messages: notice.content?.[0]?.text?.slice(0, 400) });
    return { ...decision, messages: [...decision.messages, notice] };
  });

  ctx.on('agent/turn-stopping', ({ agent }) => {
    try {
      const record = state.get(agent);
      if (record !== undefined && record.edits.length > 0 && typeof record.cwd === 'string') {
        const state = evidenceState(record.ranProof, record.ranAny);
        appendGateJournal({
          event: 'turn-stopping',
          state,
          edits: record.edits.length,
          ranAny: record.ranAny,
          ranProof: record.ranProof,
          turn: record.turn,
          debt: state !== 'proved',
        });
        // Only a run that recorded its own evidence closes the turn silently. A
        // turn whose only commands ran outside `code_verify` still owes the
        // ledger an answer, and `unverifiedExcerpt` renders the two cases apart
        // so the next reader can tell "ran nothing" from "ran something unproven".
        if (state !== 'proved') {
          recordUnverified(
            record.cwd,
            {
              edits: record.edits,
              turn: record.turn,
              state,
              commands: state === 'ran' ? record.commands : undefined,
            },
            record.session,
          );
        }
      }
    } catch {
      /* memory is best-effort; a failed write must not fail the turn */
    }
    state.delete(agent);
  });
}
