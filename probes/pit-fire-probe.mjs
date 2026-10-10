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
/** Every scratch directory this run created, so `--keep` can name them and the rest can clean up. */
const fixtures = [];
const scratch = (tag) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-pitfire-${tag}-`));
  fixtures.push(dir);
  return dir;
};
process.env.DSH_CODE_GLOBAL_DIR = scratch('machine');

/**
 * `--keep` prints the fixture paths and does not delete them.
 */
/**
 * `--keep` prints the fixture paths and does not delete them; `--trace` prints each safe-case
 * fixture's ledger and what each field parses to.
 *
 * Why a trace flag rather than a separate probe: `$env:TEMP` is a **per-command** directory on
 * this host (recorded machine fact), so a fixture written by one command is unreachable from
 * the next one — a second probe cannot inspect what this one wrote, no matter whether it cleans
 * up. Bringing up the `B` checks below is the occasion: `safe case` arrived while the entry's own
 * `do not repeat:` did not, which no single-expression story explains, and answering it needed
 * the fixture's bytes *and* the parsed fields side by side in one run.
 */
const KEEP = process.argv.includes('--keep');
const TRACE = process.argv.includes('--trace');

/** How the guard reads a field, spelled as `lib/pit-guard.js` spells it. */
const fieldExpression = (label) => `^- ${label}\\s*(?:[（(][^\\n]*?[）)])?\\s*[:：]\\s*([^\\n]*)$`;
const readField = (block, labels) => {
  for (const label of String(labels).split('/')) {
    const match = new RegExp(fieldExpression(label), 'm').exec(block);
    if (match !== null && match[1].trim().length > 0) return match[1].trim();
  }
  return undefined;
};

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
/** This probe's fixture ledger inside one scratch project. */
const ledgerFile = (root) => path.join(root, '.dsh-code', 'mistakes.md');
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

// --- B: a safe case written the way a human writes it ---------------------------
//
// `pit-guard-probe`'s `K10` pins the same promise and could not catch this defect, because its
// fixture goes through `ledger.recordMistake()` and the **writer** emits the ASCII spelling
// (`- safe case: …`) while the **reader** required it. Reader and writer agreed with each
// other and neither was ever tested against a line a human had written.
//
// Measured 2026-10-06: every safe case in both real ledgers used a full-width delimiter —
// `- safe case（2026-10-05 实测补记）：…` and `- 安全情形（…）：…` — so the reader parsed
// `undefined` for all four lines and the line the mechanism exists to deliver was never
// delivered once. Nothing anywhere said so, which is the same silent failure this ledger
// already records for a mistyped `trigger:`.
//
// So this check writes the line **by hand, byte for byte**, in the spellings the ledgers use,
// and then asks the guard's own handler to deliver it.
{
  /**
   * Append one hand-written entry to the fixture's ledger.
   *
   * `fields` are the entry's lines **exactly as they must appear in the file**, bullet included
   * — deliberately not pre-bulleted by a helper, because the point of this block is to write the
   * bytes a human writes. The first version of this helper prefixed every line with `- `, and
   * the safe-case lines already carried it, so the file got `- - safe case: …`: every field in
   * the entry then failed to parse and the probe reported all three spellings as unreadable.
   * That is a fixture defect wearing the shape of the defect under test, which is why the
   * evidence printed here carries the ledger tail.
   */
  const writeEntry = (root, fields) => {
    const text = fs.readFileSync(ledgerFile(root), 'utf8');
    fs.writeFileSync(ledgerFile(root), `${text}\n## 2026-10-06 · PITFIRE-HAND-WRITTEN-SAFE-CASE\n${fields.join('\n')}\n`, 'utf8');
  };
  /** Drive one command through a fresh guard instance and read the notice it delivered. */
  const noticeForTrigger = async (root, command) => {
    const ctx = fakeCtx();
    guard.apply(ctx, undefined);
    const agent = { session: { id: SESSION, header: { cwd: root } } };
    await preExecute(ctx, { name: 'pwsh', agent, arguments: { cmd: command } });
    const handler = (ctx.handlers.get('agent/pre-step') ?? [])[0];
    if (handler === undefined) return '';
    const decision = await handler({ agent, turn: 1, messages: [] }, async () => ({ messages: [] }));
    return (Array.isArray(decision?.messages) ? decision.messages : [])
      .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
      .filter((block) => block?.type === 'text')
      .map((block) => String(block.text))
      .join('\n');
  };

  const spellings = [
    {
      id: 'B1',
      tag: 'ascii',
      what: 'the reader still accepts the spelling the writer produces',
      safeLine: '- safe case: SAFE-ASCII-TEXT the upstream is a cmdlet, not a native program',
      marker: 'SAFE-ASCII-TEXT',
    },
    {
      id: 'B2',
      tag: 'fullwidth',
      what: 'a safe case written with the full-width delimiter the real ledgers use',
      safeLine: '- safe case（2026-10-05 实测补记）：SAFE-FULLWIDTH-TEXT 只有上游是原生程序时才有这个坑',
      marker: 'SAFE-FULLWIDTH-TEXT',
    },
    {
      id: 'B3',
      tag: 'chinese',
      what: 'a safe case filed under the Chinese label, as this project\'s own ledger does',
      safeLine: '- 安全情形（2026-10-05 实测补记）：SAFE-CHINESE-TEXT 单引号包脚本且脚本内无引号时安全',
      marker: 'SAFE-CHINESE-TEXT',
    },
  ];

  for (const spelling of spellings) {
    const root = scratch(`safe-${spelling.tag}`);
    ledger.initLedger(root, SESSION);
    writeEntry(root, [
      '- symptom: PITFIRE-SAFE a trigger that also fires on honest work',
      '- cause: a regex over command text cannot express the precondition',
      '- fix: let the entry name the safe case',
      '- trigger: pitfire-safe-case-trigger',
      '- do not repeat: PITFIRE-SAFE-RULE must reach the reader',
      spelling.safeLine,
    ]);
    // `guard.apply` registers into this ctx only, so each spelling gets its own guard instance
    // and its own hit counter.
    const text = await noticeForTrigger(root, 'pitfire-safe-case-trigger --now');
    if (TRACE) {
      const raw = fs.readFileSync(ledgerFile(root), 'utf8');
      const blocks = raw
        .split(/\n(?=## )/)
        .map((block) => block.trim())
        .filter((block) => block.startsWith('## '));
      console.log(`\n--- TRACE ${spelling.id} (${spelling.tag}) ${root}`);
      console.log(`    blocks: ${blocks.length} · bytes: ${raw.length}`);
      blocks.forEach((block, index) => console.log(`    block ${index}: ${JSON.stringify(block)}`));
      const carrier = blocks.find((block) => readField(block, 'trigger') !== undefined);
      if (carrier === undefined) console.log('    no block carries a trigger');
      else {
        for (const label of ['symptom', 'cause', 'fix', 'trigger', 'do not repeat', 'safe case/安全情形', 'avoid']) {
          console.log(`    ${label.padEnd(22)} → ${JSON.stringify(readField(carrier, label))}`);
        }
        console.log(`    first code points of each line:`);
        for (const line of carrier.split('\n')) {
          const codes = [...line.slice(0, 3)].map((char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
          console.log(`      ${codes}  ${JSON.stringify(line.slice(0, 80))}`);
        }
      }
    }
    check(
      spelling.id,
      spelling.what,
      text.includes(spelling.marker) && text.includes('PITFIRE-SAFE-RULE'),
      {
        noticeFound: text.length > 0,
        markerDelivered: text.includes(spelling.marker),
        ruleDelivered: text.includes('PITFIRE-SAFE-RULE'),
        safeCaseLine: spelling.safeLine,
        ledgerTail: fs.readFileSync(ledgerFile(root), 'utf8').slice(-320),
        notice: text.replace(/\s+/g, ' ').slice(0, 400),
      },
    );
  }
}

// --- B4: the same promise through the *writer* ----------------------------------
//
// `B1`–`B3` write the ledger line by hand. This one goes through `ledger.recordMistake()` with
// the `safeCase` API key, which is the path `pit-guard-probe`'s `K10` exercises in the Electron
// channel and which no plain-node probe covered — and that channel yields no readable output
// here (measured: empty stdout, empty stderr, empty `$LASTEXITCODE`), so when `K10` went red
// with 35/36 there was no way to see which assertion failed *through that channel*.
//
// Reproducing it here is not a duplicate of `K10`: it is the same contract measured where a
// failure can be read. The writer emits `- safe case: …` (`lib/ledger.js:2060`), so this also
// pins the writer↔reader pair as a pair.
{
  const root = scratch('safe-writer');
  ledger.initLedger(root, SESSION);
  ledger.recordMistake(
    root,
    {
      symptom: 'PITFIRE-WRITER a recorded trigger fired on a command that was in fact safe',
      cause: 'the trigger matches command text, which cannot express the real precondition',
      fix: 'let the entry name the safe case so the reader checks it in one step',
      trigger: 'pitfire-writer-trigger',
      avoid: 'PITFIRE-WRITER-RULE-MUST-REACH-THE-READER',
      safeCase: 'PITFIRE-WRITER-SAFE-CASE only when the upstream is a native program',
    },
    SESSION,
  );
  const written = fs.readFileSync(ledgerFile(root), 'utf8');
  const ctx = fakeCtx();
  guard.apply(ctx, undefined);
  const agent = { session: { id: SESSION, header: { cwd: root } } };
  await preExecute(ctx, { name: 'pwsh', agent, arguments: { cmd: 'pitfire-writer-trigger --now' } });
  const handler = (ctx.handlers.get('agent/pre-step') ?? [])[0];
  const decision = handler === undefined ? undefined : await handler({ agent, turn: 1, messages: [] }, async () => ({ messages: [] }));
  const text = (Array.isArray(decision?.messages) ? decision.messages : [])
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text))
    .join('\n');
  check(
    'B4',
    'an entry written through recordMistake() delivers its safe case — the same contract K10 pins in the Electron channel',
    text.includes('PITFIRE-WRITER-SAFE-CASE') && text.includes('PITFIRE-WRITER-RULE-MUST-REACH-THE-READER'),
    {
      writerLine: (written.match(/^- safe case: .*$/m) ?? ['(writer emitted no safe-case line)'])[0].slice(0, 120),
      safeCaseDelivered: text.includes('PITFIRE-WRITER-SAFE-CASE'),
      ruleDelivered: text.includes('PITFIRE-WRITER-RULE-MUST-REACH-THE-READER'),
      notice: text.replace(/\s+/g, ' ').slice(0, 320),
    },
  );
}

for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.id} ${r.name}${r.ok ? '' : `\n       <- ${JSON.stringify(r.evidence).slice(0, 700)}`}`);
if (KEEP) {
  for (const dir of fixtures) console.log(`kept fixture: ${dir}`);
} else {
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed, failed=[${failed.map((r) => r.id).join(', ')}]`);
process.exit(failed.length === 0 ? 0 : 1);
