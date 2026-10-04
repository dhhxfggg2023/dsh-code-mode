/**
 * AUDIT PROBE E — what actually settles an unproven turn?
 *
 * `lib/ledger.js:1736-1744` states the rule: "a passing, non-claimed `code_verify`
 * recorded after the unproven turn settles it — but only for the edits that
 * verification actually covers". This drives the real `recordUnverified` /
 * `recordVerified` / `brief` and asks whether that is what the code does.
 *
 * Run: node .dsh-code/audits/probe-debt-coverage.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-audit-debt-${tag}-`));
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

const ledger = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'ledger.js')).href);
const results = [];
const check = (id, name, ok, evidence) => results.push({ id, name, ok: ok === true, evidence });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A project with one unproven turn, then one recorded proof.
 *
 * The 25 ms sleep is load-bearing: `unverifiedExcerpt` compares ISO timestamps with
 * `proof.ts > when`, so a proof written in the SAME millisecond as the debt does not
 * cover it. Without the sleep this probe measures the clock, not the rule.
 */
async function scenario(tag, unprovenEdits, proof) {
  const root = scratch(tag);
  ledger.initLedger(root, 'debt-session-live');
  ledger.recordUnverified(root, { edits: unprovenEdits.map((target) => `write ${target}`), turn: 1, state: 'none' }, 'debt-session-old');
  await sleep(25);
  if (proof !== undefined) ledger.recordVerified(root, proof, 'debt-session-old');
  const brief = ledger.brief(root, { session: 'debt-session-reader' });
  const text = typeof brief === 'string' ? brief : JSON.stringify(brief ?? null);
  return { root, text };
}
void scenario;

/** Every scenario, with the ordering fix applied. */
async function run(tag, edits, proof) {
  const root = scratch(tag);
  ledger.initLedger(root, 'debt-session-live');
  ledger.recordUnverified(root, { edits: edits.map((target) => `write ${target}`), turn: 1, state: 'none' }, 'debt-session-old');
  await sleep(25);
  if (proof !== undefined) ledger.recordVerified(root, proof, 'debt-session-old');
  const brief = ledger.brief(root, { session: 'debt-session-reader' });
  return typeof brief === 'string' ? brief : JSON.stringify(brief ?? null);
}

const visible = (text) => /Turns that changed code/.test(text);

// E1 — INVERTED 2026-10-04. As written by the first version of this probe it asserted
// that a bare passing `echo hi` recorded at the project root does NOT settle the debt on
// that project's lib/a.js — i.e. that the structural half of the settlement rule must not
// fire. That is the opposite of what this project recorded as intended behaviour:
//
//   decisions.md (2026-10-02, the entry this probe's header quotes): a debt is settled by
//   a later passing code_verify that `ok:true`, is not `claimed`, and **对得上** the edited
//   files — 「(a) 结构对得上：那次验证是在被改文件的祖先目录里跑的（新记 `cwd` 字段）」 or
//   (b) the command/output names the file. 「宽，但和『在同一个项目里跑过测试』的直觉一致」.
//   `recordVerified`'s own comment says the same: the `cwd` field exists because
//   "a project-level `pnpm test` names no file at all".
//
// E1 also contradicted its own control: E1b *requires* that rule to keep working for
// `pnpm test`, and the ledger cannot tell a good command from a bad one — coverage is
// structural by design. So the check now asserts the recorded rule, keeps its teeth
// (the debt must actually disappear), and the guard E1 was reaching for — that coverage is
// SCOPED and must not leak — is E5 (absolute, cross-tree) and E8 (relative, out-of-tree).
{
  const root = scratch('bare-echo');
  ledger.initLedger(root, 'debt-session-live');
  const target = path.join(root, 'lib', 'a.js');
  ledger.recordUnverified(root, { edits: [`write ${target}`], turn: 1, state: 'none' }, 'debt-session-old');
  await sleep(25);
  // Exactly what `code_verify` records: cwd = the project root it ran in
  // (lib/tool-verify.js:68), a command that names no file and proves only exit 0.
  ledger.recordVerified(root, { cmd: 'echo hi', expect: undefined, ok: true, tail: 'hi' }, 'debt-session-old');
  const brief = ledger.brief(root, { session: 'debt-session-reader' });
  const text = typeof brief === 'string' ? brief : JSON.stringify(brief ?? null);
  check(
    'E1',
    'INVERTED 2026-10-04: a passing proof at the project root DOES settle the debt on that project\'s lib/a.js (the structural rule decisions.md records; as written this check asserted the superseded "must name the file" rule and contradicted its own control E1b)',
    !visible(text),
    { settled: !visible(text), target, root, excerpt: text.slice(0, 700) },
  );
}

