import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
// The canonical owner of "run a ledger-supplied regex without ever hanging": `pit-guard`
// already used it, `ledger` did not, and the audit measured the difference (21,432 ms).
import { testPatternSync } from './pattern-matcher.js';
// The one reader of a `- label: value` line. Shared with `pit-guard` because eight copies of it
// drifted apart once already, and the two that merely *reported* on a field ended up announcing
// the opposite of what the guard actually read (2026-10-06). `superseded by:` is read through it
// for the same reason: a second regex here would be a second answer to "what does this say".
import { entryField } from './entry-fields.js';

export const DIRNAME = '.dsh-code';
export const FILES = {
  project: 'project.json',
  tasks: 'tasks.json',
  decisions: 'decisions.md',
  mistakes: 'mistakes.md',
  journal: 'journal.jsonl',
};

/**
 * Scope of a fact. `project` is the ledger next to the code (what this project
 * is, how it runs, what it already paid for); `global` is the machine-wide
 * ledger (what is true of *this host*, whatever project you are in).
 *
 * The distinction exists because a pit can belong to the machine rather than to
 * one project — measured 2026-10-02: a Windows PowerShell 5.1 pipe wrote a
 * `byte[]` out as concatenated decimal values and destroyed three files here, and
 * the same trap waits in every other repository on this host. Filed per project,
 * that lesson has to be paid for again in each of them; filed globally, it
 * arrives once and then every project's brief carries it.
 */
export const SCOPE = { project: 'project', global: 'global' };

/**
 * Where the machine-wide ledger lives: `~/.dsh/code/`, inside DSH's own `~/.dsh/`.
 *
 * Not `~/.dsh-code/`: that was the pre-2026-10-10 location, and it is a second
 * top-level folder in the user's profile. `~/.dsh/` already exists the moment
 * anything runs DSH and already holds `profiles/`, `sessions/`, `storages/`,
 * so the ledger sits where those do rather than claiming a new neighbour —
 * "不要在我的c盘乱创建文件夹" (2026-10-10). The old path is still honoured below
 * while it holds a ledger, so an unpatched copy in flight keeps its own memory
 * across the move instead of quietly starting a second one.
 *
 * `DSH_CODE_GLOBAL_DIR` overrides it. That is not a convenience: a probe running
 * under the file sandbox cannot write the user's home directory, so the override
 * is what makes this layer testable in both channels (the same reason the probes
 * put their reports in temp).
 */
export function globalDir() {
  const override = process.env.DSH_CODE_GLOBAL_DIR;
  if (typeof override === 'string' && override.trim().length > 0) return path.resolve(override.trim());
  // Home inside DSH's own directory, not a second top-level folder in the user's profile:
  // "不要在我的c盘乱创建文件夹" (2026-10-10). `~/.dsh/` is created by anything that runs DSH,
  // which is the software this whole package belongs to, and it already holds `profiles/`,
  // `sessions/`, `storages/`, so the ledger sits where those do.
  const inside = path.join(os.homedir(), '.dsh', 'code');
  // The pre-2026-10-10 location, honoured while it still holds a ledger so a running (unpatched)
  // copy keeps reading and writing its own memory across the move instead of starting a second
  // one. Retired by `probes/cleanup-migrated-ledgers.mjs --retire-machine`.
  const legacy = path.join(os.homedir(), DIRNAME);
  if (fs.existsSync(inside)) return inside;
  return fs.existsSync(legacy) ? legacy : inside;
}

/**
 * The single store every project ledger now lives in: `<globalDir>/projects/<slug>/`.
 *
 * Why one place (2026-10-10, user request): ledgers used to be born wherever the agent
 * happened to work, so every repository grew its own `.dsh-code/`. The user asked for one
 * location and for the existing ledgers to be migrated into it. The machine ledger was
 * already at `~/.dsh-code/`, so the whole machine now has exactly one parent directory.
 *
 * How a directory is identified: by the `project-root` file inside it, holding the absolute
 * project path. The reader looks for the directory that claims this project — deliberately
 * *not* by recomputing a slug, because a shared algorithm is one more thing that can drift
 * between the writer (`probes/migrate-ledgers.mjs`) and the reader. `slugFor` exists only for
 * the greenfield case, and its shape matches the migration script's.
 *
 * How a migrated project keeps working: `<repo>/.dsh-code/CENTRAL` says `central <path>`.
 * Reading the pointer first is what lets the old location stay *usable* rather than
 * *preferred* — 25+ probes build `<scratch>/.dsh-code/...` by hand and would all break if the
 * local directory stopped winning.
 */
const PROJECT_STORE_DIRNAME = 'projects';
const PROJECT_POINTER = 'CENTRAL';
const PROJECT_ROOT_MARKER = 'project-root';

/** The store, honouring `DSH_CODE_PROJECTS_DIR` so a probe can run hermetically. */
export function projectStoreDir() {
  const override = process.env.DSH_CODE_PROJECTS_DIR;
  return typeof override === 'string' && override.trim().length > 0
    ? path.resolve(override.trim())
    : path.join(globalDir(), PROJECT_STORE_DIRNAME);
}

/** The slug a *new* project directory gets; the same shape the migration script derives. */
export function slugFor(cwd) {
  const resolved = path.resolve(cwd);
  const normal = resolved.replace(/\\/g, '/').toLowerCase();
  const base = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'project';
  return `${base}-${createHash('sha256').update(normal).digest('hex').slice(0, 8)}`;
}

/** What a directory in the store says its project is, or undefined when it says nothing. */
function storeOwner(directory) {
  try {
    const value = fs.readFileSync(path.join(directory, PROJECT_ROOT_MARKER), 'utf8').trim();
    return value.length === 0 ? undefined : path.resolve(value);
  } catch {
    return undefined;
  }
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** Whether `candidate` is `inside` or equal to it, compared segment-wise. */
function isInside(inside, candidate) {
  const from = path.resolve(inside).toLowerCase();
  const to = path.resolve(candidate).toLowerCase();
  if (from === to) return true;
  const relative = path.relative(from, to);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The store directory for `cwd`, created on demand together with its identity marker.
 *
 * @returns the directory, or undefined in the one case that must never be written through:
 *   when it would resolve to the project itself (a guard, not a formality — a store living
 *   inside a project would make the ledger a child of the thing it describes).
 */
export function projectDirFor(cwd) {
  const resolved = path.resolve(cwd);
  const store = projectStoreDir();
  /**
   * Refuse a store that lives anywhere **inside** the project — not only the `<project>/.dsh-code`
   * case. Measured 2026-10-10: the guard originally compared against `<project>/.dsh-code`
   * exactly, so a store configured at `<project>/.dsh-code/store` slipped through and the
   * ledgers nested one level deeper (probe S5 caught it, and the first version of that check
   * passed for the wrong reason). A store inside a project makes the ledger a child of the
   * thing it describes; there is no configuration in which that is what someone meant.
   */
  if (isInside(resolved, store)) return undefined;
  let names;
  try {
    names = fs.readdirSync(store, { withFileTypes: true });
  } catch {
    names = [];
  }
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(store, entry.name);
    const owner = storeOwner(directory);
    if (owner !== undefined && samePath(owner, resolved)) return directory;
  }
  const directory = path.join(store, slugFor(resolved));
  try {
    fs.mkdirSync(directory, { recursive: true });
    if (storeOwner(directory) === undefined) {
      fs.writeFileSync(path.join(directory, PROJECT_ROOT_MARKER), `${resolved}\n`, 'utf8');
    }
  } catch {
    /* a read-only or unwritable store is reported by the caller, not here */
  }
  return directory;
}

/** Caps keep every ledger read cheaper than re-deriving the fact. */
const CAP = {
  brief: 4000,
  journalTail: 5,
  projectBytes: 3200,
  tasks: 40,
  resultChars: 6000,
};

/**
 * Journal rotation. The journal is the only ledger file with no ceiling above it:
 * every verification appends a line and nothing ever removes one, so it is the one
 * file whose growth is unbounded *and read whole* — measured 2026-10-03 at 328 lines
 * / 396,412 bytes in this project alone, and `pit-liveness.mjs` plus three paths
 * inside this module read all of it to answer a question about one turn.
 *
 * The fix is rotation, *not* deletion: when the live file passes `JOURNAL_ROTATE_BYTES`
 * it is renamed aside and a fresh one starts, so the cost of a read is bounded by the
 * segment size while every line stays on disk and stays readable through
 * {@link readJournalText}. `JOURNAL_KEEP` is a guard against a pathological writer,
 * not a retention policy — nothing here deletes a rotated segment.
 */
const JOURNAL_ROTATE_BYTES = 512 * 1024;
const JOURNAL_KEEP = 8;

/**
 * How long a `.lock` file may sit before it is assumed to belong to a process that died.
 *
 * The critical sections are synchronous file writes, so a lock this old is never a live
 * writer — it is a crashed one, and refusing to write would be worse than breaking it.
 */
const LOCK_STALE_MS = 5000;

/** Above this, a single entry is clipped like any other; below it, one entry fits whole. */
const HARD_ENTRY_CHARS = 1200;

/**
 * How long one prose field of a mistake or decision may get before the writer is
 * told about it.
 *
 * This is the write-side half of the bounded-brief problem, and it is the *only*
 * side that can work: the briefing is already bounded by construction, so a ledger
 * that grows past what a briefing can show does so entirely through **new entries**.
 * Measured on this host 2026-10-03: 35 project mistake entries (34,295 chars) plus 77
 * machine-wide ones (80,571) against a briefing that can display ~4,000–8,900, with a
 * one-line index costing 79–94 characters per entry — so 112 entries need ~10,000
 * characters of index alone, more than the whole budget. The entries that get dropped
 * are the cold ones, and they are dropped silently from the reader's point of view.
 *
 * A warning and not a refusal, deliberately. The rule this project already enforces
 * (refuse an entry that has neither a rule nor a retrieval coordinate) protects
 * *findability*; length does not, because a long entry with a `trigger:` is still
 * found by its trigger. Refusing on length would also lose the fact entirely, which is
 * worse than a verbose record of it — the ledger's own standard is that a fact nobody
 * wrote down is the expensive outcome.
 */
const PROSE_FIELD_LIMIT = 1600;

/**
 * Warn when a ledger entry is written as narrative rather than as a rule.
 *
 * @param fields - `{ label: text }` prose fields the caller supplied.
 * @param block - the rendered entry, measured as a whole.
 * @returns a warning sentence, or undefined when the entry is within its shape.
 */
function entryLengthWarning(fields, block) {
  const long = Object.entries(fields)
    .filter(([, text]) => typeof text === 'string' && text.trim().length > PROSE_FIELD_LIMIT)
    .map(([label, text]) => `${label} (${text.trim().length})`);
  const total = String(block ?? '').length;
  if (long.length === 0 && total <= PROSE_FIELD_LIMIT * 2) return undefined;
  return (
    `This entry is unusually long (${total} chars${long.length === 0 ? '' : `; over the ${PROSE_FIELD_LIMIT}-char bar: ${long.join(', ')}`}). ` +
    'A briefing shows whole entries ranked by usefulness, so a verbose entry crowds out several others and a cold one stops being shown at all. ' +
    'Keep the rule and the coordinates, and move the narrative into the rule: what a stranger must do differently is worth more than how you found it.'
  );
}


/**
 * Character budget per briefing section, applied before the sections are
 * joined.
 *
 * A plain head slice at CAP.brief used to run *after* assembly, so the first
 * sections won the whole budget: on a populated ledger the verbose `## Project`
 * block plus a `## Recent ledger entries` index consumed it, the section order
 * (project → board → journal → unverified → mistakes → decisions) left no room,
 * and the brief was cut mid-heading with every known mistake and recent decision
 * silently evicted — measured 2026-10-01 at 4043 chars, 4/4 mistakes and 3/4
 * decisions gone, `## Turns that cha` torn (`.dsh-probe\deep-guard-probe.mjs`,
 * check A1/A2/A3). Nothing downstream can report what it never saw.
 *
 * The allocation is deliberately lopsided: the expensive narrative (project,
 * layout, and a journal index the briefing already summarises) yields first,
 * because the memory the briefing exists for is the mistakes and the decisions.
 * `unverified` gets the largest slot through its own section cap because it is
 * the pointer to proof that does not exist yet. A single section is never cut
 * and left marked as present: it is cut and dropped whole, and the caller is
 * told which ones were dropped.
 */
const SECTION_BUDGET = {
  // section key -> [share of the divisibility pass, hard per-section ceiling]
  project: [6, 1700],
  global: [12, 1100],
  journal: [5, 1100],
  unverified: [12, 1600],
  mistake_debt: [8, 900],
  board: [5, 900],
  mistakes: [16, 1400],
  decisions: [16, 1400],
};
/** The machine-wide section names its own scope, so a reader knows where it came from. */
const GLOBAL_HEADING = '## Machine-wide facts (true of this host, every project)';
/** Order the reader sees; the allocation pass is independent of it. */
const SECTION_ORDER = ['project', 'global', 'board', 'journal', 'unverified', 'mistake_debt', 'mistakes', 'decisions'];
/**
 * The pool above which the per-section division stops mattering: the sum of every
 * section's ceiling, so dividing what is left cannot give any section less than the
 * ceiling it would take anyway.
 *
 * Derived from {@link SECTION_BUDGET} rather than written down, because the constant it
 * replaces (8,900) was *smaller* than the sum it is supposed to cover — the eight
 * ceilings add up to 10,100. A brief that reached the ceilings branch could therefore
 * spend 10,100 characters against an 8,900-character budget and had its tail clipped,
 * which is where the retrieval hint and the drop notices live (measured 2026-10-04:
 * audit probe 12B, `maxChars 8948` took the branch and the project section spent its
 * whole 1,700-character ceiling).
 */
const UNCAPPED_TOTAL = Object.values(SECTION_BUDGET).reduce((sum, [, ceiling]) => sum + ceiling, 0);

/**
 * Order-independent allocation: every section gets room before any section gets
 * its ceiling, so no single verbose section can starve the rest.
 *
 * `reserved` is the room the trailing notices need, and it is reserved *before* the
 * sections divide the rest — the opposite of the old order, which appended notices
 * after every section had spent its allowance. Measured 2026-10-03 against the real
 * ledgers: the section bodies came to 3,825 characters of a 4,000-character budget,
 * the appended notices then pushed the text past the bound, and the final clip removed
 * the one line that told the reader the other 106 entries existed. A brief that hides
 * its own index is worse than a short one.
 *
 * The floor is one entry plus one index line: below that a section shows a fragment and
 * reveals nothing, so it is better to drop the section and name it.
 *
 * Above {@link UNCAPPED_TOTAL} the division is skipped altogether and every section may
 * spend its ceiling — but the comparison is against the *pool*, which is the budget minus
 * the reserve, so a caller that wants that branch has to ask for more than the constant
 * itself (see {@link briefFull}).
 * @param budget - total characters available for section bodies.
 * @param reserved - characters the caller will append after the sections.
 * @returns per-section character allowance.
 */
function allocateSectionBudget(budget, reserved = 0) {
  const keys = Object.keys(SECTION_BUDGET);
  const pool = Math.max(1, budget - reserved);
  const totalWeight = keys.reduce((sum, key) => sum + SECTION_BUDGET[key][0], 0);
  const allowance = {};
  for (const key of keys) {
    const [weight, ceiling] = SECTION_BUDGET[key];
    const share = Math.floor((pool * weight) / totalWeight);
    allowance[key] = Math.max(1, Math.min(ceiling, share));
  }
  if (pool >= UNCAPPED_TOTAL) for (const key of keys) allowance[key] = SECTION_BUDGET[key][1];
  return allowance;
}

/** Cut one section body to `limit`, marking the cut so a reader can tell. */
function clip(body, limit) {
  const text = String(body ?? '');
  if (text.length <= limit) return text;
  return `${wholeCharSlice(text, 0, Math.max(1, limit - 1))}…`;
}

/**
 * Cut a section to `limit`, keeping one line that says it was cut and where the rest is.
 *
 * `clip` alone drops the fact that anything was dropped, and for the handover that is
 * the expensive kind of loss: this project has already recorded both halves of it — a
 * debt section that vanished after an unrelated proof, and a notice that `clipTail`
 * removed because its room had not been reserved. So the marker's own length is spent
 * *before* the body is cut, and the line that says "there was more" is never the thing
 * that gets removed.
 * @param body - the assembled section body, no heading.
 * @param limit - characters available for the body.
 * @param tailHint - where the cut-off part can be read.
 */
function clipWithNotice(body, limit, tailHint) {
  const text = String(body ?? '');
  if (text.length <= limit) return text;
  const marker = `\n… (cut here for length; the rest is in ${tailHint})`;
  if (marker.length + 1 >= limit) return clip(text, limit);
  return `${clip(text, limit - marker.length)}${marker}`;
}

/** Keep the tail of a line-oriented body, naming how many lines were dropped. */
function clipTail(body, limit, unit = 'lines') {
  const text = String(body ?? '');
  if (text.length <= limit) return text;
  const lines = text.split('\n');
  const kept = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const size = lines[index].length + 1;
    if (used + size > limit) break;
    kept.unshift(lines[index]);
    used += size;
  }
  const dropped = lines.length - kept.length;
  const marker = `… (${dropped} earlier ${unit} dropped for length)`;
  return kept.length === 0 ? clip(text.slice(-limit), limit) : `${marker}\n${kept.join('\n')}`;
}

/**
 * Newest complete blocks that fit `limit`, plus a marker naming how many older
 * blocks were dropped.
 *
 * A raw character window is unsafe for this: it slices by characters, which
 * can cut *inside* an entry so the reader gets a heading-less fragment with no
 * indication that anything is missing (measured 2026-10-01: the mistakes
 * section came out as a single dangling `## 2026-10-01 · mistake-3-…` heading,
 * 136 chars, while the section had ~900 chars of room). Complete entries, or a
 * named omission — never a silent half-entry. `windowEntries` below is what
 * replaced the raw slice; the entry this comment describes is kept because it
 * is the reason the current shape is what it is.
 * @param text - the raw markdown file.
 * @param limit - characters available for the kept blocks, marker included.
 * @returns block text plus how many older blocks did not fit.
 */

/**
 * Assemble the briefing. Every section is optional, so a fresh project yields a
 * short "start the ledger" answer rather than an error.
 * @param cwd - project root.
 * @param options - `topic` narrows the mistake section; `session` labels journal rows.
 * @param options.maxChars - total characters the caller will show; sections are
 *   allocated inside it and any that do not fit are reported in `omitted`.
 */
