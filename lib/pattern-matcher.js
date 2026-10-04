/**
 * Regex matching with a hard time bound, for patterns the ledger did not write.
 *
 * A recorded `trigger:` is a regular expression from the ledger, and it used to be run
 * verbatim, synchronously, inside `tools/pre-execute` — twice per command. Measured
 * 2026-10-04 by the gate/budget audit: a nested-quantifier pattern took 10 / 39 / 151 / 565 /
 * 2385 ms as the subject grew 17 → 29 characters (≈×4 per character), i.e. exponential, and
 * the `code_brief({topic})` path never returned at 34 characters.
 *
 * JavaScript has no regex timeout, so the bound comes from a worker: the match runs in a
 * thread this module can terminate. Two properties matter and both are deliberate:
 *
 *   - **The worker is reused.** Spawning one per command would cost tens of milliseconds on
 *     a hot path; one worker answers many matches, and is only created when there is a
 *     pattern to test at all. The timer still starts only while a match is in flight.
 *   - **The worker's `vm` context has no `require`, no `process`, no `import`** — a
 *     `trigger:` is data from a ledger file, so it must not gain the ability to execute
 *     anything beyond the regex engine.
 *
 * A timeout is reported as **no match**, never as a crash and never as a hang: a pit that
 * cannot be evaluated in time is a pit that does not block the command (the alternative —
 * holding a turn while an expression backtracks — is the failure this exists to prevent).
 * The caller is told, because a silently dropped pit is the failure mode the ledger is built
 * to avoid.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

/** Longer than any legitimate match on a command line, short enough not to be felt. */
const MATCH_TIMEOUT_MS = 250;

/** Budget for one synchronous in-process test, before the pattern is called expensive. */
const INLINE_BUDGET_MS = 40;

/** How long the synchronous child gets for one match when the channel permits one at all. */
const SYNC_CHILD_DEADLINE_MS = 1500;

