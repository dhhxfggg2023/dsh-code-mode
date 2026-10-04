/**
 * AUDIT PROBE G — `lib/budget.js`, both halves, through the real handlers.
 *
 * The host consumes `tools/pre-execute` as
 *   `const gate = await ctx.waterfall(carrier, "tools/pre-execute", exec, () => ({kind:"allow"}))`
 * and then reads `decision.kind` / `decision.reason` / `decision.info`
 * (`dsh-tools/lib/index.js:3225-3242`), and `tools/post-execute` as an accept decision
 * whose `content` may be replaced (`:3504-3531`). This drives the real handlers and
 * checks the shapes against those two consumers.
 *
 * Run: node .dsh-code/audits/probe-budget-shapes.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

const budget = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'budget.js')).href);

const results = [];
const check = (id, name, ok, evidence) => results.push({ id, name, ok: ok === true, evidence });
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-budget-'));

const CONFIG = { enabled: true, readTools: ['read'], maxReadBytes: 1000, maxResultChars: 500, headChars: 300, tailChars: 100 };

function mount(config = CONFIG) {
  const handlers = new Map();
  const ctx = {
    handlers,
    logger: { warn() {}, info() {} },
    get: () => undefined,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
  };
  budget.apply(ctx, config);
  return ctx;
}

/** Run one pre-execute through the real handler; next() is the host's `{kind:'allow'}`. */
async function pre(ctx, exec) {
  const handler = (ctx.handlers.get('tools/pre-execute') ?? [])[0];
  return handler(exec, async () => ({ kind: 'allow' }));
}

/** Run one post-execute through the real handler; the tail of the chain is `{kind:'accept', content}`. */
async function post(ctx, exec, result, downstream = { kind: 'accept' }) {
  const handler = (ctx.handlers.get('tools/post-execute') ?? [])[0];
  return handler(exec, result, async () => downstream);
}

const agent = { session: { id: 'audit-budget', header: { cwd: process.cwd() } } };

// G1 — a whole-file read above maxReadBytes is denied, with the fields the host reads
{
  const dir = scratch();
  const big = path.join(dir, 'big.js');
  fs.writeFileSync(big, 'x'.repeat(5000));
  const decision = await pre(mount(), { name: 'read', agent, arguments: { file_path: big } });
  check(
    'G1',
    'a whole-file read over the cap returns {kind:"deny", reason, info{name,code}} as the host expects',
    decision?.kind === 'deny' &&
      typeof decision.reason === 'string' &&
      decision.reason.includes('[code-budget]') &&
      decision.info?.code === 'READ_TOO_LARGE' &&
      typeof decision.info?.name === 'string',
    { decision },
  );
}

// G2 — a ranged read is allowed through
{
  const dir = scratch();
  const big = path.join(dir, 'big.js');
  fs.writeFileSync(big, 'x'.repeat(5000));
  const decision = await pre(mount(), { name: 'read', agent, arguments: { file_path: big, offset: 1, limit: 50 } });
  check('G2', 'a ranged read of the same file is not denied', decision?.kind === 'allow', { decision });
}

// G3 — a missing file neither throws nor denies
{
  const decision = await pre(mount(), { name: 'read', agent, arguments: { file_path: path.join(scratch(), 'nope.js') } });
  check('G3', 'a missing target does not throw and is not denied', decision?.kind === 'allow', { decision });
}

// G4 — another tool is untouched
{
  const decision = await pre(mount(), { name: 'grep', agent, arguments: { pattern: 'x' } });
  check('G4', 'a non-read tool passes through the pre-execute half', decision?.kind === 'allow', { decision });
}

// G5 — an oversized result is trimmed to head+tail with the note, staying an accept
{
  const text = Array.from({ length: 200 }, (_, index) => `line ${index} ${'y'.repeat(20)}`).join('\n');
  const decision = await post(mount(), { name: 'pwsh', agent, arguments: {} }, { kind: 'accept' }, { kind: 'accept', content: [{ type: 'text', text }] });
  const out = decision?.content?.map((block) => block.text).join('\n') ?? '';
  check(
    'G5',
    'an oversized result comes back as {kind:"accept", content} no longer than maxResultChars, keeping head and tail',
    decision?.kind === 'accept' && out.length <= CONFIG.maxResultChars && out.includes('line 0 ') && out.includes('line 199 ') && out.includes('[code-budget]'),
    { kind: decision?.kind, chars: out.length, head: out.slice(0, 40), tail: out.slice(-120) },
  );
}