export function brief(cwd, { topic, session, maxChars, full } = {}) {
  const requested = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : CAP.brief;
  if (!exists(cwd)) {
    // A project with no ledger of its own still benefits from the machine's: the
    // host facts (interpreter paths, shell traps) and the pits that are true of
    // this machine are exactly what a first session here would otherwise re-learn
    // by breaking something. The caller's budget applies on this path too: this is
    // the only section it gets, so its allowance is the smaller of the budget and
    // the section ceiling. Ignoring `maxChars` here meant a caller asking for 60
    // characters could receive 900 (measured 2026-10-02 by the guard probe).
    const machine = globalExcerpt(Math.min(SECTION_BUDGET.global[1], requested), topic);
    return {
      text: [
        machine === undefined ? undefined : `${GLOBAL_HEADING}\n${machine}`,
        `No ledger yet at ${ledgerPointer(cwd, 'project')}.`,
        'Record the basics before exploring: code_record(kind="project", patch={commands:{test:"…"},stack:"…",layout:"…"}).',
      ]
        .filter((part) => part !== undefined)
        .join('\n\n'),
      empty: true,
      omitted: [],
    };
  }
  /**
   * The line that turns a bounded brief into a readable ledger, computed *before* the
   * sections so its room can be reserved rather than begged for at the end.
   *
   * Every section ranks entries and indexes the rest, but ranking is only half: without
   * this sentence the reader sees a selection and has no reason to think a follow-up
   * call would find anything else — the exact state the machine ledger sat in with 77
   * pits and a handful displayed. It also names the coordinates the reader already has
   * in hand (a file being edited, a command about to run, a symptom).
   */
  const hint = retrievalHint([
    { dir: ledgerDir(cwd, SCOPE.project), scope: SCOPE.project },
    ...(exists(undefined, SCOPE.global) ? [{ dir: globalDir(), scope: SCOPE.global }] : []),
  ]);
  // The restart notice is budgeted and emitted as a *notice*, not as a section body.
  //
  // Measured 2026-10-03: putting it at the head of the journal body meant `clipTail` — which
  // keeps the tail — deleted exactly the one line that must not be dropped, so the notice
  // showed up under `briefFull` and vanished under the default budget. Same failure class as
  // the briefing that hid its own index and the machine section that showed a drop count
  // with nothing shown: the reserved room is computed *first*, then the sections divide what
  // is left.
  /**
   * A pending restart is carried as a *notice*, not as a section body.
   *
   * Two reasons, both measured. A ninth section would change the allocation every other
   * section gets (and the budget probes assert those numbers) for one line. And the first
   * attempt put it at the head of the journal body, where `clipTail` — which keeps the tail
   * — deleted exactly the line that must not be dropped: it appeared under `briefFull` and
   * vanished under the default budget.
   */
  const pendingRestart = restartPending(cwd);
  const restartNotice =
    pendingRestart === undefined
      ? undefined
      : `**Waiting for a restart:** ${pendingRestart.files.length === 0 ? 'a lib/ file' : pendingRestart.files.map((f) => path.basename(f)).join(', ')} changed at ${String(pendingRestart.at).slice(0, 16).replace('T', ' ')} and the running host has not loaded it. Child plugin modules are imported once at mount, so the change is dormant until DSH restarts — and after that restart, start a NEW conversation rather than resuming one, or the whole prefix re-sends uncached.`;
  // Note: `brief` reads. It deliberately does not record a `session_start` — that write
  // belongs to the tool layer (`tool-brief.js`), because a *read* function that mutates the
  // ledger means every probe and every caller records something, and measured 2026-10-03 it
  // turned an empty journal section non-empty and made this very briefing report "1 earlier
  // ledger entries dropped for length" in a fixture that must produce no notice at all.
  const reserve =
    (hint === undefined ? 0 : hint.length + 2) +
    24 * Math.max(1, Math.ceil(SECTION_ORDER.length / 4)) +
    (restartNotice === undefined ? 0 : restartNotice.length + 2);
  /**
   * The bound this assembly is held to, and the budget the sections divide.
   *
   * `full` asks for the largest *bounded* view, which is the ceilings branch — and that
   * branch is decided on the pool, i.e. on the budget **minus the reserve**, while the
   * reserve is only knowable here (it is the hint's and the restart notice's own length,
   * just above). So `full` cannot be expressed by the caller as a number at all: passing
   * exactly `UNCAPPED_TOTAL` is what made the branch unreachable, because the reserve took
   * the pool under the threshold on every call and `full` behaved exactly like a normal
   * brief. Measured 2026-10-04 (audit probe 06B): `briefFull() -> 5816 chars, project body
   * 704` against `brief(maxChars: 20000) -> 6803 chars, project body 1691`, with
   * `briefFull lifts the division: false`.
   *
   * `UNCAPPED_TOTAL + reserve` makes the pool exactly `UNCAPPED_TOTAL`, so the branch
   * fires, every section spends its ceiling, and the sum of those ceilings plus the
   * reserve is still the returned text's hard bound — the final clip below can only fire
   * on a genuine overrun, never on the budget being one reserve too small.
   */
  const budget = full === true ? UNCAPPED_TOTAL + reserve : requested;
  const allowance = allocateSectionBudget(budget, reserve);
  const mistakes = mistakeExcerpt(cwd, topic, allowance.mistakes - 30);
  const decisions = decisionExcerpt(cwd, topic, allowance.decisions - 30);
  const bodies = {
    project: projectSummary(cwd, allowance.project),
    /**
     * The machine section is built to *its own* ceiling, never past the one this budget
     * gave it.
     *
     * `globalExcerpt` falls back to `SECTION_BUDGET.global[1]` (1100) whenever its limit
     * is not a positive number, so a tiny total budget — which allocates this section a
     * share of 1 — used to build a 1100-character body that its allowance could never
     * hold. The allocator then dropped the section (and named it, which is why this was
     * not the silent loss the audit predicted), but the section body had already
     * overrun the allowance the allocation pass is supposed to guarantee. Clamping here
     * keeps "bounded by construction" true rather than argued.
     */
    global: globalExcerpt(allowance.global, topic, factRecency(SCOPE.global)),
    board: boardSummary(cwd),
    // All three journal readers are given the scope they are answering for. They
    // used to call `ledgerPath(cwd, 'journal')` with no scope at all, so a
    // machine-wide briefing summarised *this project's* journal — a wrong-scope read
    // that looked perfectly healthy because the project almost always has one.
    journal: recentJournal(cwd, session, SCOPE.project),
    unverified: unverifiedExcerpt(cwd, session, SCOPE.project),
    mistake_debt: unrecordedMistakes(cwd, session, SCOPE.project),
    // Entry-bearing sections keep whole entries and name what they dropped,
    // instead of slicing mid-entry and losing the heading that gives it meaning.
    mistakes: mistakes.body,
    decisions: decisions.body,
  };
  const headings = {
    project: '## Project',
    global: GLOBAL_HEADING,
    board: '## Task board',
    journal: '## Recent ledger entries',
    unverified:
      '## Turns that changed code and ran nothing\nEarlier sessions edited them and never proved anything; a line marked "no recorded evidence" also ran commands, but nothing wrote down what they printed:',
    mistake_debt:
      '## Failing commands nobody wrote down\nEarlier turns ran these, they failed, and the turn recorded no mistake — the pit is in the journal but not in the ledger:',
    mistakes: `## Known mistakes${topic === undefined ? '' : ` matching "${topic}"`}`,
    decisions: topic === undefined ? '## Recent decisions' : `## Decisions matching "${topic}"`,
  };
  const sections = [];
  const project = readProject(cwd);
  const board = readTasks(cwd);
  /**
   * Whether the ledger holds a section that the reader should have seen but did
   * not. Deliberately false for `journal` and `unverified`: their bodies are
   * filtered (settled debts, entries from the current session), so an empty body
   * there means "nothing to report", not "something is hidden".
   */
  const hasContent = {
    // `initLedger` writes a project.json that carries nothing but version/createdAt
    // and empty fields, so presence alone is not content — the same distinction
    // the rest of this section already makes for mistakes and decisions.
    project: projectSummary(cwd, CAP.projectBytes) !== undefined,
    // The machine-wide ledger may simply not exist on this host; producing a body
    // at all means it holds facts or pits, so presence is content here.
    global: bodies.global !== undefined,
    // An initialized board with no tasks (`{active:[],done:[],blocked:[]}`) holds
    // nothing to show either — "read the files" would point at empty arrays.
    board:
      board !== undefined &&
      ['active', 'done', 'blocked'].some((key) => Array.isArray(board[key]) && board[key].length > 0),
    journal: false,
    unverified: false,
    mistake_debt: false,
    mistakes: (mistakes.entries ?? 0) > 0,
    decisions: (decisions.entries ?? 0) > 0,
  };
  /** Sections the budget refused; an absent section is not a dropped section. */
  const dropped = [];
  /** Sections that exist in the ledger but produced no body (e.g. all entries filtered away). */
  const emptySections = [];
  for (const key of SECTION_ORDER) {
    const body = bodies[key];
    // A section that was never written is simply absent, not "omitted".
    if (body === undefined || body.trim().length === 0) {
      // "Had no entry to show" must mean the ledger holds one but the reader
      // cannot see it. An empty body from a *settled* debt (or a journal whose
      // entries were all skipped) is the normal, healthy case: reporting it as
      // empty was the same absent-vs-dropped confusion this briefing already
      // paid for once (measured 2026-10-01: a settled debt still produced
      // "unverified exist in the ledger but had no entry to show").
      if (hasContent[key]) emptySections.push(key);
      continue;
    }
    const heading = headings[key];
    const room = allowance[key] - heading.length - 2;
    if (room <= 0) {
      dropped.push(key);
      continue;
    }
    let clipped;
    if (key === 'mistakes' || key === 'decisions') {
      // The excerpt already shaped itself into entries plus an index of the rest;
      // re-windowing it here would cut the index away and reintroduce the very
      // "counted but unreachable" state this section exists to end.
      clipped = body;
    } else if (key === 'project' || key === 'global') {
      clipped = body; // the excerpt already spent its own allowance
    } else if (key === 'journal' || key === 'unverified' || key === 'mistake_debt') {
      clipped = clipTail(
        body,
        room,
        key === 'journal' ? 'ledger entries' : key === 'unverified' ? 'unverified turns' : 'unrecorded failures',
      );
    } else {
      clipped = clip(body, room);
    }
    if (clipped.trim().length === 0) {
      dropped.push(key);
      continue;
    }
    sections.push(`${heading}\n${clipped}`);
  }
  let text = sections.join('\n\n');
  const notices = [];
  if (dropped.length > 0) {
    notices.push(
      `… (${dropped.length} ledger section(s) dropped for length: ${dropped.join(', ')}; read the files in ${ledgerPointer(cwd)} for the rest)`,
    );
  }
  if (emptySections.length > 0) {
    notices.push(
      `… (${emptySections.join(', ')} exist in the ledger but had no entry to show — read the files in ${ledgerPointer(cwd)})`,
    );
  }
  /**
   * A topic that matched nothing says so.
   *
   * Found by reading this assembly rather than by running it: with a `topic` that hits nothing,
   * `mistakes` and `decisions` both come back with zero entries, their sections are simply
   * *absent* (an absent section is not a dropped one), and the brief that comes back is
   * indistinguishable from one where no question was asked at all. The reader asks, receives a
   * briefing, and cannot tell that the answer was "nothing here" — the silent-omission class this
   * file keeps paying for, in the one message whose job is to answer a question.
   *
   * Scoped to this project's ledger on purpose, and it claims nothing about the machine-wide
   * section: `globalExcerpt` deliberately falls back to showing *all* machine pits when a topic
   * does not match them, so "the machine ledger has nothing" is not a fact this function can know.
   */
  const topicShown = Array.from(String(topic ?? '').trim()).slice(0, 80).join('');
  const topicMissed =
    typeof topic === 'string' &&
    topic.trim().length > 0 &&
    (mistakes.entries ?? 0) === 0 &&
    (decisions.entries ?? 0) === 0;
  if (topicMissed) {
    notices.unshift(
      `… (\`topic: "${topicShown}"\` matched no mistake and no decision in this project's ledger — either this project has not paid for it yet, or it is filed under different words: try a file name, a symptom fragment, or a \`trigger:\`)`,
    );
  }
  // First among the notices: a dormant change is a fact about the code the session is
  // running, which outranks anything about how the briefing itself was clipped.
  if (restartNotice !== undefined) notices.unshift(restartNotice);
  // The hint was computed before the sections so its room could be reserved; a second
  // computation here would be a second owner of the same sentence.
  if (hint !== undefined) notices.push(hint);
  if (notices.length > 0) text += `\n\n${notices.join('\n')}`;
  /**
   * The hard bound, enforced rather than argued.
   *
   * `A1` has asserted `text.length <= 4000` since the first briefing, and every
   * section is allocated inside the budget by construction — but "by construction"
   * is a claim, and this function has overrun its budget before (the machine section
   * came out at 490 characters against an allowance of 273, measured 2026-10-02).
   * Notices are appended after every section has spent its allowance, so they are
   * exactly where an overrun can still happen. Clip last, and say so.
   */
  if (text.length > budget) text = clip(text, budget);
  return { text, empty: false, omitted: dropped, emptySections };
}

/**
 * How much of the ledger one handover may carry.
 *
 * Half of {@link CAP.brief}, deliberately: a brief opens a session with the whole
 * window ahead of it, while a handover rides inside a step that is already near the
 * context bound (T2 attaches one to the gate's own message), so its ceiling has to be
 * *smaller* than the view it is derived from, not equal to it. The number is a budget,
 * not a measurement.
 */
const HANDOVER_BUDGET = 2000;

/** The two sections a handover has, and nothing else. */
const HANDOVER_HEADINGS = { next: '## Next', avoid: '## Avoid' };

/**
 * Newest decisions named in `## Avoid`. Their heading line is the whole obligation
 * ("do not re-open this"); the argument stays re-readable in the file, and the count
 * of the ones not named is emitted rather than dropped silently.
 */
const HANDOVER_DECISIONS = 4;

/**
 * The label that keeps "nothing has proved this" apart from "this is proved".
 *
 * The gate's instruction used to *ask* the model to keep those two apart in prose;
 * a derived view can do it structurally instead, which is the whole reason this
 * function exists.
 */
const HANDOVER_UNVERIFIED = 'Unverified (edited, and no recorded proof covers it — do not treat it as done):';

/**
 * The two labels `## Avoid` splits the pits under, in the order they are rendered.
 *
 * The split is the view's own rule (see the comment where it is applied): a pit that
 * carries a `trigger:` or a `files:` can arrive on its own while you work, and one that
 * carries neither cannot — it is a rule to look up. Saying which is which is the point;
 * listing them in one ranked block would leave the reader to guess.
 */
const HANDOVER_COORDINATE_LABEL = 'Rules that carry a coordinate (`trigger:`/`files:`) — these arrive on their own:';
const HANDOVER_PROSE_LABEL = 'Rules with no coordinate — nothing will surface these, so look them up when they apply:';

/**
 * What to do next and what to avoid, derived from the ledger, bounded, read-only.
 *
 * Why this exists (2026-10-05): the compaction gate's third option asked the model to
 * **write** the whole handover, which made the ledger's own contents a memory burden —
 * the one thing a ledger exists to remove — and invited exactly what the instruction
 * then had to forbid in words: a summary of the conversation just had. The user
 * narrowed the handover to two things, "what is next" and "what to avoid", and at that
 * width almost all of it is a *view* of records that already exist:
 *
 *   - "next" is the board's in-flight work, plus the turns nothing has proved, plus the
 *     failures nobody wrote down, plus a `lib/` change still dormant behind a restart;
 *   - "avoid" is the pits that carry a coordinate and the questions already decided.
 *
 * Two fields cannot be derived from any ledger, so the caller supplies them: `nextMove`
 * and `stoppedBecause`. Nothing else is taken from the caller, and that is what makes
 * the "no conversation narrative" requirement structural rather than a rule someone has
 * to remember: this function has no access to a conversation. It renders structured
 * entries, so what the user said — let alone how they said it — has no path in.
 *
 * Every read goes through the readers `brief` already uses. That is a rule and not a
 * style: this project has already paid for two owners of one read (`pit-guard`'s
 * matcher and {@link searchEntries} drifted until one of them hung for 21,432 ms). The
 * pits half of `## Avoid` is the one place that could not call its reader whole —
 * {@link mistakeExcerpt} ranks its entries before it returns, and this view has to split
 * them before they are ranked (see the comment where the split happens) — so it composes
 * the same two calls that reader composes (`markdownEntries` over the file,
 * {@link shapeEntries} to rank) and adds a filter over their result. A filter is not a
 * second parser, and within each half `shapeEntries` is still the only ranker; what
 * would have been the second implementation is a locally written block parser, and there
 * is none.
 *
 * Read-only, without exception: it writes no file and appends no journal line. Same
 * reasoning as `brief` (a *read* that records something turns every caller and every
 * probe into a writer, so `noteSessionStart` belongs to the tool layer) plus one of its
 * own: a handover that recorded anything would settle the very debt it reports.
 *
 * @param cwd - project root.
 * @param options - `session` skips the current session's own in-flight turns;
 *   `nextMove` (what to do next) and `stoppedBecause` (why it stopped here) are the two
 *   fields no ledger holds; `maxChars` overrides {@link HANDOVER_BUDGET}.
 * @returns `{ text, empty }` — the same shape `brief` returns, so the tool layer's
 *   existing "was there anything to say" branch works unchanged. `empty` is true when
 *   neither a derivation nor a supplied field produced a line. There is no `omitted`
 *   list: each reader used here already names what *it* dropped, and a section with no
 *   body is never emitted, so no heading in the result is hollow.
 */
export function handover(cwd, { session, nextMove, stoppedBecause, maxChars } = {}) {
  const bound = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : HANDOVER_BUDGET;
  /**
   * Both sections are needed at once — "what is next" without "what to avoid" is half
   * of the pair this exists as — so the split is fixed rather than first-come, and the
   * two headings plus the blank line between them are reserved before either section
   * spends anything. `## Next` takes the larger half: it carries the only two fields
   * that cannot be re-derived by reading a ledger.
   */
  const room = Math.max(40, bound - HANDOVER_HEADINGS.next.length - HANDOVER_HEADINGS.avoid.length - 4);
  /**
   * `## Next` takes this share of the room the two headings leave.
   *
   * Named because it is the one number that decides which half of a handover a reader meets
   * first: `## Next` carries the only two fields that cannot be re-derived by reading a ledger,
   * so it takes the larger half. As a bare fraction it was untunable and invisible.
   */
  const HANDOVER_NEXT_SHARE = 0.55;
  const nextRoom = Math.floor(room * HANDOVER_NEXT_SHARE);
  const avoidRoom = room - nextRoom;

  // --- Next ------------------------------------------------------------------
  /**
   * The order inside `## Next` is a priority, because a bounded section is cut from the
   * tail: the two fields this text uniquely carries come first, then the derived debt,
   * then the two things the *next* session's own `code_brief` prints from the same
   * readers anyway (the board, and the dormant-change notice, which `brief` carries as a
   * reserved notice).
   *
   * That order is the repository's own rule for a bounded view — cut what is regenerable
   * from a file, reserve room for what cannot be recovered by reading anything. It was
   * measured here the other way round first: with the caller's two fields last, a
   * verbose `nextMove` pushed the *debt* off the end of the section (2026-10-05, this
   * probe's first run, `N2`/`N2c` red), which is the wrong half to lose.
   */
  const next = [];
  if (typeof nextMove === 'string' && nextMove.trim().length > 0) {
    next.push(`- Next move: ${clip(nextMove.trim(), 240)}`);
  }
  if (typeof stoppedBecause === 'string' && stoppedBecause.trim().length > 0) {
    next.push(`- Stopped because: ${clip(stoppedBecause.trim(), 160)}`);
  }
  /**
   * Proved and unproved, as two things a reader can tell apart.
   *
   * `verifyCount` is the proved side rather than a walk of our own: a second read of
   * the journal here would be a second answer to one question, which is the drift this
   * file keeps paying for. The pair is emitted only when there *is* unproved work — a
   * count of proofs with nothing to contrast it against is noise, and noise is what a
   * handover at 2,000 characters cannot afford.
   */
  const unproven = unverifiedExcerpt(cwd, session, SCOPE.project);
  if (unproven !== undefined) {
    const proofs = verifyCount(cwd);
    next.push(
      proofs === 0
        ? 'Verified: nothing — no passing code_verify result is on record, so nothing below is proved:'
        : `Verified: ${proofs} passing code_verify result${proofs === 1 ? '' : 's'} on record, and none of them covers the edits below:`,
    );
    next.push(HANDOVER_UNVERIFIED, unproven);
  }
  const unrecorded = unrecordedMistakes(cwd, session, SCOPE.project);
  if (unrecorded !== undefined) next.push('Failures nobody wrote down:', unrecorded);
  for (const task of (readTasks(cwd)?.active ?? []).slice(0, 5)) {
    const id = typeof task.id === 'string' && task.id.length > 0 ? task.id : '(no id)';
    const title = typeof task.title === 'string' && task.title.length > 0 ? task.title : '(untitled)';
    // The id and the title, never `notes`: a task's notes are where the thousands of
    // characters live, and the board is one file read away.
    next.push(`- Task ${id} — ${clip(title, 120)}`);
  }
  const restart = restartPending(cwd);
  if (restart !== undefined) {
    const files = restart.files.length === 0 ? 'a lib/ file' : restart.files.map((entry) => path.basename(entry)).join(', ');
    next.push(
      `- Dormant until DSH restarts: ${files} changed at ${String(restart.at).slice(0, 16).replace('T', ' ')} and the running host has not loaded it.`,
    );
  }

  // --- Avoid -----------------------------------------------------------------
  const avoid = [];
  const decisions = markdownEntries(readFile(ledgerPath(cwd, 'decisions', SCOPE.project)));
  const named = decisions.slice(-HANDOVER_DECISIONS).reverse();
  const decisionLines = named.map((block) => `- ${clip(headingOf(block), 160)}`);
  if (decisions.length > named.length) {
    decisionLines.push(`- … ${decisions.length - named.length} older decision(s) in ${ledgerPointer(cwd, 'decisions')}`);
  }
  const decisionsBlock = decisionLines.length === 0 ? '' : `Already decided — do not re-open:\n${decisionLines.join('\n')}`;
  /**
   * The pits are split *before* they are ranked, and that order is the whole point.
   *
   * `shapeEntries` ranks by what makes a rule worth showing while someone is working: a
   * `recurred:` count above an executable `trigger:` above a `files:` name above recency.
   * `code_brief` keeps exactly that order, and this view does not change it — within each
   * half below, `shapeEntries` is still the only ranker. What differs is the first
   * question asked, because a handover is read once by a session that has to act: *can
   * this rule reach me on its own?* A pit carrying a `trigger:` that matches the command
   * about to run, or a `files:` that names the file about to be edited, will arrive by
   * itself; a pit with neither is a rule you have to go and look up, and it belongs below
   * the ones that will find you — including below a coordinate pit that has never fired,
   * because recurrence is evidence for the brief's question ("which rule is most worth
   * showing?") and not for this one ("which rule will stop me in the next five minutes?").
   *
   * The split happens here rather than inside the ranking because it *cannot* happen
   * after it: ranking first and filtering second gives the same rules in the wrong order,
   * which is why the ordering is decided before `shapeEntries` is called at all. Both
   * halves are parsed by the same `markdownEntries` read and ranked by the same
   * `shapeEntries`, so nothing here is a second implementation of either.
   */
  const pitBlocks = markdownEntries(readFile(ledgerPath(cwd, 'mistakes', SCOPE.project)));
  const carriesCoordinate = (block) => fieldOf(block, 'trigger') !== undefined || fieldOf(block, 'files') !== undefined;
  const coordinatePits = pitBlocks.filter(carriesCoordinate);
  const prosePits = pitBlocks.filter((block) => !carriesCoordinate(block));
  // The decided questions are paid for first, then the prose-only pits (a small, fixed
  // share — a rule that cannot arrive on its own is a rule to look up, not to skim), and
  // the coordinate pits take what is left, which is where the room should end up.
  const proseRoom = prosePits.length === 0 ? 0 : Math.max(80, Math.min(400, Math.floor(avoidRoom / 5)));
  const pitRoom = Math.max(120, avoidRoom - decisionsBlock.length - (prosePits.length === 0 ? 0 : proseRoom + HANDOVER_PROSE_LABEL.length) - 2);
  if (coordinatePits.length > 0) {
    avoid.push(HANDOVER_COORDINATE_LABEL, shapeEntries(coordinatePits, pitRoom).text);
  }
  if (prosePits.length > 0) {
    avoid.push(HANDOVER_PROSE_LABEL, shapeEntries(prosePits, proseRoom).text);
  }
  if (decisionsBlock.length > 0) avoid.push(decisionsBlock);

  // --- assemble --------------------------------------------------------------
  /**
   * A section is cut with {@link clipWithNotice}, never with a bare `clip`: the tail of
   * both sections is a reader's only warning that something is missing (the debt rows at
   * the end of `## Next`, the decided questions at the end of `## Avoid`), and dropping
   * it silently is the failure this project has paid for twice.
   */
  const sections = [];
  const nextBody = next.join('\n').trim();
  if (nextBody.length > 0) {
    sections.push(
      `${HANDOVER_HEADINGS.next}\n${clipWithNotice(nextBody, nextRoom, `${ledgerPointer(cwd, 'journal')} and ${ledgerPointer(cwd, 'tasks')}`)}`,
    );
  }
  const avoidBody = avoid.join('\n').trim();
  if (avoidBody.length > 0) {
    sections.push(
      `${HANDOVER_HEADINGS.avoid}\n${clipWithNotice(avoidBody, avoidRoom, `${ledgerPointer(cwd, 'mistakes')} and ${ledgerPointer(cwd, 'decisions')}`)}`,
    );
  }
  let text = sections.join('\n\n');
  /**
   * The hard bound, executed here rather than argued — the same last step `brief` takes,
   * for the same reason. Every reader above is bounded and both sections are clipped to
   * their own share, but this project's own recorded lesson is that `"by construction"
   * is a claim`, and there is a live counter-example in the path: `shapeEntries`
   * deliberately returns one whole entry rather than a fragment, so a section *can*
   * overrun the limit it was given. A caller asking for less than the two section floors
   * is the case no inner limit can cover at all.
   */
  if (text.length > bound) text = clip(text, bound);
  return { text, empty: text.trim().length === 0 };
}

