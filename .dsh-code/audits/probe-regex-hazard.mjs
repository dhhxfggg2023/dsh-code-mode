/**
 * AUDIT PROBE F — a recorded `trigger:` regex is run against the command line with
 * no timeout, no length cap, and no complexity check.
 *
 * `lib/pit-guard.js:212-219` compiles the ledger's `trigger:` verbatim and tests it
 * against the raw command and its whitespace-collapsed form, synchronously, inside
 * `tools/pre-execute` — before the command is allowed to run. `code_record` compiles
 * the pattern at write time (so a malformed one is refused) but nothing measures what
 * it costs to run: `matchesTrigger`'s own `try/catch` cannot fire, because catastrophic
 * backtracking is not an exception, it is a hang.
 *
 * This probe mounts the REAL `tools/pre-execute` handler of `lib/pit-guard.js` against
 * a scratch project whose mistakes.md carries one recorded pit, and times the match at
 * two input sizes. Bounded sizes keep the measurement finite; the growth is the finding.
 *
 * Run: node .dsh-code/audits/probe-regex-hazard.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-audit-regex-${tag}-`));
process.env.DSH_CODE_GLOBAL_DIR = scratch('machine');

function chainable(keys = undefined) {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'shape' && keys !== undefined) return keys;
      return () => chainable(keys);
    },
  });
}
globalThis.__stubs = {
  schemastery: { object: (shape) => chainable(shape), boolean: () => chainable(), number: () => chainable(), string: () => chainable(), array: () => chainable(), optional: () => chainable() },
  createUserMessage: ({ content, source }) => ({ role: 'user', content, source }),
};
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

const SESSION = 'audit-regex-session';
/** One hand-written pit whose `trigger:` is a classic catastrophic pattern. */
const TRIGGER = '^(a+)+$';

function projectWith(trigger) {
  const root = scratch('proj');
  ledger.initLedger(root, SESSION);
  const mistakes = path.join(root, '.dsh-code', 'mistakes.md');
  fs.writeFileSync(
    mistakes,
    `# mistakes\n\n## audit pit with an expensive trigger\n- symptom: the command that matched this pattern never returned\n- cause: a ` +
      'nested quantifier in `trigger:`\n- fix: n/a\n- do not repeat: keep recorded triggers linear\n' +
      `- trigger: ${trigger}\n`,
    'utf8',
  );
  return root;
}

function fakeCtx() {
  const handlers = new Map();
  return {
    handlers,
    logger: { warn() {}, info() {}, debug() {} },
    get: () => undefined,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
  };
}

/** One `tools/pre-execute` call through the real handler; returns elapsed ms. */
async function timeCommand(ctx, root, command) {
  const handler = (ctx.handlers.get('tools/pre-execute') ?? [])[0];
  const exec = { name: 'pwsh', agent: { session: { id: SESSION, header: { cwd: root } } }, arguments: { cmd: command } };
  const started = process.hrtime.bigint();
  await handler(exec, async () => 'end');
  return Number(process.hrtime.bigint() - started) / 1e6;
}

const rows = [];
for (const words of [16, 22, 24, 26, 28]) {
  // `aaa…a!` — `^(a+)+$` fails, and every partition of the run is explored.
  const command = `${'a'.repeat(words)}!`;
  const root = projectWith(TRIGGER);
  const ctx = fakeCtx();
  guard.apply(ctx, undefined);
  const ms = await timeCommand(ctx, root, command);
  rows.push({ chars: command.length, ms: Math.round(ms * 10) / 10 });
  console.log(`chars=${command.length} elapsed=${Math.round(ms)}ms`);
  if (ms > 30000) {
    console.log('stopping: already past 30s at this size');
    break;
  }
}

// Control: the same wiring with no `trigger:` pit in the ledger.
{
  const root = projectWith('a-linear-pattern-that-matches-nothing');
  const ctx = fakeCtx();
  guard.apply(ctx, undefined);
  const ms = await timeCommand(ctx, root, `${'a '.repeat(26)}!`);
  console.log(`control (linear trigger, 26 words) elapsed=${Math.round(ms)}ms`);
}

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe-regex-hazard.out.json');
fs.writeFileSync(OUT, `${JSON.stringify({ trigger: TRIGGER, rows }, null, 2)}\n`, 'utf8');
console.log(`report: ${OUT}`);