// E1b — the same, but the proof is a project-level test command (the documented intent)
{
  const root = scratch('pnpm-test');
  ledger.initLedger(root, 'debt-session-live');
  const target = path.join(root, 'lib', 'a.js');
  ledger.recordUnverified(root, { edits: [`write ${target}`], turn: 1, state: 'none' }, 'debt-session-old');
  await sleep(25);
  ledger.recordVerified(root, { cmd: 'pnpm test', expect: 're:pass', ok: true, tail: 'pass' }, 'debt-session-old');
  const brief = ledger.brief(root, { session: 'debt-session-reader' });
  const text = typeof brief === 'string' ? brief : JSON.stringify(brief ?? null);
  check(
    'E1b',
    'CONTROL: a real project test (`pnpm test`) at the root settles the debt (documented intent)',
    !visible(text),
    { settled: !visible(text), excerpt: text.slice(0, 400) },
  );
}

// E2 — a proof that names a DIFFERENT file, in another subtree
{
  const outside = path.join(scratch('elsewhere'), 'lib', 'target.js');
  const text = await run('other-file', [outside], { cmd: 'node unrelated/file.js', expect: undefined, ok: true, tail: 'ok' });
  check(
    'E2',
    'a proof naming a different path elsewhere leaves the debt visible (and names it)',
    visible(text),
    { visible: visible(text), named: /did not exercise|still in journal/i.test(text), excerpt: text.slice(0, 700), outside },
  );
}

// E3 — a proof that ran elsewhere and names nothing must be NAMED, not dropped
{
  const outside = path.join(scratch('elsewhere2'), 'lib', 'target.js');
  const text = await run('mismatch-named', [outside], { cmd: 'echo done', expect: undefined, ok: true, tail: 'done' });
  check(
    'E3',
    'a proof that did not cover the debt is named in the brief rather than dropped',
    visible(text) && /did not exercise|still in journal/i.test(text),
    { visible: visible(text), named: /did not exercise|still in journal/i.test(text), excerpt: text.slice(0, 700) },
  );
}

// E4 — control: a passing proof whose command names the file settles it
{
  const outside = path.join(scratch('elsewhere3'), 'lib', 'target.js');
  const text = await run('named-file', [outside], { cmd: 'node lib/target.js', expect: 'ok', ok: true, tail: 'target.js ok' });
  check('E4', 'CONTROL: a proof naming the file settles it', !visible(text), { excerpt: text.slice(0, 400) });
}

// E5 — the same proof, recorded in the project root, over an out-of-tree edit
{
  const outside = path.join(scratch('elsewhere4'), 'lib', 'target.js');
  const root = scratch('root-proof');
  ledger.initLedger(root, 'debt-session-live');
  ledger.recordUnverified(root, { edits: [`write ${outside}`], turn: 1, state: 'none' }, 'debt-session-old');
  await sleep(25);
  // `code_verify` records `cwd` = the project root it ran in (lib/tool-verify.js:68).
  ledger.recordVerified(root, { cmd: 'npm test', expect: undefined, ok: true, tail: 'all green' }, 'debt-session-old');
  const brief = ledger.brief(root, { session: 'debt-session-reader' });
  const text = typeof brief === 'string' ? brief : JSON.stringify(brief ?? null);
  check(
    'E5',
    'a project-root proof does not settle an edit made OUTSIDE that project (no false coverage across trees)',
    visible(text),
    { visible: visible(text), excerpt: text.slice(0, 600), outside },
  );
}