/**
 * The project root for one tool call. Prefer the agent session's working
 * directory (a subagent or a resumed session may differ from the Host cwd),
 * and fall back to the Host process cwd.
 * @param exec - the tool run context.
 */
export function ledgerRoot(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd();
}

/**
 * Whether this project's ledger has been migrated: `<repo>/.dsh-code/CENTRAL` holds
 * `central <absolute project path>`. Checked before the local directory on purpose — after a
 * migration the local `.dsh-code/` still exists with the same files, and preferring it would
 * keep every write in the old place while the store slowly went stale.
 */
export function isCentral(cwd) {
  try {
    const value = fs.readFileSync(path.join(cwd, DIRNAME, PROJECT_POINTER), 'utf8').trim();
    if (!/^central\b/i.test(value)) return false;
    const declared = value.replace(/^central\b/i, '').trim();
    if (declared.length === 0) return true;
    return samePath(declared, cwd);
  } catch {
    return false;
  }
}

/**
 * Whether `<cwd>/.dsh-code/` already **is** this project's ledger.
 *
 * Any ledger file counts, not only `project.json`. The reason is measured, not theoretical:
 * the probe fixtures build `<scratch>/.dsh-code/` by hand and several of them write only
 * `mistakes.md` or only `journal.jsonl`. A test for `project.json` alone would call those
 * "no ledger here", send the write to the store, and leave the fixture's own file — and the
 * check that reads it — untouched and failing. That is the "two owners" failure this whole
 * change is supposed to avoid, one level down.
 *
 * The predicate that implemented this was `hasLocalLedger`, removed 2026-10-16: it had no
 * caller. Step 3 below replaced it — a new project stays local rather than being sent to the
 * store, which is the same outcome by a simpler route. The paragraph above is kept because it
 * is the reason step 3 exists.
 */

/**
 * The directory holding one ledger.
 *
 * Order, and each step is load-bearing:
 *   1. `global` scope is the machine ledger at `~/.dsh-code/` — never moved.
 *   2. a `CENTRAL` pointer means this project was migrated: the store wins.
 *   3. any local ledger file means an unmigrated, working ledger: leave it alone. This is also
 *      what keeps every probe fixture (built by hand in 25+ files) working unchanged.
 *   4. otherwise a brand-new project: the store, so no `.dsh-code/` is ever created again.
 *
 * @param cwd - project root.
 * @param scope - {@link SCOPE}; anything but `global` means the project ledger.
 */
export function ledgerDir(cwd, scope) {
  if (scope === SCOPE.global) return globalDir();
  if (isCentral(cwd)) return projectDirFor(cwd) ?? path.join(cwd, DIRNAME);
  // Unmigrated: the project's own directory, as it always was. Routing *new* projects into the
  // store instead broke `guard-probe` (measured 2026-10-10: exit 1, no report, on a suite that
  // is green without the change) because that probe writes its fixture through `writeProject`
  // and then appends to `<fixture>/.dsh-code/journal.jsonl` by hand — and several suites seed a
  // fixture the same way. A hand-written ledger is a ledger; deciding otherwise on the writer's
  // behalf creates two owners for one file. Migration is therefore an explicit act (the
  // `CENTRAL` pointer, written by `probes/migrate-ledgers.mjs`), never an inference — and the
  // user's goal still holds, because a project has exactly one ledger, in one place.
  return path.join(cwd, DIRNAME);
}

/**
 * Where a reader should be sent for the rest of this ledger: the short form while the ledger
 * still lives inside the project, the resolved path once it has been migrated out.
 *
 * The distinction is about the briefing's character budget as much as about correctness: these
 * pointers are drawn from it, `ledgerDir()`/`ledgerPath()` are always correct but ~90 characters
 * long once a project has been migrated, and a notice that grows without bound is a notice that
 * evicts the memory it is printed next to. Short where it is still true, resolved where it is
 * not.
 *
 * Do not repeat the mistake this comment first carried: it claimed `journal-rotation-probe` J3
 * went red *because* the resolved path was pasted in, on the strength of an A/B against `HEAD`.
 * That baseline was worthless — `git stash -- lib/` reverts every uncommitted `lib/` change, and
 * this repository carries a whole session's migration work uncommitted — so the comparison was
 * "pre-migration code" versus "now", not "my edit" versus "without my edit". J3 is still red
 * with this function in place, and its cause is elsewhere (see the ledger's 2026-10-10 entry).
 *
 * @param cwd - project root.
 * @param kind - one of {@link FILES}, or undefined for the directory itself.
 */
export function ledgerPointer(cwd, kind) {
  const resolved = kind === undefined ? ledgerDir(cwd) : ledgerPath(cwd, kind);
  if (isCentral(cwd)) return resolved;
  return path.relative(cwd, resolved).split(path.sep).join('/') || DIRNAME;
}

/**
 * {@link ledgerDir}, but a directory that cannot be created is fatal *here*.
 *
 * Every write path used to do `fs.mkdirSync(ledgerDir(...), {recursive:true})` and ignore the
 * result. With the store that would be worse than before: a store that cannot be reached must
 * not silently turn into a write into the project (or into nothing at all). One helper, one
 * decision point.
 */
function ledgerDirOrThrow(cwd, scope) {
  const directory = ledgerDir(cwd, scope);
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error) {
    throw new Error(
      `unusable ledger directory ${directory} for ${scope === SCOPE.global ? 'the machine ledger' : `project ${path.resolve(cwd)}`}: ${error?.code ?? error?.message ?? error}`,
    );
  }
  return directory;
}

/**
 * One ledger file by kind.
 * @param cwd - project root.
 * @param kind - one of {@link FILES}.
 * @param scope - {@link SCOPE}.
 */
export function ledgerPath(cwd, kind, scope) {
  return path.join(ledgerDir(cwd, scope), FILES[kind]);
}

export function exists(cwd, scope) {
  return fs.existsSync(ledgerDir(cwd, scope));
}

/**
 * Read a ledger JSON file, treating "missing" and "unreadable" as different things.
 *
 * They used to be one branch — a bare `catch { return fallback }` — and that made a
 * single typo destructive. Every caller turns the fallback into a fresh default and the
 * next mutation writes it back over the real file, so a hand-edit or a torn write cost
 * the whole ledger while the tool reported success. Measured 2026-10-04: a trailing
 * comma in `.dsh-code/tasks.json` (the shape a truncated write leaves) followed by one
 * `recordTask` erased every task on the board.
 *
 * This function stays pure: it still returns the fallback. {@link preserveCorruptFile}
 * is what the *writing* paths call, so a corrupt file is set aside exactly where the
 * overwrite would have happened, and never on a read.
 */
function readJson(file, fallback, valid = undefined) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
  // A caller can pass a shape test for the case the parse cannot see: valid JSON that is
  // not the thing at all (`null`, `42`, `"oops"`, `[7]`). Returning the fallback here is
  // what routes it into the same preserve-and-tell path as a syntax error.
  if (valid !== undefined && !valid(parsed)) return fallback;
  return parsed;
}

/**
 * Whether a ledger JSON file parsed. A `false` here means "present but unusable", which is
 * what decides the wording of {@link corruptNotice}: the two cases read differently to the
 * person who has to recover the file, and the recovery path is the same for both.
 */
function parsedButInvalid(file, valid) {
  try {
    return valid(JSON.parse(fs.readFileSync(file, 'utf8'))) ? undefined : 'parsed but does not contain the expected shape';
  } catch {
    return undefined; // a syntax error is already described as "could not be parsed"
  }
}

/**
 * Move a present-but-unparseable ledger file aside before defaults are written over it.
 *
 * Called by the mutation paths (`writeProject`, `recordTask`) once they have seen a read
 * fail on a file that exists. The original bytes are kept rather than repaired in place:
 * guessing at a repair is how the wrong half gets kept.
 * @param file - the ledger JSON file about to be overwritten.
 * @returns the path the bytes were moved to, or undefined when there was nothing to save.
 */
function preserveCorruptFile(file) {
  if (!fs.existsSync(file)) return undefined; // absent, not corrupt: nothing to lose
  const recovery = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    fs.renameSync(file, recovery);
    return recovery;
  } catch {
    return undefined;
  }
}

/**
 * The sentence a mutation returns when it found a ledger file it could not read.
 * @param recovery - path from {@link preserveCorruptFile}, or undefined.
 * @param what - what was lost, e.g. `tasks`.
 * @param why - what was wrong with it; defaults to "could not be parsed".
 */
function corruptNotice(recovery, what, why = 'could not be parsed') {
  if (recovery === undefined) return undefined;
  return (
    `[!] ${what} ${why}, so it was moved aside to ${recovery} and a fresh file was written. ` +
    `The ledger is intact again, but the previous content is only in that file — read it before assuming those records are gone.`
  );
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Whole file as text, or '' when unreadable. Parse with this, window afterwards. */
function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Newest complete entries whose combined size fits `limit`, oldest first.
 *
 * This replaced `readTail` (a raw character window, deleted 2026-10-16 with no caller left),
 * which could cut inside an entry and hand the reader a heading-less fragment with no sign
 * that anything was missing — measured 2026-10-01: the mistakes section came out as one
 * dangling `## 2026-10-01 · mistake-3-…` heading, 136 chars, while the section had ~900 chars
 * of room. Whole entries, or a named omission — never a silent half-entry.
 */
function windowEntries(entries, limit) {
  const kept = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const size = entries[index].length + 1;
    if (kept.length > 0 && used + size > limit) break;
    if (kept.length === 0 && size > limit) {
      kept.unshift(entries[index]);
      break;
    }
    kept.unshift(entries[index]);
    used += size;
  }
  return kept.join('\n\n');
}

function appendBlock(file, block) {
  appendLocked(file, `${block}\n`);
}

/**
 * Append to a ledger file while holding a short-lived lock in the same directory.
 *
 * Two sessions can share one project (a second GUI window, a subagent, a resumed
 * session), and every ledger write is a read-modify-append on a file whose whole
 * value is its line structure. A lost append is silent: the writer sees success,
 * and the entry is simply not there for the next reader — the same "looks fine,
 * content is missing" class this project keeps paying for. The lock is advisory
 * and best-effort on purpose: an unavailable lock delays the write, and a stale
 * lock (a crashed session) is broken after a few seconds, because refusing to
 * record a fact is worse than a rare interleaved line.
 * @param file - the ledger file to append to.
 * @param text - the text to append verbatim.
 * @returns true when the append happened (with or without the lock).
 */
function appendLocked(file, text) {
  withLedgerLock(file, () => {
    fs.appendFileSync(file, text, 'utf8');
  });
  return true;
}

/**
 * Run `work` while holding `file`'s lock — the same single owner the append path uses.
 *
 * Extracted 2026-10-04 because two writers had drifted apart: `appendLocked` took this
 * lock, while the merge path (`recordMistake`) did a read-modify-write with a plain
 * `writeFileAtomic` and no lock at all. Two processes merging concurrently therefore both
 * rewrote the file from their own snapshot, so one repeat was recorded as `recurred: 1`
 * twice; and because a rename onto a file another process holds open fails on Windows, the
 * merge's exception used to escape the tool call and the record was lost.
 *
 * Contention is expected and cheap here: the critical sections are synchronous file
 * operations, so a spin with `Atomics.wait` is the whole retry strategy, as it was in the
 * append path. A lock older than {@link LOCK_STALE_MS} belonged to a process that died.
 */
function withLedgerLock(file, work) {
  const lock = `${file}.lock`;
  let acquired = false;
  const deadline = Date.now() + 2000;
  while (!acquired && Date.now() < deadline) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      acquired = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') break; // not contention: run the work unlocked rather than refuse it
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // it disappeared between the open and the stat
      }
      if (ageMs > LOCK_STALE_MS) {
        try {
          fs.unlinkSync(lock); // a session that died holding it
        } catch {
          /* someone else broke it first */
        }
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return work();
  } finally {
    if (acquired) {
      try {
        fs.unlinkSync(lock);
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * The journal's live file plus every rotated segment, oldest first.
 *
 * Rotation renames rather than deletes, so a reader that walks this list sees the
 * same sequence of lines it would have seen before rotation existed — that is the
 * whole point, and why every in-module reader goes through
 * {@link readJournalText} instead of touching `FILES.journal` directly.
 * @param cwd - project root.
 * @param scope - {@link SCOPE}.
 * @returns absolute paths, oldest segment first, the live file last.
 */
export function journalFiles(cwd, scope) {
  const dir = ledgerDir(cwd, scope);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [ledgerPath(cwd, 'journal', scope)];
  }
  const live = FILES.journal;
  const rotated = names
    .filter((name) => name.startsWith(`${live}.`) && !name.endsWith('.lock'))
    // HIGHEST NUMBER FIRST, and that is not a detail: rotation shifts `.00N` -> `.00(N+1)`
    // and then renames the live file onto `.000`, so the newest segment is `.000` and the
    // OLDEST is the highest number. This used to sort ascending and call itself
    // chronological, which reversed the order from the second rotation onward — readers
    // then saw the newest lines as the oldest, and `restart_pending` answered "no pending
    // restart" while the journal's own timestamps said the change was still dormant
    // (ledger-core audit F4, 2026-10-04).
    .sort()
    .reverse()
    .map((name) => path.join(dir, name));
  return [...rotated, path.join(dir, live)];
}

/**
 * Every journal line for one ledger, oldest segment first.
 *
 * Reads *all* segments on purpose. A bounded read that silently skipped the rotated
 * ones would turn "no failing command was left unrecorded" into "no such line was in
 * the part I happened to read" — the silent-omission class this project keeps paying
 * for. Callers that want a bounded view (the briefing's tail) take the tail of this.
 * @param cwd - project root.
 * @param scope - {@link SCOPE}.
 * @returns the concatenated text, or `''` when there is no journal yet.
 */
export function readJournalText(cwd, scope) {
  let out = '';
  for (const file of journalFiles(cwd, scope)) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (text.length > 0) out += text.endsWith('\n') ? text : `${text}\n`;
    } catch {
      /* a segment that vanished between readdir and read is not an error */
    }
  }
  return out;
}

/**
 * Rename the live journal aside so the next read is cheap again.
 *
 * Best-effort and non-destructive by construction: it only ever renames, it never
 * deletes a segment, and any failure leaves the caller to append to the file it
 * already had. A journal that cannot rotate is a slow journal, not a lost one.
 * @returns the new segment's path, or undefined when nothing was rotated.
 */
function rotateJournal(file) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return undefined; // no file yet: nothing to rotate
  }
  if (size < JOURNAL_ROTATE_BYTES) return undefined;
  const dir = path.dirname(file);
  const base = path.basename(file);
  const slot = (index) => path.join(dir, `${base}.${String(index).padStart(3, '0')}`);
  // Retire the oldest segment FIRST, so the shift below always has somewhere to put its
  // last move. Doing it after the shift left `.000` occupied whenever the window was full —
  // every slot taken, `.000` -> `.001` skipped because `.001` existed — so rotation returned
  // early and the live file grew without bound (ledger-core audit F5: the real ledger had
  // used 1 of its 9 slots and was at 319 KB of a 524 KB threshold). `JOURNAL_KEEP` is the
  // retention window it was always documented to be, not a tripwire nobody could cross.
  if (fs.existsSync(slot(JOURNAL_KEEP))) {
    try {
      fs.unlinkSync(slot(JOURNAL_KEEP));
    } catch {
      return undefined; // cannot retire it: leave the live file alone rather than overwrite
    }
  }
  // Shift `.00(N-1)` -> `.00N` from the highest down, so nothing is overwritten.
  for (let index = JOURNAL_KEEP - 1; index >= 0; index -= 1) {
    const from = slot(index);
    const to = slot(index + 1);
    if (!fs.existsSync(from)) continue;
    try {
      if (!fs.existsSync(to)) fs.renameSync(from, to);
    } catch {
      /* keep going: an older segment that cannot move must not block this one */
    }
  }
  const target = slot(0);
  try {
    if (fs.existsSync(target)) return undefined; // shift failed; stay on the live file
    fs.renameSync(file, target);
    return target;
  } catch {
    return undefined;
  }
}

function appendJournal(cwd, entry, scope) {
  const file = ledgerPath(cwd, 'journal', scope);
  ledgerDirOrThrow(cwd, scope);
  rotateJournal(file);
  appendLocked(file, `${JSON.stringify(entry)}\n`);
}

/**
 * Append one arbitrary event to a ledger's journal.
 *
 * Exported so a plugin can record something the ledger itself has no opinion about —
 * currently a pit's `trigger:` firing. The design notes call a mistyped trigger a
 * *silent* failure: the pit simply never fires and nothing says so, and there was no
 * statistic for "this trigger has never matched anything". Recording the hit is what
 * turns that absence into evidence.
 * @param cwd - project root.
 * @param event - any JSON-serialisable record; `kind` is the caller's to choose.
 * @param scope - {@link SCOPE}.
 */
export function journalEvent(cwd, event, scope) {
  appendJournal(cwd, { ts: new Date().toISOString(), ...event }, scope);
}

/**
 * A briefing with the bound lifted, for when a selection is not enough.
 *
 * `full: true` is the only way to reach the ceilings branch of
 * {@link allocateSectionBudget}: the allocator decides on the budget *minus* the reserve,
 * and the reserve belongs to `brief` (it is the retrieval hint's and the restart notice's
 * own length), so this function asks for the *view* rather than for a number that would
 * have to guess that reserve. The section division then disappears — every section may
 * spend its ceiling in full, and the entry-bearing sections keep every whole entry
 * instead of ranking them and indexing the rest. That is the difference between "show me
 * the important ones" and "stop hiding things from me" — the state a reader reaches when
 * a ledger has outgrown the budget and `topic` is the wrong question to ask because they
 * do not yet know what to search for.
 *
 * Still bounded, deliberately: sections keep their individual ceilings, so this cannot
 * grow with the ledger and cannot blow a context window. It is the largest *bounded*
 * view, not an unbounded one — a caller who wants the entire file should read the file.
 * @param cwd - project root.
 * @param options.session - current session id, for the journal/debt sections.
 * @returns the same shape as {@link brief}.
 */
export function briefFull(cwd, { session } = {}) {
  return brief(cwd, { session, full: true });
}

/**
 * When each machine fact was last written, from the journal.
 *
 * `writeProject` records the patch it applied, so the journal already knows which keys changed
 * and when — no extra bookkeeping on the fact itself. This is what lets the machine section
 * rank facts: with 9 facts costing 1,748 characters against a 1,100-character ceiling
 * (measured 2026-10-03), something has to decide who is shown in full, and "what was learned
 * most recently" is the only ordering this ledger can honestly support.
 * @param scope - {@link SCOPE}; the machine ledger is the one that matters here.
 * @returns `Map<key, isoTimestamp>` of the newest write per key.
 */
