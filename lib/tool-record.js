import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  SCOPE,
  globalDir,
  initLedger,
  ledgerRoot,
  recordDecision,
  recordMistake,
  recordTask,
  recordVerified,
  writeProject,
} from './ledger.js';

export const name = 'code-record';
export const inject = ['tools'];

export const Config = z.object({});

/** What each kind writes, shown in the tool description so the model maps intent to kind. */
const KINDS = [
  'project — how this project runs and is laid out (patch: commands/stack/layout/notes)',
  'progress — one task moves: start it, note a finding on it, or close it with status: done',
  'decision — an approach was chosen, with the reason and the alternatives rejected',
  'mistake — something failed and why, so no later session repeats it',
  'verified — a command someone else already ran and what it showed. Only a claim: it is journalled as claimed (ok unknown), never as evidence. Prefer code_verify, which actually runs the command and records the exit code and output.',
].join('; ');

/**
 * What the `supersedes` pointer did, said in one line — including when it did nothing.
 *
 * A pointer that landed nowhere looks exactly like one that landed if both are silent, and
 * silent failure is the class of defect this whole ledger is built against (a mistyped
 * `trigger:` that never fires, an entry recorded twice because the tool *looked* like it failed).
 * So the outcomes are three sentences rather than an optional one: stamped, already stamped by an
 * earlier call, and matched no heading.
 *
 * The result is folded into `summary`, which is a declared key — this handler may return exactly
 * four keys, because `output.schema` sets `additionalProperties: false` and the harness validates
 * *after* the write (measured 2026-10-04: a fifth key made every decision and mistake report
 * "value is not lossless JSON" while the entry had already landed).
 */