/** The worker body: compile one pattern, test one subject, reply, stay alive. */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (job) => {
  try {
    // RegExp construction, NOT a parsed expression. The first version wrapped the pattern in
    // parentheses and evaluated it as code inside a vm context, which broke three ways at
    // once: a pattern like 'a+b' compiled as the expression 'a + b' and threw "a is not
    // defined", an anchored pattern like '^ (a+)+$' was a hard SyntaxError ("Unexpected
    // token '^'"), and the vm context had no RegExp in scope at all. The worker thread is
    // the isolation this needs; no vm required.
    const re = new RegExp(job.pattern, job.flags || 'i');
    parentPort.postMessage({ id: job.id, matched: re.test(job.subject) === true });
  } catch (error) {
    parentPort.postMessage({ id: job.id, error: String(error && error.message ? error.message : error) });
  }
});
`;

let nextId = 1;

/**
 * One worker **per pattern**, because the shared-worker version starved the guard.
 *
 * The first version ran every pattern through a single worker, which answers jobs in order. A
 * pathological pattern queued ahead of an ordinary one therefore held the queue for as long as
 * it ran, and everything behind it was reported as a timeout it had not caused. Traced
 * 2026-10-04: the first eight jobs (`(a+)+$` first, then a harmless `pnpm\s+test`) never
 * answered, and a normal, previously-working trigger was then classified as expensive — the
 * guard silently stopped firing while still looking alive, which is the failure this whole
 * module exists to prevent.
 *
 * Per-pattern isolation makes that impossible by construction: a runaway pattern can only ever
 * starve itself. The cost is one thread per distinct pattern that has been tested, so the pool
 * is capped and the cap evicts the least recently created worker.
 */
const WORKER_POOL_LIMIT = 6;
const workers = new Map(); // pattern -> { worker, pending: Map<id, entry> }

/**
 * Patterns proven **cheap** by a completed match, and the subjects they were proven on.
 *
 * Cheapness is a property of the pair, not of the pattern alone: `a+b` on a 40-character
 * command line costs nothing and on a 100 KB one costs real time. So the verdict is recorded
 * as `(pattern, flags, subject)`, and the synchronous path also refuses any subject longer than
 * {@link SYNC_MAX_SUBJECT} — a subject that big is the one case where "we measured it once"
 * stops being an argument.
 */
const PROVEN_CHEAP = new Map();
const PROVEN_CHEAP_LIMIT = 256;
const SYNC_MAX_SUBJECT = 4096;

function rememberCheap(pattern, subject, flags = 'i') {
  if (subject.length > SYNC_MAX_SUBJECT) return;
  // The key must be built exactly as {@link testPatternSync} builds it. It was not, once: the
  // two used the same format string but this one omitted `flags`, so every verdict lookup
  // missed and the synchronous path never once answered from a proven pair — the probe caught
  // it (`P3a`, `P6c`) rather than a human.
  const key = verdictKey(pattern, flags, subject);
  if (PROVEN_CHEAP.has(key)) return;
  if (PROVEN_CHEAP.size >= PROVEN_CHEAP_LIMIT) PROVEN_CHEAP.delete(PROVEN_CHEAP.keys().next().value);
  PROVEN_CHEAP.set(key, true);
}

/** One format for "this pattern+flags+subject was tested and answered" — never two. */
function verdictKey(pattern, flags, subject) {
  return [pattern, flags, subject].join('\u0000');
}

/** The child body: compile one pattern, test one subject, exit. Bounded by the parent. */
const SYNC_CHILD_SOURCE = `
const [pattern, flags, subject] = process.argv.slice(1);
try {
  process.stdout.write(new RegExp(pattern, flags).test(subject) ? 'match' : 'nomatch');
} catch (error) {
  process.stdout.write(\`bad:\${error && error.message ? error.message : error}\`);
}
`;

/** Drop a pattern's worker and settle anything still waiting on it. */
function retireWorker(pattern, reason) {
  const slot = workers.get(pattern);
  if (slot === undefined) return;
  workers.delete(pattern);
  slot.worker.terminate?.().catch(() => {});
  for (const [, entry] of slot.pending) {
    clearTimeout(entry.timer);
    entry.resolve({ matched: false, timedOut: true, error: reason });
  }
  slot.pending.clear();
}

/** The worker for one pattern, created on demand; each caps out per-pattern concurrency. */
function workerFor(pattern) {
  const existing = workers.get(pattern);
  if (existing !== undefined) return existing;
  const slot = { worker: undefined, pending: new Map() };
  const worker = new Worker(WORKER_SOURCE, { eval: true });
  slot.worker = worker;
  worker.on('message', (message) => {
    const entry = slot.pending.get(message.id);
    if (entry === undefined) return; // timed out and settled already
    slot.pending.delete(message.id);
    clearTimeout(entry.timer);
    // The match finished inside the deadline: this exact pair is now known to be cheap, which
    // is what lets {@link testPatternSync} answer it inline.
    if (message.error === undefined && entry.subject !== undefined) {
      rememberCheap(entry.pattern, entry.subject, entry.flags);
    }
    entry.resolve(message);
  });
  // A worker that dies takes its in-flight matches with it; they are reported as
  // "did not match" like a timeout, and the next call starts a fresh worker.
  worker.on('error', () => retireWorker(pattern, 'regex worker failed'));
  worker.unref?.();
  workers.set(pattern, slot);
  // Bounded pool: retire the least recently created pattern rather than grow without limit.
  while (workers.size > WORKER_POOL_LIMIT) {
    retireWorker(workers.keys().next().value, 'worker pool full');
  }
  return slot;
}

/**
 * Test one pattern against one subject, giving up after {@link MATCH_TIMEOUT_MS}.
 * @returns `{ matched, timedOut, error }` — `matched` is false whenever the answer is unknown.
 */
export function testPattern(pattern, subject, flags = 'i') {
  return new Promise((resolve) => {
    let slot;
    try {
      slot = workerFor(pattern);
    } catch (error) {
      resolve({ matched: false, timedOut: false, error: `no worker: ${error?.message ?? error}` });
      return;
    }
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => {
      slot.pending.delete(id);
      // The worker is stuck inside this match; it cannot be interrupted, so its whole worker is
      // discarded. One leaked thread is a bounded price for not hanging the turn — and because
      // the worker belongs to this pattern alone, no other pattern pays for it.
      retireWorker(pattern, 'match exceeded the deadline');
      resolve({ matched: false, timedOut: true });
    }, MATCH_TIMEOUT_MS);
    slot.pending.set(id, { resolve, timer, pattern, subject, flags });
    try {
      slot.worker.postMessage({ id, pattern, flags, subject });
    } catch (error) {
      clearTimeout(timer);
      slot.pending.delete(id);
      resolve({ matched: false, timedOut: false, error: `post failed: ${error?.message ?? error}` });
    }
  });
}

/**
 * Test one pattern against one subject **synchronously**, with a hard bound.
 *
 * Exists for the callers that cannot become async: `ledger.js`'s `searchEntries` and
 * `matchesExpectation` are reached from synchronous read paths, and the audit's own
 * reproduction measured that exact path at **21,432 ms for a 26-character topic**
 * (2026-10-04, `(a+)+$` recorded as a `trigger:`). Turning those two into async would mean
 * touching `brief()` and the fifteen probe files that call it synchronously.
 *
 * The bound is layered, and each layer was measured against this host rather than assumed:
 *
 *   1. A pair a completed worker match has already proven cheap runs inline, and the inline
 *      run is itself timed — a pair that used to be cheap and is not any more falls through
 *      and loses its verdict.
 *   2. A pair with no verdict is **pre-warmed** (one worker job, whose answer arrives on the
 *      next event-loop turn) and answered `false` now. This is the layer that matters here:
 *      the worker is the only spawn the host channels actually grant — measured 2026-10-04,
 *      `spawnSync`/`execFileSync` of a child that pipes its stdout fails with **EPERM** in
 *      both the `code_verify` and the `pwsh` channel — so nothing may *depend* on a child.
 *   3. The child process is kept as a best-effort third layer for the environment where it is
 *      permitted (a normal terminal), with a short deadline so a refusal costs ~1 ms. If it
 *      is refused, that costs correctness, never the turn.
 *
 * An unknown pair therefore answers **false on its first encounter**. That is a real cost and
 * it is taken deliberately: one caller is relevance ranking, where `searchEntries` has already
 * established the entry is relevant by substring and the missed upgrade is a stronger ranking;
 * the other is `matchesExpectation`, which requires a verdict and fails closed. In both, "no
 * match" is a far smaller failure than "the turn never returns".
 *
 * @returns `{ matched, timedOut, error, source }` — `matched` is false whenever the answer is unknown.
 */
export function testPatternSync(pattern, subject, flags = 'i') {
  const key = verdictKey(pattern, flags, subject);
  // Compiling inline is what makes a broken pattern a *decision* rather than a guess: the old
  // `try { new RegExp(...) } catch { substring }` contract in `matchesExpectation` (probe P5d)
  // depends on knowing the pattern does not compile, and a worker cannot say that
  // synchronously. Construction is only dangerous to *run*, never to build.
  try {
    new RegExp(pattern, flags);
  } catch (error) {
    return { matched: false, timedOut: false, error: String(error?.message ?? error), source: 'bad-pattern' };
  }
  if (PROVEN_CHEAP.has(key)) {
    const started = Date.now();
    try {
      const matched = new RegExp(pattern, flags).test(subject) === true;
      if (Date.now() - started <= INLINE_BUDGET_MS) return { matched, timedOut: false, source: 'inline' };
      PROVEN_CHEAP.delete(key);
    } catch (error) {
      return { matched: false, timedOut: false, error: String(error?.message ?? error), source: 'inline' };
    }
  }
  // The child is attempted only on a subject small enough that its cost is bounded anyway, so
  // a refused spawn (the normal case in a sandboxed channel) costs a millisecond and nothing
  // else, and a permitted one can still answer correctly.
  if (subject.length <= SYNC_MAX_SUBJECT) {
    try {
      const out = execFileSync(process.execPath, ['-e', SYNC_CHILD_SOURCE, pattern, flags, subject], {
        encoding: 'utf8',
        timeout: SYNC_CHILD_DEADLINE_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim();
      if (out === 'match' || out === 'nomatch') {
        rememberCheap(pattern, subject, flags);
        return { matched: out === 'match', timedOut: false, source: 'child' };
      }
      // A pattern that does not compile, or any other child-side answer: a ledger mistake,
      // never a crash and never a hang.
      return { matched: false, timedOut: false, error: out.slice(0, 200), source: 'child' };
    } catch (error) {
      const denied = error?.code === 'EPERM' || error?.code === 'EACCES';
      if (!denied) {
        // A real timeout, or a child that died: this pattern is not trustworthy inline.
        return { matched: false, timedOut: true, error: String(error?.message ?? error).slice(0, 200), source: 'child' };
      }
    }
  }
  // No verdict available. Ask for one on this pattern's own worker — the answer lands on a
  // later turn, which is why this caller gets "no match" now — and fail closed rather than
  // gamble on a pattern nobody has ever timed. Because the worker belongs to this pattern, a
  // pathological one queued here cannot delay any other pattern's verdict.
  testPattern(pattern, subject, flags).catch(() => {});
  return { matched: false, timedOut: false, error: 'no verdict yet: pre-warmed', source: 'prewarm' };
}

/** Where this module lives, for callers that log it. */
export const MODULE_PATH = path.join('lib', 'pattern-matcher.js');