export function factRecency(scope = SCOPE.global, cwd) {
  const seen = new Map();
  const text = readJournalText(cwd, scope);
  if (text.length === 0) return seen;
  for (const line of text.split('\n')) {
    if (!line.includes('"kind":"project"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.kind !== 'project' || entry.patch === null || typeof entry.patch !== 'object') continue;
    for (const key of Object.keys(entry.patch)) {
      const prior = seen.get(key);
      if (prior === undefined || String(entry.ts) > String(prior)) seen.set(key, entry.ts);
    }
  }
  return seen;
}

/**
 * Rules that have fired in more than one *project* — machine facts filed per project.
 *
 * The scope decision has a mechanical answer the design already states: pass
 * `scope="global"` when the fact would bite you again in a *different* project on this
 * host. Nothing measured "different project" until now. The pit guard's own view
 * (`pit-liveness.mjs`) replays each `trigger:` against commands recorded in **this**
 * project, so a rule that bit in three repositories was indistinguishable from one that
 * bit three times here — while `code-pit-guard` journals every real hit with the `root`
 * it happened in, which is the evidence this needs.
 *
 * Lives here rather than in the probe because it is ledger knowledge, not a probe's
 * private business: it reads journals (through {@link readJournalText}, so rotated
 * segments count) and any future caller gets the same answer.
 * @param roots - project roots to scan.
 * @returns `[{ heading, source, roots }]`, most-widely-bitten first; empty when nothing crosses a project boundary.
 */
export function crossProjectTriggers(roots) {
  const byRule = new Map();
  for (const root of roots) {
    if (typeof root !== 'string' || root.length === 0) continue;
    const text = readJournalText(root, SCOPE.project);
    if (text.length === 0) continue;
    for (const line of text.split('\n')) {
      // Cheap pre-filter before JSON.parse: a journal is mostly other kinds.
      if (!line.includes('trigger_hit')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.kind !== 'trigger_hit') continue;
      const key = `${entry.heading ?? '(no heading)'}\u0000${entry.source ?? ''}`;
      if (!byRule.has(key)) byRule.set(key, { heading: entry.heading, source: entry.source, roots: new Set() });
      // The hit names the project it happened in; fall back to the root being scanned so
      // an entry written before `root` was recorded still counts for the project it is in.
      byRule.get(key).roots.add(String(entry.root ?? root));
    }
  }
  return [...byRule.values()]
    .map((rule) => ({ heading: rule.heading, source: rule.source, roots: [...rule.roots] }))
    .filter((rule) => rule.roots.length > 1)
    .sort((a, b) => b.roots.length - a.roots.length);
}

/**
 * Project roots with a ledger, for a cross-project report to scan.
 *
 * Deliberately shallow: the siblings of `current` and the projects under
 * `~/.dsh/projects`. A deep search would walk every drive to answer a question about
 * ledgers, and a report nobody runs is not worth a slow probe.
 * @param current - the project asking.
 * @returns absolute roots, excluding `current` itself.
 */
export function siblingProjects(current) {
  const found = new Set();
  // The store is where a migrated project's ledger now lives, so a cross-project report that
  // only scanned the old locations would silently see nothing after a migration — and
  // `crossProjectTriggers` would stop promoting rules that demonstrably recur.
  const storeParent = projectStoreDir();
  const parents = [path.dirname(current), path.join(os.homedir(), '.dsh', 'projects'), storeParent];
  for (const parent of parents) {
    let entries;
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const root = path.join(parent, entry.name);
      // A store directory names the project it describes in its marker, and that project has
      // no `.dsh-code/` of its own any more — so the marker *is* the evidence a ledger exists.
      // Measured 2026-10-10 by `ledger-store-probe` S6: without this branch the cross-project
      // scan saw 1 of 4 projects after migration, which reads exactly like "no rule recurs".
      const owner = parent === storeParent ? storeOwner(root) : undefined;
      const candidate = owner ?? root;
      if (samePath(candidate, current)) continue;
      if (owner !== undefined || fs.existsSync(path.join(candidate, DIRNAME))) found.add(candidate);
    }
  }
  return [...found];
}

/**
 * How many times each `files:` pit has actually arrived, from the journal.
 *
 * The counterpart of `everSeen` for triggers, and the wider half: 31 of this project's
 * 35 pits are file-keyed. Without it the file side could only answer "does this path
 * still exist", never "has this pit ever been useful" — so an entry whose path resolves
 * but never matches an edit was invisible, the same silent failure a mistyped `trigger:`
 * used to be.
 *
 * Reads `file_hit` events (written by the pit guard at the moment it announces an entry)
 * rather than replaying anything: it counts what *happened*, not what would have.
 * @param cwd - project root.
 * @param scope - {@link SCOPE}.
 * @returns `Map<heading, count>`.
 */
export function fileHitCounts(cwd, scope) {
  const counts = new Map();
  const text = readJournalText(cwd, scope);
  if (text.length === 0) return counts;
  for (const line of text.split('\n')) {
    if (!line.includes('file_hit')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.kind !== 'file_hit' || typeof entry.heading !== 'string') continue;
    counts.set(entry.heading, (counts.get(entry.heading) ?? 0) + 1);
  }
  return counts;
}

/**
 * How many times each `trigger:` pit has actually arrived, from the journal.
 *
 * The command-side twin of {@link fileHitCounts}, and it lives here for the same reason
 * `crossProjectTriggers` does: counting hits is ledger knowledge, not a probe's private
 * business. Until 2026-10-05 the command side was counted inside
 * `probes/pit-liveness.mjs` while the file side was counted here — an asymmetry with a
 * concrete cost: the effect audit could *name* the liveness owner (its `E4` requires exactly
 * that) but could not report a hit rate without writing a second implementation of one,
 * which is the drift this file has already paid for twice.
 *
 * Reads `trigger_hit` events — what *happened*, not what would have — and counts by heading,
 * the same key {@link fileHitCounts} uses. Rotated segments count: `readJournalText` reads
 * them, and a hit that scrolled into `.000` is exactly as much evidence as a fresh one.
 * @param cwd - project root.
 * @param scope - {@link SCOPE}.
 * @returns `Map<heading, count>`.
 */
export function triggerHitCounts(cwd, scope) {
  const counts = new Map();
  const text = readJournalText(cwd, scope);
  if (text.length === 0) return counts;
  for (const line of text.split('\n')) {
    if (!line.includes('trigger_hit')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.kind !== 'trigger_hit' || typeof entry.heading !== 'string') continue;
    counts.set(entry.heading, (counts.get(entry.heading) ?? 0) + 1);
  }
  return counts;
}

/**
 * The identity of a ledger entry: its heading without the date.
 *
 * A heading is dated (`## 2026-10-05 · slug`), and events are keyed by heading — so anything
 * that gives an entry a NEW heading, which is exactly what merging two duplicates does, would
 * reset every count that entry had earned. The whole point of a merge is to consolidate
 * evidence, so losing it would invert the fix. Measured 2026-10-05 while merging the duplicate
 * `git commit` entries: the survivor kept only its own hits until this existed.
 * @param heading - a `## ` heading, dated or not.
 */
export function headingKey(heading) {
  return String(heading).replace(/^\d{4}-\d{2}-\d{2}\s*·\s*/, '').trim();
}

/**
 * One read of the journal, synthesised into what a reader needs to *work on* the ledger.
 *
 * The three counters above answer "how often" one heading at a time. This answers the
 * questions a session about to clean the ledger actually asks, and every one of them is
 * already recorded — nobody had joined the events:
 *
 * 1. **Which entries are redundant?** The guard walks every entry on each action and writes
 *    one event per match, so entries that fired inside the *same* action share a session and
 *    a millisecond. Measured 2026-10-05: one `node -e` command matched four entries (three
 *    project, one machine) — the same PowerShell pit filed three times with different
 *    symptoms, which `recordMistake`'s symptom-slug merge cannot see because it compares
 *    symptoms and these entries' commonality is their `trigger:`. That inflation also moves
 *    every published count (`33/67 never seen`, `file-keyed 32/86`), which is why the number
 *    a reader needs is "how many entries fire together", not "how many entries exist".
 * 2. **Which entries have never arrived?** The other half of the same question, by heading.
 * 3. **What has actually been refused?** `trigger_block` (2026-10-05) is written only by the
 *    refusal path; before it existed, the one read-side event that stops work left no trace.
 *
 * `cmd` is the command as recorded, already truncated to 200 characters by the writer, so a
 * collision count never depends on the whole command line being equal — only on the events
 * sharing one action.
 *
 * @param cwd - project root.
 * @param scope - {@link SCOPE}.
 * @returns `{ byHeading: Map<heading, {triggerHits, fileHits, blocks}>, collisions: Array<{session, at, headings, cmd}> }`.
 */
export function pitEvents(cwd, scope) {
  const byHeading = new Map();
  const row = (key) => {
    let found = byHeading.get(key);
    if (found === undefined) {
      found = { triggerHits: 0, fileHits: 0, blocks: 0 };
      byHeading.set(key, found);
    }
    return found;
  };
  const groups = new Map();
  const text = readJournalText(cwd, scope);
  if (text.length === 0) return { byHeading, collisions: [] };
  for (const line of text.split('\n')) {
    if (!line.includes('trigger_hit') && !line.includes('file_hit') && !line.includes('trigger_block')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event.heading !== 'string') continue;
    const counts = row(headingKey(event.heading));
    let key;
    if (event.kind === 'trigger_hit') {
      counts.triggerHits += 1;
      // Command hits only. Folding `file_hit` in here looked right and was not: measured on
      // the real ledger 2026-10-05, it reported 409 "collisions" whose largest group was
      // eight entries that all name `lib/ledger.js` — one file edited repeatedly, which is
      // ordinary, not redundant. A command matching several `trigger:` entries at one instant
      // is the redundancy worth acting on, because one action then argues with itself.
      key = `${event.session}|${event.ts}`;
    } else if (event.kind === 'file_hit') {
      counts.fileHits += 1;
      continue;
    } else if (event.kind === 'trigger_block') {
      counts.blocks += 1;
      continue; // a refusal is already a single entry's story; it is not a collision
    } else {
      continue;
    }
    let group = groups.get(key);
    if (group === undefined) {
      group = { session: event.session, at: event.ts, headings: new Set(), cmd: event.cmd ?? event.target ?? '', scope };
      groups.set(key, group);
    }
    // Stored as the entry *identity*, not the dated heading: after a merge the survivor has a
    // new heading, and a report still naming the retired one would send the reader to an entry
    // that is not there any more.
    group.headings.add(headingKey(event.heading));
  }
  const collisions = [...groups.values()]
    .filter((group) => group.headings.size > 1)
    .map((group) => ({
      session: group.session,
      at: group.at,
      headings: [...group.headings],
      cmd: group.cmd,
    }))
    .sort((a, b) => b.headings.length - a.headings.length);
  return { byHeading, collisions };
}

/**
 * Merge candidates inside the groups {@link pitEvents} found.
 *
 * "These entries fire together" is a lead, not an instruction: several `files:` entries can
 * legitimately name one file. What makes a group actionable is entries that describe the
 * *same* pit under different symptoms — the one case `recordMistake`'s symptom-slug merge
 * cannot see, because it compares symptoms and these entries' commonality is their subject.
 * Measured 2026-10-05: one `node -e` command matched three project entries that all document
 * PowerShell eating quotes, filed on 10-03, 10-03 and 10-04.
 *
 * Similarity is token overlap on the heading, with the date and the slug punctuation removed.
 * Deliberately crude and deliberately a **suggestion**: merging two entries is a judgement
 * about meaning, and this repo has already paid for automating that judgement (audit F6: a
 * lossy slug merged unrelated pits). A caller shows these to a reader; nothing merges itself.
 *
 * @param collisions - the `collisions` array from {@link pitEvents}.
 * @returns `Array<{session, at, sample, pairs}>`, strongest overlap first.
 */
export function mergeCandidates(collisions) {
  /**
   * How much of the shorter heading's vocabulary two entries must share to be offered as a
   * merge candidate — the line between "the same pit in two spellings" and "two entries that
   * happen to share a word". Named because it is a judgement, and a bare literal made it
   * invisible to anyone tuning the suggestion.
   */
  const NEAR_DUPLICATE_OVERLAP = 0.34;
  const tokens = (heading) =>
    new Set(
      heading
        .replace(/^\d{4}-\d{2}-\d{2}\s*·\s*/, '')
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fff]+/)
        .filter((word) => word.length > 2),
    );
  const pairs = new Map();
  for (const group of collisions) {
    if (group.headings.length < 2) continue;
    for (let i = 0; i < group.headings.length; i += 1) {
      for (let j = i + 1; j < group.headings.length; j += 1) {
        const a = tokens(group.headings[i]);
        const b = tokens(group.headings[j]);
        if (a.size === 0 || b.size === 0) continue;
        const shared = [...a].filter((word) => b.has(word));
        const overlap = shared.length / Math.min(a.size, b.size);
        if (overlap < NEAR_DUPLICATE_OVERLAP) continue;
        // Keyed by the pair, not by the action: the same two entries fire together in every
        // session that runs that command, and listing the pair once per action turned the
        // first real report into the same `git commit` pair repeated three times. What a
        // reader needs is the pair, once, with every command that has produced it.
        const key = `${headingKey(group.headings[i])}\u0000${headingKey(group.headings[j])}`;
        const found = pairs.get(key);
        if (found === undefined) {
          pairs.set(key, {
            a: group.headings[i],
            b: group.headings[j],
            aKey: headingKey(group.headings[i]),
            bKey: headingKey(group.headings[j]),
            shared,
            overlap: Number(overlap.toFixed(2)),
            commands: [String(group.cmd).slice(0, 60)],
          });
        } else if (!found.commands.includes(String(group.cmd).slice(0, 60)) && found.commands.length < 3) {
          found.commands.push(String(group.cmd).slice(0, 60));
        }
      }
    }
  }
  return [...pairs.values()].sort((x, y) => y.overlap - x.overlap);
}

/**
 * Whether a `lib/` edit is waiting for a restart, and what it was.
 *
 * The mode's own iron rule is that a changed `lib/*.js` or `cordis.patch.yml` does not
 * take effect until DSH restarts (child plugin modules are imported once, at mount), and
 * until now nothing recorded that a batch was pending — it lived in the human's memory.
 * This repo has already paid for the consequence twice: a session edited the system
 * prompt, a later session resumed, and `LIVE DIFFERS` cost 306,313 uncached tokens in one
 * request.
 *
 * The signal is the journal's own history rather than a flag someone must clear: a
 * `restart_pending` event with no `session_start` after it means the newest process has
 * not picked the change up yet. The first `code_brief` of a new session is what appends
 * that `session_start`, so the notice settles itself exactly when it stops being true.
 * @param cwd - project root.
 * @returns `{ at, files }` for the newest unanswered edit, or undefined.
 */
export function restartPending(cwd) {
  let lines;
  try {
    lines = readJournalText(cwd, SCOPE.project).split('\n');
  } catch {
    return undefined;
  }
  /**
   * Which of the two relevant events came last — a `session_start` or the dormant edit.
   *
   * A `session_start` *after* a `restart_pending` means a later process began, so it loaded
   * the change and the change is no longer dormant. Reading backwards is what makes this
   * depend on the current state instead of on how history happened to be appended.
   *
   * This deliberately does **not** compare process boot times. Two attempts did, and both
   * were wrong in the same way: measured 2026-10-03, one ignored the boot it was handed and
   * the other let an older boot's start un-settle the notice, so the notice stayed up after
   * the very restart it described. Order is the whole answer, and it needs no clock.
   */
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) continue;
    if (!line.includes('restart_pending') && !line.includes('session_start')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.kind === 'session_start') return undefined; // a later process already began
    if (entry.kind === 'restart_pending') {
      return { at: entry.ts, files: Array.isArray(entry.files) ? entry.files : [] };
    }
  }
  return undefined;
}

/**
 * When the running process started, or undefined when the platform will not say.
 *
 * `process.uptime()` is the portable way to learn this: subtracting it from now gives the
 * boot instant, which is stable for a process's whole life and different after a restart.
 * Undefined is treated as "cannot tell", never as "settled" — a restart notice that
 * disappears because a measurement failed is the omission class this file keeps paying for.
 *
 * `DSH_CODE_BOOT` overrides it so a probe can simulate two processes. This is the same
 * shape as `DSH_CODE_GLOBAL_DIR`: the real caller never sets it, and a fixture that could
 * not vary the value could not test the behaviour at all — one process has one boot time.
 */
function processBootTime() {
  const override = process.env.DSH_CODE_BOOT;
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  const uptime = Number(process.uptime?.());
  return Number.isFinite(uptime) && uptime >= 0 ? new Date(Date.now() - uptime * 1000).toISOString() : undefined;
}

/**
 * Record that a session has begun, once per process.
 *
 * The guard is the journal's own history: if the newest `session_start` was written by this
 * same boot, a second briefing is a no-op. Without it every brief appended a line and grew
 * the journal for nothing.
 */
export function noteSessionStart(cwd, sessionId, scope, boot = processBootTime()) {
  // A project with no ledger stays without one. `code_brief` is a *read* tool: it must be
  // able to answer "no ledger yet at …" without creating the thing it is reporting the
  // absence of — measured 2026-10-03, when recording the start here made a fresh project
  // report a populated brief and broke the acceptance check that pins that answer.
  if (!exists(cwd, scope)) return;
  const currentBoot = boot;
  const text = readJournalText(cwd, scope);
  let last;
  for (const line of text.split('\n')) {
    if (!line.includes('"kind":"session_start"')) continue;
    try {
      last = JSON.parse(line);
    } catch {
      /* a torn line is not the newest start */
    }
  }
  if (last !== undefined && currentBoot !== undefined && last.processBoot === currentBoot) return;
  appendJournal(
    cwd,
    { ts: new Date().toISOString(), session: sessionId, kind: 'session_start', processBoot: currentBoot },
    scope,
  );
}

/**
 * Record that `lib/` was edited and the change is waiting for a restart.
 *
 * No process identity is recorded: {@link restartPending} answers by event *order*, so a
 * boot stamp here would be a field nothing reads.
 * @param cwd - project root.
 * @param files - the edited files, as given to the edit tool.
 * @param sessionId - the session that made the edit.
 */
export function noteRestartPending(cwd, files, sessionId) {
  appendJournal(cwd, { ts: new Date().toISOString(), session: sessionId, kind: 'restart_pending', files }, 'project');
}

/**
 * The shape of the briefing a session just read, and whether it moved since the last one.
 *
 * The rule this serves is already written down — "protect the prompt prefix while a session is
 * live", which this project paid ~590k uncached tokens to learn — but a rule with no instrument
 * is an intention. This is the reading side of that rule for the half a session can actually see:
 * the ledger. `restartPending` owns the other half (the static prompt section, which moves only
 * when a `lib/` edit lands), so the two do not overlap — a restart notice means the *code* moved,
 * a changed shape here means the *ledger* moved under a session that is still running, which is
 * what makes the first brief of a session and the tenth different documents.
 *
 * One line is written per *changed* shape, and nothing at all when the shape repeats: a session
 * that reads its brief five times writes one line, not five. The journal is bounded on purpose,
 * and a heartbeat is the fastest way to spend it.
 *
 * Called from the tool layer (`tool-brief.js`), never from `brief()`: a read that records
 * something turns every caller and every probe into a writer, and a *read* must not be able to
 * create the ledger whose absence it is reporting. Same reasoning as `noteSessionStart`, and the
 * same guard.
 *
 * @param cwd - project root.
 * @param sessionId - the session that read the brief.
 * @param shape - `{ digest, chars }` of the text handed to the model.
 * @returns `{ recorded, previous }`; `previous` is undefined for a session's first brief.
 */
export function noteBriefShape(cwd, sessionId, shape) {
  if (!exists(cwd, SCOPE.project)) return { recorded: false, previous: undefined };
  const previous = lastBriefShape(cwd, sessionId);
  // Compared on the digest, not on the character count: two different briefs can be the same
  // length, and "the ledger moved" is precisely the case where the length happened not to.
  if (previous !== undefined && previous.digest === shape.digest) return { recorded: false, previous };
  appendJournal(
    cwd,
    {
      ts: new Date().toISOString(),
      session: sessionId,
      kind: 'brief_shape',
      digest: shape.digest,
      chars: shape.chars,
    },
    SCOPE.project,
  );
  return { recorded: true, previous };
}

