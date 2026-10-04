/**
 * Drive `lib/pit-guard.js`'s real `tools/pre-execute` handler and ask two questions the
 * ledger's own statistics could not answer:
 *
 *   1. Does the `files:` side write the `file_hit` event it documents
 *      (`lib/pit-guard.js:334-343` says the record is written "in the same pass as the
 *      notice, so the two can never disagree")?
 *   2. Does the restart note fire for an edit to a `lib/*.js` file of this package
 *      (`:317-333`)? The audit of 2026-10-04 claims `target` is normalised
 *      (lowercased, `/`) while `root` and `path.sep` are not, so the test can never pass
 *      on Windows.
 *
 * Why this probe exists: the real journal holds 16 `trigger_hit` events and **zero**
 * `file_hit`, across 528 KB of rotated segment and the live file — measured 2026-10-04 —
 * while notices for file-keyed pits demonstrably fired in that same session. A statistic
 * that is written but never appears is a silent failure of exactly the kind this mode is
 * built to prevent, and the project's own probe (`pit-guard-probe.mjs`) does not ask.
 *
 * Plain node with the two host imports stubbed, the way `handover-grant-probe.mjs` does
 * it; it needs no Electron, so it runs in a confined channel.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-pitfire-${tag}-`));
process.env.DSH_CODE_GLOBAL_DIR = scratch('machine');

/** Chainable stand-in for schemastery, as `handover-grant-probe.mjs` uses. */
function chainable(keys = undefined) {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'shape' && keys !== undefined) return keys;
      return () => chainable(keys);
    },
  });
}
const schemastery = { object: (shape) => chainable(shape), boolean: () => chainable(), number: () => chainable(), string: () => chainable(), array: () => chainable(), optional: () => chainable() };
const createUserMessage = ({ content, source }) => ({ role: 'user', content, source });
globalThis.__stubs = { schemastery, createUserMessage };
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: `stub:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'stub:@deepseek-ai/schemastery') return { format: 'module', shortCircuit: true, source: 'export default globalThis.__stubs.schemastery;' };
    if (url === 'stub:@deepseek-ai/dsh-llm') return { format: 'module', shortCircuit: true, source: 'export const createUserMessage = globalThis.__stubs.createUserMessage;' };
    return nextLoad(url, context);
  },
});

const guard = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'pit-guard.js')).href);
const ledger = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'ledger.js')).href);

const results = [];
const check = (id, name, ok, evidence) => results.push({ id, name, ok: ok === true, evidence });

const SESSION = 'pitfire-session';
/** A fake ctx that records handlers, like the other plain-node probes. */
function fakeCtx() {
  const handlers = new Map();
  const ctx = {
    logger: { warn() {}, info() {}, debug() {} },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    get: () => undefined,
    handlers,
  };
  return ctx;
}

/** Fire one tool call through the real registered handler. */
async function preExecute(ctx, exec) {
  let value;
  let threw = null;
  const chain = async () => {
    value = 'end';
    return 'end';
  };
  const handler = (ctx.handlers.get('tools/pre-execute') ?? [])[0];
  if (handler === undefined) throw new Error('pit-guard registered no tools/pre-execute handler');
  try {
    await handler(exec, chain);
  } catch (error) {
    threw = `${error?.name}: ${error?.message}`;
  }
  return { value, threw };
}

// --- A: an edit to files this package is made of -------------------------------
{
  const root = scratch('proj');
  ledger.initLedger(root, SESSION);
  // A pit keyed on this package's own ledger.js, so the file side has something to match.
  ledger.recordMistake(
    root,
    { symptom: 'PITFIRE a recorded pit that names a lib file', cause: 'c', fix: 'f', files: 'lib/ledger.js:1', avoid: 'a rule long enough to be accepted' },
    SESSION,
  );
  const ctx = fakeCtx();
  guard.apply(ctx, undefined);
  const target = path.join(PKG_DIR, 'lib', 'ledger.js');
  const fired = await preExecute(ctx, {
    name: 'edit',
    agent: { session: { id: SESSION, header: { cwd: root } } },
    arguments: { file_path: target },
  });
  const journal = path.join(root, '.dsh-code', 'journal.jsonl');
  const text = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8') : '';
  check(
    'A1',
    'an edit whose target matches a recorded `files:` token writes a file_hit event',
    /"kind":"file_hit"/.test(text),
    { target, threw: fired.threw, fileHits: (text.match(/"kind":"file_hit"/g) ?? []).length, journalChars: text.length },
  );
  check(
    'A2',
    'editing a lib/*.js of this package records restart_pending',
    /"kind":"restart_pending"/.test(text),
    {
      target,
      packageRoot: PKG_DIR,
      // The audit's claim, shown as data: what `target` looks like vs what the test compares.
      targetAsNormalised: String(target).replace(/\\/g, '/').toLowerCase(),
      comparedAgainst: `${PKG_DIR}${path.sep}`,
      wouldMatch: String(target).replace(/\\/g, '/').toLowerCase().startsWith(`${PKG_DIR}${path.sep}`),
      restartEvents: (text.match(/"kind":"restart_pending"/g) ?? []).length,
    },
  );
}

for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.id} ${r.name}${r.ok ? '' : `\n       <- ${JSON.stringify(r.evidence).slice(0, 700)}`}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed, failed=[${failed.map((r) => r.id).join(', ')}]`);
process.exit(failed.length === 0 ? 0 : 1);