// G6 — a result at or under the cap is untouched (same object)
{
  const content = [{ type: 'text', text: 'small' }];
  const decision = await post(mount(), { name: 'pwsh', agent, arguments: {} }, { kind: 'accept' }, { kind: 'accept', content });
  check('G6', 'a result under the cap is returned unchanged', decision?.content === content, { content: decision?.content });
}

// G7 — a deny from another plugin is not rewritten into an accept
{
  const decision = await post(
    mount(),
    { name: 'read', agent, arguments: {} },
    { kind: 'accept' },
    { kind: 'deny', reason: 'another plugin said no', content: [{ type: 'text', text: 'z'.repeat(5000) }] },
  );
  check('G7', 'a non-accept decision passes through the post-execute half untouched', decision?.kind === 'deny' && decision.reason === 'another plugin said no', { decision: { kind: decision?.kind, reason: decision?.reason } });
}

// G8 — a cap below the note reserve still returns something bounded-ish
{
  const text = 'z'.repeat(5000);
  const decision = await post(
    mount({ enabled: true, readTools: ['read'], maxReadBytes: 1000, maxResultChars: 100, headChars: 300, tailChars: 100 }),
    { name: 'pwsh', agent, arguments: {} },
    { kind: 'accept' },
    { kind: 'accept', content: [{ type: 'text', text }] },
  );
  const out = decision?.content?.map((block) => block.text).join('') ?? '';
  check(
    'G8',
    'with maxResultChars below NOTE_RESERVE the result is still bounded by the cap (or the note, whichever is larger)',
    out.length <= 400,
    { chars: out.length, text: out.slice(0, 200) },
  );
}

// G9 — the shape a `value`-replacing neighbour would produce (host line 3515)
{
  const text = 'q'.repeat(5000);
  const decision = await post(
    mount(),
    { name: 'pwsh', agent, arguments: {} },
    { kind: 'accept' },
    { kind: 'accept', value: { big: 'value' }, content: [{ type: 'text', text }] },
  );
  const both = Object.hasOwn(decision ?? {}, 'content') && Object.hasOwn(decision ?? {}, 'value');
  check(
    'G9',
    'when a downstream post-execute decision carries `value`, the trimmed decision does not carry both keys (host rejects that)',
    !both,
    { keys: Object.keys(decision ?? {}), both },
  );
}

// G5b — the MOUNTED config: no `config:` row for code-budget in cordis.patch.yml,
// so the library defaults apply (maxResultChars 24000, head 12000, tail 4000).
{
  const text = Array.from({ length: 2000 }, (_, index) => `line ${index} ${'y'.repeat(20)}`).join('\n');
  // `{}` is what the preset gives this row: `- id: code-budget` declares no `config:`,
  // so `resolveLimits` falls back to the library defaults.
  const ctx = mount({});
  const decision = await post(ctx, { name: 'pwsh', agent, arguments: {} }, { kind: 'accept' }, { kind: 'accept', content: [{ type: 'text', text }] });
  const out = decision?.content?.map((block) => block.text).join('\n') ?? '';
  check(
    'G5b',
    'with the defaults code-budget is mounted with, the kept text has BOTH a head and a tail',
    decision?.kind === 'accept' && out.includes('line 0 ') && out.includes('line 1999 ') && out.length <= 24000,
    { chars: out.length, head: out.slice(0, 30), tail: out.slice(-60) },
  );
}

for (const entry of results) {
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.id} ${entry.name}`);
  console.log(`       <- ${JSON.stringify(entry.evidence).slice(0, 500)}`);
}
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed, failed=[${failed.map((entry) => entry.id).join(', ')}]`);
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe-budget-shapes.out.json');
fs.writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(`report: ${OUT}`);