/** The newest `brief_shape` this session wrote, or undefined when it wrote none. */
function lastBriefShape(cwd, sessionId) {
  let text;
  try {
    text = readJournalText(cwd, SCOPE.project);
  } catch {
    return undefined;
  }
  let found;
  for (const line of text.split('\n')) {
    if (!line.includes('"kind":"brief_shape"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.session === sessionId) found = entry;
    } catch {
      /* a torn line is not the newest shape */
    }
  }
  return found === undefined ? undefined : { digest: found.digest, chars: found.chars };
}

/**
 * @param cwd - project root.
 * @param scope - {@link SCOPE}; `global` reads the machine-wide ledger.
 * @returns the loaded project record or undefined.
 */
export function readProject(cwd, scope) {
  // Same distinction as the board: `null` parses, but it is not a project record, and
  // spreading it into the next write would silently drop every fact the file held.
  return readJson(ledgerPath(cwd, 'project', scope), undefined, isRecordLike);
}

/** `{}` is a record with no fields; `null`, `42`, `"x"` and `[]` are not records. */
function isRecordLike(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * File a task under the list its `status` says it belongs to.
 *
 * Boards written before 2026-10-01 can hold a task in `active` whose status is
 * already `done` or `blocked` (the creation path used to push into `active`
 * regardless). Reading such a board as-is made the briefing print a `[done]` row
 * under "In flight:", so normalisation happens on every read: the board a caller
 * sees always agrees with itself, without needing a write to repair the file.
 * @param board - loaded board, mutated in place.
 * @returns the same board.
 */
function normalizeBoard(board) {
  if (board === undefined) return board;
  for (const key of ['active', 'done', 'blocked']) if (!Array.isArray(board[key])) board[key] = [];
  const order = { active: [], done: [], blocked: [] };
  const seen = new Set();
  for (const key of ['active', 'done', 'blocked']) {
    for (const task of board[key]) {
      // Non-objects are dropped rather than assigned to: `task.status = …` on a primitive
      // throws in strict mode, which is how a `"x"` inside `active` took down every brief
      // and every progress write. They are not silently kept either — `isBoardLike` refuses
      // such a file at the read seam, so its bytes are preserved and the caller is told.
      if (!isTaskLike(task) || seen.has(task)) continue;
      seen.add(task);
      const status = task.status === 'done' || task.status === 'blocked' ? task.status : 'active';
      task.status = status;
      order[status].push(task);
    }
  }
  board.active = order.active;
  board.done = order.done;
  board.blocked = order.blocked;
  return board;
}

/** @param cwd - project root. @returns the loaded task board or undefined. */
export function readTasks(cwd) {
  const file = ledgerPath(cwd, 'tasks');
  // "Parses" is not "is a board". `null`, `42`, `"oops"` and `[7]` are all valid JSON, and
  // the old `normalizeBoard(readJson(...))` threw a TypeError on every one of them — so
  // `code_brief` AND `code_record(kind="progress")` died on that project, while
  // `preserveCorruptFile` never fired because the parse had succeeded. Measured 2026-10-04
  // by the ledger-core audit: 6 of 10 malformed-but-parseable variants crashed the briefing.
  // A value that cannot carry a board is therefore treated exactly like unparseable JSON.
  return normalizeBoard(readJson(file, undefined, isBoardLike));
}

/**
 * Whether a parsed value could be a task board at all.
 *
 * Deliberately permissive about *contents* — `normalizeBoard` repairs wrong or missing
 * lists (that is its job) — and strict only about the top level, because `{}` is a board
 * with no tasks while `null` is not a board.
 */
function isBoardLike(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  // Depth matters as much as the top level: a `"x"` or a `7` sitting *inside* `active` is
  // valid JSON that still breaks the board, because `normalizeBoard` assigns `task.status`
  // on every entry — and assigning a property to a primitive throws in a module (strict
  // mode) while silently doing nothing in sloppy code. The ledger-core audit found exactly
  // these two variants surviving the first version of this check (2 of 10 still threw).
  for (const key of ['active', 'done', 'blocked']) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return false;
    if (!list.every(isTaskLike)) return false;
  }
  return true;
}

/** A task is an object; primitives and arrays cannot carry an id, a status or notes. */
function isTaskLike(task) {
  return typeof task === 'object' && task !== null && !Array.isArray(task);
}

/** How much of the cleaned text becomes the readable part of a slug. */
const SLUG_LIMIT = 60;

/**
 * Width of the disambiguating digest appended to a lossy slug.
 *
 * Five base-36 characters is ~60 million values, which is far more than the collision budget a
 * per-project ledger of hundreds of entries can exhaust. The width is a budget decision, not an
 * arbitrary one: a heading is rendered into a briefing whose `## Known mistakes` section has a
 * fixed character ceiling, so every character added here is taken from the trailing
 * "N more entries beyond this list" note. Measured 2026-10-04: at 7 characters the forty-entry
 * fixture in `guard-probe` A6 pushed that note past the ceiling and it was clipped mid-word
 * ("beyond this lis…"), so the reader lost the one line that says entries are missing — the
 * exact silent omission the briefing's design forbids. At 5 it fits.
 */
const SLUG_DIGEST_WIDTH = 5;

/** A short, stable digest of a whole string, over code points so no surrogate is ever split. */
export function digest(text) {
  let hash = 0x811c9dc5;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(SLUG_DIGEST_WIDTH, '0').slice(-SLUG_DIGEST_WIDTH);
}

/**
 * Shape of every ledger slug: usable in a filename and greppable.
 *
 * **The slug is an identity, not a label**, so a slug that is not injective merges unrelated
 * entries. Two ways it was not, both measured 2026-10-04 (ledger-core audit F6):
 *
 *   - `.slice(0, 60)` truncated the slug, so two different symptoms sharing their first 60
 *     slug characters became one pit. The second one's `do not repeat:` rule never reached
 *     `mistakes.md` and a topic search for its own text found nothing.
 *   - The character class is `[a-z0-9\u4e00-\u9fff._-]`, so a symptom written in *any* other
 *     script (Cyrillic, Greek, accented Latin…) reduced to nothing and every such pit got the
 *     same fallback slug — `mistake`.
 *
 * So the digest of the **whole** input is appended whenever the slug would otherwise be a lossy
 * function of it: when it was truncated, and when it came out empty. An input that fits keeps
 * its old slug, which keeps every existing heading, task id and search term working.
 *
 * A genuine repeat is unaffected by construction: the same symptom text hashes to the same
 * digest, so it still finds its own entry and still increments `recurred:`.
 */
export function slug(text, fallback = 'untitled') {
  const input = String(text ?? '');
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const truncated = cleaned.slice(0, SLUG_LIMIT);
  if (truncated.length === 0) return `${fallback}-${digest(input)}`;
  return cleaned.length > truncated.length ? `${truncated}-${digest(input)}` : truncated;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Store the environment facts a resumed session would otherwise re-derive.
 * @param scope - {@link SCOPE}; `global` writes the machine-wide ledger instead.
 */
export function writeProject(cwd, patch, sessionId, scope) {
  const file = ledgerPath(cwd, 'project', scope);
  const read = readProject(cwd, scope);
  // A file that exists but did not parse would be overwritten by the default below, so
  // it is set aside first and the caller is told where it went (see `preserveCorruptFile`).
  const notice = read === undefined ? corruptNotice(preserveCorruptFile(file), 'project.json', parsedButInvalid(file, isRecordLike)) : undefined;
  const previous = read ?? { version: 1, createdAt: new Date().toISOString() };
  const next = { ...previous, ...patch, updatedAt: new Date().toISOString() };
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  writeJson(file, next);
  appendJournal(cwd, { ts: new Date().toISOString(), session: sessionId, kind: 'project', patch }, scope);
  return { file, notice };
}

/** Create the ledger if absent; never overwrite an existing one. */
export function initLedger(cwd, sessionId, scope) {
  const created = [];
  if (!fs.existsSync(ledgerPath(cwd, 'project', scope))) {
    writeProject(
      cwd,
      { version: 1, createdAt: new Date().toISOString(), commands: {}, notes: '' },
      sessionId,
      scope,
    );
    created.push(FILES.project);
  }
  // A machine-wide ledger has no task board: work belongs to a project, and
  // `code_record(kind="progress")` refuses the global scope for that reason.
  if (scope !== SCOPE.global && !fs.existsSync(ledgerPath(cwd, 'tasks', scope))) {
    writeJson(ledgerPath(cwd, 'tasks', scope), { version: 1, active: [], done: [], blocked: [] });
    created.push(FILES.tasks);
  }
  for (const kind of ['decisions', 'mistakes']) {
    const file = ledgerPath(cwd, kind, scope);
    if (!fs.existsSync(file)) {
      ledgerDirOrThrow(cwd, scope);
      fs.writeFileSync(file, `# ${kind === 'decisions' ? 'Decisions' : 'Mistakes'}\n`, 'utf8');
      created.push(FILES[kind]);
    }
  }
  if (created.length > 0) {
    appendJournal(cwd, { ts: new Date().toISOString(), session: sessionId, kind: 'init', scope: scope ?? SCOPE.project }, scope);
  }
  return created;
}

/**
 * Task board mutation. `progress` records work under an active task, adding it
 * when unknown; only `kind: 'progress'` with `status: 'done'` closes a task.
 */
export function recordTask(cwd, { title, status, note, slug: id }, sessionId) {
  const file = ledgerPath(cwd, 'tasks');
  const read = readTasks(cwd);
  // Set aside a `tasks.json` that exists but did not parse, before the default below
  // replaces it — this is the exact write that used to erase a whole board for one
  // stray comma (see `preserveCorruptFile`). The caller is told where the bytes went.
  const notice = read === undefined ? corruptNotice(preserveCorruptFile(file), 'tasks.json', parsedButInvalid(file, isBoardLike)) : undefined;
  const board = read ?? { version: 1, active: [], done: [], blocked: [] };
  for (const key of ['active', 'done', 'blocked']) if (!Array.isArray(board[key])) board[key] = [];
  const wanted = status ?? 'active';
  // Every list, `done` included. Finding a task used to look at `active` and `blocked`
  // only, so a completed task could not be located at all: the refusal named its id as
  // being "on the board", and passing the *title* instead built a SECOND task with the
  // same id — one id on two lists (measured 2026-10-04; this is also why the audit's own
  // board task could not be annotated after it was marked done).
  const all = [...board.active, ...board.blocked, ...board.done];
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  // `task` may arrive as the full id (`2026-10-01-fix-the-parser`), as the title
  // the human used, or as a slug built from that title — a caller reaching for
  // "which task" naturally passes the title, and refusing that while the task is
  // plainly on the board is a trap, not a safeguard. A date-prefixed id resolves
  // through the bare slug too. Ambiguity with no title to disambiguate is the
  // only case still refused.
  const wantedId = norm(id);
  const matches = (t) =>
    norm(t.id) === wantedId ||
    norm(t.title) === wantedId ||
    norm(t.id).endsWith(`-${wantedId}`);
  let task = id === undefined ? undefined : all.find(matches);
  if (task === undefined && title !== undefined) task = all.find((t) => norm(t.title) === norm(title));
  if (task === undefined) {
    if (title === undefined) {
      throw new Error(
        `code_record(kind=progress): no task on the board matches ${JSON.stringify(id)}. Pass either the full id or an exact title` +
          (all.length > 0 ? `; on the board: ${all.map((t) => t.id).join(', ')}` : '; the board is empty'),
      );
    }
    if (all.some((t) => norm(t.id).endsWith(`-${norm(title)}`))) {
      throw new Error(
        `code_record(kind=progress): ${JSON.stringify(title)} already exists on the board; pass its id in \`task\` (or the exact title in \`title\`) to move it instead of creating a second task`,
      );
    }
    task = { id: `${today()}-${slug(title)}`, title, status: wanted, acceptance: '', notes: [] };
    // Honour `wanted` on creation too. Creating a task already marked done is a
    // legitimate call (recording work finished in one step), and pushing it into
    // `active` regardless produced the contradiction this mode's own briefing
    // then displayed: a `## Task board` section headed "In flight:" listing a
    // `[done]` row — observed on this project 2026-10-01 right after a real task
    // was recorded that way.
    if (wanted === 'done') board.done.unshift(task);
    else if (wanted === 'blocked') board.blocked.unshift(task);
    else board.active.unshift(task);
  } else {
    // Every list it could be sitting in, not just the two the lookup used to consider:
    // moving a task out of `done` left a stale copy there under the same id.
    board.active = board.active.filter((t) => t !== task);
    board.blocked = board.blocked.filter((t) => t !== task);
    board.done = board.done.filter((t) => t !== task);
    if (wanted === 'active') board.active.unshift(task);
    else if (wanted === 'done') board.done.unshift(task);
    else board.blocked.unshift(task);
  }
  task.status = wanted;
  if (note !== undefined && note.trim().length > 0) {
    task.notes = [...(task.notes ?? []), `${today()}: ${note.trim()}`].slice(-12);
  }
  // "done" is a claim about evidence, so check the evidence. A session with no
  // real (non-claimed, passing) verification is marking a task complete on
  // nothing but its own word — the failure mode the ledger exists to prevent.
  // Advisory, not a refusal: a long-running task may legitimately have been
  // verified in an earlier session, so the note says how to record that.
  if (wanted === 'done' && verifyCount(cwd, sessionId) === 0) {
    task.notes = [
      ...(task.notes ?? []),
      `${today()}: [!] marked done with no passing code_verify recorded in this session — "done" is a claim, not evidence. ` +
        `If it truly was verified, run the command again through code_verify (or record the exact command and its output) so the ledger holds the proof; otherwise do not treat this task as proven.`,
    ].slice(-12);
  }
  /**
   * The board is a bounded working set (`CAP.tasks` per list), and it is ordered by
   * recency — so the cap evicts the *oldest* task. It used to do that with no word to
   * anyone: the 41st task pushed `open task number 1` off the board, and neither the
   * tool's answer, the journal nor the briefing mentioned it (measured 2026-10-04, audit
   * probe 12C: `tasks created: 41; board holds active=40`, `the journal mentions the
   * dropped task as removed: false`, `the brief says anything about …: false`).
   *
   * Eviction is kept rather than turned into a refusal — refusing would fail the turn's
   * own progress record, and the board's ordering is recency by construction — but it is
   * now named three ways: the caller gets the ids in `notice` (which `code_record` renders
   * in its summary), each eviction is journalled as `task_removed` with the id, and
   * `## Recent ledger entries` reads the journal, so the next briefing says it too. The
   * creation line was never lost, so an id named here is recoverable from the journal.
   */
  const removed = [];
  for (const key of ['active', 'done', 'blocked']) {
    if (board[key].length > CAP.tasks) removed.push(...board[key].slice(CAP.tasks).map((t) => ({ key, id: t?.id, title: t?.title })));
    board[key] = board[key].slice(0, CAP.tasks);
  }
  for (const gone of removed) {
    // Deliberately no `title`: `recentJournal` renders the first of symptom/title/id/cmd,
    // so a title here would *replace* the id in the briefing — and the id is the handle a
    // later reader needs (`code_record(task: <id>)` is how a task is picked up again).
    // The `task` line written below carries no title either, for the same reason.
    appendJournal(cwd, { ts: new Date().toISOString(), session: sessionId, kind: 'task_removed', id: gone.id, from: gone.key });
  }
  const capNotice =
    removed.length === 0
      ? undefined
      : `task board cap (${CAP.tasks} per list): the oldest ${removed.length} task(s) were dropped to make room — ${removed
          .map((gone) => `${gone.id} [${gone.key}]`)
          .join(', ')}. Their creation lines are still in ${FILES.journal}, so nothing is unrecoverable, but they are no longer on the board.`;
  writeJson(file, board);
  appendJournal(cwd, { ts: new Date().toISOString(), session: sessionId, kind: 'task', id: task.id, status: wanted });
  return { file, task, notice: [notice, capNotice].filter((part) => typeof part === 'string' && part.length > 0).join(' ') || undefined };
}

/**
 * Prose that cannot forge structure.
 *
 * A ledger entry is a markdown block, and both readers that matter — {@link markdownEntries} here
 * and `mistakeEntries` in `lib/pit-guard.js` — find an entry by splitting the file on `\n## ` and
 * read one field per `^- label: ` line. That makes any *prose* a writer's territory: a symptom
 * that contains a blank line and then `## 2026-01-01 · something` forges a **second entry**, and
 * one containing `\n- hard block: 1` forges a **field of its own block**, which is the field that
 * turns a pit from a reminder into an edit barrier.
 *
 * The prose arrives from the model, which means it arrives from whatever the model just read — an
 * issue, a README, a command's own output. That is the same path memory-poisoning work describes
 * for harness agents whose memory is persistent and replayed: the entry is written once and read
 * back in every later session, so a forged field is not a bad turn, it is a bad *rule*. `tail`,
 * the raw command output the journal keeps, is kept as it came (`journalMistake` passes the
 * original strings) because a record of what was said must not be rewritten — what is normalised
 * is the artifact that gets *parsed*, and only where parsing could be fooled.
 *
 * The fix is structural rather than a warning: a line-leading `## ` or `- ` inside prose is
 * indented by two spaces, which is not a heading and not a list item in markdown, so the block
 * boundary and the field list cannot be reached from prose at all. Nothing is deleted and nothing
 * is escaped into unreadability — the text still reads as the writer wrote it, one level in.
 *
 * @param value - the prose as supplied.
 * @param options.firstLineSafe - true when this prose is embedded after a label on its own line
 *   (`- symptom: …`), so its first line cannot begin the line; false for text that starts a line
 *   of its own, such as a decision's body, where the first line can forge just as easily.
 * @returns `{ text, flattened }` — the safe text, and which kinds of line were indented.
 */
function flattenProse(value, { firstLineSafe } = {}) {
  const input = String(value ?? '');
  if (input.length === 0) return { text: input, flattened: [] };
  const flattened = [];
  const lines = input.split('\n').map((line, index) => {
    if (index === 0 && firstLineSafe === true) return line;
    const match = /^\s*(##\s+|-\s+)/.exec(line);
    if (match === null) return line;
    flattened.push(match[1].startsWith('##') ? 'heading' : 'field');
    return `  ${line}`;
  });
  return { text: lines.join('\n'), flattened };
}

/**
 * What {@link flattenProse} had to do, said to the writer instead of done silently.
 *
 * Silence here would be the wrong kind of success: the writer asked for a text and got a slightly
 * different one, and the difference is the reason a rule cannot be forged. Reported the same way
 * the other write-side advisories are — folded into `summary`, because a tool handler may return
 * exactly the keys its `output.schema` declares.
 */
function flattenNote(flattened) {
  if (flattened.length === 0) return undefined;
  const kinds = [...new Set(flattened)].join('/');
  return `${flattened.length} prose line(s) started with \`## \` or \`- \` (${kinds}) and were indented by two spaces: that is what stops a symptom or a body being read as another entry, or as fields of its own. The text is unchanged apart from the indent.`;
}

/**
 * Mark an older entry as taken over by a later one, in place, under the ledger's lock.
 *
 * Read-modify-write for the same reason {@link recordMistake}'s merge is: two writers on one
 * markdown file, one of them renaming a temp over it, is how an append gets lost on Windows
 * (`EPERM` on the rename, exception out of the tool call, record gone — measured 2026-10-04).
 * So this goes through `withLedgerLock` and `writeFileAtomic`, the two primitives that already
 * own that problem, rather than opening a third path that would have to re-earn them.
 *
 * `fragment` is matched against the *heading*, case-insensitively and by substring, because a
 * caller naming a decision has its title in hand and not its date — the same reason the mistake
 * merge matches the slug instead of the dated heading.
 *
 * Idempotent: an entry that already names a successor is left exactly as it is, so recording a
 * successor twice cannot produce a second line or lose the first. A fragment that matches nothing
 * is *reported*, never silently ignored: a pointer that landed nowhere must not look like a
 * pointer that landed.
 */
function stampSuperseded(file, fragment, marker) {
  const needle = String(fragment).trim().toLowerCase();
  if (needle.length === 0) return { matched: false, reason: 'empty' };
  return withLedgerLock(file, () => {
    const existing = markdownEntries(readFile(file));
    for (let index = existing.length - 1; index >= 0; index -= 1) {
      const block = existing[index];
      if (!headingOf(block).toLowerCase().includes(needle)) continue;
      const heading = headingOf(block);
      const already = supersededBy(block);
      if (already !== undefined) return { matched: true, heading, already };
      const next = [...existing];
      next[index] = `${block.replace(/\s+$/, '')}\n- superseded by: ${marker}\n- superseded at: ${today()}`;
      const header = headerOf(readFile(file));
      writeFileAtomic(file, `${header.length === 0 ? '' : `${header}\n\n`}${next.join('\n\n')}\n`);
      return { matched: true, heading, marker };
    }
    return { matched: false, reason: 'no entry heading contains that fragment' };
  });
}

/**
 * One decision entry, optionally keyed to the files it governs and to the entry it replaces.
 *
 * `files:` is borrowed from the repository-map half of context engineering (Aider's repo map,
 * Anthropic's just-in-time retrieval): the decision that governs a file should arrive when that
 * file is about to change, not when someone happens to think of searching for it. Mistakes have
 * been keyed this way from the start — `code-pit-guard` answers them on the edit itself, before
 * the write — while decisions were reachable only by ranking, and ranking is the first thing a
 * growing ledger takes away. `pit-guard` reads this field for decisions too (see its
 * `decisionEntries`); the field is written through here because a field only a text editor can
 * produce is a field nobody produces (the same argument as `safe case`).
 *
 * `supersedes` names the decision this one replaces; see {@link stampSuperseded}. It is written
 * on the *older* entry rather than on this one, so the older entry says what took its place and
 * this one needs no back-pointer.
 *
 * @param options.supersedes - a heading fragment of the entry this decision replaces.
 * @returns `{ file, superseded, warning }` — `superseded` reports what the pointer did, including
 *   the case where it matched nothing.
 */
export function recordDecision(cwd, { title, body, alternatives, files, supersedes }, sessionId, scope) {
  const file = ledgerPath(cwd, 'decisions', scope);
  const keyed = files === undefined ? '' : String(files).trim();
  // The heading line is prose too, and it is the one line a forged `## ` would land on: a title
  // containing a newline and a heading would write a second entry *above* this one.
  const proseTitle = flattenProse(title, { firstLineSafe: true });
  /**
   * Trimmed **before** it is flattened, and never after: the body begins a line of its own, so its
   * first line is flattened like every other one — and `.trim()` on the flattened text would peel
   * that indent straight back off, restoring exactly the forgery the flatten exists to stop.
   * Measured by `probes/borrowed-mechanisms-probe.mjs` F4, whose first version of this line read
   * `proseBody.text.trim()`: the forged `- files:` came back to column 0.
   */
  const proseBody = flattenProse(String(body ?? '').trim(), { firstLineSafe: false });
  const proseAlternatives = flattenProse(alternatives, { firstLineSafe: true });
  const block = [
    `## ${today()} · ${proseTitle.text.trim()}`,
    '',
    proseBody.text,
    alternatives === undefined || alternatives.trim().length === 0 ? '' : `\nRejected: ${proseAlternatives.text.trim()}`,
    keyed.length === 0 ? '' : `\n- files: ${keyed}`,
    '',
  ].join('\n');
  appendBlock(file, block);
  const replaced =
    supersedes === undefined || String(supersedes).trim().length === 0
      ? undefined
      : stampSuperseded(file, supersedes, `## ${today()} · ${title}`);
  appendJournal(
    cwd,
    {
      ts: new Date().toISOString(),
      session: sessionId,
      kind: 'decision',
      title,
      ...(keyed.length === 0 ? {} : { files: keyed }),
      ...(replaced === undefined ? {} : { superseded: replaced }),
    },
    scope,
  );
  return {
    file,
    superseded: replaced,
    warning:
      [
        flattenNote([...proseTitle.flattened, ...proseBody.flattened, ...proseAlternatives.flattened]),
        entryLengthWarning({ 'body': body, 'rejected alternatives': alternatives }, block),
      ]
        .filter((part) => typeof part === 'string' && part.length > 0)
        .join(' ') || undefined,
  };
}

/**
 * One mistake entry.
 *
 * `trigger` is the *command* side of the pit guard, the counterpart of `files`:
 * a regular expression matched against the command line of a run-tool call, so a
 * pit that has nothing to do with a file (a shell that mangles a pipe, a flag that
 * silently changes meaning) can still arrive before the command runs. It is an
 * explicit pattern, never a similarity guess: a warning that fires on commands
 * the entry never named is a warning the model learns to ignore.
 */
export function recordMistake(cwd, { symptom, cause, fix, files, trigger, avoid, safeCase, supersedes }, sessionId, scope) {
  const file = ledgerPath(cwd, 'mistakes', scope);
  const rule = (avoid ?? symptom).trim();
  /**
   * Fold a repeat of a known pit into the entry that already describes it.
   *
   * Measured 2026-10-03: the project ledger held 30 entries (29,696 characters) and
   * the machine one 77 (80,571), while the briefing can display about 8,900 characters
   * in total. Appending a second entry for a pit that already has one is how a ledger
   * becomes unreadable, and it is *not* what a repeat means: a repeat is the strongest
   * evidence a ledger can hold that the rule is needed. So the entry gains a
   * `recurred:` count, which also ranks it first in the briefing, and a `last:` date.
   *
   * Identity is the heading, which is derived from the symptom — two entries with the
   * same symptom are the same pit. Deletion is never the answer here: the file stays
   * the archive, the briefing is what gets bounded.
   */
  const pitSlug = slug(symptom, 'mistake');
  const signature = `## ${today()} · ${pitSlug}`;
  // Every heading already in the file, filled in under the lock; the "looks like the same pit"
  // hint further down needs them and they are only readable inside it.
  let existingHeadings = [];
  // The whole read-modify-write runs under the ledger's lock. It used to run without one
  // while `appendLocked` took it, which cost two things: a merge that read the file before
  // a concurrent append rewrote the file from its own snapshot and dropped that append, and
  // — on Windows — a rename onto a file another process holds open fails with `EPERM`, so
  // the exception escaped the tool call and the record was lost while the temp file stayed.
  const merged = withLedgerLock(file, () => {
    const existing = markdownEntries(readFile(file));
    existingHeadings = existing.map((block) => block.trim().split('\n', 1)[0].trim());
    // Match on the symptom slug alone, *not* on the dated heading: a pit recorded
    // yesterday and bitten again today has a different heading by construction, so
    // comparing `## <today> · slug` would make the merge silently never fire — the
    // exact failure mode "recorded twice" is supposed to end.
    const priorIndex = existing.findIndex((block) => block.split('\n', 1)[0].trim().endsWith(`· ${pitSlug}`));
    if (priorIndex < 0) return undefined;
    const prior = existing[priorIndex];
    const recurred = recurredOf(prior) + 1;
    const lines = prior.split('\n');
    // The heading's date becomes the day it last happened, so the entry reads as
    // "first seen then, bitten again now" instead of looking like an old dead pit.
    lines[0] = signature;
    let updated = lines.filter((line) => !/^- (recurred|last): /.test(line)).join('\n');
    updated += `\n- recurred: ${recurred}\n- last: ${today()}`;
    const next = [...existing];
    next[priorIndex] = updated;
    const header = headerOf(readFile(file));
    writeFileAtomic(file, `${header.length === 0 ? '' : `${header}\n\n`}${next.join('\n\n')}\n`);
    return { recurred, updated };
  });
  if (merged !== undefined) {    const { recurred, updated } = merged;
    // `merged` is set by the lock: `undefined` means no prior entry with this slug exists,
    // so this is a first occurrence and falls through to the append below.
    journalMistake(cwd, scope, sessionId, {
      symptom,
      cause,
      fix,
      files,
      trigger,
      avoid,
      recurred,
      merged: true,
    });
    return {
      file,
      merged: true,
      recurred,
      entry: signature,
      // A repeat takes no pointer, and says so rather than dropping the request: the caller asked
      // to mark something as replaced and nothing was marked, which is the difference between a
      // mechanism that did nothing and a mechanism that was not asked.
      superseded: { matched: false, reason: 'this symptom already had an entry, so it merged into that one instead of being written; nothing was marked as superseded' },
      warning: entryLengthWarning({ symptom, cause, fix, avoid }, updated),
    };
  }
  const proseSymptom = flattenProse(symptom, { firstLineSafe: true });
  const proseCause = flattenProse(cause, { firstLineSafe: true });
  const proseFix = flattenProse(fix, { firstLineSafe: true });
  const proseRule = flattenProse(rule, { firstLineSafe: true });
  const proseFiles = flattenProse(files, { firstLineSafe: true });
  const proseTrigger = flattenProse(trigger, { firstLineSafe: true });
  const proseSafeCase = flattenProse(safeCase, { firstLineSafe: true });
  const block = [
    signature,
    `- symptom: ${proseSymptom.text.trim()}`,
    `- cause: ${proseCause.text.trim()}`,
    `- fix: ${proseFix.text.trim()}`,
    files === undefined ? undefined : `- files: ${proseFiles.text.trim()}`,
    trigger === undefined ? undefined : `- trigger: ${proseTrigger.text.trim()}`,
    // `- safe case:` — the one precondition a trigger cannot express. A trigger is a regex over
    // command TEXT, so an entry written wider than its real failure mode keeps firing on honest
    // work, and "does the command contain a quote" is precisely what a regex cannot see. Writing
    // it through this path (rather than only by hand) is what makes the field usable: the three
    // entries that carry it on 2026-10-05 were hand-edited, and a field only a text editor can
    // produce is one nobody will produce.
    safeCase === undefined || String(safeCase).trim().length === 0 ? undefined : `- safe case: ${proseSafeCase.text.trim()}`,
    `- do not repeat: ${proseRule.text.trim()}`,
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
  appendBlock(file, block);
  /**
   * A pit that has stopped being true is *superseded*, never deleted.
   *
   * The entry is the evidence that someone paid for it and the reason today's shape is what it
   * is; deleting it is the one move this ledger's design rules out ("账本永不自动删").
   * The pointer is written on the old entry, so the old entry says what replaced it.
   *
   * Deliberately only on this path: the merge above already runs inside `withLedgerLock`, and
   * calling {@link stampSuperseded} from in there would take the same lock twice.
   */
  const replaced =
    supersedes === undefined || String(supersedes).trim().length === 0
      ? undefined
      : stampSuperseded(file, supersedes, `## ${today()} · ${pitSlug}`);
  journalMistake(cwd, scope, sessionId, { symptom, cause, fix, files, trigger, avoid });
  /**
   * Two shapes are worth telling the writer about, and neither is a refusal.
   *
   * Length: see {@link PROSE_FIELD_LIMIT} — the write side is the only side that can
   * stop a ledger outgrowing the briefing that reads it.
   *
   * No coordinate: an entry with neither `files:` nor `trigger:` can only ever be
   * surfaced by ranking, and ranking is exactly what a growing ledger takes away
   * first. It is not refused, because it is still true and still better recorded
   * than remembered; it is reported, because the next session may never see it.
   */
  const warning = [flattenNote([...proseSymptom.flattened, ...proseCause.flattened, ...proseFix.flattened, ...proseRule.flattened, ...proseFiles.flattened, ...proseTrigger.flattened, ...proseSafeCase.flattened]), entryLengthWarning({ symptom, cause, fix, avoid }, block)].filter((part) => typeof part === 'string' && part.length > 0).join(' ') || undefined;
  const noCoordinate =
    (files === undefined || String(files).trim().length === 0) &&
    (trigger === undefined || String(trigger).trim().length === 0);
  const coordinateWarning = noCoordinate
    ? 'No `files:` and no `trigger:`: nothing will surface this entry at the moment it applies, so it competes for briefing space purely on recency — and a cold entry stops being shown. Add whichever the pit actually has.'
    : undefined;
  /**
   * The cost of making identity exact, stated rather than hidden.
   *
   * While the heading was a truncated slug, the *same* pit described in slightly different
   * words still merged — because both truncated to the same text — and so did unrelated pits
   * that happened to share a prefix. The 2026-10-04 fix removed the second behaviour, and the
   * first one went with it: re-describing a pit now appends a second entry instead of
   * incrementing `recurred:`, which is how a ledger becomes unreadable.
   *
   * This is the honest middle: the entry is written (nothing is folded away silently), and the
   * writer is told which existing entry looks like the same pit so *that* decision is made by
   * someone with the meaning in front of them. Reported separately from the warnings above
   * because the remedy is different — it is not "write a better entry", it is "merge or say why
   * not".
   */
  const repeats = existingHeadings.find((heading) => {
    const bare = heading.replace(/^##\s*(\d{4}-\d{2}-\d{2}\s*·\s*)?/, '');
    return bare !== pitSlug && bare.slice(0, SLUG_LIMIT) === pitSlug.slice(0, SLUG_LIMIT);
  });
  const repeatHint =
    repeats === undefined
      ? undefined
      : `This looks like the same pit as \`${repeats}\` (their headings agree for the first ${SLUG_LIMIT} characters). If it is, record the repeat against that entry so its \`recurred:\` count grows instead of the ledger growing.`;
  return {
    file,
    merged: false,
    recurred: 0,
    entry: signature,
    superseded: replaced,
    warning: [coordinateWarning, warning].filter((w) => w !== undefined).join(' ').trim() || undefined,
    repeatHint,
  };
}

/**
 * The file's own preamble — its `# Mistakes` title and anything else above the first
 * entry — as opposed to an entry block.
 *
 * The merge rewrites the whole file as `header` + every block from `markdownEntries`, so
 * this has to use the *same* predicate that decides what a block is: a piece of text
 * whose trimmed form starts with `## `. The version this replaces took everything before
 * the first `\n## `, which is not the same thing at all — in a file that starts with an
 * entry, the first `## ` sits at offset 0 with no newline in front of it, so the *second*
 * entry's heading ended the "header" and the whole first entry was carried through it.
 * The rewrite then emitted that entry twice, the copy inside the header being the stale
 * one, and every further repeat duplicated it again (measured 2026-10-04, audit probe 05:
 * `entry first, NO header line` went 3 → 4 headings after the second repeat, and `alpha
 * something happened` appeared 3× instead of 2×). Splitting on the same separator as
 * {@link markdownEntries} is what makes that impossible: block #0 is either an entry or
 * the preamble, and there is no third answer.
 * @param text - raw markdown.
 */
function headerOf(text) {
  const [first = ''] = String(text ?? '').split(/\n(?=## )/);
  const preamble = first.trim();
  // `trim()` is also what strips a leading BOM, exactly as it does for the block parser,
  // so a BOM'd file that begins with an entry is recognised as headerless too.
  return preamble.startsWith('## ') ? '' : preamble;
}

/**
 * Write a whole ledger file without ever leaving it half-written — or leaving litter.
 *
 * The rename is what makes it atomic, and on Windows a rename onto a file another process
 * holds open fails with `EPERM`. Without the `finally` below that left a `<file>.tmp-<pid>`
 * behind *and* propagated the error out of the tool call, so a record that had already been
 * decided on was lost with a 25 MB temp file as its tombstone (measured 2026-10-04 against a
 * 24 MB ledger; the same probe shows the temp is removed now).
 */
function writeFileAtomic(file, text) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, text, 'utf8');
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* the rename already moved it, or the channel refuses the unlink */
    }
    throw error;
  }
}

/** One journal shape for mistakes, so a merge and a new entry stay comparable. */
function journalMistake(cwd, scope, sessionId, entry) {
  appendJournal(
    cwd,
    {
      ts: new Date().toISOString(),
      session: sessionId,
      kind: 'mistake',
      symptom: entry.symptom,
      ...(entry.cause === undefined ? {} : { cause: entry.cause }),
      ...(entry.fix === undefined ? {} : { fix: entry.fix }),
      ...(entry.files === undefined ? {} : { files: entry.files }),
      ...(entry.trigger === undefined ? {} : { trigger: entry.trigger }),
      ...(entry.avoid === undefined ? {} : { avoid: entry.avoid }),
      ...(entry.recurred === undefined ? {} : { recurred: entry.recurred }),
      ...(entry.merged === undefined ? {} : { merged: entry.merged }),
      ...(scope === undefined || scope === SCOPE.project ? {} : { scope }),
    },
    scope,
  );
}

/**
 * One verification, recorded with the facts needed to *attribute* it later.
 *
 * `run` is the channel report: which runner produced this exit code, whether the sandbox denied
 * it, whether the runner itself failed, and what the command was allowed to do. It exists because
 * this project has already been contradicted by its own evidence — an identical command passed in
 * the `pwsh` channel and failed with `EPERM` in `code_verify`'s, and neither record said which
 * channel it came from, so the difference had to be re-derived from scratch. An exit code with no
 * channel is a number that later cannot be argued with; an exit code with one can.
 *
 * @param options.run - `{ via, exitCode, matched, denied, runnerFailed, aborted, timeoutMs, policy }`.
 */
export function recordVerified(cwd, { cmd, expect, ok, tail, claimed, run }, sessionId, scope) {
  const file = ledgerPath(cwd, 'journal', scope);
  appendJournal(
    cwd,
    {
      ts: new Date().toISOString(),
      session: sessionId,
      kind: 'verified',
      cmd,
      // Where the command ran. `unverifiedExcerpt` needs it to tell "a proof that
      // exercised these files" from "a proof that happened later and elsewhere":
      // without the coordinate, the only way to settle a debt is to name the file
      // in the command, and a project-level `pnpm test` names no file at all.
      cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined,
      expect,
      ok,
      ...(claimed === true ? { claimed: true } : {}),
      ...(run === undefined || run === null || typeof run !== 'object' ? {} : { run }),
      tail,
    },
    scope,
  );
  return file;
}

/**
 * Append one line to the gate's debug journal, when a session opts in.
 *
 * The gate has one layer no probe can reach: what a *real* turn did inside the
 * real host. The event chain is driven by stubs in `gate-probe.mjs`, and the one
 * time the real path was measured it was through instrumentation that was then
 * deleted, so the result was not reproducible. This is that instrumentation as a
 * permanent, opt-in switch: with `DSH_CODE_GATE_JOURNAL` pointing at a file, every
 * decision the gate actually made in the host lands there as JSONL, and
 * `gate-journal-probe.mjs` gets its fixture from this function rather than from a
 * second implementation of the same idea.
 *
 * Off by default, and deliberately silent on failure: a debug trace is never
 * allowed to be the reason a turn fails.
 * @param event - one JSON-serialisable record of a decision the gate made.
 */
export function appendGateJournal(event) {
  const target = process.env.DSH_CODE_GATE_JOURNAL;
  if (typeof target !== 'string' || target.trim().length === 0) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    appendLocked(target, `${JSON.stringify({ ts: new Date().toISOString(), source: 'code-gate', ...event })}\n`);
  } catch {
    /* a debug trace must never break a turn */
  }
}

/**
 * Remember a turn that changed files and ran nothing at all. This is the
 * durable half of the completion gate: it cannot stop the turn that is already
 * ending, so it makes the unproven work visible to the next session's brief.
 * @param cwd - project root.
 * @param input - `edits` are the changed targets; `turn` labels the finished turn.
 * @param sessionId - session that ended with the debt.
 */
export function recordUnverified(cwd, { edits, turn, state: evidence, commands }, sessionId) {
  appendJournal(cwd, {
    ts: new Date().toISOString(),
    session: sessionId,
    kind: 'unverified',
    turn,
    // `state` separates the two ways a turn can owe an answer: `none` ran no
    // command at all, `ran` ran commands whose output nothing recorded. The
    // second used to be invisible, because any command at all silenced the gate.
    ...(evidence === undefined ? {} : { state: evidence }),
    ...(Array.isArray(commands) && commands.length > 0 ? { commands } : {}),
    // The coordinate makes the debt answerable later: a proof recorded inside
    // this subtree settles it, a proof recorded outside it does not.
    cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined,
    edits: [...(edits ?? [])],
  });
  return ledgerPath(cwd, 'journal');
}

/**
 * Remember a turn whose command failed and which recorded no mistake anyway.
 *
 * This is the durable half of the pit guard. A turn that is already ending
 * cannot be made to write `mistakes.md`, and an error the model worked through
 * is exactly the knowledge that otherwise dies with the conversation — measured
 * on this package 2026-10-02: the mode that exists to record pits had no ledger
 * of its own and kept its lessons in a hand-written document instead. So the
 * fact is appended to the journal and the next `code_brief` opens with it.
 * @param cwd - project root.
 * @param input - `failures` are `{ cmd, signature }`; `turn` labels the finished turn.
 * @param sessionId - session that ended with the unrecorded failure.
 */
export function recordMistakeDebt(cwd, { failures, turn }, sessionId) {
  appendJournal(cwd, {
    ts: new Date().toISOString(),
    session: sessionId,
    kind: 'mistake_unrecorded',
    turn,
    failures: (failures ?? []).map((failure) => ({ cmd: failure?.cmd, signature: failure?.signature })),
  });
  return ledgerPath(cwd, 'journal');
}

/**
 * Failures from earlier turns that no later mistake recording has settled.
 *
 * Settlement is deliberately *not* a passing verification: proving that some
 * command now works says nothing about whether anyone wrote down why it did not
 * work before. Only a `kind: 'mistake'` entry recorded after the failing turn
 * settles it, because that is the act the debt is asking for.
 * @param cwd - project root.
 * @param sessionId - current session, whose own turns are still in flight.
 */
/**
 * Normalise a path for comparison, keeping its segments (unlike the pit guard's
 * `normPath`, which flattens one to a single token).
 * @param value - a path, possibly with a `:line` suffix, possibly quoted.
 */
function comparablePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/^[`"'([]+|[`"'),.\]]+$/g, '')
    .replace(/:\d+(?:-\d+)?$/, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Path segments, with the empty and single-dot ones dropped and `..` resolved.
 *
 * `..` is resolved rather than kept as a literal segment, because containment is a claim
 * about the filesystem: `<root>/../other/a.js` names a file *beside* the project, and
 * while it was kept literally the segment comparison saw `<root>` as its prefix and
 * called it covered — so a proof in the project silently settled a debt on a file the
 * project does not contain (measured 2026-10-04 while adding probe-debt-coverage's E8:
 * with `..` kept, the same fixture is settled, with it resolved it is not).
 */
function pathSegments(value) {
  const out = [];
  for (const part of String(value ?? '').split('/')) {
    if (part.length === 0 || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out;
}

/** Whether a comparable path (see {@link comparablePath}) is absolute: `c:/…` or `/…`. */
function isAbsolutePath(value) {
  return /^[a-z]:\//.test(value) || value.startsWith('/');
}

/**
 * Whether one path is the other, or an ancestor directory of it.
 *
 * A segment comparison, not a string prefix: `/tmp/p1-a` must not be read as an ancestor
 * of `/tmp/p1-b`. The two sides are written by different tools, though, and they do not
 * agree on whether a path is absolute: `recordVerified` stores the absolute project root
 * as the proof's `cwd`, while `gate-verify.js` records the edit tool's argument verbatim,
 * so a model writing `edit lib/ledger.js` produces exactly that. Both sides are anchored
 * at the *start* of the longer path here, which is why the relative/absolute pair never
 * matched (`['lib','ledger.js']` was compared with `['e:','projects',…]`) although this
 * comment used to claim it worked — measured 2026-10-04, audit probe 12A: an absolute
 * target settles against a proof in its subtree, the same debt with a relative target does
 * not.
 *
 * A relative `target` is made absolute before it arrives here (see
 * {@link resolveAgainst}), so the only mixed pair left is a relative `candidate` — and
 * there the relative directory can only be the *tail* of the target's own directory
 * (`lib` names the `lib` that holds the file). A relative candidate with nothing in common
 * with that directory is not an ancestor of anything.
 * @param candidate - the directory a proof ran in.
 * @param target - the file a debt is about.
 */
function isAncestorOrSelf(candidate, target) {
  const left = String(candidate ?? '');
  const right = String(target ?? '');
  const a = pathSegments(left);
  const b = pathSegments(right);
  if (a.length === 0 || b.length === 0) return false;
  if (isAbsolutePath(left) !== isAbsolutePath(right)) {
    if (!isAbsolutePath(right)) return false; // a relative target: nothing to anchor the candidate on
    const directory = b.slice(0, -1);
    const offset = directory.length - a.length;
    return offset >= 0 && a.every((segment, index) => segment === directory[offset + index]);
  }
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return short.every((segment, index) => segment === long[index]);
}

/**
 * A relative target made absolute against the directory it was recorded in.
 *
 * A relative path carries no root of its own; the record it belongs to is the only place
 * its root was ever written down, and `recordUnverified` writes it as the entry's `cwd`.
 * The proof's `cwd` is *not* that place: resolving the target against wherever the proof
 * happened to run makes containment true for a proof in any directory at all, which is
 * exactly the cross-project false coverage this whole test exists to prevent. A target
 * that is already absolute, or a record with no coordinate to resolve against, comes back
 * unchanged — and then only the literal match below can settle it, which is the honest
 * answer rather than coverage manufactured out of nothing.
 * @param target - a comparable target path.
 * @param origin - the `cwd` of the `unverified` entry the target came from.
 */
function resolveAgainst(target, origin) {
  const base = comparablePath(origin);
  if (isAbsolutePath(target) || !isAbsolutePath(base)) return target;
  return `${base}/${target}`;
}

/**
 * Whether a proof recorded in the journal covers one edited target.
 *
 * Two ways to match, either is enough:
 *  - structural — the proof ran in a working directory that contains the target
 *    (so `pnpm test` at the repository root covers the files edited there); or
 *  - literal — the command line or the output tail names the target's basename.
 *
 * The second exists because plenty of proofs run from elsewhere or name only the
 * test file, and demanding an exact path would turn real proof into no proof.
 * @param proof - a journal `verified` entry.
 * @param target - one path from an `unverified` entry's `edits`.
 * @param origin - that entry's own `cwd`, needed to resolve a relative target.
 */
function proofCoversTarget(proof, target, origin) {
  const path = resolveAgainst(comparablePath(target), origin);
  if (path.length < 3) return true; // nothing to match on: do not manufacture a debt
  if (typeof proof.cwd === 'string' && proof.cwd.trim().length > 0) {
    const base = comparablePath(proof.cwd);
    // A recorded `cwd` is a path, so segment containment is an ancestor
    // relationship even when one side is absolute and the other relative
    // (`e:/projects/p/lib/x.js` vs `lib/x.js`).
    if (base.length > 0 && isAncestorOrSelf(base, path)) return true;
  }
  const needle = path.split('/').at(-1) ?? '';
  if (needle.length < 4) return false;
  return [proof.cmd, proof.tail].some((text) => typeof text === 'string' && text.toLowerCase().includes(needle));
}

/**
 * Path tokens out of a recorded `files:` field, or another free-text field.
 * Drops `:line` suffixes and quote characters so a token can be compared with a
 * command line.
 * @param value - the raw field text, or undefined.
 */
function unquoteTokens(value) {
  return String(value ?? '')
    .split(/[,;\n]/)
    .map((part) =>
      part
        .trim()
        .replace(/^[`"'([]+|[`"'),.\]]+$/g, '')
        .replace(/:\d+(?:-\d+)?$/, '')
        .replace(/\\/g, '/')
        .trim()
        .toLowerCase(),
    )
    .filter((part) => part.length > 0);
}

/**
 * Whether a mistake recorded later is about the same failure as this debt.
 *
 * Every field of the entry is searched, because the failed command and its error
 * signature may be quoted in the symptom, the cause, or the rule; the `files:`
 * field is searched too, since a pit recorded against the failing file is the
 * same pit. A mistake that neither names the command nor quotes the failure is a
 * *different* lesson and must not clear this line (measured 2026-10-02: before
 * this rule, any unrelated mistake cleared every earlier unrecorded failure).
 * @param mistake - a journal `mistake` entry.
 * @param failures - the debt's `{ cmd, signature }` list.
 */
function mistakeSettlesFailures(mistake, failures) {
  const fields = ['symptom', 'cause', 'fix', 'avoid', 'trigger', 'files']
    .map((key) => (typeof mistake[key] === 'string' ? mistake[key] : ''))
    .join('\n');
  if (fields.trim().length === 0) return false;
  const haystack = `${fields}\n${String(mistake.heading ?? '')}`.toLowerCase();
  const compact = haystack.replace(/\s+/g, ' ');
  return failures.some((failure) => {
    const cmd = String(failure?.cmd ?? '').trim().toLowerCase();
    if (cmd.length >= 6 && (haystack.includes(cmd) || compact.includes(cmd.replace(/\s+/g, ' ')))) return true;
    // The other direction: an entry that files the pit against a path named by the
    // failed command has written down that failure, even when it quotes no error
    // text (`files: lib/ledger.js` against `node --test test/ledger.test.js` is not
    // a match, but against `node probes/guard-probe.mjs` it is).
    const paths = unquoteTokens(mistake.files);
    if (paths.some((token) => token.length >= 6 && cmd.includes(token.replace(/\s+/g, ' ')))) return true;
    const signature = String(failure?.signature ?? '').trim().toLowerCase();
    if (signature.length < 12) return false;
    if (haystack.includes(signature)) return true;
    const head = signature.slice(0, 40);
    return head.length >= 12 && haystack.includes(head);
  });
}

/**
 * File paths named by one recorded edit line (`edit src/a.js`, `write E:/x/b.ts`).
 * @param edits - an `unverified` entry's `edits` array.
 */
function editTargets(edits) {
  const tokens = new Set();
  for (const edit of Array.isArray(edits) ? edits : []) {
    const parts = String(edit ?? '').trim().split(/\s+/);
    const last = parts.at(-1) ?? '';
    const path = comparablePath(last);
    // Short fragments (`edit`, `write`, a bare tool name) carry no location.
    if (path.length >= 4) tokens.add(path);
  }
  return [...tokens].sort();
}

/** The failure text of one debt, lowercased, for matching a recorded mistake. */
function failureText(failures) {
  return failures
    .map((failure) => `${failure?.cmd ?? ''}\n${failure?.signature ?? ''}`)
    .join('\n')
    .toLowerCase();
}

/**
 * Turns from earlier sessions that ran commands which failed and were never written down.
 *
 * "The previous session" is derived from the debts' own timestamps, not from the journal's
 * session order — see the comment on `recentDebtSession` below for the two ways the old basis
 * was measured to be wrong.
 *
 * @param cwd - the project whose journal to read, or a global ledger path for the machine scope.
 * @param sessionId - the session asking; its own debts are never shown back to it.
 * @param scope - `project` (default) or `global`.
 */
function unrecordedMistakes(cwd, sessionId, scope) {
  // `readJournalText` never throws and reads every rotated segment, so the old
  // try/catch-and-return-undefined shape would now hide a real absence behind a
  // catch that can no longer fire.
  const text = readJournalText(cwd, scope);
  const debts = [];
  const mistakes = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"mistake_unrecorded"') && !line.includes('"mistake"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.kind === 'mistake_unrecorded') debts.push(e);
      else if (e.kind === 'mistake') mistakes.push(e);
    } catch {
      /* a torn last line is not a record */
    }
  }
  const seenFailures = new Set();
  /** A line clipped for length may hide the tail of a command; keep matching honest. */
  const clipped = (failure) => ({ cmd: failure?.cmd, lookedForAnyOf: failureText([failure]).trim().slice(0, 200) });
  /**
   * Only the session immediately before this one gets a full row; everything older is a count.
   *
   * Why this is a 口径 fix and not a filter: measured 2026-10-05 on this repository, 67 distinct
   * unsettled failures spanned 16 sessions and **all 67 came from sessions other than the
   * current one** — and after each of those sessions a mistake *had* been recorded. They stay
   * "unwritten" only because `mistakeSettlesFailures` matches per the letter: a mistake written
   * at the time is about *that* pit and does not quote an older command line. Nobody will go back
   * and quote commands from 2026-10-02, so those lines are **unsettleable, not unpaid** — and
   * `## Next` was leading with them, ahead of the two fields that section exists to carry. A
   * heading that means "what is next" cannot spend its first screen on a list nobody can act on.
   *
   * The previous session keeps its rows because its failures are still fresh enough to write
   * down properly, which is the only action this block ever asks for. With one prior session in
   * the journal — every probe fixture, and any young project — nothing changes: that session
   * *is* the previous one, which is why `handover-derive-probe`'s `N2c` still sees its
   * `broken.mjs` row, and `N2c` is the control for this change.
   *
   * The older half is never dropped silently: the count is printed, the word `unsettleable` is
   * in the line, and the file holding the evidence is named. Deleting it would tell a reader
   * those failures had been written down — the failure this function's own comment already
   * refuses for the single-debt case below.
   */
  /**
   * Which prior session is "the previous one", derived from the debts themselves.
   *
   * This used to be inferred from the journal's session order (`sessionOrderBefore`), and that is
   * wrong in two measured ways. ① When the current session is not in the journal — every probe
   * fixture, and any session that has not written yet — `sessionOrderBefore` returns *every*
   * session, `slice(0, -1)` removes an unrelated one, and the debt is counted as old **before**
   * settlement is ever evaluated. `pit-guard-probe`'s `J6` failed for exactly that reason: the
   * mistake that settles the debt was in the journal, and the row was hidden before anyone looked.
   * ② Even when the current session is present, entries written by other mechanisms carry their own
   * session, so the ordering surface is not the one a reader pictures.
   *
   * Recency comes from the debts' own timestamps, which is self-contained: it needs neither the
   * journal's session order nor the current session to appear anywhere. A debt with no session id
   * cannot be shown to be old, so it is treated as recent — the direction that shows the row.
   */
  const dated = debts
    .filter((debt) => typeof debt.session === 'string' && debt.session !== sessionId)
    .filter((debt) => typeof debt.ts === 'string' && debt.ts.length > 0)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const recentDebtSession = dated.at(-1)?.session;
  const rows = [];
  let older = 0;
  const olderSeen = new Set();
  let olderProof;
  for (const debt of debts) {
    if (sessionId !== undefined && debt.session === sessionId) continue;
    // Counted, never shown: an older session's failures are evidence about the past, and the
    // evidence stays in the journal. Only the most recent prior session keeps a row.
    if (recentDebtSession !== undefined && debt.session !== recentDebtSession) {
      older += (Array.isArray(debt.failures) ? debt.failures : []).length;
      olderSeen.add(typeof debt.session === 'string' ? debt.session : '(unknown session)');
      continue;
    }
    const failures = (Array.isArray(debt.failures) ? debt.failures : []).filter(
      (failure) => !seenFailures.has(`${failure?.cmd ?? ''}\u0000${failure?.signature ?? ''}`),
    );
    if (failures.length === 0) continue;
    for (const failure of failures) seenFailures.add(`${failure?.cmd ?? ''}\u0000${failure?.signature ?? ''}`);
    const when = typeof debt.ts === 'string' ? debt.ts : '';
    const settled = mistakes.find(
      (mistake) =>
        typeof mistake.ts === 'string' && when.length > 0 && mistake.ts > when && mistakeSettlesFailures(mistake, failures),
    );
    if (settled !== undefined) continue;
    const later = mistakes.filter((mistake) => typeof mistake.ts === 'string' && when.length > 0 && mistake.ts > when);
    if (later.length === 0) {
      const lines = failures.slice(0, 3).map((failure) => `  - \`${failure?.cmd ?? '?'}\``);
      rows.push(
        `${when.slice(0, 16).replace('T', ' ')} · ${failures.length} failing command(s), no mistake recorded:\n${lines.join('\n')}\n  → record it: code_record(kind="mistake", …) — that settles this line`,
      );
    } else {
      // A mistake was recorded afterwards, but it is about something else. Say so:
      // deleting the line would tell the reader the failure was written down.
      older += failures.length;
      olderSeen.add(typeof debt.session === 'string' ? debt.session : '(unknown session)');
      olderProof = later.map((mistake) => String(mistake.ts).slice(0, 16).replace('T', ' ')).sort().at(-1);
    }
    if (rows.length >= 2) break;
  }
  if (older > 0) {
    const span = olderSeen.size === 0 ? '' : ` across ${olderSeen.size} earlier session(s)`;
    rows.push(
      `… ${older} failing command(s)${span} are **unsettleable, not unpaid**: a mistake was recorded in each of those sessions, but settling matches per the letter — it needs that command line or its error signature quoted — so no later entry can clear them. They remain in \`${FILES.journal}\` as evidence${olderProof === undefined ? '' : ` (latest mistake recorded ${olderProof})`}. Nothing to do here; this line exists so the number stays visible instead of leading.`,
    );
  }
  if (rows.length === 0) return undefined;
  return rows.join('\n');
}

/**
 * Turns from earlier sessions that edited files and whose work nothing has
 * exercised yet.
 *
 * Without settlement this section only ever grew: every unproven turn from every
 * past session was listed forever, so a debt resolved weeks ago still ate the
 * brief's budget and buried the live ones — measured 2026-10-01 on this project,
 * where the stale `gate-demo.js` debt survived a real verification that proved
 * the file was gone. An alarm nobody can turn off stops being an alarm.
 *
 * Settlement rule: a passing, non-claimed `code_verify` recorded *after* the
 * unproven turn settles it — but only for the edits that verification actually
 * **covers** ({@link proofCoversTarget}: the same project subtree, or the file
 * named in the command or its output). The older rule settled everything, and
 * that was measured to be wrong on 2026-10-02: `code_verify` without an `expect`
 * only demands exit 0, so a bare `echo hi` silently deleted this whole section,
 * telling the next reader the work had been proven. Edits that no recorded proof
 * covers are not deleted; they are named in one line, because a section that
 * disappears is a section a reader concludes was empty.
 * @param cwd - project root.
 * @param sessionId - current session, whose own turns are still in flight.
 */
function unverifiedExcerpt(cwd, sessionId, scope) {
  const text = readJournalText(cwd, scope);
  const unproven = [];
  const proofs = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"unverified"') && !line.includes('"verified"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.kind === 'unverified') unproven.push(e);
      else if (e.kind === 'verified' && e.ok === true && e.claimed !== true && typeof e.ts === 'string') proofs.push(e);
    } catch {
      /* a torn last line is not a record */
    }
  }
  if (proofs.length === 0 && unproven.length === 0) return undefined;
  const rows = [];
  let older = 0;
  let olderProof;
  for (const entry of unproven) {
    if (sessionId !== undefined && entry.session === sessionId) continue;
    const when = typeof entry.ts === 'string' ? entry.ts : '';
    const targets = editTargets(entry.edits);
    const later = proofs.filter((proof) => when.length > 0 && proof.ts > when);
    if (when.length === 0) {
      // No timestamp: it cannot be compared with any proof, so it stays visible.
      rows.push(`- ${(Array.isArray(entry.edits) && entry.edits.length > 0 ? entry.edits.join(', ') : 'unknown targets')}`);
      continue;
    }
    if (later.length === 0) {
      const edits = Array.isArray(entry.edits) && entry.edits.length > 0 ? entry.edits.join(', ') : 'unknown targets';
      const ran = entry.state === 'ran';
      const commands = Array.isArray(entry.commands) ? entry.commands : [];
      rows.push(
        `- ${when.slice(0, 16).replace('T', ' ')}: ${edits}${ran ? ` — ${commands.length > 0 ? `${commands.length} command(s) ran with no recorded evidence: ${commands.map((c) => `\`${c}\``).join(', ')}` : 'a command ran, but nothing recorded its exit code or output'}` : ''}`,
      );
    } else if (targets.length === 0 || targets.some((target) => later.some((proof) => proofCoversTarget(proof, target, entry.cwd)))) {
      // Covered by proof that came later: settled.
      continue;
    } else {
      older += 1;
      olderProof = later.map((proof) => `${String(proof.ts).slice(0, 16).replace('T', ' ')} \`${String(proof.cmd ?? '').slice(0, 60)}\``).at(-1);
    }
    if (rows.length >= 3) break;
  }
  if (older > 0) {
    rows.push(
      `… ${older} earlier unproven turn(s) are still in ${FILES.journal}: a verification was recorded after them, but it neither ran in their project subtree nor named their files, so it did not exercise them${olderProof === undefined ? '' : ` (latest: ${olderProof})`}. Run the command that proves those files and record it with code_verify, or say plainly that they are unproven.`,
    );
  }
  if (rows.length === 0) return undefined;
  return rows.join('\n');
}

