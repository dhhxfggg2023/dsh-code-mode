// Behavioural probe for <这个包的 checkout>/lib/gate-verify.js (plugin name 'code-gate')
// plus the new ledger helpers recordUnverified / unverifiedExcerpt (via brief) / recentJournal detail.
//
// Run (resolution bootstrap is required: the modules import @deepseek-ai/* bare specifiers):
//   $env:ELECTRON_RUN_AS_NODE='1'
//   & '<install>\DeepSeek Harness.exe' --expose-internals '<这个包的 checkout>\probes\gate-probe.mjs'
//
// Outputs: gate-log.txt (human log) and gate-report.json (the FULL result object, both in the OS
// temp dir), plus one compact JSON line on stdout: { summary, findings: [id, …], report, config? }.
// `config` is included only when its JSON form is short (see CONFIG_STDOUT_MAX); the full config
// always lives in the report file. The findings' long text lives only in the report file — printing
// it here cost every session that ran the suite ~50 KB of model-visible stdout (measured 2026-10-02).
//
//   --all | --verbose   print the full result object to stdout instead of the compact line
//                       (for a human debugging a failure; the checks and the exit code are identical)
//
// Exit code: 0 when every check passes, 1 otherwise (unchanged by the flag).
import fs from 'node:fs';
import path from 'node:path';
import { setEnvironmentData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { ASAR, PKG_DIR, PROBES_DIR, installResolution, profileDir, tempReport } from './paths.mjs';

const ASAR_DSH = path.join(ASAR, 'dsh');
const BOOT = path.join(ASAR_DSH, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
const BOOTSTRAP = path.join(ASAR_DSH, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'worker', 'profile-resolution-bootstrap.js');
const PROFILE_DIR = profileDir();

const PROJ = tempReport('gate-proj');
const LEDGER = path.join(PROJ, '.dsh-code');
const JOURNAL = path.join(LEDGER, 'journal.jsonl');
const OUT_JSON = tempReport('gate-report.json');
const OUT_LOG = tempReport('gate-log.txt');

const SESSION_A = 'sess-gate-A'; // writes the durable debt
const SESSION_B = 'sess-gate-B'; // a different session: must distrust A's debt
const SESSION_CN = 'sess-gate-CN'; // Chinese path round-trip
const GATE_EVENTS = ['tools/post-execute', 'agent/pre-step', 'agent/turn-stopping'];

const stdoutAll = process.argv.includes('--all') || process.argv.includes('--verbose');
const report = { startedAt: new Date().toISOString(), routing: null, config: {}, configSize: null, stdoutAll, checks: [], findings: [], notes: [], journal: {} };
const log = [];
const say = (line) => log.push(String(line));
const preview = (v, n = 300) => {
  let s;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) s = String(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const errInfo = (e) => ({
  name: e?.name,
  message: String(e?.message ?? e).slice(0, 500),
  stack: String(e?.stack ?? '').split('\n').slice(0, 5).join(' | ').slice(0, 700),
});
/** All text the notices appended to a decision carry, for asserting on wording. */
const noticeText = (returned, decision) => {
  const base = Array.isArray(decision?.messages) ? decision.messages.length : 0;
  const added = Array.isArray(returned?.messages) ? returned.messages.slice(base) : [];
  return added
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .join('\n');
};
const checks = [];
const check = (id, item, name, pass, evidence) => {
  const c = { id, item, name, pass: pass === true, evidence };
  checks.push(c);
  say(`${pass === true ? 'PASS' : 'FAIL'} ${id} [item ${item}] ${name}\n      ${preview(evidence, 600)}`);
  return c;
};
const note = (text) => {
  report.notes.push(text);
  say(`NOTE ${text}`);
};
const finding = (id, text) => {
  report.findings.push({ id, text });
  say(`FINDING ${id}: ${text}`);
};

// ---------------------------------------------------------------- clean slate
fs.mkdirSync(PROJ, { recursive: true });
const hadLedger = fs.existsSync(LEDGER);
fs.rmSync(LEDGER, { recursive: true, force: true });
say(`scratch project ${PROJ} ready (previous .dsh-code present: ${hadLedger}, removed)`);

// ------------------------------------------- resolution interception (reused from smoke-mode.mjs)
try {
  const appBoot = await import(pathToFileURL(BOOT).href);
  const base = await appBoot.createRuntimeResolution({ installAnchor: ASAR_DSH + '\\package.json' });
  setEnvironmentData('@deepseek-ai/dsh-app-boot/profile-resolution', {
    resolution: {
      ...base,
      profileDir: PROFILE_DIR,
      localPackageNames: [],
      linkedRoots: [{ name: 'dsh-code-mode', realPath: PKG_DIR }],
    },
  });
  await import(pathToFileURL(BOOTSTRAP).href);
  report.routing = { ok: true, entries: base.entries.length, profileDir: PROFILE_DIR };
  say(`routing installed, base entries ${base.entries.length}, profileDir ${PROFILE_DIR}`);
} catch (e) {
  report.routing = { ok: false, ...errInfo(e) };
  say(`ROUTING FAILED: ${e?.message}`);
}

// ---------------------------------------------------------------- stub cordis context
function makeCtx() {
  const handlers = new Map();
  const order = [];
  return {
    handlers,
    order,
    on(event, handler) {
      order.push(event);
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
  };
}
const handlersOf = (ctx, event) => ctx.handlers.get(event) ?? [];
/** Cordis waterfall: next() runs the next listener, else the fallback decision. */
async function waterfall(hs, args, fallback) {
  let i = 0;
  const next = () =>
    i >= hs.length
      ? Promise.resolve(typeof fallback === 'function' ? fallback() : fallback)
      : Promise.resolve(hs[i++](...args, next));
  return next();
}
const postExecute = (ctx, exec, result = { kind: 'result', isError: false, content: [] }) =>
  waterfall(handlersOf(ctx, 'tools/post-execute'), [exec, result], { kind: 'accept' });
const preStep = (ctx, payload, fallback) => waterfall(handlersOf(ctx, 'agent/pre-step'), [payload], fallback);
const turnStopping = async (ctx, payload) => {
  const out = [];
  for (const h of handlersOf(ctx, 'agent/turn-stopping')) out.push(await h(payload));
  return out;
};
let seq = 0;
const agentFor = (cwd, id) => ({ session: { id, header: { cwd } } });
const execFor = (agent, name, args) => ({
  token: 't',
  callId: `c${++seq}`,
  rootCallId: `c${seq}`,
  name,
  signal: undefined,
  agent,
  arguments: args,
});
const ctxDecision = () => ({
  kind: 'enter',
  startsRequestSeries: false,
  messages: [{ id: 'runtime-context-1', role: 'user', content: [{ type: 'text', text: 'runtime context' }], source: { kind: 'runtime-context' } }],
});
const userMsg = () => ({ id: 'u1', role: 'user', content: [{ type: 'text', text: 'new instruction' }], source: { kind: 'user' } });

// ---------------------------------------------------------------- imports
const gateUrl = pathToFileURL(path.join(PKG_DIR, 'lib', 'gate-verify.js')).href;
const ledgerUrl = pathToFileURL(path.join(PKG_DIR, 'lib', 'ledger.js')).href;
let gate;
let ledger;
try {
  gate = await import(gateUrl);
  say(`import ok gate-verify.js: keys=[${Object.keys(gate).join(',')}]`);
} catch (e) {
  check('1.import', 1, 'import gate-verify.js', false, errInfo(e));
  say(`IMPORT FAIL gate-verify.js: ${e?.name}: ${e?.message}\n${e?.stack}`);
}
try {
  ledger = await import(ledgerUrl);
  say(`import ok ledger.js: exports=[${Object.keys(ledger).join(',')}]`);
} catch (e) {
  check('1.import-ledger', 1, 'import ledger.js', false, errInfo(e));
  say(`IMPORT FAIL ledger.js: ${e?.name}: ${e?.message}`);
}

// module identity: does the imported ledger.js share the instance gate-verify.js imports?
report.moduleIdentity = {};
try {
  const again = await import(ledgerUrl);
  report.moduleIdentity.sameLedgerInstance = again === ledger;
} catch (e) {
  report.moduleIdentity.error = errInfo(e);
}

// ---------------------------------------------------------------- 1. load / apply
if (gate !== undefined) {
  const meta = {
    name: gate.name,
    ConfigType: typeof gate.Config,
    ConfigIsSchema: typeof gate.Config === 'function' && gate.Config['~standard'] !== undefined,
    applyType: typeof gate.apply,
    exportKeys: Object.keys(gate),
  };
  report.module = meta;
  check(
    '1.exports',
    1,
    "name === 'code-gate', Config + apply present",
    gate.name === 'code-gate' && typeof gate.apply === 'function' && meta.ConfigIsSchema,
    preview(meta),
  );

  const ctxU = makeCtx();
  let applyUndefinedError;
  try {
    await gate.apply(ctxU, undefined);
  } catch (e) {
    applyUndefinedError = errInfo(e);
  }
  check(
    '1.apply-undefined-events',
    1,
    'apply(ctx, undefined) registers exactly the three events',
    applyUndefinedError === undefined && GATE_EVENTS.every((e) => handlersOf(ctxU, e).length === 1) && ctxU.order.length === 3,
    { registered: ctxU.order, counts: Object.fromEntries(GATE_EVENTS.map((e) => [e, handlersOf(ctxU, e).length])), applyUndefinedError },
  );

  const ctxOff = makeCtx();
  let applyOffError;
  try {
    await gate.apply(ctxOff, { enabled: false });
  } catch (e) {
    applyOffError = errInfo(e);
  }
  check(
    '1.apply-disabled',
    1,
    'apply(ctx, { enabled: false }) registers nothing',
    applyOffError === undefined && ctxOff.order.length === 0,
    { registered: ctxOff.order, applyOffError },
  );

  // Config semantics: what does cordis's resolveConfig hand apply() for a row with no `config:`?
  const safeValidate = (schema, input) => {
    try {
      const r = schema['~standard'].validate(input);
      return { input: preview(input, 60), issues: r?.issues ? preview(r.issues, 300) : null, value: r?.value === undefined ? null : r.value };
    } catch (e) {
      return { input: preview(input, 60), threw: errInfo(e) };
    }
  };
  const safeCall = (schema, input) => {
    try {
      const v = schema(input);
      return { value: v === undefined ? null : v };
    } catch (e) {
      return { threw: errInfo(e) };
    }
  };
  report.config.validateUndefined = safeValidate(gate.Config, undefined);
  report.config.validateEmpty = safeValidate(gate.Config, {});
  report.config.validatePartial = safeValidate(gate.Config, { patience: 1 });
  report.config.callEmpty = safeCall(gate.Config, {});
  say(`Config['~standard'].validate(undefined) -> ${preview(report.config.validateUndefined)}`);
  say(`Config['~standard'].validate({})        -> ${preview(report.config.validateEmpty)}`);
  say(`Config({})                              -> ${preview(report.config.callEmpty)}`);

  // control: prompt.js is declared in cordis.patch.yml with no config either (same default pattern).
  try {
    const promptMod = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'prompt.js')).href);
    report.config.promptControlUndefined = safeValidate(promptMod.Config, undefined);
    say(`control prompt.Config.validate(undefined) -> ${preview(report.config.promptControlUndefined)}`);
  } catch (e) {
    report.config.promptControlError = errInfo(e);
  }

  const prodCfg = report.config.validateUndefined.value ?? report.config.validateEmpty.value ?? gate.Config({});
  report.config.productionEquivalent = prodCfg;
  // Measured here, not at print time: `report` is written to the report file below, so the size
  // recorded in that file matches the size the stdout decision used.
  report.configSize = JSON.stringify(report.config).length;

  // Journal reader (used from section 2 onward).
  const journalState = () => {
    let text = '';
    try {
      text = fs.readFileSync(JOURNAL, 'utf8');
    } catch (e) {
      return { exists: false, error: String(e?.message ?? e).slice(0, 200), lines: [], parsed: [] };
    }
    const lines = text.split('\n').filter((l) => l.length > 0);
    const parsed = lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        return { __parseError: String(e?.message ?? e).slice(0, 200), __line: l };
      }
    });
    return { exists: true, lines, parsed };
  };
  const unverifiedOf = (st) => st.parsed.filter((e) => e?.kind === 'unverified');

  // ---------------------------------------------------------------- 2. in-turn notice
  const driveNotice = async (cfg, { prime, turn, label, session }) => {
    const ctx = makeCtx();
    await gate.apply(ctx, cfg);
    const agent = agentFor(PROJ, session ?? `${SESSION_A}-${label}`);
    const trace = [];
    if (prime) {
      const d = await preStep(ctx, { agent, messages: [], turn, step: 1 }, () => ctxDecision());
      trace.push(`primed pre-step turn=${turn} -> messages=${d.messages.length}`);
    }
    await postExecute(ctx, execFor(agent, 'edit', { file_path: 'a.js' }));
    trace.push('post-execute edit a.js');
    for (let i = 0; i < 3; i += 1) {
      await postExecute(ctx, execFor(agent, 'read', { file_path: 'a.js' }));
      trace.push(`post-execute read #${i + 1}`);
    }
    const decision = ctxDecision();
    const returned = await preStep(ctx, { agent, messages: [], turn, step: 2 }, () => decision);
    const msgs = Array.isArray(returned?.messages) ? returned.messages : [];
    const notice = msgs[msgs.length - 1];
    return {
      ctx,
      agent,
      trace,
      decision,
      returned,
      notice,
      added: msgs.length === decision.messages.length + 1 ? notice : undefined,
      grewBy: msgs.length - decision.messages.length,
    };
  };

  const r2Literal = await driveNotice(undefined, { prime: false, turn: 1, label: 'literal' });
  report.drive2Literal = { trace: r2Literal.trace, grewBy: r2Literal.grewBy, notices: r2Literal.notice === undefined ? 0 : 1 };
  note(`item 2 literal drive (apply(ctx, undefined), no priming pre-step): decision.messages grew by ${r2Literal.grewBy}`);

  const r2Cold = await driveNotice(prodCfg, { prime: false, turn: 1, label: 'cold', session: SESSION_A });
  const r2Warm = await driveNotice(prodCfg, { prime: true, turn: 1, label: 'warm' });
  report.drive2Cold = { trace: r2Cold.trace, grewBy: r2Cold.grewBy };
  report.drive2Warm = { trace: r2Warm.trace, grewBy: r2Warm.grewBy };

  const n2 = r2Warm.notice;
  const src2 = n2?.source ?? {};
  const text2 = Array.isArray(n2?.content) ? n2.content.map((b) => b?.text ?? '').join('\n') : '';
  report.notice = { source: preview(src2), text: text2, frozen: n2 === undefined ? null : Object.isFrozen(n2), role: n2?.role };
  check(
    '2.notice-shape',
    2,
    'warm turn: decision.messages grows by exactly the notice, source {kind: code-gate, form: notice}, text names a.js',
    r2Warm.added !== undefined &&
      src2.kind === 'code-gate' &&
      src2.form === 'notice' &&
      src2.summary === '1 edit(s), nothing run' &&
      text2.includes('a.js') &&
      n2?.role === 'user' &&
      Object.isFrozen(n2) === true &&
      r2Warm.returned !== r2Warm.decision &&
      r2Warm.returned.messages[r2Warm.returned.messages.length - 1] === n2,
    { grewBy: r2Warm.grewBy, lastIsNotice: r2Warm.returned.messages[r2Warm.returned.messages.length - 1] === n2, source: preview(src2), textHead: text2.slice(0, 200), frozen: n2 === undefined ? null : Object.isFrozen(n2) },
  );
  check(
    '2.cold-order',
    2,
    "F2 regression: the spec's literal item-2 order (tools delivered before the turn's first agent/pre-step) fires the notice",
    r2Cold.added !== undefined && r2Cold.notice?.source?.kind === 'code-gate' && r2Cold.notice?.source?.form === 'notice',
    { grewBy: r2Cold.grewBy, trace: r2Cold.trace, source: preview(r2Cold.notice?.source), expected: 'notice fires under the literal item-2 wording' },
  );
  // F2 regression (second half): in that same cold ordering the durable entry must carry the turn number.
  const beforeCold4 = journalState();
  await turnStopping(r2Cold.ctx, { turn: 1, signal: undefined, agent: r2Cold.agent });
  const afterCold4 = journalState();
  const coldEntry = afterCold4.parsed.slice(beforeCold4.parsed.length).pop();
  check(
    '4.cold-order-turn',
    4,
    "F2 regression: tools-first ordering, then a pre-step, then turn-stopping writes an entry carrying turn:1",
    afterCold4.lines.length === beforeCold4.lines.length + 1 &&
      coldEntry?.kind === 'unverified' &&
      coldEntry?.turn === 1 &&
      coldEntry?.edits?.[0] === 'edit a.js',
    { linesBefore: beforeCold4.lines.length, linesAfter: afterCold4.lines.length, entry: preview(coldEntry) },
  );
  check(
    '2.apply-undefined-notice',
    2,
    "F1 regression: apply(ctx, undefined) with the spec's sequence now fires the notice (defaults are inlined by resolveLists)",
    r2Literal.added !== undefined && r2Literal.notice?.source?.kind === 'code-gate',
    { grewBy: r2Literal.grewBy, trace: r2Literal.trace, expected: 'notice fires with the schema defaults' },
  );

  check(
    '2.spread-preserves',
    2,
    'the rewritten decision is a spread of the original: kind and extra fields survive, prior messages kept by identity',
    r2Warm.returned.kind === r2Warm.decision.kind &&
      r2Warm.returned.startsRequestSeries === r2Warm.decision.startsRequestSeries &&
      r2Warm.returned.messages[0] === r2Warm.decision.messages[0] &&
      r2Warm.returned.messages.length === r2Warm.decision.messages.length + 1,
    {
      returned: preview({ kind: r2Warm.returned.kind, startsRequestSeries: r2Warm.returned.startsRequestSeries, messages: r2Warm.returned.messages.length }),
      original: preview({ kind: r2Warm.decision.kind, startsRequestSeries: r2Warm.decision.startsRequestSeries, messages: r2Warm.decision.messages.length }),
      firstMessageIdentical: r2Warm.returned.messages[0] === r2Warm.decision.messages[0],
    },
  );

  finding(
    'F1-FIXED',
    'F1 is fixed in the new revision: E:\\tools\\DSH\\dsh-code-mode\\lib\\gate-verify.js:65-71 `resolveLists` now falls back to DEFAULT_EDIT_TOOLS/DEFAULT_RUN_TOOLS/DEFAULT_DOC_EXTENSIONS (declared gate-verify.js:27-33 and shared with Config at gate-verify.js:38-41), and apply() uses it at gate-verify.js:82-83. Verified: 1.config-matrix (raw undefined, raw {}, raw {docExtensions:[]}, explicit lists and cordis-validated defaults all fire), 2.apply-undefined-notice (grewBy 1), 4.apply-undefined-journal (entry for "edit src/literal.js" under session sess-gate-A).',
  );
  finding(
    'F2-FIXED',
    'F2 is fixed in the new revision: E:\\tools\\DSH\\dsh-code-mode\\lib\\gate-verify.js:123-131 now stamps the turn on first observation (`if (record.turn === undefined) record.turn = payload.turn; else if (record.turn !== payload.turn) { ...reset... }`), so tool executions delivered before the turn\'s first agent/pre-step survive it. Verified: 2.cold-order (tools-first drive grewBy 1, notice source kind code-gate) and 4.cold-order-turn (the same ordering\'s journal entry carries "turn":1 with edits ["edit a.js"]).',
  );
  finding(
    'F3-FIXED',
    'F3 is fixed in this revision: E:\\tools\\DSH\\dsh-code-mode\\lib\\gate-verify.js:73-78 `isDoc` now normalises both sides (`typeof extension === "string" && lower.endsWith(extension.toLowerCase())`), so the configured value is matched case-insensitively. Verified: 7h.config-extension-case (this was the inverted probe P1, which observed grewBy 1 / journalDelta 1 for [".MD"] — now [".MD"], [".Md"] and [".md"] all give 0/0), 7i.mixed-case-list ([".MD",".rst"] suppresses notes.md and changelog.rst while changelog.py in the same config still counts), 7j.non-string-entries ([".md",42,null] is inert rather than fatal: notes.md 0/0, src/a.js 1/1, no throw).',
  );
  finding(
    'V7',
    'New behaviour verified as specified: a doc-extension edit is a total no-op for the accounting (gate-verify.js:93-99 with isDoc at :73-77) — no entry pushed, sinceEdit untouched, warned not cleared. 7a notes.md silent (grewBy 0, journalDelta 0), 7b src/a.js still warns + writes, 7c README.MD treated as a doc, 7d a.py treated as code, 7e a doc edit after a warning fires no second notice even after 3 more non-run calls and the doc path never reaches the entry, 7f docExtensions:[] makes .md count as code again, 7g an edit with no target still counts as code (edits ["edit"]).',
  );

  // Which config forms actually arm the gate? (editTools/runTools defaults live only in Config.)
  const matrix = [];
  for (const [label, cfg] of [
    ['raw undefined (apply(ctx, undefined))', undefined],
    ['raw {}', {}],
    ['raw { editTools, runTools } (defaults inlined by hand)', { editTools: ['edit'], runTools: ['pwsh', 'bash', 'shell', 'code_verify'] }],
    ['raw { docExtensions: [] } only (partial raw config)', { docExtensions: [] }],
    ['cordis-validated defaults (what a real load passes)', prodCfg],
  ]) {
    const d = await driveNotice(cfg, { prime: true, turn: 20, label: `mx-${matrix.length}` });
    matrix.push({ config: label, noticeFired: d.added !== undefined, grewBy: d.grewBy });
  }
  report.configMatrix = matrix;
  check(
    '1.config-matrix',
    1,
    'F1 regression: every config form now arms the gate — raw undefined, raw {}, an explicit list, and the cordis-validated defaults all fire the notice',
    matrix.every((m) => m.noticeFired === true),
    matrix,
  );


  await postExecute(r2Warm.ctx, execFor(r2Warm.agent, 'read', { file_path: 'a.js' }));
  const decision2 = ctxDecision();
  const returned2 = await preStep(r2Warm.ctx, { agent: r2Warm.agent, messages: [], turn: 1, step: 3 }, () => decision2);
  check(
    '2.fires-once',
    2,
    'a second pre-step in the same turn adds no second notice',
    returned2 === decision2 && returned2.messages.length === decision2.messages.length,
    { identicalDecisionObject: returned2 === decision2, messages: returned2.messages.length, expected: decision2.messages.length },
  );

  // decision without a messages array
  const ctx3 = makeCtx();
  await gate.apply(ctx3, prodCfg);
  const agent3 = agentFor(PROJ, `${SESSION_A}-nomsg`);
  await preStep(ctx3, { agent: agent3, messages: [], turn: 5, step: 1 }, () => ctxDecision());
  await postExecute(ctx3, execFor(agent3, 'edit', { file_path: 'b.js' }));
  for (let i = 0; i < 3; i += 1) await postExecute(ctx3, execFor(agent3, 'read', { file_path: 'b.js' }));
  const decisionNoMessages = { kind: 'enter' };
  let threw = null;
  let returnedNoMessages;
  try {
    returnedNoMessages = await preStep(ctx3, { agent: agent3, messages: [], turn: 5, step: 2 }, () => decisionNoMessages);
  } catch (e) {
    threw = errInfo(e);
  }
  let returnedUndefined;
  let threwUndefined = null;
  try {
    returnedUndefined = await preStep(ctx3, { agent: agent3, messages: [], turn: 5, step: 3 }, () => undefined);
  } catch (e) {
    threwUndefined = errInfo(e);
  }
  check(
    '2.no-messages-decision',
    2,
    'decision without a messages array (and undefined decision) returns unchanged without throwing',
    threw === null && returnedNoMessages === decisionNoMessages && threwUndefined === null && returnedUndefined === undefined,
    { identicalDecisionObject: returnedNoMessages === decisionNoMessages, returnedUndefined, threw, threwUndefined },
  );

  // ---------------------------------------------------------------- 3. no false positives
  const run3 = async (label, { prime = true, turn = 10, steps }) => {
    const ctx = makeCtx();
    await gate.apply(ctx, prodCfg);
    const agent = agentFor(PROJ, `${SESSION_A}-${label}`);
    if (prime) await preStep(ctx, { agent, messages: [], turn, step: 1 }, () => ctxDecision());
    await steps(ctx, agent);
    const decision = ctxDecision();
    const returned = await preStep(ctx, { agent, messages: [], turn, step: 9 }, () => decision);
    return { ctx, agent, decision, returned, grewBy: returned.messages.length - decision.messages.length };
  };

  const a3a = await run3('run-pwsh', {
    turn: 11,
    steps: async (ctx, agent) => {
      await postExecute(ctx, execFor(agent, 'edit', { file_path: 'c.js' }));
      await postExecute(ctx, execFor(agent, 'pwsh', { command: 'node --test' }));
      for (let i = 0; i < 3; i += 1) await postExecute(ctx, execFor(agent, 'read', { file_path: 'c.js' }));
    },
  });
  // Changed 2026-10-02: a command that ran *outside* `code_verify` records nothing
  // in the ledger, so it is no longer treated as proof. The in-turn notice now
  // names what was run and asks for the evidence to be recorded. Measured before
  // the change: `pwsh` after an edit silenced the gate and left no journal line,
  // so the one place that could have said "an unproven command ran" stayed empty.
  const a3aText = noticeText(a3a.returned, a3a.decision);
  check(
    '3a.run-tool',
    3,
    'edit -> pwsh -> 3 reads -> pre-step: one notice saying the command recorded no evidence',
    a3a.grewBy === 1 && /no recorded evidence|nothing recorded/.test(a3aText) && a3aText.includes('node --test'),
    { grewBy: a3a.grewBy, text: a3aText.slice(0, 300) },
  );

  const a3b = await run3('immediate', {
    turn: 12,
    steps: async (ctx, agent) => {
      await postExecute(ctx, execFor(agent, 'edit', { file_path: 'd.js' }));
    },
  });
  const a3b2 = await run3('two-reads', {
    turn: 13,
    steps: async (ctx, agent) => {
      await postExecute(ctx, execFor(agent, 'edit', { file_path: 'd.js' }));
      await postExecute(ctx, execFor(agent, 'read', { file_path: 'd.js' }));
      await postExecute(ctx, execFor(agent, 'read', { file_path: 'd.js' }));
    },
  });
  check(
    '3b.below-patience',
    3,
    'edit -> pre-step immediately (sinceEdit=0) and edit -> 2 reads (sinceEdit=2): no notice',
    a3b.grewBy === 0 && a3b2.grewBy === 0,
    { sinceEdit0: a3b.grewBy, sinceEdit2: a3b2.grewBy, patience: prodCfg.patience },
  );

  const a3c = await run3('code-verify', {
    turn: 14,
    steps: async (ctx, agent) => {
      await postExecute(ctx, execFor(agent, 'edit', { file_path: 'e.js' }));
      await postExecute(ctx, execFor(agent, 'code_verify', { cmd: 'node --test' }));
      for (let i = 0; i < 3; i += 1) await postExecute(ctx, execFor(agent, 'read', { file_path: 'e.js' }));
    },
  });
  check('3c.code-verify-counts', 3, 'code_verify counts as a run', a3c.grewBy === 0, { grewBy: a3c.grewBy });

  // (d) exec objects without an agent are ignored
  const ctx3d = makeCtx();
  await gate.apply(ctx3d, prodCfg);
  const agent3d = agentFor(PROJ, `${SESSION_A}-noagent`);
  await preStep(ctx3d, { agent: agent3d, messages: [], turn: 15, step: 1 }, () => ctxDecision());
  for (const e of [
    { name: 'edit', arguments: { file_path: 'f.js' } },
    { name: 'edit', arguments: { file_path: 'g.js' } },
    { name: 'write', arguments: { path: 'h.js' } },
    { name: 'read', arguments: { file_path: 'f.js' } },
    { name: 'read', arguments: { file_path: 'f.js' } },
    { name: 'read', arguments: { file_path: 'f.js' } },
  ]) {
    await postExecute(ctx3d, e); // no agent property at all
  }
  const decision3d = ctxDecision();
  const returned3d = await preStep(ctx3d, { agent: agent3d, messages: [], turn: 15, step: 2 }, () => decision3d);
  check(
    '3d.agentless-exec-ignored',
    3,
    'exec objects without an agent record nothing (no notice for the real agent)',
    returned3d.messages.length === decision3d.messages.length,
    { grewBy: returned3d.messages.length - decision3d.messages.length },
  );

  // (e) a new user message in payload.messages resets the accounting
  const ctx3e = makeCtx();
  await gate.apply(ctx3e, prodCfg);
  const agent3e = agentFor(PROJ, `${SESSION_A}-usermsg`);
  await preStep(ctx3e, { agent: agent3e, messages: [], turn: 16, step: 1 }, () => ctxDecision());
  await postExecute(ctx3e, execFor(agent3e, 'edit', { file_path: 'i.js' }));
  for (let i = 0; i < 3; i += 1) await postExecute(ctx3e, execFor(agent3e, 'read', { file_path: 'i.js' }));
  const decision3e = ctxDecision();
  const returned3e = await preStep(ctx3e, { agent: agent3e, messages: [userMsg()], turn: 16, step: 2 }, () => decision3e);
  const decision3e2 = ctxDecision();
  const returned3e2 = await preStep(ctx3e, { agent: agent3e, messages: [], turn: 16, step: 3 }, () => decision3e2);
  check(
    '3e.user-message-resets',
    3,
    'a user-source message in payload.messages clears the accounting (no notice now or on the next pre-step)',
    returned3e.messages.length === decision3e.messages.length && returned3e2.messages.length === decision3e2.messages.length,
    { withUserMessage: returned3e.messages.length - decision3e.messages.length, nextPreStep: returned3e2.messages.length - decision3e2.messages.length },
  );

  // (f) a new turn number resets it too, and the gate re-arms in the new turn
  const ctx3f = makeCtx();
  await gate.apply(ctx3f, prodCfg);
  const agent3f = agentFor(PROJ, `${SESSION_A}-newturn`);
  await preStep(ctx3f, { agent: agent3f, messages: [], turn: 17, step: 1 }, () => ctxDecision());
  await postExecute(ctx3f, execFor(agent3f, 'edit', { file_path: 'j.js' }));
  for (let i = 0; i < 3; i += 1) await postExecute(ctx3f, execFor(agent3f, 'read', { file_path: 'j.js' }));
  const decision3f = ctxDecision();
  const returned3f = await preStep(ctx3f, { agent: agent3f, messages: [], turn: 18, step: 1 }, () => decision3f);
  await postExecute(ctx3f, execFor(agent3f, 'edit', { file_path: 'k.js' }));
  for (let i = 0; i < 3; i += 1) await postExecute(ctx3f, execFor(agent3f, 'read', { file_path: 'k.js' }));
  const decision3f2 = ctxDecision();
  const returned3f2 = await preStep(ctx3f, { agent: agent3f, messages: [], turn: 18, step: 2 }, () => decision3f2);
  const notice3f2 = returned3f2.messages[returned3f2.messages.length - 1];
  check(
    '3f.new-turn-resets',
    3,
    'a new turn number clears the previous turn\'s edits (no notice), and a later edit in the new turn still warns',
    returned3f.messages.length === decision3f.messages.length &&
      returned3f2.messages.length === decision3f2.messages.length + 1 &&
      notice3f2?.source?.kind === 'code-gate',
    {
      turn18PreStep: returned3f.messages.length - decision3f.messages.length,
      laterEditInTurn18: returned3f2.messages.length - decision3f2.messages.length,
      laterNoticeText: preview(notice3f2?.content?.[0]?.text, 120),
    },
  );

  // ---------------------------------------------------------------- 4. durable debt
  const ctx4Literal = makeCtx();
  await gate.apply(ctx4Literal, undefined);
  const agent4L = agentFor(PROJ, SESSION_A);
  await postExecute(ctx4Literal, execFor(agent4L, 'edit', { file_path: 'src/literal.js' }));
  await turnStopping(ctx4Literal, { turn: 1, signal: undefined, agent: agent4L });
  const afterLiteral = journalState();
  check(
    '4.apply-undefined-journal',
    4,
    'F1 regression: edit -> turn-stopping under apply(ctx, undefined) now writes the journal entry',
    afterLiteral.exists &&
      unverifiedOf(afterLiteral).length >= 1 &&
      unverifiedOf(afterLiteral).some((e) => e.edits?.includes('edit src/literal.js') && e.session === SESSION_A),
    { journalExists: afterLiteral.exists, unverifiedCount: unverifiedOf(afterLiteral).length, parsed: preview(afterLiteral.parsed, 300) },
  );

  const ctx4 = makeCtx();
  await gate.apply(ctx4, prodCfg);
  const agent4 = agentFor(PROJ, SESSION_A);
  const before4 = journalState();
  await postExecute(ctx4, execFor(agent4, 'edit', { file_path: 'src/a.js' }));
  await turnStopping(ctx4, { turn: 1, signal: undefined, agent: agent4 });
  const afterEdit = journalState();
  const newEntries = afterEdit.parsed.slice(before4.parsed.length);
  const entry = newEntries[newEntries.length - 1];
  check(
    '4.journal-entry',
    4,
    "edit -> turn-stopping writes journal.jsonl {kind:'unverified', edits:['edit src/a.js'], session:'sess-gate-A'}",
    afterEdit.exists &&
      newEntries.length === 1 &&
      entry?.kind === 'unverified' &&
      Array.isArray(entry.edits) &&
      entry.edits.length === 1 &&
      entry.edits[0] === 'edit src/a.js' &&
      entry.session === SESSION_A &&
      typeof entry.ts === 'string',
    {
      path: JOURNAL,
      newEntryCount: newEntries.length,
      entry: preview(entry),
      lineCount: afterEdit.lines.length,
      turnKeyPresent: entry !== undefined && 'turn' in entry,
    },
  );

  // `turn` is only ever set by agent/pre-step, so this spec-literal drive (no pre-step)
  // leaves it undefined and JSON.stringify drops the key. Re-drive in loop order.
  const ctx4t = makeCtx();
  await gate.apply(ctx4t, prodCfg);
  const agent4t = agentFor(PROJ, SESSION_A);
  await preStep(ctx4t, { turn: 9, step: 1, messages: [], signal: undefined, agent: agent4t }, () => ctxDecision());
  await postExecute(ctx4t, execFor(agent4t, 'edit', { file_path: 'src/turn9.js' }));
  const before4t = journalState();
  await turnStopping(ctx4t, { turn: 9, signal: undefined, agent: agent4t });
  const after4t = journalState();
  const entryT = after4t.parsed.slice(before4t.parsed.length).pop();
  check(
    '4.turn-label',
    4,
    'the turn number is stamped once the turn has had any pre-step (including one delivered after the tools, per F2), and is absent only when no pre-step was ever delivered',
    entry !== undefined && 'turn' in entry === false && entryT?.turn === 9 && entryT?.edits?.[0] === 'edit src/turn9.js',
    { withoutPreStep: preview(entry), withPreStep: preview(entryT) },
  );

  const before4b = journalState();
  await postExecute(ctx4, execFor(agent4, 'edit', { file_path: 'src/b.js' }));
  await postExecute(ctx4, execFor(agent4, 'pwsh', { command: 'node --test' }));
  await turnStopping(ctx4, { turn: 2, signal: undefined, agent: agent4 });
  const after4b = journalState();
  const ranEntry = after4b.parsed.slice(before4b.parsed.length).pop();
  check(
    '4.verified-turn-silent',
    4,
    'edit -> pwsh (no recorded evidence) -> turn-stopping writes a debt saying a command ran unproven',
    after4b.lines.length === before4b.lines.length + 1 &&
      ranEntry?.kind === 'unverified' &&
      ranEntry?.state === 'ran' &&
      Array.isArray(ranEntry?.commands) &&
      ranEntry.commands.includes('node --test'),
    { linesBefore: before4b.lines.length, linesAfter: after4b.lines.length, entry: preview(ranEntry) },
  );

  // ... while `code_verify` records its own evidence, so the turn closes silently.
  const before4v = journalState();
  await postExecute(ctx4, execFor(agent4, 'edit', { file_path: 'src/c.js' }));
  await postExecute(ctx4, execFor(agent4, 'code_verify', { cmd: 'node --test' }));
  await turnStopping(ctx4, { turn: 3, signal: undefined, agent: agent4 });
  const after4v = journalState();
  check(
    '4.code-verify-closes-silently',
    4,
    'edit -> code_verify -> turn-stopping writes no debt at all',
    after4v.lines.length === before4v.lines.length,
    { linesBefore: before4v.lines.length, linesAfter: after4v.lines.length },
  );

  // ... and a turn with no command at all still records the original debt, so the
  // two cases stay distinguishable in the journal.
  const before4n = journalState();
  await postExecute(ctx4, execFor(agent4, 'edit', { file_path: 'src/d.js' }));
  await turnStopping(ctx4, { turn: 4, signal: undefined, agent: agent4 });
  const after4n = journalState();
  const noneEntry = after4n.parsed.slice(before4n.parsed.length).pop();
  check(
    '4.no-command-state',
    4,
    'edit -> nothing run -> the debt is stamped state:"none", not "ran"',
    noneEntry?.kind === 'unverified' && noneEntry?.state === 'none' && noneEntry?.commands === undefined,
    { entry: preview(noneEntry) },
  );

  // guard rails: turn-stopping with no state, and with no known cwd
  const ctx4c = makeCtx();
  await gate.apply(ctx4c, prodCfg);
  const linesBefore4c = journalState().lines.length;
  let threw4c = null;
  try {
    await turnStopping(ctx4c, { turn: 3, signal: undefined, agent: agentFor(PROJ, SESSION_A) });
    const noCwd = { session: { id: SESSION_A, header: {} } };
    await postExecute(ctx4c, execFor(noCwd, 'edit', { file_path: 'no-cwd.js' }));
    await turnStopping(ctx4c, { turn: 3, signal: undefined, agent: noCwd });
  } catch (e) {
    threw4c = errInfo(e);
  }
  const after4c = journalState();
  check(
    '4.guard-rails',
    4,
    'turn-stopping with no recorded state, and with an unknown cwd, writes nothing and does not throw',
    threw4c === null && after4c.lines.length === linesBefore4c,
    { threw: threw4c, linesBefore: linesBefore4c, linesAfter: after4c.lines.length },
  );

  // ---------------------------------------------------------------- 5. brief surfacing
  const st5 = journalState();
  report.journal.unverified = unverifiedOf(st5);
  say(`journal.jsonl now:\n${st5.lines.join('\n')}`);
  const briefOther = ledger.brief(PROJ, { session: SESSION_B });
  const briefOwn = ledger.brief(PROJ, { session: SESSION_A });
  const HEAD = '## Turns that changed code and ran nothing';
  check(
    '5.brief-other-session',
    5,
    `brief(cwd, { session: '${SESSION_B}' }) shows the unverified section naming src/a.js`,
    briefOther.text.includes(HEAD) && briefOther.text.includes('src/a.js'),
    { hasSection: briefOther.text.includes(HEAD), namesPath: briefOther.text.includes('src/a.js'), sectionExcerpt: preview(briefOther.text.split(HEAD)[1]?.slice(0, 220), 260) },
  );
  check(
    '5.brief-own-session',
    5,
    `brief(cwd, { session: '${SESSION_A}' }) omits the section (a session does not distrust itself)`,
    !briefOwn.text.includes(HEAD),
    { hasSection: briefOwn.text.includes(HEAD), unverifiedRows: ledger.brief(PROJ, { session: undefined }).text.includes(HEAD) },
  );
  const ownRow = briefOwn.text.split('## Recent ledger entries')[1]?.split('\n').find((l) => l.includes('unverified'));
  const otherRow = briefOther.text.split('## Recent ledger entries')[1]?.split('\n').find((l) => l.includes('unverified'));
  check(
    '5.recent-journal-detail',
    5,
    "recentJournal renders the unverified row as 'N edit(s), ran nothing' (surfaced through brief)",
    typeof ownRow === 'string' && ownRow.includes('1 edit(s), ran nothing') && typeof otherRow === 'string' && otherRow.includes('1 edit(s), ran nothing'),
    { ownRow: ownRow ?? null, otherRow: otherRow ?? null },
  );
  report.brief = {
    otherSessionHasSection: briefOther.text.includes(HEAD),
    ownSessionHasSection: briefOwn.text.includes(HEAD),
    empty: briefOther.empty,
    chars: briefOther.text.length,
  };

  // ---------------------------------------------------------------- 6. encoding
  const agentCN = agentFor(PROJ, SESSION_CN);
  const cnTarget = 'src/中文模块.js';
  await postExecute(ctx4, execFor(agentCN, 'edit', { file_path: cnTarget }));
  await turnStopping(ctx4, { turn: 1, signal: undefined, agent: agentCN });
  const st6 = journalState();
  const cnEntry = unverifiedOf(st6).find((e) => e.session === SESSION_CN);
  const cnLine = st6.lines.find((l) => l.includes(SESSION_CN));
  const allParse = st6.parsed.every((e) => e.__parseError === undefined);
  check(
    '6.utf8-roundtrip',
    6,
    'every journal line is valid JSON, and a Chinese edit target round-trips exactly as raw UTF-8',
    allParse &&
      st6.exists &&
      cnEntry !== undefined &&
      cnEntry.edits[0] === `edit ${cnTarget}` &&
      typeof cnLine === 'string' &&
      cnLine.includes(cnTarget) &&
      !cnLine.includes('\\u') &&
      JSON.stringify(cnEntry) === cnLine.replace(/^/, '').trim() &&
      !cnLine.includes('\uFFFD'),
    {
      allLinesParse: allParse,
      lineCount: st6.lines.length,
      rawLine: preview(cnLine, 260),
      parsedEdits: preview(cnEntry?.edits),
      exactMatch: cnEntry?.edits?.[0] === `edit ${cnTarget}`,
      noUnicodeEscapes: typeof cnLine === 'string' && !cnLine.includes('\\u'),
      noReplacementChar: typeof cnLine === 'string' && !cnLine.includes('\uFFFD'),
      reStringifyEqualsLine: typeof cnLine === 'string' && JSON.stringify(cnEntry) === cnLine.trim(),
    },
  );

  // ---------------------------------------------------------------- 7. documentation edits
  // An edit whose target ends with a doc extension must be a total no-op for the accounting:
  // no entry pushed, sinceEdit untouched, warned not cleared.
  const docDrive = async ({ cfg, args, tool = 'edit', label, extraDocEdit }) => {
    const ctx = makeCtx();
    await gate.apply(ctx, cfg);
    const agent = agentFor(PROJ, `${SESSION_A}-${label}`);
    const turn = 30;
    const linesBefore = journalState().lines.length;
    await postExecute(ctx, execFor(agent, tool, args));
    for (let i = 0; i < 3; i += 1) await postExecute(ctx, execFor(agent, 'read', { file_path: 'x.js' }));
    const decision = ctxDecision();
    const returned = await preStep(ctx, { agent, messages: [], turn, step: 2 }, () => decision);
    const grewBy = (Array.isArray(returned?.messages) ? returned.messages.length : 0) - decision.messages.length;
    let secondGrewBy = null;
    if (extraDocEdit !== undefined) {
      // (e) a doc edit AFTER the warning must not re-arm it: follow it with 3 more non-run
      // calls, so a doc edit wrongly counted as code would push sinceEdit back to patience.
      await postExecute(ctx, execFor(agent, extraDocEdit.tool ?? 'edit', extraDocEdit.args));
      for (let i = 0; i < 3; i += 1) await postExecute(ctx, execFor(agent, 'read', { file_path: 'x.js' }));
      const decision2 = ctxDecision();
      const returned2 = await preStep(ctx, { agent, messages: [], turn, step: 3 }, () => decision2);
      secondGrewBy = (Array.isArray(returned2?.messages) ? returned2.messages.length : 0) - decision2.messages.length;
    }
    await turnStopping(ctx, { turn, signal: undefined, agent });
    const after = journalState();
    const entry = after.parsed.slice(linesBefore).pop();
    return {
      grewBy,
      secondGrewBy,
      journalDelta: after.lines.length - linesBefore,
      entry,
      lastText: Array.isArray(returned?.messages) ? returned.messages[returned.messages.length - 1]?.content?.[0]?.text : undefined,
    };
  };

  const d7a = await docDrive({ cfg: prodCfg, args: { file_path: 'notes.md' }, label: 'doc-md' });
  check(
    '7a.doc-edit-silent',
    7,
    'edit notes.md -> 3 non-run calls -> pre-step: no notice, and turn-stopping writes no journal entry',
    d7a.grewBy === 0 && d7a.journalDelta === 0,
    { grewBy: d7a.grewBy, journalDelta: d7a.journalDelta },
  );

  const d7b = await docDrive({ cfg: prodCfg, args: { file_path: 'src/a.js' }, label: 'doc-code-regression' });
  check(
    '7b.code-edit-still-counts',
    7,
    'regression guard: the same sequence with edit src/a.js still fires the notice and writes the entry',
    d7b.grewBy === 1 && d7b.journalDelta === 1 && d7b.entry?.edits?.[0] === 'edit src/a.js' && d7b.lastText?.includes('src/a.js'),
    { grewBy: d7b.grewBy, journalDelta: d7b.journalDelta, entry: preview(d7b.entry) },
  );

  const d7c = await docDrive({ cfg: prodCfg, args: { file_path: 'README.MD' }, label: 'doc-upper' });
  check(
    '7c.uppercase-doc',
    7,
    'edit README.MD (uppercase target) is treated as a doc',
    d7c.grewBy === 0 && d7c.journalDelta === 0,
    { grewBy: d7c.grewBy, journalDelta: d7c.journalDelta },
  );

  const d7d = await docDrive({ cfg: prodCfg, args: { file_path: 'a.py' }, label: 'doc-py' });
  check(
    '7d.non-doc-extension',
    7,
    'edit a.py is treated as code',
    d7d.grewBy === 1 && d7d.journalDelta === 1 && d7d.entry?.edits?.[0] === 'edit a.py',
    { grewBy: d7d.grewBy, journalDelta: d7d.journalDelta, entry: preview(d7d.entry) },
  );

  const d7e = await docDrive({
    cfg: prodCfg,
    args: { file_path: 'src/warn.js' },
    label: 'doc-after-warning',
    extraDocEdit: { args: { file_path: 'notes.md' } },
  });
  check(
    '7e.doc-edit-does-not-rearm',
    7,
    'a doc edit after a code edit already warned fires no second notice, and the doc path is absent from the entry',
    d7e.grewBy === 1 &&
      d7e.secondGrewBy === 0 &&
      d7e.journalDelta === 1 &&
      d7e.entry?.edits?.length === 1 &&
      d7e.entry?.edits?.[0] === 'edit src/warn.js',
    { firstPreStep: d7e.grewBy, afterDocEdit: d7e.secondGrewBy, journalDelta: d7e.journalDelta, entry: preview(d7e.entry) },
  );

  const d7f = await docDrive({ cfg: { docExtensions: [] }, args: { file_path: 'notes.md' }, label: 'doc-disabled' });
  check(
    '7f.docExtensions-empty',
    7,
    'apply(ctx, { docExtensions: [] }) makes a .md edit count as code again',
    d7f.grewBy === 1 && d7f.journalDelta === 1 && d7f.entry?.edits?.[0] === 'edit notes.md',
    { grewBy: d7f.grewBy, journalDelta: d7f.journalDelta, entry: preview(d7f.entry) },
  );

  const d7g = await docDrive({ cfg: prodCfg, args: {}, label: 'doc-no-target' });
  check(
    '7g.unknown-target-is-code',
    7,
    'an edit with no target path (unknown target) still counts as code, conservatively',
    d7g.grewBy === 1 && d7g.journalDelta === 1 && d7g.entry?.edits?.[0] === 'edit',
    { grewBy: d7g.grewBy, journalDelta: d7g.journalDelta, entry: preview(d7g.entry) },
  );

  // 7h: the flipped F3 probe (previously the deliberately-inverted `P1.config-extension-case`).
  // A configured extension is now normalised, so an uppercase or mixed-case value matches.
  const d7h = await docDrive({ cfg: { docExtensions: ['.MD'] }, args: { file_path: 'notes.md' }, label: 'doc-cfg-upper' });
  const d7h2 = await docDrive({ cfg: { docExtensions: ['.md'] }, args: { file_path: 'notes.md' }, label: 'doc-cfg-lower' });
  const d7h3 = await docDrive({ cfg: { docExtensions: ['.Md'] }, args: { file_path: 'notes.md' }, label: 'doc-cfg-mixedcase' });
  check(
    '7h.config-extension-case',
    7,
    'F3 fix: the configured extension is normalised — [".MD"], [".Md"] and [".md"] all suppress the notes.md edit (this was probe P1, which observed grewBy 1 / journalDelta 1 for [".MD"])',
    d7h.grewBy === 0 && d7h.journalDelta === 0 && d7h2.grewBy === 0 && d7h2.journalDelta === 0 && d7h3.grewBy === 0 && d7h3.journalDelta === 0,
    {
      configuredUpperMD: { grewBy: d7h.grewBy, journalDelta: d7h.journalDelta },
      configuredLowerMD: { grewBy: d7h2.grewBy, journalDelta: d7h2.journalDelta },
      configuredMixedCaseMd: { grewBy: d7h3.grewBy, journalDelta: d7h3.journalDelta },
    },
  );

  // 7i: a mixed-case, multi-entry list must still classify by extension, not by position.
  const mixed = { docExtensions: ['.MD', '.rst'] };
  const d7i = await docDrive({ cfg: mixed, args: { file_path: 'notes.md' }, label: 'doc-mixed-md' });
  const d7i2 = await docDrive({ cfg: mixed, args: { file_path: 'changelog.rst' }, label: 'doc-mixed-rst' });
  const d7i3 = await docDrive({ cfg: mixed, args: { file_path: 'changelog.py' }, label: 'doc-mixed-py' });
  check(
    '7i.mixed-case-list',
    7,
    'docExtensions: [".MD", ".rst"] suppresses notes.md and changelog.rst, while changelog.py in the same configuration still counts as code',
    d7i.grewBy === 0 && d7i.journalDelta === 0 && d7i2.grewBy === 0 && d7i2.journalDelta === 0 && d7i3.grewBy === 1 && d7i3.journalDelta === 1 && d7i3.entry?.edits?.[0] === 'edit changelog.py',
    {
      notesMd: { grewBy: d7i.grewBy, journalDelta: d7i.journalDelta },
      changelogRst: { grewBy: d7i2.grewBy, journalDelta: d7i2.journalDelta },
      changelogPy: { grewBy: d7i3.grewBy, journalDelta: d7i3.journalDelta, entry: preview(d7i3.entry) },
    },
  );

  // 7j: hostile list entries must be inert rather than fatal. cordis would reject such a config up
  // front (docExtensions is z.array(z.string())), so this guards the direct `apply(ctx, cfg)` path.
  const nsCfg = { docExtensions: ['.md', 42, null] };
  const nsDocDecision = ctxDecision();
  const nsCodeDecision = ctxDecision();
  let nsDocGrewBy = -1;
  let nsDocJournalDelta = -1;
  let nsCodeGrewBy = -1;
  let nsJournalDelta = -1;
  let nsEntry;
  let nsError;
  const nsTrace = [];
  try {
    const nsCtxDoc = makeCtx();
    await gate.apply(nsCtxDoc, nsCfg);
    const nsAgentDoc = agentFor(PROJ, `${SESSION_A}-nonstring-doc`);
    const nsDocBefore = journalState().lines.length;
    await postExecute(nsCtxDoc, execFor(nsAgentDoc, 'edit', { file_path: 'notes.md' }));
    for (let i = 0; i < 3; i += 1) await postExecute(nsCtxDoc, execFor(nsAgentDoc, 'read', { file_path: 'x.js' }));
    const nsDocReturned = await preStep(nsCtxDoc, { agent: nsAgentDoc, messages: [], turn: 40, step: 2 }, () => nsDocDecision);
    nsDocGrewBy = (Array.isArray(nsDocReturned?.messages) ? nsDocReturned.messages.length : 0) - nsDocDecision.messages.length;
    await turnStopping(nsCtxDoc, { turn: 40, signal: undefined, agent: nsAgentDoc });
    nsDocJournalDelta = journalState().lines.length - nsDocBefore;
    nsTrace.push('notes.md');

    const nsCtxCode = makeCtx();
    await gate.apply(nsCtxCode, nsCfg);
    const nsAgentCode = agentFor(PROJ, `${SESSION_A}-nonstring-code`);
    const nsBefore = journalState().lines.length;
    await postExecute(nsCtxCode, execFor(nsAgentCode, 'edit', { file_path: 'src/a.js' }));
    for (let i = 0; i < 3; i += 1) await postExecute(nsCtxCode, execFor(nsAgentCode, 'read', { file_path: 'x.js' }));
    const nsCodeReturned = await preStep(nsCtxCode, { agent: nsAgentCode, messages: [], turn: 41, step: 2 }, () => nsCodeDecision);
    nsCodeGrewBy = (Array.isArray(nsCodeReturned?.messages) ? nsCodeReturned.messages.length : 0) - nsCodeDecision.messages.length;
    await turnStopping(nsCtxCode, { turn: 41, signal: undefined, agent: nsAgentCode });
    const nsAfter = journalState();
    nsJournalDelta = nsAfter.lines.length - nsBefore;
    nsEntry = nsAfter.parsed.slice(nsBefore).pop();
    nsTrace.push('src/a.js');
  } catch (error) {
    nsError = `${error?.name}: ${error?.message} @ ${(error?.stack ?? '').split('\n')[1]?.trim() ?? 'no-frame'}`;
  }
  check(
    '7j.non-string-entries',
    7,
    'docExtensions: [".md", 42, null] is inert, not fatal: notes.md still suppressed (0 notice / 0 entry), src/a.js still counted (notice + entry), nothing throws across the drive',
    nsError === undefined &&
      nsDocGrewBy === 0 &&
      nsDocJournalDelta === 0 &&
      nsCodeGrewBy === 1 &&
      nsJournalDelta === 1 &&
      nsEntry?.edits?.[0] === 'edit src/a.js',
    {
      error: nsError ?? null,
      completedSteps: nsTrace.join(' -> '),
      notesMd: { grewBy: nsDocGrewBy, journalDelta: nsDocJournalDelta },
      srcAJs: { grewBy: nsCodeGrewBy, journalDelta: nsJournalDelta, entry: preview(nsEntry) },
    },
  );

  // Sharper, mechanism-isolating form of item 5: by now other sessions have written entries,
  // so the own-session brief shows the section — it must never show its OWN paths in it.
  const briefOwnLate = ledger.brief(PROJ, { session: SESSION_A });
  const lateSection = briefOwnLate.text.split(HEAD)[1] ?? '';
  check(
    '5.own-session-row-filter',
    5,
    'with other sessions present, the own-session brief shows the section but filters out its own entries (no src/turn9.js, no src/literal.js, no "edit a.js")',
    briefOwnLate.text.includes(HEAD) &&
      !lateSection.includes('src/turn9.js') &&
      !lateSection.includes('src/literal.js') &&
      !lateSection.includes('edit a.js'),
    { hasSection: briefOwnLate.text.includes(HEAD), sectionExcerpt: preview(lateSection.slice(0, 300), 340) },
  );

  const finalJournal = journalState();
  report.docCases = [
    ['7a notes.md', d7a],
    ['7b src/a.js', d7b],
    ['7c README.MD', d7c],
    ['7d a.py', d7d],
    ['7e src/warn.js then notes.md', d7e],
    ['7f docExtensions:[] + notes.md', d7f],
    ['7g edit with no target', d7g],
    ['7h docExtensions:[".MD"] + notes.md', d7h],
    ['7h docExtensions:[".md"] + notes.md', d7h2],
    ['7h docExtensions:[".Md"] + notes.md', d7h3],
    ['7i docExtensions:[".MD",".rst"] + notes.md', d7i],
    ['7i docExtensions:[".MD",".rst"] + changelog.rst', d7i2],
    ['7i docExtensions:[".MD",".rst"] + changelog.py', d7i3],
    ['7j docExtensions:[".md",42,null] + notes.md', { grewBy: nsDocGrewBy, secondGrewBy: null, journalDelta: nsDocJournalDelta, entry: undefined }],
    ['7j docExtensions:[".md",42,null] + src/a.js', { grewBy: nsCodeGrewBy, secondGrewBy: null, journalDelta: nsJournalDelta, entry: nsEntry }],
  ].map(([label, r]) => ({
    case: label,
    noticeFired: r.grewBy === 1,
    grewBy: r.grewBy,
    afterDocEdit: r.secondGrewBy,
    journalDelta: r.journalDelta,
    edits: r.entry?.edits,
  }));
  say('');
  say('item 7 doc-extension cases:');
  for (const c of report.docCases) say(`  ${JSON.stringify(c)}`);

  report.journal.final = {
    path: JOURNAL,
    lines: finalJournal.lines,
    parsed: finalJournal.parsed,
    bytes: fs.statSync(JOURNAL).size,
  };
}

// ---------------------------------------------------------------- wrap up
const failed = checks.filter((c) => c.pass !== true);
report.checks = checks;
report.summary = { total: checks.length, passed: checks.length - failed.length, failed: failed.map((c) => c.id) };
say('');
say(`checks: ${report.summary.passed}/${report.summary.total} passed; failed: ${failed.length === 0 ? '(none)' : failed.map((c) => c.id).join(', ')}`);
fs.writeFileSync(OUT_LOG, `${log.join('\n')}\n`, 'utf8');
fs.writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

// stdout: one compact JSON line by default, the full result object with --all (see the header).
// Every check, the summary and the exit code are identical either way — only this line differs.
const CONFIG_STDOUT_MAX = 400;
const compact = { summary: report.summary, findings: report.findings.map((f) => f.id), report: OUT_JSON };
if ((report.configSize ?? JSON.stringify(report.config ?? null).length) < CONFIG_STDOUT_MAX) compact.config = report.config;
console.log(JSON.stringify(stdoutAll ? { summary: report.summary, findings: report.findings, routing: report.routing, config: report.config } : compact));
process.exitCode = failed.length === 0 ? 0 : 1;
