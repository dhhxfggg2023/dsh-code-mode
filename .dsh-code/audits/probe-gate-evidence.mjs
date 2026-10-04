/**
 * AUDIT PROBE B — does a FAILED `code_verify` count as proof in the completion gate?
 *
 * `lib/gate-verify.js:191` counts a run tool as evidence by NAME alone:
 *
 *     } else if (runTools.has(tool)) {
 *       record.ranAny += 1;
 *       if (proofTools.has(tool)) record.ranProof += 1;
 *
 * `_result` is never read, so `code_verify` that returned `ok:false` — "exit 0, but
 * the expected output never appeared", or `FAILED (exit 1)` — is filed as `proved`
 * and `agent/turn-stopping` then writes no `unverified` entry at all.
 *
 * The other half of the same package disagrees: `lib/ledger.js:1757` settles an
 * unproven turn only against `e.kind === 'verified' && e.ok === true`.
 *
 * Run: node .dsh-code/audits/probe-gate-evidence.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-audit-evidence-${tag}-`));
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

const gate = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'gate-verify.js')).href);
const ledger = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'ledger.js')).href);

const results = [];
const check = (id, name, ok, evidence) => results.push({ id, name, ok: ok === true, evidence });

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

const drive = async (ctx, event, args) => {
  const handlers = ctx.handlers.get(event) ?? [];
  const next = async () => ({ kind: 'enter', messages: [] });
  const out = [];
  for (const handler of handlers) out.push(await handler(...args, next));
  return out;
};

/** One whole turn: edit, run one tool, stop. Returns the journal text written for it. */
async function turn(root, session, runTool, runResult) {
  const ctx = fakeCtx();
  gate.apply(ctx, undefined);
  const agent = { session: { id: session, header: { cwd: root } } };
  const gateJournal = path.join(root, 'gate-journal.jsonl');
  process.env.DSH_CODE_GATE_JOURNAL = gateJournal;
  await drive(ctx, 'tools/post-execute', [{ name: 'write', agent, arguments: { file_path: path.join(root, 'src', 'a.js') } }, { kind: 'accept' }]);
  await drive(ctx, 'tools/post-execute', [{ name: runTool, agent, arguments: { cmd: 'node src/a.js' } }, runResult]);
  // Three more tool calls, so the in-turn notice (patience 3) would fire if the gate
  // did not consider the turn proved.
  for (let i = 0; i < 3; i += 1) await drive(ctx, 'tools/post-execute', [{ name: 'grep', agent, arguments: {} }, { kind: 'accept' }]);
  await drive(ctx, 'agent/pre-step', [{ agent, turn: 1, step: 2, signal: {}, messages: [] }]);
  await drive(ctx, 'agent/turn-stopping', [{ agent, turn: 1 }]);
  delete process.env.DSH_CODE_GATE_JOURNAL;
  const journal = path.join(root, '.dsh-code', 'journal.jsonl');
  return {
    journal: fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8') : '',
    gate: fs.existsSync(gateJournal) ? fs.readFileSync(gateJournal, 'utf8') : '',
  };
}

const counts = (text, needle) => (text.match(new RegExp(needle, 'g')) ?? []).length;