// E6 — a FAILING verification never settles anything (a guard that exists)
{
  const target = path.join(scratch('failing-root'), 'lib', 'a.js');
  const text = await run('failing-proof', [target], { cmd: 'node lib/a.js', expect: 'ok', ok: false, tail: 'boom' });
  check('E6', 'a FAILING verification leaves the debt visible', visible(text), { excerpt: text.slice(0, 400) });
}

// E7 — a `claimed` proof never settles (the other guard)
{
  const target = path.join(scratch('claimed-root'), 'lib', 'a.js');
  const text = await run('claimed-proof', [target], { cmd: 'node lib/a.js', expect: 'ok', ok: true, claimed: true, tail: 'ok' });
  check('E7', 'a claimed (not independently verified) proof leaves the debt visible', visible(text), { excerpt: text.slice(0, 400) });
}

// E8 — the guard E1 was reaching for, made precise: coverage is SCOPED, and a relative
// target must be anchored on the coordinate the debt itself carries (`unverified.cwd`,
// written by `recordUnverified`), not on wherever the proof happened to run. `lib/ledger.js`
// resolves the target against that cwd; anchoring it on the *proof's* cwd instead would
// make containment true for a proof anywhere, which is what E9 below pins from the other
// side. This case is the `..` half: `<root>/../other/a.js` names a file beside the
// project, and while `..` was kept as a literal path segment the segment comparison saw
// `<root>` as its prefix and settled it.
{
  const root = scratch('relative-up');
  ledger.initLedger(root, 'debt-session-live');
  ledger.recordUnverified(root, { edits: ['edit ../other/a.js'], turn: 1, state: 'none' }, 'debt-session-old');
  await sleep(25);
  ledger.recordVerified(root, { cmd: 'pnpm test', expect: undefined, ok: true, tail: 'all green' }, 'debt-session-old');
  const brief = ledger.brief(root, { session: 'debt-session-reader' });
  const text = typeof brief === 'string' ? brief : JSON.stringify(brief ?? null);
  check(
    'E8',
    'a proof inside the project does NOT settle a debt whose RELATIVE target resolves outside it (`../other/a.js` against the debt\'s own cwd)',
    visible(text),
    { visible: visible(text), root, excerpt: text.slice(0, 600) },
  );
}

// E9 — the same guard from the cross-project side: the relative target is anchored on the
// debt's cwd, so a proof recorded in a DIFFERENT project cannot settle it. This is the case
// a vacuous anchor (resolve the target against the proof's cwd) fails, and it is written
// from raw journal lines because the fixture needs two different `cwd`s in one journal.
{
  const root = scratch('relative-leak');
  const other = scratch('relative-leak-other');
  ledger.initLedger(root, 'debt-session-live');
  fs.writeFileSync(
    path.join(root, '.dsh-code', 'journal.jsonl'),
    [
      JSON.stringify({ ts: '2026-10-01T00:00:00.000Z', session: 'earlier', kind: 'unverified', turn: 1, edits: ['edit lib/target.js'], cwd: root, state: 'none' }),
      JSON.stringify({ ts: '2026-10-01T00:10:00.000Z', session: 'earlier', kind: 'verified', cmd: 'pnpm test', cwd: other, ok: true, tail: 'all green' }),
      '',
    ].join('\n'),
    'utf8',
  );
  const brief = ledger.brief(root, { session: 'debt-session-reader' });
  const text = typeof brief === 'string' ? brief : JSON.stringify(brief ?? null);
  check(
    'E9',
    'a proof recorded in ANOTHER project does not settle a debt whose target is relative to this one',
    visible(text),
    { visible: visible(text), root, other, excerpt: text.slice(0, 600) },
  );
}

for (const entry of results) {
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.id} ${entry.name}`);
  console.log(`       <- ${JSON.stringify(entry.evidence).slice(0, 500)}`);
}
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed, failed=[${failed.map((entry) => entry.id).join(', ')}]`);
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe-debt-coverage.out.json');
fs.writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(`report: ${OUT}`);
