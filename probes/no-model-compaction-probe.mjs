/**
 * The ban: no path in the coding mode may hand a large span of context to a model to be compressed
 * in one shot.
 *
 * The user's instruction (2026-10-10): 「编程模式需要把所有能将大量上下文拿去一下子压缩的禁止了，因为
 * 我已经打算用转接文档代替了」. The handover document replaces that role, so the file that owns
 * `summarize()` — `lib/compact-summary.js` — must be able to answer a reset **without a model**, in
 * every state of the ledger.
 *
 * Why a probe and not a reading of the code: the ban's whole content is a *call that does not
 * happen*. A `super.summarize(...)` that is still reachable looks identical, in every log this
 * project keeps, to one that is not — the difference only shows up when a reset fires in a project
 * whose ledger is empty, which is exactly the case nobody exercises by hand. So the stub engine
 * below counts the calls, and each check asserts the count as well as the text.
 *
 * Three entry points reach `summarize()` — `/compact` (`compactNow`), the gate's line, and the
 * danger-band `compactIfNeeded` — and they all arrive here, which is why one ban covers all three.
 *
 * Plain node with the host imports stubbed, so it runs in a confined channel.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = [];
const scratch = (tag) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-nomodel-${tag}-`));
  fixtures.push(dir);
  return dir;
};
process.env.DSH_CODE_GLOBAL_DIR = scratch('machine');
// The ban's own switch must be absent for the run that tests the ban.
delete process.env.DSH_CODE_MODEL_COMPACTION;

function chainable(keys = undefined) {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'shape' && keys !== undefined) return keys;
      return () => chainable(keys);
    },
  });
}
const schemastery = {
  object: (shape) => chainable(shape),
  boolean: () => chainable(),
  number: () => chainable(),
  string: () => chainable(),
  array: () => chainable(),
  optional: () => chainable(),
};
const createUserMessage = ({ content, source }) => ({ role: 'user', content, source });
/** How many times the engine's own summarizer was reached. The whole point of this probe. */
globalThis.__stubs = { schemastery, createUserMessage, modelCalls: 0 };
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: `stub:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'stub:@deepseek-ai/schemastery') {
      return { format: 'module', shortCircuit: true, source: 'export default globalThis.__stubs.schemastery;' };
    }
    if (url === 'stub:@deepseek-ai/dsh-llm') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const createUserMessage = globalThis.__stubs.createUserMessage;',
      };
    }
    /**
     * The engine, reduced to the three things this file uses: the schema it re-exports, the
     * constructor it overrides, and the `summarize()` it must not reach by default.
     */
    if (url === 'stub:@deepseek-ai/dsh-compaction-basic') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
export class BasicCompactionEngine {
  static inject = [];
  static Config = globalThis.__stubs.schemastery.object({});
  constructor(ctx, config = {}) { this.ctx = ctx; this.config = config; }
  async summarize() {
    globalThis.__stubs.modelCalls += 1;
    return { summary: [{ type: 'text', text: 'MODEL-WRITTEN-SUMMARY-WAS-CALLED' }] };
  }
  async compactNow() {}
  async compactIfNeeded() {}
}
export default BasicCompactionEngine;
`,
      };
    }
    return nextLoad(url, context);
  },
});

const ledger = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'ledger.js')).href);
const summaryUrl = pathToFileURL(path.join(PKG_DIR, 'lib', 'compact-summary.js')).href;
const summary = await import(summaryUrl);

const SESSION = 'nomodel-session';
const results = [];
const check = (id, name, ok, evidence) => results.push({ id, name, ok: ok === true, evidence });
const agentFor = (cwd) => ({ session: { id: SESSION, header: { cwd } } });
const textOf = (value) => (Array.isArray(value?.summary) ? value.summary.map((block) => block.text ?? '').join('\n') : '');
const modelCalls = () => globalThis.__stubs.modelCalls;

// --- A: the ban is about the *model-written summary*, not about `auto` -----------------
//
// Rewritten 2026-10-11. Until then this block pinned `auto: false` too, because the two
// instructions arrived together: the user wanted no model-written summary, and (the same day) no
// automatic compaction at all. On 2026-10-11 the second one was withdrawn — 「自动压缩本来就有，
// 只不过之前我关了，这条路我觉得不对」 — while the first one stands. So the constructor no longer
// touches `auto`, and this block must pin the two things separately, because a single check that
// asserted both would now have to be deleted and would take the surviving ban with it.
//
// `A1` is the surviving ban's scope: `auto` is configuration's, so the class passes it through
// unchanged. `A2` is the part that actually matters and did not change: whatever `auto` says, the
// engine's own summarizer is not reachable except through the break-glass (that is `D1`/`D2`).
{
  const untouched = new summary.HandoverCompactionEngine({}, {});
  const passedThrough = new summary.HandoverCompactionEngine({}, { auto: true });
  const passedThroughOff = new summary.HandoverCompactionEngine({}, { auto: false });
  check(
    'A1',
    'the constructor no longer overrides `auto` — the preset decides, in both directions',
    untouched.config.auto === undefined &&
      passedThrough.config.auto === true &&
      passedThroughOff.config.auto === false,
    {
      withoutConfig: untouched.config.auto ?? null,
      withAutoTrue: passedThrough.config.auto,
      withAutoFalse: passedThroughOff.config.auto,
    },
  );
}