/**
 * Byte-bounded project summary for the briefing.
 *
 * Built field by field rather than as one string that is later sliced: slicing
 * keeps the wrong end (a tail-clip on a long `notes` field returns notes and
 * drops `Commands:`/`Stack:`, which is exactly backwards), while field-at-a-time
 * either keeps a field whole or names it as dropped. A long single-line field
 * that cannot fit whole is trimmed to one line that says so, so the reader
 * learns the field exists and where to read it.
 * @param cwd - project root.
 * @param limit - characters available for the section body.
 */
function projectSummary(cwd, limit) {
  const project = readProject(cwd);
  if (project === undefined) return undefined;
  const named = Object.entries(project.commands ?? {}).filter(
    ([, value]) => typeof value === 'string' && value.length > 0,
  );
  /** @type {[string, string[]][]} label, marked lines */
  const other = [];
  if (typeof project.stack === 'string' && project.stack.length > 0) other.push(['Stack', [`Stack: ${project.stack}`]]);
  if (typeof project.layout === 'string' && project.layout.length > 0)
    other.push(['Layout', [`Layout: ${project.layout}`]]);
  if (typeof project.notes === 'string' && project.notes.length > 0) other.push(['Notes', [`Notes: ${project.notes}`]]);
  for (const [key, value] of Object.entries(project)) {
    if (['version', 'createdAt', 'updatedAt', 'commands', 'stack', 'layout', 'notes'].includes(key)) continue;
    if (typeof value === 'string' && value.length > 0) other.push([key, [`${key}: ${value}`]]);
  }
  if (named.length === 0 && other.length === 0) return undefined;
  const cap = Number.isFinite(limit) && limit > 0 ? limit : CAP.projectBytes;
  const out = [];
  const dropped = [];
  let used = 0;
  /**
   * Commands obey the cap too.
   *
   * Measured 2026-10-03 on the real ledger: this section pushed *every* command into
   * `out` before measuring anything, so it was the one section with no bound at all.
   * Nine project commands cost ~1,100 characters of a 4,000-character brief, and the
   * cost landed on the sections that carry memory — the briefing ended up showing one
   * mistake, one decision, and no index at all. A command list is re-derivable from
   * `project.json`; a pit is not.
   */
  const cut = `… (read the rest in ${ledgerPointer(cwd, 'project')})`;
  const commandLines = named.map(([key, value]) => `- ${key}: ${value}`);
  const commandRoom = cap - cut.length - 2;
  const shownCommands = [];
  let commandUsed = 0;
  for (const line of commandLines) {
    if (commandUsed + line.length + 1 > commandRoom) break;
    shownCommands.push(line);
    commandUsed += line.length + 1;
  }
  const commandsCut = commandLines.length - shownCommands.length;
  if (shownCommands.length > 0) {
    out.push('Commands:', ...shownCommands);
    if (commandsCut > 0) out.push(`… (${commandsCut} more command(s); ${cut.slice(3)}`);
    used += out.reduce((sum, line) => sum + line.length + 1, 0);
  }
  for (const [label, lines] of other) {
    const size = lines.reduce((sum, line) => sum + line.length + 1, 0);
    if (used + size <= cap) {
      out.push(...lines);
      used += size;
      continue;
    }
    const room = cap - used - cut.length - label.length - 6;
    if (room > 40) {
      const line = lines[0];
      out.push(`${line.slice(0, room)}… ${cut}`);
      used += room + cut.length + 3;
      continue;
    }
    dropped.push(label);
  }
  if (out.length === 0) return undefined;
  if (dropped.length > 0) out.push(`… (dropped for length: ${dropped.join(', ')}; read ${ledgerPointer(cwd, 'project')})`);
  return out.join('\n');
}

