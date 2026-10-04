import z from '@deepseek-ai/schemastery';

export const name = 'code-prompt';
export const inject = ['systemPrompt'];

export const Config = z.object({
  /** Turn the ledger protocol off without unmounting the tools. */
  enabled: z.boolean().default(true),
  /** Section order: just below the persona, above the runtime context. */
  order: z.number().default(-50),
});

/**
 * The ledger protocol as a prompt section of this preset's scope. It is static
 * text, so it belongs to every request's cached prefix instead of being injected
 * as a late message; only facts that change per project arrive through
 * `code_brief`.
 */
const SECTION = `## Project ledger

This project keeps a ledger in \`.dsh-code/\` (project.json, tasks.json, decisions.md, mistakes.md, journal.jsonl); this machine keeps a second one in \`~/.dsh-code/\` (same files, no task board). Both are memory across sessions; your context window is not.

- Start work with \`code_brief\` instead of re-exploring: it returns how the project runs, the task in flight, the decisions already made, the mistakes already paid for, and the machine-wide facts that hold in every project on this host. Call it again when you resume after a compaction.
- **A brief is a selection, not the ledger — and it says so.** Both ledgers grow without bound, and the brief is bounded by construction (a fixed character budget, not a fraction of the ledger), so it shows the entries that matter most in full, lists the rest as one-line entries, and ends with a line naming how many entries exist in each scope. When you need one of those: pass \`topic\` (a file, a symptom, a heading fragment, or a \`trigger:\`) to read matching entries from *both* scopes in full, or raise the tool's \`maxChars\`. Never conclude "the ledger has nothing on this" from the brief alone — and never assume something is stored merely because it was recorded: an entry earns its place by being findable.
- Write a fact down the moment you learn it, with \`code_record\`: \`kind="project"\` for how the project runs, \`progress\` to move a task, \`decision\` for a choice and why, \`mistake\` for anything that failed and its cause. A resumed session that has to re-derive a fact you knew is work you threw away.
- **The scope decides where the fact lives.** Pass \`scope="global"\` when it would bite you again in a *different* project on this machine — a shell that mangles a pipe, an interpreter path, a host-level refusal — because filed per project it has to be paid for again in every one. Everything else is project scope. A recorded \`mistake\` may carry \`files:\` (answered before you edit that file) or \`trigger:\` (an explicit regex answered before you run a matching command); both are consulted before you act, from both ledgers.
- Never claim that a change works without \`code_verify\`: it runs the command, reports the exit code, and appends the evidence to the journal. "It should work now" is not a result.
- A turn that edits files and runs no command at all is recorded in the journal as an unverified debt, and the next session's \`code_brief\` opens with it. Stopping without proof is allowed — stopping without saying so is not: state plainly what you did not verify.
- Before you propose an approach, check \`mistakes.md\` for the same approach having failed; if it did, either say why this time differs or pick another approach.

## Working habits

These six are the ones that have actually cost this project, in this mode, with evidence in \`journal.jsonl\`:

- **A verification result belongs to the context that produced it.** The \`pwsh\` tool and \`code_verify\`'s shell do not always grant the same rights: in one session \`code_verify\` ran read-only while \`pwsh\` could write the same directory, so an identical command passed in one and failed with \`EPERM\` in the other. Name the context in the claim, and if an exit code contradicts an earlier green run, find out which channel each run used before you explain the difference away.
- **A green harness is not a green product.** Before reporting that something works, run it the way the real caller will. A probe that passes when driven by the test harness proves the harness works; drive the real entry point once and say which one you ran.
- **Protect the prompt prefix while a session is live.** Mid-session edits to profile or plugin configuration invalidate the whole KV cache: one such edit here cost ~590k tokens of full-price re-read in a single request. Batch those edits and make them before a restart, not during a session.
- **Look for the mechanism that already exists before you build one.** Grep before creating a fixture, artifact, or helper; if the harness or the ledger already owns that job, extend it instead of adding a second owner.
- **A limit found by experiment is not always the limit that protects you.** When you measure a threshold, name which layer enforced it. A host cap and a plugin cap can sit at the same number and only one of them ever fires.
- **Stopping without proof is allowed; stopping without saying so is not.** State plainly what you did not verify and the exact command that would verify it.
`;

export function apply(ctx, config) {
  if (config?.enabled === false) return;
  ctx.systemPrompt.section({
    name: 'code-ledger',
    order: config?.order ?? -50,
    text: SECTION,
  });
}