// ---- B1: code_verify whose expectation did not match -------------------------
{
  const root = scratch('proj-failed-verify');
  ledger.initLedger(root, 'audit-session-1');
  const { journal, gate: gateText } = await turn(
    root,
    'audit-session-1',
    'code_verify',
    {
      kind: 'accept',
      content: [
        {
          type: 'text',
          text: '$ node src/a.js\nexit 0, but the expected output never appeared\n\n(no output)\n\nexitCode 0 · expectation not matched · ok false\nLogged to .dsh-code/journal.jsonl',
        },
      ],
    },
  );
  check(
    'B1',
    'a turn that edited a file and ran ONLY a mismatched code_verify writes an `unverified` debt',
    counts(journal, '"kind":"unverified"') > 0,
    { unverified: counts(journal, '"kind":"unverified"'), gateJournal: gateText.trim().slice(0, 400) },
  );
  check(
    'B2',
    'the gate journal records that turn as NOT proved, so the debt is visible in the trace too (was: it recorded `proved`, which is the defect this probe found)',
    // Inverted 2026-10-04 with the fix. As written by the audit this asserted the BUG —
    // `"state":"proved"` on a `code_verify` that reported `ok false` — which is why it went
    // red the moment the gate started reading the result. The check now requires the honest
    // reading, and keeps its diagnostic value: the journal is the trace a later reader uses
    // to see which decision the gate made.
    /"event":"turn-stopping"[^\n]*"state":"(ran|none)"/.test(gateText) && !/"event":"turn-stopping"[^\n]*"state":"proved"/.test(gateText),
    {
      turnStopping: (gateText.match(/"event":"turn-stopping"[^\n]*/g) ?? []).slice(0, 2),
      noticeDelivered: (gateText.match(/"event":"notice-delivered"/g) ?? []).length,
    },
  );
}

// ---- B3: code_verify that reported a non-zero exit --------------------------
{
  const root = scratch('proj-failed-exit');
  ledger.initLedger(root, 'audit-session-2');
  const { journal, gate: gateText } = await turn(root, 'audit-session-2', 'code_verify', {
    kind: 'accept',
    content: [{ type: 'text', text: '$ node src/a.js\nFAILED (exit 1)\n\nboom\n\nexitCode 1 · expectation not matched · ok false' }],
  });
  check(
    'B3',
    'a code_verify that FAILED (exit 1) also leaves an `unverified` debt',
    counts(journal, '"kind":"unverified"') > 0,
    { unverified: counts(journal, '"kind":"unverified"'), gateJournal: gateText.trim().slice(0, 300) },
  );
}

// ---- B4: control — a pwsh run records the debt ------------------------------
{
  const root = scratch('proj-pwsh');
  ledger.initLedger(root, 'audit-session-3');
  const { journal, gate: gateText } = await turn(root, 'audit-session-3', 'pwsh', {
    kind: 'accept',
    content: [{ type: 'text', text: 'hello\n[exit code: 0]' }],
  });
  check(
    'B4',
    'CONTROL: the same turn with a plain pwsh run DOES write the debt and DOES deliver the notice',
    counts(journal, '"kind":"unverified"') > 0 && /"event":"notice-delivered"/.test(gateText),
    { unverified: counts(journal, '"kind":"unverified"'), gateJournal: gateText.trim().slice(0, 500) },
  );
}

// ---- B5: does the ledger's own settle path agree? ---------------------------
{
  const root = scratch('proj-settle');
  ledger.initLedger(root, 'audit-session-4');
  // An unproven turn, then a FAILING verification of the same file in the same cwd.
  ledger.recordUnverified(root, { edits: ['write ' + path.join(root, 'src', 'a.js')], turn: 1, state: 'none' }, 'audit-session-4');
  ledger.recordVerified(root, { cmd: 'node src/a.js', expect: 're:ok', ok: false, tail: 'exit 0, but the expected output never appeared' }, 'audit-session-4');
  const brief = ledger.brief(root, { session: 'audit-other-session' });
  const body = typeof brief === 'string' ? brief : JSON.stringify(brief ?? null);
  check(
    'B5',
    'the ledger half treats the same failing verification as NO proof (debt stays visible)',
    /unproven|unverified/i.test(body),
    { exported: Object.keys(ledger).filter((key) => /brief/i.test(key)), excerpt: body.slice(0, 900) },
  );
}

for (const entry of results) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.id} ${entry.name}\n       <- ${JSON.stringify(entry.evidence).slice(0, 900)}`);
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed, failed=[${failed.map((entry) => entry.id).join(', ')}]`);
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe-gate-evidence.out.json');
fs.writeFileSync(OUT, `${JSON.stringify({ results, summary: { failed: failed.map((entry) => entry.id) } }, null, 2)}\n`, 'utf8');
console.log(`report: ${OUT}`);