function boardSummary(cwd) {
  const board = readTasks(cwd);
  if (board === undefined) return undefined;
  const line = (t) => `- [${t.status}] ${t.id} — ${t.title}${t.acceptance ? ` (acceptance: ${t.acceptance})` : ''}`;
  const parts = [];
  if ((board.active ?? []).length > 0) parts.push(`In flight:\n${board.active.slice(0, 6).map(line).join('\n')}`);
  if ((board.blocked ?? []).length > 0) parts.push(`Blocked:\n${board.blocked.slice(0, 4).map(line).join('\n')}`);
  if (parts.length === 0 && (board.done ?? []).length > 0) {
    parts.push(`No open task. Last done: ${board.done[0].title}`);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** Recent journal lines, for "what did the last session actually change". */
function recentJournal(cwd, sessionId, scope) {
  try {
    const text = readJournalText(cwd, scope).trimEnd();
    if (text.length === 0) return undefined;
    const lines = text.split('\n').slice(-CAP.journalTail);
    return lines
      .map((line) => {
        try {
          const e = JSON.parse(line);
          const own = e.session !== undefined && e.session === sessionId ? ' (this session)' : '';
          const detail =
            e.symptom ??
            e.title ??
            e.id ??
            e.cmd ??
            (Array.isArray(e.edits) ? `${e.edits.length} edit(s), ran nothing` : '');
          return `- ${e.ts?.slice(0, 16).replace('T', ' ')} ${e.kind}${own}: ${detail}`;
        } catch {
          return undefined;
        }
      })
      .filter((l) => l !== undefined)
      .join('\n');
  } catch {
    return undefined;
  }
}

/**
 * Complete `## ` entries from a markdown ledger file, oldest first.
 *
 * The window used to be applied *before* parsing (`readTail`, a raw 1200-char
 * slice), which cut entries mid-body: measured 2026-10-01, a 4275-char
 * mistakes.md yielded exactly 1 parseable block out of 4, and a topic search for
 * an entry in the middle found nothing while the full file matched. Parse whole
 * entries first, then window them.
 * @param text - raw markdown.
 * @returns entry blocks, oldest first.
 */
function markdownEntries(text) {
  return String(text ?? '')
    .split(/\n(?=## )/)
    .map((b) => b.trim())
    .filter((b) => b.startsWith('## '));
}

/**
 * One `- label: value` field out of a markdown entry block.
 * @param block - a whole `## ` entry.
 * @param label - the field name, e.g. `do not repeat`.
 */
function fieldOf(block, label) {
  return new RegExp(`^- ${label}: (.*)$`, 'm').exec(block)?.[1]?.trim();
}

/** The `## ` heading text of an entry, without the hashes or the date. */
function headingOf(block) {
  const line = block.split('\n', 1)[0].trim();
  return line.startsWith('## ') ? line.slice(3).trim() : line;
}

/**
 * How often a rule has bitten again, as recorded by {@link recordMistake}'s merge.
 *
 * A pit that recurred is the most valuable thing a ledger can hold: it is proof that
 * the rule is needed, and it is the one signal here that comes from real work rather
 * than from the shape of the text.
 */
function recurredOf(block) {
  const value = Number(fieldOf(block, 'recurred'));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Which later entry took this one's place, if any (`- superseded by: …`).
 *
 * Borrowed from the temporal-knowledge-graph shape (Graphiti/Zep): a claim is not deleted and not
 * rewritten when it stops being true — it is *invalidated*, with the successor named. This ledger
 * has needed that since its first reversal. On 2026-10-10 `decisions.md` held the compaction switch
 * moving `0.8/0.65 → 0.75/0.6 → 67.8%` and `auto: false` moving from the profile row into the
 * module, so three entries stated a policy a fourth had already replaced, and the only way to learn
 * which one still held was to read them in date order and infer. "Newest wins" is exactly the
 * inference that breaks the moment someone records a decision *about* an older one, so the
 * successor is written down instead of guessed.
 *
 * The entry itself stays: it explains why the current shape is the way it is, which is the half of
 * a decision a changelog loses. What changes is its rank (see {@link importance}) and how it is
 * labelled in an index line.
 */
function supersededBy(block) {
  return entryField(block, 'superseded by/被取代/取代者');
}

/**
 * Where a superseded entry ranks: below every live one, whatever its other signals say.
 *
 * Deliberately a finite number rather than `-Infinity`: a comparison that is not a number makes
 * the sort in {@link shapeEntries} implementation-defined, and that function's one hard guarantee
 * — "at least one entry is always shown in full" — would then rest on which comparator the engine
 * happened to pick.
 */
const SUPERSEDED_PENALTY = -1_000_000_000;

/**
 * Priority of one entry for the space it is given, high first.
 *
 * Ordered by what makes a rule worth showing while someone is working:
 *   0. it is not superseded — a replaced decision is history, not a rule;
 *   1. it has recurred (`recurred:`) — real evidence, ranked above every heuristic;
 *   2. it carries an executable `trigger:` — it can arrive on its own;
 *   3. it names `files:` — it can be found by what is being edited;
 *   4. then recency, and finally brevity (cheap to show, so more rules fit).
 *
 * Recency is last on purpose: the newest entry is already kept by every previous
 * version of this briefing, and "newest" is exactly the signal that let 77 machine
 * pits accumulate while only the last few were ever displayed.
 * @param entry - `{ block, index }` in file order.
 * @param total - number of entries, for recency scoring.
 */
function importance(entry, total) {
  const { block, index } = entry;
  const trigger = fieldOf(block, 'trigger') !== undefined;
  const files = fieldOf(block, 'files') !== undefined;
  const recurring = recurredOf(block);
  return (
    (supersededBy(block) === undefined ? 0 : SUPERSEDED_PENALTY) +
    recurring * 1_000_000 +
    (trigger ? 100_000 : 0) +
    (files ? 10_000 : 0) +
    // Newer entries score higher; ties broken by shorter block first.
    Math.round((index / Math.max(1, total)) * 1_000) * 10 -
    Math.min(9, Math.floor(block.length / 400))
  );
}

/** One line that names an entry and what makes it findable again. */
function indexLine(block) {
  const trigger = fieldOf(block, 'trigger');
  const files = fieldOf(block, 'files');
  const recurred = recurredOf(block);
  // `superseded by` sits next to the heading, ahead of every "why you can find this" field: the
  // one thing a reader must know about a replaced entry is that it is replaced.
  const superseded = supersededBy(block);
  return `- [${headingOf(block)}]${superseded === undefined ? '' : ` · superseded by ${superseded}`}${recurred > 0 ? ` recurred ${recurred}×` : ''}${trigger === undefined ? '' : ` trigger: ${trigger}`}${
    files === undefined ? '' : ` files: ${files.split(',')[0].trim()}`
  }`;
}

/**
 * Fit a whole section — entries and an index of everything else — into `limit`.
 *
 * This is the answer to "the ledger grows forever and the briefing cannot": the file
 * stays the source of truth and is never trimmed, while the briefing shows the
 * highest-priority entries in full and every remaining entry as one findable line.
 *
 * Guarantees, in this order:
 *   1. the returned text never exceeds `limit`;
 *   2. at least one entry is always shown in full, even when it must be clipped,
 *      because a pointer at nothing is worse than a fragment that names something;
 *   3. entries that fit the index budget are *not* reported as beyond it — the count
 *      that says "read the file" is only emitted when index lines were really lost.
 *
 * @param entries - entry blocks, oldest first.
 * @param limit - characters available, marker included.
 * @returns the section body and what it had to leave out.
 */
export function shapeEntries(entries, limit) {
  if (entries.length === 0) return { text: '', full: 0, indexed: 0, beyond: 0 };
  const ranked = entries
    .map((block, index) => ({ block, index }))
    .sort((a, b) => importance(b, entries.length) - importance(a, entries.length));
  const full = [];
  const rest = [];
  const note = (count) => `… (${count} more entr${count === 1 ? 'y' : 'ies'} beyond this list: name one in code_brief({topic}) to read it in full)`;
  // The "beyond" marker is reserved first: a marker emitted on top of a spent
  // allowance is how this section used to overrun the budget it was given.
  let used = ranked[0].block.length + 2;
  full.push(ranked[0].block);
  for (const entry of ranked.slice(1)) {
    const size = entry.block.length + 2;
    // `limit - 100` is not a magic number: it is the room a single index line needs
    // (headings are clipped to 220, and the shortest useful line is far below 100).
    // Without this reserve a section of *short* entries filled up whole and left no
    // room for the index at all — the exact state this function exists to end, where
    // everything shown is fine and everything else is unreachable.
    if (used + size > limit - 100) {
      rest.push(entry);
      continue;
    }
    used += size;
    full.push(entry.block);
  }
  /**
   * Build the body *unclipped* first, because the decision below needs its true length.
   *
   * Measured 2026-10-03, the hard way: the clip used to happen here, before the "one entry that
   * fits whole is never clipped" rule could look at `text.length`, so that rule could never
   * fire — `text.length > limit` was false by construction. A guard that cannot trigger is
   * worse than no guard: it reads like protection and provides none.
   */
  let text = full.join('\n\n');
  const lines = [];
  let indexUsed = 0;
  const lost = [];
  const room = Math.max(0, limit - text.length - 2);
  for (const entry of rest) {
    const line = clip(indexLine(entry.block), 220);
    if (indexUsed + line.length + 1 > room) {
      lost.push(entry);
      continue;
    }
    lines.push(line);
    indexUsed += line.length + 1;
  }
  if (lines.length > 0) text += `\n\n${lines.join('\n')}`;
  // No note appended here: it is added in the return below, with its length reserved before the
  // clip. Appending it here and clipping afterwards is what used to truncate the note itself.
  /**
   * One entry that fits whole is never clipped.
   *
   * Measured 2026-10-03: a single machine pit of 237 characters was clipped to 186 because the
   * section gave it only `floor(cap / 3)` — cutting off its `trigger:` and `do not repeat:`, the
   * two fields that make a pit actionable. A compact `## ` entry whose lines fit *should* fit:
   * clipping must be the last resort for genuinely exceeding the limit, not a side effect of a
   * caller passing a small one. Above {@link HARD_ENTRY_CHARS} the hard limit stands, because
   * the briefing's bound outranks any single entry.
   */
  if (full.length === 1 && lines.length === 0 && lost.length === 0 && text.length > limit && text.length <= HARD_ENTRY_CHARS) {
    return { text, full: 1, indexed: 0, beyond: 0 };
  }
  /**
   * The note is paid for *before* the clip, not after it.
   *
   * Measured 2026-10-04 (guard-probe A6, while a longer slug shifted the boundary): the note was
   * appended and then `clip(text, limit)` cut it in the middle of its own sentence —
   * `… (39 more entries beyond this list:…` — so the reader was told entries are missing and
   * *not* told that `code_brief({topic})` reads them in full. That is the same loss the note
   * exists to prevent, one level down: a recovery hint that a bound eats is not a way back.
   * Reserving its length first means the clipping falls on entry text, which is regenerable,
   * instead of on the one line that explains how to reach what was dropped.
   */
  if (lost.length > 0) {
    const marker = note(lost.length);
    return { text: `${clip(text, Math.max(0, limit - marker.length - 1))}\n${marker}`, full: full.length, indexed: lines.length, beyond: lost.length };
  }
  return { text: clip(text, limit), full: full.length, indexed: lines.length, beyond: lost.length };
}

/**
 * Search every ledger entry a query could mean.
 *
 * `topic` used to be a substring test over the project's `mistakes.md` only, which is
 * how 77 machine-wide pits could be unreadable by any means: the compound query path
 * simply did not exist for the scope that held them. A query is now matched against
 * the heading, the whole body, the `trigger:` regex, the `files:` list and the
 * `do not repeat:` rule — the same coordinates `code-pit-guard` uses to arrive on its
 * own, so "the thing that just happened" and "the thing I am asking about" agree.
 * @param ledgers - `[{ dir, scope }]`, project first.
 * @param query - free text: a file, a symptom, a trigger, a heading fragment.
 * @returns matching entries, best first.
 */
function searchEntries(ledgers, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle.length === 0) return [];
  const hits = [];
  for (const { dir, scope } of ledgers) {
    for (const kind of ['mistakes', 'decisions']) {
      const file = path.join(dir, FILES[kind]);
      for (const [index, block] of markdownEntries(readFile(file)).entries()) {
        const haystack = block.toLowerCase();
        if (!haystack.includes(needle)) continue;
        const trigger = fieldOf(block, 'trigger');
        let patternHit = false;
        if (trigger !== undefined) {
          // Bounded on purpose. This used to be `new RegExp(trigger, 'i').test(query)` — the
          // same unbounded call `pit-guard` had already been cured of — so a recorded
          // nested-quantifier trigger hung the briefing: measured 2026-10-04 at 21,432 ms for
          // a 26-character topic, never returning at 34 (ledger-core audit F2).
          patternHit = testPatternSync(trigger, String(query ?? '')).matched === true;
        }
        hits.push({
          scope: scope === SCOPE.global ? 'global' : 'project',
          kind,
          file,
          heading: headingOf(block),
          block,
          // A hit in the rule or the trigger is the one that matters at the moment
          // of action; a hit in the prose is context.
          strength: patternHit ? 3 : fieldOf(block, 'do not repeat')?.toLowerCase().includes(needle) ? 2 : 1,
          index,
        });
      }
    }
  }
  return hits.sort((a, b) => b.strength - a.strength || b.index - a.index);
}

/**
 * Every entry that a follow-up query can reach, for the caller to print as a hint.
 * @param ledgers - `[{ dir, scope }]`.
 */
function retrievalHint(ledgers) {
  const count = (dir) => ({
    mistakes: markdownEntries(readFile(path.join(dir, FILES.mistakes))).length,
    decisions: markdownEntries(readFile(path.join(dir, FILES.decisions))).length,
  });
  const project = count(ledgers[0].dir);
  const machine = ledgers[1] === undefined ? { mistakes: 0, decisions: 0 } : count(ledgers[1].dir);
  if (project.mistakes + project.decisions + machine.mistakes + machine.decisions === 0) return undefined;
  return `This brief is a selection, not the ledger: ${project.mistakes} mistake entr${project.mistakes === 1 ? 'y' : 'ies'} and ${project.decisions} decision${project.decisions === 1 ? '' : 's'} in this project${
    machine.mistakes + machine.decisions === 0
      ? ''
      : `, plus ${machine.mistakes} machine-wide pit${machine.mistakes === 1 ? '' : 's'}`
  }. Name a file, a symptom, a heading or a \`trigger:\` in code_brief({topic}) to read any of them in full.`;
}

/** Mistakes matching a topic, newest last; the whole window when no topic is given. */
function mistakeExcerpt(cwd, topic, limit) {
  const entries = markdownEntries(readFile(ledgerPath(cwd, 'mistakes')));
  // A ledger file that only carries its `# Mistakes` header has no entries yet;
  // reporting that as a section (or worse, as one dropped for length) is noise.
  if (entries.length === 0) return { entries: undefined, body: undefined };
  if (topic === undefined || topic.trim().length === 0) {
    const shaped = shapeEntries(entries, limit);
    return {
      entries: entries.length,
      body: shaped.text,
      shown: shaped.full,
      indexed: shaped.indexed,
      beyond: shaped.beyond,
    };
  }
  const hits = searchEntries([{ dir: ledgerDir(cwd, SCOPE.project), scope: SCOPE.project }], topic).filter(
    (hit) => hit.kind === 'mistakes',
  );
  if (hits.length === 0) return { entries: 0, body: undefined };
  const shaped = shapeEntries(
    hits.map((hit) => hit.block),
    limit,
  );
  return { entries: hits.length, body: shaped.text, shown: shaped.full, indexed: shaped.indexed, beyond: shaped.beyond };
}

/**
 * Decisions, optionally narrowed to what a topic (usually a file) touches.
 *
 * The topic half is the same just-in-time move as {@link mistakeExcerpt}'s, and it is what makes
 * `files:` on a decision worth writing: `code_brief({topic:"lib/ledger.js"})` reaches the
 * decisions that govern that file, instead of the reader being handed the four newest decisions
 * and left to hope. The empty-body answers below are the reader's own rule — "an absent section
 * is not a dropped section" — so a topic that matches nothing reports zero entries rather than
 * claiming a section exists and hid itself.
 */
function decisionExcerpt(cwd, topic, limit) {
  const entries = markdownEntries(readFile(ledgerPath(cwd, 'decisions')));
  if (entries.length === 0) return { entries: undefined, body: undefined };
  if (topic === undefined || topic.trim().length === 0) {
    const shaped = shapeEntries(entries, limit);
    return { entries: entries.length, body: shaped.text, shown: shaped.full, indexed: shaped.indexed, beyond: shaped.beyond };
  }
  const hits = searchEntries([{ dir: ledgerDir(cwd, SCOPE.project), scope: SCOPE.project }], topic).filter(
    (hit) => hit.kind === 'decisions',
  );
  if (hits.length === 0) return { entries: 0, body: undefined };
  const shaped = shapeEntries(
    hits.map((hit) => hit.block),
    limit,
  );
  return { entries: hits.length, body: shaped.text, shown: shaped.full, indexed: shaped.indexed, beyond: shaped.beyond };
}

/**
 * The machine-wide ledger, compressed for the briefing.
 *
 * Two things belong in this scope and nowhere else: environment facts (a global
 * `project.json` — interpreter paths, shell traps, host quirks) and the pits that
 * are true of *this host* rather than of one repository. Each pit is shown with
 * its `trigger`, because for a machine-wide pit the trigger — not a filename — is
 * what decides when it arrives while you work.
 * @param limit - characters available for the section body.
 */
export function globalExcerpt(limit, topic, factRecency = new Map()) {
  const dir = globalDir();
  if (!fs.existsSync(dir)) return undefined;
  const project = readProject(undefined, SCOPE.global);
  const facts = [];
  if (project !== undefined) {
    for (const [key, value] of Object.entries(project)) {
      if (['version', 'createdAt', 'updatedAt'].includes(key)) continue;
      if (typeof value === 'string' && value.length > 0) facts.push(`- ${key}: ${value}`);
      else if (value !== null && typeof value === 'object' && Object.keys(value).length > 0)
        facts.push(`- ${key}: ${JSON.stringify(value)}`);
    }
  }
  const entries = markdownEntries(readFile(path.join(dir, FILES.mistakes)));
  const pits = entries.map((block) => ({
    block,
    heading: headingOf(block),
    avoid: fieldOf(block, 'do not repeat'),
    trigger: fieldOf(block, 'trigger'),
  }));
  /**
   * A topic search reads the machine ledger on demand — the half that did not exist.
   *
   * Measured 2026-10-03: this ledger held 77 pits, the briefing showed a handful, and
   * `code_brief({topic})` searched the project file only, so the scope holding most of
   * the rules was unreadable by any means. When a query arrives, the matching pits are
   * the only thing this section should spend room on.
   */
  const matches =
    typeof topic === 'string' && topic.trim().length > 0
      ? searchEntries([{ dir, scope: SCOPE.global }], topic)
          .filter((hit) => hit.kind === 'mistakes')
          .map((hit) => hit.block)
      : [];
  if (facts.length === 0 && pits.length === 0) return undefined;
  const cap = Number.isFinite(limit) && limit > 0 ? limit : SECTION_BUDGET.global[1];
  const header = `Ledger: ${dir}`;
  const projectFile = path.join(dir, FILES.project);
  const mistakesFile = path.join(dir, FILES.mistakes);
  const marker = (count, what, file) => `… (${count} ${what} dropped for length; read ${file})`;
  /**
   * Pits are what this section is *for*, so they are shaped and reserved before any fact is
   * rendered — `shapeEntries` always shows at least one entry, so the pit block can never be
   * empty while facts take its room. Measured 2026-10-02 on a real session: five `- key: value`
   * facts are ~600 characters, they consumed the whole allowance, and the briefing came out as
   * "`… (4 older machine-wide pit(s) dropped for length)`" with **zero** pits shown — the machine
   * layer was present and said nothing actionable. Facts are recoverable from one file; a pit
   * that never arrives is the failure this layer exists to prevent.
   */
  const factKey = (fact) => {
    const at = fact.indexOf(': ');
    return fact.slice(2, at === -1 ? undefined : at);
  };
  const rankedFacts = [...facts].sort(
    (a, b) => String(factRecency.get(factKey(b)) ?? '').localeCompare(String(factRecency.get(factKey(a)) ?? '')),
  );
  const keptBlocks = matches.length > 0 ? matches : pits.map((pit) => pit.block);
  /**
   * Shape the pits against what is actually left, rather than shaping them generously and
   * clipping the result — clipping is what broke this section, measured 2026-10-03: the
   * section came out over its allowance, the briefing's `clipTail` removed the *head* to
   * compensate, and that head held the section's own heading plus the newest fact. The pit
   * block is capped first and keeps at least one entry, so it can never be empty while facts
   * take its room (measured 2026-10-02: facts crowded out every pit and the machine layer
   * ended up saying nothing actionable).
   */
  const pitHeader =
    matches.length > 0
      ? `Pits matching "${topic}" (${matches.length}), by importance:`
      : 'Pits that are true of this machine, by importance:';
  const pitsBlock = `${pitHeader}\n${shapeEntries(keptBlocks, Math.max(24, Math.floor(cap / 3))).text}`;
  const factsBudget = Math.max(60, cap - header.length - 1 - pitsBlock.length - 2);
  /**
   * Two passes, by cursor: show what fits in full, then *name* what did not.
   *
   * The old loop `break`ed at the first fact that did not fit, which cost nothing visible
   * while every fact fit and everything once they did not — the reader got a count of
   * anonymous facts instead of their names. Measured 2026-10-03: 9 facts / 1,748 characters
   * against a 1,100-character ceiling, and the *longest* fact (the most valuable, a measured
   * environment finding) was the one dropped by size. Two passes make the second half of this
   * section's contract true: a fact that cannot be shown in full is still named, with its size,
   * so the reader knows it exists and what it costs.
   */
  const shownFacts = [];
  const namedFacts = [];
  let cursor = 0;
  let factsUsed = 0;
  for (; cursor < rankedFacts.length; cursor += 1) {
    const fact = rankedFacts[cursor];
    if (factsUsed + fact.length + 1 > factsBudget) break;
    shownFacts.push(fact);
    factsUsed += fact.length + 1;
  }
  let indexUsed = 0;
  for (; cursor < rankedFacts.length; cursor += 1) {
    const fact = rankedFacts[cursor];
    const line = `- ${factKey(fact)} (${fact.length - factKey(fact).length - 4} chars)`;
    if (indexUsed + line.length + 1 > factsBudget - factsUsed) break;
    namedFacts.push(line);
    indexUsed += line.length + 1;
  }
  const beyond = Math.max(0, rankedFacts.length - shownFacts.length - namedFacts.length);
  const factsBlock = [];
  if (shownFacts.length > 0) factsBlock.push('Facts:', ...shownFacts);
  if (namedFacts.length > 0) {
    // Deliberately terse: measured 2026-10-03, a 100-character header here is real budget on a
    // 1,100-character ceiling, and it cost a full fact line in the real ledger.
    factsBlock.push(`More facts (${namedFacts.length} not shown):`, ...namedFacts);
  }
  if (beyond > 0) factsBlock.push(marker(beyond, 'more fact(s), not even named', projectFile));
  /**
   * Facts ride on top of the shaped pits, but only when they still fit under `cap`.
   *
   * This restores the original composition exactly and adds one guard. Measured
   * 2026-10-04: `shapeEntries` deliberately returns one whole entry rather than a
   * fragment, so `pitsBlock` can exceed any `cap` smaller than one entry — and the facts
   * were then emitted on top of it, the final head-keeping `clip` cut from the front to
   * compensate, and the briefing came back with **no machine heading, no pit and no
   * fact**: the 80 machine-wide rules reached the reader as nothing, while
   * `omittedSections` stayed empty so nothing said so either. Pits first, then facts, is
   * the priority this section already documents — a fact is recoverable from one file, a
   * pit that never arrives is the failure the section exists to prevent.
   *
   * An earlier attempt at this dropped the whole facts block when it did not fit, which
   * took the *names* of the dropped facts with it and broke the "names those it cannot
   * show" guarantee (`guard-probe` B7) — so the block is kept intact whenever it fits at
   * all, rather than restructured.
   */
  /**
   * Pits first, facts second, and a fact that cannot be shown is still *named* — in recency
   * order, which is the order the ranking already produced.
   *
   * The old composition simply concatenated everything and let the final head-keeping
   * `clip` do the bounding. That kept the newest facts (they sit first) but destroyed
   * exactly the guarantee this section's two-pass fact rendering exists for: the named
   * lines for the older facts were the tail, so they were the first thing clipped away,
   * and a fact holding 643 characters of measured environment finding vanished with no
   * trace. Dropping *shows* rather than names is the failure this section already paid for
   * once.
   *
   * Measured 2026-10-04 while fixing this: a first attempt dropped the whole facts block
   * when it did not fit, which took the names with it and turned `guard-probe` B7 red
   * (45/45 -> 44/45) — the same mistake in the other direction. Hence: full lines if they
   * fit, otherwise the same facts reduced to recency-ordered index lines, otherwise the
   * pits alone. `guard-probe` B7 and `audit-verify-probe` B1/B2 pin all three.
   */
  const factsText = factsBlock.filter((line) => line !== undefined).join('\n');
  const indexText = rankedFacts.length === 0
    ? ''
    : [`More facts (${rankedFacts.length} not shown):`, ...rankedFacts.map((fact) => `- ${factKey(fact)} (${fact.length - factKey(fact).length - 4} chars)`)].join('\n');
  const fits = (middle) => header.length + 1 + (middle.length === 0 ? 0 : middle.length + 1) + pitsBlock.length <= cap;
  const middle = fits(factsText) ? factsText : fits(indexText) ? indexText : '';
  const text = [header, ...(middle.length === 0 ? [] : [middle]), pitsBlock].join('\n');
  // `clip` (head-keeping) is the correct last resort here, never `clipTail`: this section's
  // readers want its heading and its newest content, both of which sit at the head.
  return text.length <= cap ? text : clip(`${header}\n${pitsBlock}`, cap);
}

/**
 * Assemble the briefing. Every section is optional, so a fresh project yields a
 * short "start the ledger" answer rather than an error. The budgeted version
 * lives above next to SECTION_BUDGET; this older whole-text slice was replaced
 * because it evicted the mistakes and decisions sections (see SECTION_BUDGET).
 */

/** Count of real (non-claimed, passing) verifications in the current session, for the completion gate. */
export function verifyCount(cwd, sessionId) {
  try {
    const text = readJournalText(cwd, SCOPE.project);
    let n = 0;
    for (const line of text.split('\n')) {
      if (!line.includes('"verified"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.kind !== 'verified' || e.ok !== true || e.claimed === true) continue;
        if (sessionId === undefined || e.session === sessionId) n++;
      } catch {
        /* a torn last line is not a verification */
      }
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * Slice that never cuts a UTF-16 surrogate pair in half.
 *
 * `String.prototype.slice` counts UTF-16 units, so a limit landing between the two halves of
 * an astral character (an emoji, a rare CJK glyph) leaves a lone surrogate — a broken
 * character that then travels into the ledger, the briefing and the session log, where it is
 * quoted back. Measured 2026-10-04: `truncate('\u{1F600}'.repeat(50), 10)` produced
 * `'\u{1F600}\u{1F600}\uD83D'`. The adjustment is one code unit in either direction; when the
 * caller's limit cannot be met with whole characters, the slice keeps one fewer rather than
 * corrupting the character.
 * @param value - the string to cut.
 * @param from - first index, counted in UTF-16 units.
 * @param to - end index, exclusive, counted in UTF-16 units. May be negative.
 */
function wholeCharSlice(value, from, to) {
  const last = to < 0 ? value.length + to : to;
  const first = Math.max(0, from);
  // Snap both edges onto character boundaries. A start that would have to grow to keep its
  // character is moved BACK instead: dropping half a character silently is worse than
  // returning one fewer, because the result is read as if it were whole text.
  const start =
    first > 0 && value.charCodeAt(first) >= 0xdc00 && value.charCodeAt(first) <= 0xdfff && isHighSurrogate(value.charCodeAt(first - 1))
      ? first - 1
      : first;
  const end =
    last > 0 && last < value.length && isHighSurrogate(value.charCodeAt(last - 1)) && value.charCodeAt(last) >= 0xdc00
      ? last + 1
      : last;
  return value.slice(start, end);
}

/** UTF-16 high surrogate: the first half of an astral character. */
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

export function truncate(text, limit = CAP.resultChars) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  /**
   * How much of a clipped value stays in the head; the rest becomes the tail.
   *
   * Named because it is the same split `lib/budget.js` declares as `headChars`/`tailChars`
   * (12000/4000) for the *same* job — bounding a result — and the two were free to disagree
   * while neither could see the other. One owner is the real fix; a name is what makes the
   * disagreement visible.
   */
  const CLIP_HEAD_SHARE = 0.6;
  const head = Math.floor(limit * CLIP_HEAD_SHARE);
  return `${wholeCharSlice(s, 0, head)}\n… (${s.length - limit} chars omitted) …\n${wholeCharSlice(s, s.length - (limit - head), s.length)}`;
}

/**
 * Exit marker the native shell tools append to a failed result. A successful
 * foreground command carries no marker at all, so its absence means exit 0.
 */
const EXIT_MARKER = /\[exit code: (-?\d+)\]/i;

/**
 * Normalize one native shell tool result into verification evidence. The shell
 * tool reports a nonzero exit in its text and a failed call as `isError`, so
 * both are read here rather than trusting either alone.
 * @param content - the shell tool's content blocks.
 * @param isError - whether the shell tool reported a failed call.
 */
export function shellResult(content, isError) {
  const text = (Array.isArray(content) ? content : [])
    .map((block) => (block?.type === 'text' ? block.text : ''))
    .join('\n')
    .trim();
  const marker = EXIT_MARKER.exec(text);
  const exitCode = marker === null ? (isError ? 1 : 0) : Number(marker[1]);
  return {
    ok: !isError && exitCode === 0,
    exitCode,
    output: truncate(text),
  };
}

/**
 * Whether an observed output satisfies a stated expectation. A plain string is a
 * substring test; `re:<pattern>` is a regular expression, so an exit-code-shaped
 * claim and an output-shaped claim are both expressible.
 * @param output - combined stdout and stderr.
 * @param expect - the stated expectation, or undefined to mean "exit code 0".
 */
export function matchesExpectation(output, expect) {
  if (expect === undefined || expect.trim().length === 0) return true;
  const needle = expect.trim();
  if (needle.startsWith('re:')) {
    // Bounded for the same reason as the trigger search above: this expectation is written by
    // the caller at call time, so it never passes the write side's checks. `m` is kept —
    // `code_verify(expect: 're:^ok$')` is documented against a multi-line output — and it is
    // passed through rather than dropped by the bounded matcher.
    //
    // The fallback is the *unbounded* pattern, not a substring of it: this function promises
    // "the regex decides, or if the regex will not compile, the literal does" (probe P5d),
    // so a pattern that does not compile falls back to a literal test, and a bounded run that
    // could not reach a verdict counts as "no match" and nothing else.
    const bounded = testPatternSync(needle.slice(3), String(output ?? ''), 'm');
    if (bounded.source === 'bad-pattern') return output.includes(needle.slice(3));
    return bounded.matched === true;
  }
  return output.includes(needle);
}