function supersededNote(result) {
  if (result === undefined) return undefined;
  if (result.matched !== true) {
    return `\`supersedes\` was NOT applied (${result.reason ?? 'no match'}) — nothing was marked as replaced, so the two entries still contradict each other; check the heading fragment against the older entry's heading`;
  }
  if (result.already !== undefined) {
    return `\`supersedes\` matched "${result.heading}", which already names its successor (${result.already}) — left as it was`;
  }
  return `marked "${result.heading}" as superseded by ${result.marker}`;
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'code_record',
      description:
        `Write one fact into the ledger so it survives this session and this context window. Default scope is this project (\`.dsh-code/\`); pass scope="global" for a fact that is true of the *machine* rather than of one repository (\`${globalDir()}\`) — a shell that mangles a pipe, an interpreter path, a host refusal. The test: would this bite you again in a different project on this host? Then it is global, and filing it here saves every other project from paying for it. Record at the moment you learn the fact, not at the end: ${KINDS}. Keep each entry to what a stranger would need to act on it.`,
      parameters: {
        kind: {
          type: 'string',
          required: true,
          enum: ['project', 'progress', 'decision', 'mistake', 'verified'],
          description: 'Which ledger the fact belongs to.',
        },
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description:
            'Where the fact lives. "project" (default) is the ledger for this repository — beside the code in `.dsh-code/`, or in this machine\'s project store once the project has been migrated; `code_brief` prints the resolved directory under `## Runtime`. "global" is the machine-wide ledger, read at the start of every session in every project. Not available for kind=progress: work belongs to a project.',
        },
        patch: {
          type: 'object',
          additionalProperties: true,
          description:
            'kind=project: fields to merge into project.json, e.g. {commands:{test:"pnpm test"},stack:"…",layout:"src/…"}. With scope=global, the host facts a session would otherwise re-derive (paths, versions, traps).',
        },
        task: {
          type: 'string',
          description:
            'kind=progress: which task to move or annotate — the full id from the task board (e.g. "2026-10-01-fix-the-parser"), its bare slug, or its exact title. Creating a second task when this one exists is refused, so pass this whenever the task is already on the board.',
        },
        title: {
          type: 'string',
          description:
            'kind=progress: the task title when starting a new one. kind=decision: the decision in one line.',
        },
        status: {
          type: 'string',
          enum: ['active', 'done', 'blocked'],
          description: 'kind=progress: where the task moves. Defaults to active.',
        },
        note: {
          type: 'string',
          description: 'kind=progress: what happened, appended to the task. Include the coordinate, not a summary.',
        },
        body: {
          type: 'string',
          description: 'kind=decision: why this approach, and what it commits the project to.',
        },
        alternatives: {
          type: 'string',
          description: 'kind=decision: the approaches rejected, with the reason each was rejected.',
        },
        symptom: {
          type: 'string',
          description: 'kind=mistake: what visibly went wrong, in the words of the error message.',
        },
        cause: {
          type: 'string',
          description: 'kind=mistake: the actual root cause once known.',
        },
        fix: {
          type: 'string',
          description: 'kind=mistake: what made it go away.',
        },
        avoid: {
          type: 'string',
          description: 'kind=mistake: the rule that prevents a repeat ("do not X because Y").',
        },
        files: {
          type: 'string',
          description:
            'kind=mistake: comma-separated file paths with line numbers where this lives. kind=decision: the same shape, naming the files this decision governs — a decision keyed this way is delivered by code-pit-guard on the edit itself, before the change is made, instead of waiting to be searched for. Leave it out when the decision governs no particular file.',
        },
        supersedes: {
          type: 'string',
          description:
            'kind=decision/mistake: a heading fragment of the entry this one replaces. The older entry is stamped `- superseded by: …` in place — never deleted, because it is the evidence that the rule was paid for — and it stops competing for briefing space while staying reachable by topic. Use it whenever you reverse an earlier decision or a pit stops being true: without it the two entries contradict each other and the next reader has to guess which one still holds. The result reports whether the pointer landed; a fragment matching no heading is reported, never silently ignored.',
        },
        trigger: {
          type: 'string',
          description:
            'kind=mistake: a regular expression matched against the command line of a run-tool call, for a pit that is about the *command* rather than about a file (e.g. `Set-Content|Out-File|Add-Content` for a shell that rewrites text wrongly). Quote it as the ledger should match it — it is used verbatim, never guessed at. It is compiled when you write it: a broken pattern is rejected here instead of silently never firing.',
        },
        triggerSample: {
          type: 'string',
          description:
            'kind=mistake: a command line the trigger should match when the pit comes up again. Tested against `trigger` at write time and reported back, so `trigger` is proven to fire on the case it exists for instead of being trusted. Use `;` to give several samples; samples that do NOT match are reported too, because a trigger that fires on everything is as useless as one that fires on nothing.',
        },
        safeCase: {
          type: 'string',
          description:
            'kind=mistake: the shape of an action that trips this `trigger` but is in fact safe — the precondition a regex cannot express (e.g. "the `??` is inside a quoted string belonging to another language", "the regex has no parentheses", "the pipeline upstream is a cmdlet, not a native program"). It is delivered in the notice next to the rule, so a reader settles the match in one step instead of re-deriving it every time. Worth writing whenever this pit has been hit on honest work: a warning that keeps firing on safe commands trains its reader to ignore it.',
        },
        cmd: {
          type: 'string',
          description:
            'kind=verified: the exact command line, written the same way code_verify takes it. It is NOT run here — prefer code_verify, which runs the command and records real evidence.',
        },
        expect: {
          type: 'string',
          description: 'kind=verified: the output that was reported to prove it (recorded as a claim).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true },
            scope: { type: 'string', required: true },
            file: { type: 'string', required: true },
            summary: { type: 'string', required: true },
            /**
             * No optional keys: this harness requires **every** declared property to be
             * `required: true` — `required: false` fails to compile the schema at all
             * (`JsonSchemaError: unsupported JSON schema: schema.properties.notice.required
             * must be true when present`, measured 2026-10-04 through the Electron binary).
             * So the rule for this tool is: return exactly these four keys, and put any
             * advisory text *into* `summary`. An attempt to declare `notice` as optional broke
             * `tool-record.js` entirely, which is strictly worse than the bug it was fixing —
             * that one at least recorded the entry before failing.
             */
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `Recorded ${value.kind} (${value.scope}) → ${value.file}\n${value.summary}${value.notice === undefined ? '' : `\n\n${value.notice}`}`,
          },
        ],
      },
      execute(args, exec) {
        const cwd = ledgerRoot(exec);
        const sessionId = exec.agent?.session?.id;
        const scope = args.scope === SCOPE.global ? SCOPE.global : SCOPE.project;
        if (scope === SCOPE.global && args.kind === 'progress') {
          throw new Error(
            'code_record(kind="progress", scope="global"): the task board is project-scoped — record the work in the project ledger. Machine-wide facts use kind="project"/"decision"/"mistake" with scope="global".',
          );
        }
        const kind = args.kind;
        /**
         * Validate BEFORE creating anything.
         *
         * `initLedger` used to run first, so a call that was then refused had already created
         * all five ledger files and journaled an `init` — and `code_brief` stopped answering
         * "No ledger yet" for a project where nothing was ever recorded. Measured 2026-10-04
         * (tool-surface audit F5): 4 of 5 refusal shapes left a full ledger behind. A rejected
         * call must not change the project's state at all, which means the checks have to run
         * on the arguments rather than after the side effect.
         */
        if (kind === 'project') {
          if (args.patch === undefined) throw new Error('code_record(kind="project") needs `patch`');
        } else if (kind === 'progress') {
          if (args.title === undefined && args.task === undefined) {
            throw new Error('code_record(kind="progress") needs `title` (or `task` naming one already on the board)');
          }
        } else if (kind === 'decision') {
          if (args.title === undefined || args.body === undefined) {
            throw new Error('code_record(kind="decision") needs `title` and `body`');
          }
        } else if (kind === 'mistake') {
          if (args.symptom === undefined || args.cause === undefined || args.fix === undefined) {
            throw new Error('code_record(kind="mistake") needs `symptom`, `cause`, and `fix`');
          }
          // The pattern is validated here rather than at the write, because a pit whose
          // `trigger:` does not compile would never fire and nothing would say so — and a
          // refused call must not have touched the ledger first.
          const trigger = typeof args.trigger === 'string' && args.trigger.trim().length > 0 ? args.trigger.trim() : undefined;
          if (trigger !== undefined) {
            try {
              // eslint-disable-next-line no-new
              new RegExp(trigger, 'i');
            } catch (error) {
              throw new Error(
                `code_record: \`trigger\` is not a valid regular expression, so the pit would never fire and nothing would say so. Fix the pattern and write the entry again. Pattern: ${JSON.stringify(trigger)} — ${error.message}`,
              );
            }
          }
          const hasSamples = typeof args.triggerSample === 'string' && args.triggerSample.trim().length > 0;
          if (hasSamples && trigger === undefined) {
            throw new Error('code_record: `triggerSample` needs `trigger` — there is no pattern to test it against');
          }
        } else if (kind !== 'verified') {
          throw new Error(
            `code_record: unknown kind ${JSON.stringify(kind)}. Use one of: project, progress, decision, mistake, verified.`,
          );
        }
        if (kind === 'verified') {
          if (typeof args.cmd !== 'string' || args.cmd.trim().length === 0) {
            throw new Error('code_record(kind="verified") needs `cmd`');
          }
        }
        initLedger(cwd, sessionId, scope);
        if (kind === 'project') {
          if (args.patch === undefined) throw new Error('code_record(kind="project") needs `patch`');
          const written = writeProject(cwd, args.patch, sessionId, scope);
          // The advisory is folded into `summary`, exactly as the decision/mistake branches
          // do. It must not be a key of its own: `output.schema` declares four properties
          // with `additionalProperties: false`, and an extra key is rejected *after* the
          // write — so the model is told the call failed while the ledger already has the
          // entry. Measured 2026-10-04: this branch returned `notice: written.notice`, which
          // is `undefined` on the normal path and a string when the file had to be moved
          // aside, and BOTH shapes are refused (an undefined leaf fails the lossless-JSON
          // snapshot; a string fails the property check).
          const projectSummary = [`project fields: ${Object.keys(args.patch).join(', ')}`, written.notice]
            .filter((part) => typeof part === 'string' && part.length > 0)
            .join(' — ');
          return Promise.resolve({ kind, scope, file: written.file, summary: projectSummary });
        }
        if (kind === 'progress') {
          const { file, task, notice } = recordTask(
            cwd,
            { title: args.title, status: args.status, note: args.note, slug: args.task },
            sessionId,
          );
          // Same rule as above, and this branch was the one that failed on *every* call:
          // `notice` is either an undeclared string or an undefined leaf, so both the
          // ordinary path and the corrupt-ledger path were rejected after the task had
          // already been moved on the board.
          const progressSummary = [
            `${task.id} [${task.status}] ${task.title}${args.note === undefined ? '' : ` — ${args.note}`}`,
            notice,
          ]
            .filter((part) => typeof part === 'string' && part.length > 0)
            .join(' — ');
          return Promise.resolve({ kind, scope, file, summary: progressSummary });
        }
        if (kind === 'decision') {
          if (args.title === undefined || args.body === undefined) {
            throw new Error('code_record(kind="decision") needs `title` and `body`');
          }
          const writtenDecision = recordDecision(
            cwd,
            {
              title: args.title,
              body: args.body,
              alternatives: args.alternatives,
              files: args.files,
              supersedes: args.supersedes,
            },
            sessionId,
            scope,
          );
          // The length advisory goes into `summary`, never into a key of its own.
          //
          // This handler used to return a fifth key `notice`, which `output.schema`
          // (above, `additionalProperties: false`) does not declare. The harness
          // validates the result *after* the handler has run, so every
          // kind="decision"/"mistake" call was reported to the model as
          // `tool "code_record" returned invalid output: value is not lossless JSON`
          // — while the entry had already been written to the ledger. Measured
          // 2026-10-04: kind="project" (which returns no `notice`) answered normally;
          // kind="mistake" and kind="decision" both failed and both wrote. The model
          // retrying a "failed" record is what turned one pit into `recurred: 2`.
          const decisionSummary = [args.title, supersededNote(writtenDecision.superseded), writtenDecision.warning]
            .filter((part) => typeof part === 'string' && part.length > 0)
            .join(' — ');
          return Promise.resolve({ kind, scope, file: writtenDecision.file, summary: decisionSummary });
        }
        if (kind === 'mistake') {
          if (args.symptom === undefined || args.cause === undefined || args.fix === undefined) {
            throw new Error('code_record(kind="mistake") needs `symptom`, `cause`, and `fix`');
          }
          const trigger = typeof args.trigger === 'string' && args.trigger.trim().length > 0 ? args.trigger.trim() : undefined;
          // A `trigger:` is the command-side of the pit guard: the pattern that
          // makes a pit arrive *before* the command runs. Until now a pattern that
          // did not compile was swallowed at match time (`matchesTrigger` catches
          // and returns false), so a typo meant the pit silently never fired and
          // nothing anywhere reported it — the same silent-failure class as a
          // `files:` path that names no real file. The write is the only moment a
          // human or model is looking at the pattern, so it is rejected here.
          if (trigger !== undefined) {
            try {
              // eslint-disable-next-line no-new
              new RegExp(trigger, 'i');
            } catch (error) {
              throw new Error(
                `code_record: \`trigger\` is not a valid regular expression, so the pit would never fire and nothing would say so. Fix the pattern and write the entry again. Pattern: ${JSON.stringify(trigger)} — ${error.message}`,
              );
            }
          }
          const samples =
            typeof args.triggerSample === 'string'
              ? args.triggerSample
                  .split(';')
                  .map((part) => part.trim())
                  .filter((part) => part.length > 0)
              : [];
          if (samples.length > 0 && trigger === undefined) {
            throw new Error('code_record: `triggerSample` needs `trigger` — there is no pattern to test it against');
          }
          /**
           * A pit with no rule and no coordinate is what makes a ledger unreadable.
           *
           * The briefing is bounded (8,900 characters against two ledgers of 110,000),
           * so an entry earns its place only if something can *find* it again: a
           * `trigger:` that matches a command, a `files:` path that matches an edit, a
           * `do not repeat:` rule worth reading, or a symptom long enough to search
           * for. Refusing the entry here is cheaper than carrying it forever — the
           * same reasoning that already rejects a `trigger:` that does not compile.
           */
          const rule = typeof args.avoid === 'string' ? args.avoid.trim() : '';
          const locator =
            trigger !== undefined ||
            (typeof args.files === 'string' && args.files.trim().length > 0) ||
            rule.length >= 12 ||
            String(args.symptom).trim().length >= 24;
          if (!locator) {
            throw new Error(
              'code_record: this mistake has no rule and no way to be found again — give `avoid` (the rule, "do not X because Y"), or `files`, or a `trigger` regex, or a longer `symptom`. A ledger entry nothing can retrieve is a cost with no benefit.',
            );
          }
          const written = recordMistake(
            cwd,
            {
              symptom: args.symptom,
              cause: args.cause,
              fix: args.fix,
              files: args.files,
              trigger,
              avoid: args.avoid,
              safeCase: args.safeCase,
              supersedes: args.supersedes,
            },
            sessionId,
            scope,
          );
          const tested = samples.map((sample) => {
            const re = new RegExp(trigger, 'i');
            return { sample, matches: re.test(sample) || re.test(sample.replace(/\s+/g, ' ')) };
          });
          const summary = [
            args.symptom,
            written.merged === true
              ? `MERGED into the entry that already describes this pit (now recurred ${written.recurred}×); a repeat is evidence the rule is needed, so it ranks first in the brief instead of becoming a second entry`
              : undefined,
            tested.length === 0
              ? undefined
              : `trigger tested against ${tested.length} sample(s): ${tested.filter((t) => t.matches).length} matched${tested.some((t) => !t.matches) ? `, ${tested.filter((t) => !t.matches).length} did NOT match (${tested.filter((t) => !t.matches).map((t) => JSON.stringify(t.sample)).join(', ')})` : ''}`,
            // The length/coordinate advisory rides in `summary` (a declared key) rather
            // than in a `notice` key of its own — see the note on the decision branch.
            written.warning,
            supersededNote(written.superseded),
            // Reported next to the write, because the fix is "merge, or say why not" and the
            // writer is the only one holding the meaning of the pit.
            written.repeatHint,
          ]
            .filter((part) => typeof part === 'string' && part.length > 0)
            .join(' — ');
          return Promise.resolve({ kind, scope, file: written.file, summary });
        }
        if (kind === 'verified') {
          if (args.cmd === undefined) throw new Error('code_record(kind="verified") needs `cmd`');
          const file = recordVerified(
            cwd,
            { cmd: args.cmd, expect: args.expect, ok: null, claimed: true, tail: args.expect },
            sessionId,
            scope,
          );
          return Promise.resolve({
            kind,
            scope,
            file,
            summary: `claimed (never run here): ${args.cmd}`,
          });
        }
        throw new Error(
          `unknown kind ${JSON.stringify(kind)}; expected project, progress, decision, mistake, or verified`,
        );
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `Record ${args.kind}`,
        kind: 'other',
        rawInput: args,
      }),
    }),
  );
}