// --- B: a ledger with something to say is the checkpoint, and no model is called ----
{
  const root = scratch('ledger');
  ledger.initLedger(root, SESSION);
  ledger.recordTask(root, { title: 'NOMODEL the work in flight', status: 'active' }, SESSION);
  const before = modelCalls();
  const value = await new summary.HandoverCompactionEngine({}, {}).summarize('HISTORY', agentFor(root), undefined);
  const text = textOf(value);
  check(
    'B1',
    'with a ledger, the checkpoint is the ledger handover and the engine summarizer is never called',
    text.includes('NOMODEL the work in flight') && text.includes('derived from files on disk') && modelCalls() === before,
    { modelCalls: modelCalls() - before, chars: text.length },
  );
  check(
    'B2',
    'the checkpoint tells the continuing model that the middle is gone, not summarised',
    text.includes('gone, not summarised') && text.includes('code_brief'),
    { head: text.slice(0, 160) },
  );
}

// --- C: an empty or absent ledger still costs no model call ------------------------
{
  const absent = scratch('absent');
  const initialized = scratch('initialized');
  ledger.initLedger(initialized, SESSION);
  const before = modelCalls();
  const noLedger = textOf(await new summary.HandoverCompactionEngine({}, {}).summarize('HISTORY', agentFor(absent), undefined));
  const emptyLedger = textOf(await new summary.HandoverCompactionEngine({}, {}).summarize('HISTORY', agentFor(initialized), undefined));
  check(
    'C1',
    'a project with NO ledger gets a checkpoint that says so, and no model call',
    noLedger.includes('not allowed to write one with a model') && noLedger.includes('nothing replaced it') && modelCalls() === before,
    { modelCalls: modelCalls() - before, head: noLedger.slice(0, 200) },
  );
  check(
    'C2',
    'an INITIALIZED but empty ledger is the same case — the realistic new-project path',
    emptyLedger.includes('not allowed to write one with a model') && modelCalls() === before,
    { modelCalls: modelCalls() - before },
  );
  check(
    'C3',
    'the empty-ledger checkpoint names the directory it read, so the fix is unambiguous',
    noLedger.includes(absent),
    { looksFor: absent, tail: noLedger.split('\n').filter((line) => line.includes('ledger was read')).join('') },
  );
  check(
    'C4',
    'the empty-ledger checkpoint tells the session how to make the next one free',
    noLedger.includes('code_record(kind="project"') && noLedger.includes('code_brief'),
    { tail: noLedger.split('\n').slice(-3).join(' ~ ') },
  );
  check(
    'C5',
    'the engine\u2019s own summarizer text appears nowhere in what the session is handed',
    !noLedger.includes('MODEL-WRITTEN-SUMMARY-WAS-CALLED') && !emptyLedger.includes('MODEL-WRITTEN-SUMMARY-WAS-CALLED'),
    { marker: 'MODEL-WRITTEN-SUMMARY-WAS-CALLED' },
  );
}

// --- D: the break-glass is what the ban is made of, not a comment -------------------
{
  process.env.DSH_CODE_MODEL_COMPACTION = 'allow';
  // A distinct URL, so the module-level read of the switch happens again rather than being
  // served from the ESM cache — the same reason `DSH_CODE_BOOT` exists for the boot stamp.
  const allowed = await import(`${summaryUrl}?allow=1`);
  const absent = scratch('absent-allowed');
  const before = modelCalls();
  const value = await new allowed.HandoverCompactionEngine({}, {}).summarize('HISTORY', agentFor(absent), undefined);
  delete process.env.DSH_CODE_MODEL_COMPACTION;
  check(
    'D1',
    'with the break-glass set, the engine summarizer IS reached — the ban is a switch with a default',
    textOf(value).includes('MODEL-WRITTEN-SUMMARY-WAS-CALLED') && modelCalls() === before + 1,
    { modelCalls: modelCalls() - before, switch: 'DSH_CODE_MODEL_COMPACTION=allow' },
  );
  check(
    'D2',
    'and the default module is unaffected by that import',
    textOf(await new summary.HandoverCompactionEngine({}, {}).summarize('HISTORY', agentFor(absent), undefined)).includes(
      'not allowed to write one with a model',
    ),
    { note: 'the ban must not be liftable by a stale import' },
  );
}

// --- Report -----------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
for (const result of results) {
  process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} ${result.id} ${result.name}\n`);
  if (!result.ok) process.stdout.write(`     ${JSON.stringify(result.evidence)}\n`);
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed, ${failed.length} failed\n`);
process.stdout.write(`model summarizer calls in the whole run: ${modelCalls()} (expected 1 — only the break-glass case)\n`);
for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
