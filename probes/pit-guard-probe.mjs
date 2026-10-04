/**
 * Pit-guard probe: the read side of `mistakes.md`, and the debt for a failing
 * turn that wrote nothing down.
 *
 * Each check is a behaviour that was missing on 2026-10-02 (the mode recorded
 * mistakes and read them only at session start, so "do not repeat" never arrived
 * at the moment of the edit; and a pit the model worked through but never filed
 * died with the conversation):
 *   G  editing a file a known mistake names delivers that entry's rule, once
 *   H  an unrelated edit, or a forbidden edit tool, delivers nothing
 *   J  a failing command run that recorded no mistake becomes a debt the next
 *      brief opens with, and recording a mistake settles it
 *   T  a `trigger:` on an entry fires for the run-tool call it names — once per
 *      session, whichever argument carries the command — and the machine-wide
 *      ledger (`DSH_CODE_GLOBAL_DIR`) is consulted on the command side and the
 *      file side alike
 *
 * Needs the Electron binary, because `lib/pit-guard.js` imports `@deepseek-ai/*`:
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & '<install>\DeepSeek Harness.exe' --expose-internals '<pkg>\probes\pit-guard-probe.mjs'
 *
 * `DSH_CODE_MODE_LIB` points every probe at another checkout of `lib/` (used to
 * verify a staged change before it is copied into the package).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIB_DIR, installResolution, tempReport } from './paths.mjs';

const libDir = process.env.DSH_CODE_MODE_LIB ?? LIB_DIR;
// `DSH_PROBE_REPORT` lets a parent with no stdout pipe read the verdict (see
// `acceptance-probe.mjs` for why that matters to `debt-audit.mjs`).
const OUT = process.env.DSH_PROBE_REPORT ?? tempReport('pit-guard-report.json');

await installResolution();
const ledger = await import(pathToFileURL(path.join(libDir, 'ledger.js')).href);
const pit = await import(pathToFileURL(path.join(libDir, 'pit-guard.js')).href);

const SESSION = 'sess-pit-probe';
const OTHER = 'sess-pit-earlier';

const checks = [];
const check = (id, name, ok, evidence) => checks.push({ id, name, ok: ok === true, evidence });

// --------------------------------------------------------------- stub cordis ctx
function makeCtx() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
  };
}
const handlersOf = (ctx, event) => ctx.handlers.get(event) ?? [];
/** Cordis waterfall: next() runs the next listener, else the fallback decision. */
async function waterfall(handlers, args, fallback) {
  let i = 0;
  const next = () =>
    i >= handlers.length
      ? Promise.resolve(typeof fallback === 'function' ? fallback() : fallback)
      : Promise.resolve(handlers[i++](...args, next));
  return next();
}
let seq = 0;
const agentFor = (cwd, id) => ({ session: { id, header: { cwd } } });
const execFor = (agent, name, args) => ({ token: 't', callId: `c${++seq}`, rootCallId: `c${seq}`, name, agent, arguments: args });
const preExecute = (ctx, exec) => waterfall(handlersOf(ctx, 'tools/pre-execute'), [exec], { kind: 'accept' });
const postExecute = (ctx, exec, result) =>
  waterfall(handlersOf(ctx, 'tools/post-execute'), [exec, result], { kind: 'accept' });
const preStep = (ctx, payload) =>
  waterfall(handlersOf(ctx, 'agent/pre-step'), [payload], () => ({ messages: [] }));
const turnStopping = async (ctx, payload) => {
  for (const handler of handlersOf(ctx, 'agent/turn-stopping')) await handler(payload);
};
/** Text of the notices a step delivered, whatever their source. */
const noticeTexts = (decision, kind) =>
  (Array.isArray(decision?.messages) ? decision.messages : [])
    .filter((message) => kind === undefined || message?.source?.kind === kind)
    .map((message) =>
      (Array.isArray(message?.content) ? message.content : [])
        .map((block) => (block?.type === 'text' ? block.text : ''))
        .join('\n'),
    );

const dirs = [];
function project(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-pit-${tag}-`));
  dirs.push(dir);
  ledger.initLedger(dir, SESSION);
  return dir;
}

// ------------------------------------------------- the machine-wide ledger, redirected
// Every check below consults two ledgers, and the second one is the host's
// `~/.dsh-code/`. Pointed at a temp dir the run is hermetic: it never writes the
// home directory, it does not depend on the developer's ledger existing, and no
// entry that happens to live there (a `trigger:` matching a command driven here, a
// `files:` matching a scratch edit) can be counted as a stray notice below.
// `globalDir()` reads the variable at event time, so setting it once is enough.
const GLOBAL_ENV = 'DSH_CODE_GLOBAL_DIR';
const globalEnvBefore = process.env[GLOBAL_ENV];
const GLOBAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pit-global-'));
dirs.push(GLOBAL_HOME);
process.env[GLOBAL_ENV] = GLOBAL_HOME;

const mistakesFile = (dir) => path.join(dir, '.dsh-code', 'mistakes.md');
const globalMistakesFile = () => path.join(ledger.globalDir(), ledger.FILES.mistakes);
/** The `## ` headings of a mistakes file, in the order they were appended. */
function headingsIn(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3).trim());
}
/** Record one entry through the public writer; returns the heading it landed under. */
function fileMistake(dir, fields) {
  ledger.recordMistake(dir, fields, OTHER);
  return headingsIn(mistakesFile(dir)).at(-1);
}
function fileGlobalMistake(fields) {
  ledger.recordMistake(GLOBAL_HOME, fields, OTHER, ledger.SCOPE.global);
  return headingsIn(globalMistakesFile()).at(-1);
}
const journalPath = (dir) => path.join(dir, '.dsh-code', 'journal.jsonl');
const journalLines = (dir) =>
  fs
    .readFileSync(journalPath(dir), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

const FAILED_RESULT = { kind: 'result', isError: false, content: [{ type: 'text', text: 'boom\nError: the parser exploded\n[exit code: 1]' }] };
const OK_RESULT = { kind: 'result', isError: false, content: [{ type: 'text', text: 'all good' }] };

// --- G: the pit arrives at the moment of the edit ----------------------------
{
  const dir = project('hit');
  ledger.recordMistake(
    dir,
    {
      symptom: 'code_brief silently dropped the mistakes section',
      cause: 'the budget was spent after assembly, so the first sections won it',
      fix: 'allocate per section before joining, and name what was dropped',
      files: 'lib/ledger.js:161, lib/tool-brief.js:54',
      avoid: 'never slice an assembled brief: budget each section, and name every omission',
    },
    OTHER,
  );
  const ctx = makeCtx();
  pit.apply(ctx, {});
  const agent = agentFor(dir, SESSION);

  const decision = await preExecute(ctx, execFor(agent, 'edit', { file_path: path.join(dir, 'lib', 'ledger.js') }));
  const delivered = await preStep(ctx, { agent, turn: 1, messages: [] });
  const texts = noticeTexts(delivered, 'code-pit-guard');
  check('G1', 'editing a file a known mistake names delivers one pit notice', texts.length === 1, {
    notices: texts.length,
    decision: decision?.kind,
  });
  check(
    'G2',
    'the notice quotes the recorded rule, the symptom it came from, and where the entry lives',
    texts.length === 1 &&
      texts[0].includes('never slice an assembled brief') &&
      texts[0].includes('silently dropped the mistakes section') &&
      texts[0].includes('mistakes.md') &&
      texts[0].includes('ledger.js'),
    { text: (texts[0] ?? '').slice(0, 400) },
  );

  const second = await preStep(ctx, { agent, turn: 1, messages: [] });
  check('G3', 'the same pit is not announced twice in one session', noticeTexts(second, 'code-pit-guard').length === 0, {
    notices: noticeTexts(second, 'code-pit-guard').length,
  });

  await preExecute(ctx, execFor(agent, 'write', { file_path: path.join(dir, 'lib', 'unrelated.js') }));
  const unrelated = await preStep(ctx, { agent, turn: 1, messages: [] });
  check('G4', 'editing a file no pit names delivers nothing', noticeTexts(unrelated, 'code-pit-guard').length === 0, {
    notices: noticeTexts(unrelated, 'code-pit-guard').length,
  });

  await preExecute(ctx, execFor(agent, 'read', { file_path: path.join(dir, 'lib', 'ledger.js') }));
  const readOnly = await preStep(ctx, { agent, turn: 1, messages: [] });
  check('G5', 'a read of the same file is not an edit and delivers nothing', noticeTexts(readOnly, 'code-pit-guard').length === 0, {
    notices: noticeTexts(readOnly, 'code-pit-guard').length,
  });

  // A path token must match on a segment boundary, not as a substring.
  const near = project('near');
  ledger.recordMistake(
    near,
    { symptom: 'a near miss', cause: 'c', fix: 'f', files: 'a.js', avoid: 'do not touch a.js' },
    OTHER,
  );
  const ctxNear = makeCtx();
  pit.apply(ctxNear, {});
  const agentNear = agentFor(near, SESSION);
  await preExecute(ctxNear, execFor(agentNear, 'edit', { file_path: path.join(near, 'data.json') }));
  const nearDecision = await preStep(ctxNear, { agent: agentNear, turn: 1, messages: [] });
  check('G6', 'a recorded token only matches a whole path segment (a.js does not match data.json)', noticeTexts(nearDecision, 'code-pit-guard').length === 0, {
    notices: noticeTexts(nearDecision, 'code-pit-guard').length,
  });

  const nested = project('nested');
  ledger.recordMistake(
    nested,
    { symptom: 'a nested hit', cause: 'c', fix: 'f', files: 'lib/prompt.js', avoid: 'keep the prompt section static' },
    OTHER,
  );
  const ctxNested = makeCtx();
  pit.apply(ctxNested, {});
  // The agent's project root is the scratch ledger, and the edit names the file
  // relatively — the combination that must still match a recorded token.
  const agentNested = agentFor(nested, SESSION);
  await preExecute(ctxNested, execFor(agentNested, 'edit', { file_path: 'lib/prompt.js' }));
  const nestedDecision = await preStep(ctxNested, { agent: agentNested, turn: 1, messages: [] });
  check('G7', 'a relative edit target matches a recorded relative token', noticeTexts(nestedDecision, 'code-pit-guard').length === 1, {
    notices: noticeTexts(nestedDecision, 'code-pit-guard').length,
    text: (noticeTexts(nestedDecision, 'code-pit-guard')[0] ?? '').slice(0, 200),
  });
}

// --- H: the guard never blocks, and never fails a turn ----------------------
{
  const dir = project('safe');
  const ctx = makeCtx();
  pit.apply(ctx, {});
  const agent = agentFor(dir, SESSION);
  const decision = await preExecute(ctx, execFor(agent, 'edit', { file_path: path.join(dir, 'lib', 'ledger.js') }));
  check('H1', 'the pit guard accepts every call (it can never be why work fails)', decision?.kind === 'accept', {
    decision: decision?.kind,
  });

  const boom = project('boom');
  ledger.recordMistake(boom, { symptom: 's', cause: 'c', fix: 'f', files: 'x.js', avoid: 'a' }, OTHER);
  fs.writeFileSync(path.join(boom, '.dsh-code', 'mistakes.md'), '# Mistakes\n\n## broken entry with no fields\n');
  const ctxBoom = makeCtx();
  pit.apply(ctxBoom, {});
  const agentBoom = agentFor(boom, SESSION);
  await preExecute(ctxBoom, execFor(agentBoom, 'edit', { file_path: path.join(boom, 'x.js') }));
  const afterBoom = await preStep(ctxBoom, { agent: agentBoom, turn: 1, messages: [] });
  check('H2', 'a malformed mistakes.md neither throws nor invents a notice', noticeTexts(afterBoom, 'code-pit-guard').length === 0, {
    notices: noticeTexts(afterBoom, 'code-pit-guard').length,
  });
  const disabled = makeCtx();
  pit.apply(disabled, { enabled: false });
  check('H3', 'enabled:false registers no listeners', disabled.handlers.size === 0, { events: [...disabled.handlers.keys()] });
}

// --- J: a failing turn that wrote nothing down becomes a payable debt --------
{
  const dir = project('debt');
  const ctx = makeCtx();
  pit.apply(ctx, {});
  const agent = agentFor(dir, SESSION);

  await postExecute(ctx, execFor(agent, 'pwsh', { command: 'node probes/gate-probe.mjs' }), FAILED_RESULT);
  const warned = await preStep(ctx, { agent, turn: 1, messages: [] });
  const warnTexts = noticeTexts(warned, 'code-pit-guard');
  check('J1', 'a failing command run earns an in-turn notice', warnTexts.length === 1 && warnTexts[0].includes('code_record(kind="mistake"'), {
    notices: warnTexts.length,
    text: (warnTexts[0] ?? '').slice(0, 200),
  });

  await turnStopping(ctx, { agent });
  const written = journalLines(dir).filter((e) => e.kind === 'mistake_unrecorded');
  check('J2', 'the turn that ends without a mistake records an unrecorded-mistake debt', written.length === 1 && written[0].failures?.[0]?.cmd?.includes('gate-probe.mjs'), {
    entries: written,
  });

  // The debt lands at turn end, so the *same* session must not be lectured with
  // it on the next brief: the turn that owes the write-up is the turn that just
  // ended. It is the next session's opening brief where it has to appear.
  const sameSession = ledger.brief(dir, { session: SESSION });
  check(
    'J3',
    'the turn that owes the write-up is not nagged with its own debt',
    !sameSession.text.includes('## Failing commands nobody wrote down'),
    { brief: sameSession.text.slice(-300) },
  );

  const nextSession = ledger.brief(dir, { session: 'sess-pit-next' });
  check(
    'J4',
    'the next session\'s brief opens with it, in its own named section',
    nextSession.text.includes('## Failing commands nobody wrote down') && nextSession.text.includes('gate-probe.mjs'),
    {
      section: /## Failing commands nobody wrote down\n([\s\S]*?)(\n\n|$)/.exec(nextSession.text)?.[1] ?? '(none)',
      omitted: nextSession.omitted,
    },
  );

  // A passing verification proves something works; it says nothing about
  // whether the failure was written down, so it must not settle this debt.
  ledger.recordVerified(dir, { cmd: 'node probes/gate-probe.mjs', expect: 'PASS', ok: true, tail: 'PASS' }, OTHER);
  const afterProof = ledger.brief(dir, { session: 'sess-pit-next' });
  check('J5', 'a later passing verification does not settle an unrecorded mistake', afterProof.text.includes('## Failing commands nobody wrote down'), {
    shown: afterProof.text.includes('## Failing commands nobody wrote down'),
  });

  ledger.recordMistake(
    dir,
    { symptom: 'the gate probe failed on a stale budget report', cause: 'the report was written into the workspace', fix: 'write it to the temp dir', avoid: 'probe reports go to temp, never the workspace', files: 'probes/gate-probe.mjs' },
    OTHER,
  );
  const afterRecord = ledger.brief(dir, { session: 'sess-pit-next' });
  check('J6', 'recording the mistake settles the debt', !afterRecord.text.includes('## Failing commands nobody wrote down'), {
    section: /## Failing commands nobody wrote down\n([\s\S]*?)(\n\n|$)/.exec(afterRecord.text)?.[1] ?? '(absent)',
  });

  const repeat = project('repeat');
  const ctxRepeat = makeCtx();
  pit.apply(ctxRepeat, {});
  const agentRepeat = agentFor(repeat, SESSION);
  await postExecute(ctxRepeat, execFor(agentRepeat, 'pwsh', { command: 'pnpm test' }), FAILED_RESULT);
  await postExecute(ctxRepeat, execFor(agentRepeat, 'pwsh', { command: 'pnpm test' }), FAILED_RESULT);
  const twice = await preStep(ctxRepeat, { agent: agentRepeat, turn: 1, messages: [] });
  check(
    'J7',
    'the same failure twice in one turn is reported once (no duplicate lines)',
    (twice.messages ?? []).length === 1 && (noticeTexts(twice, 'code-pit-guard')[0] ?? '').split('failed —').length === 2,
    { notices: (twice.messages ?? []).length, text: (noticeTexts(twice, 'code-pit-guard')[0] ?? '').slice(0, 300) },
  );

  const healthy = project('healthy');
  const ctxOk = makeCtx();
  pit.apply(ctxOk, {});
  const agentOk = agentFor(healthy, SESSION);
  await postExecute(ctxOk, execFor(agentOk, 'pwsh', { command: 'pnpm test' }), OK_RESULT);
  const okStep = await preStep(ctxOk, { agent: agentOk, turn: 1, messages: [] });
  await turnStopping(ctxOk, { agent: agentOk });
  check(
    'J8',
    'a turn whose commands all passed earns no notice and no debt',
    noticeTexts(okStep, 'code-pit-guard').length === 0 && journalLines(healthy).every((e) => e.kind !== 'mistake_unrecorded'),
    { notices: noticeTexts(okStep, 'code-pit-guard').length, kinds: journalLines(healthy).map((e) => e.kind) },
  );
}

// --- T: `trigger:` — the command side of the same ledger ---------------------
{
  // An edit answers `files:` ("the file I am about to change"); a pit can just as
  // well be about a command — a cmdlet that re-encodes what it touches, a flag that
  // changes meaning. `trigger:` is that side, and it is an explicit regex with no
  // similarity guessing, so an entry without one (or with one that names other
  // commands) must stay silent.
  const RULE = 'never round-trip a file through a PowerShell text cmdlet';
  const MATCHING = "Set-Content -Path 'C:\\temp\\a.txt' -Value 'x'";
  const dir = project('trigger');
  const heading = fileMistake(dir, {
    symptom: 'a Set-Content round trip destroyed three files',
    cause: 'the pipeline re-encoded the text as the console read it',
    fix: 'write through Node instead of a shell cmdlet',
    trigger: 'Set-Content|Out-File',
    avoid: RULE,
  });

  // A second trigger, so "matches nothing" is a real miss rather than the only entry
  // in the ledger — and its trigger contains a space, which is what pins the
  // whitespace-collapsed test below.
  const SECOND_RULE = 'never tear the stack down from inside a probe';
  const secondHeading = fileMistake(dir, {
    symptom: 'a stack teardown killed the fixture the probe was using',
    cause: 'the teardown was run from inside the probe',
    fix: 'stop the stack from outside the probe',
    trigger: 'docker compose down',
    avoid: SECOND_RULE,
  });

  /** Drive one run-tool call in its own agent (its own once-per-session slot). */
  const drive = async (args) => {
    const ctx = makeCtx();
    pit.apply(ctx, {});
    const agent = agentFor(dir, SESSION);
    await preExecute(ctx, execFor(agent, 'pwsh', args));
    return noticeTexts(await preStep(ctx, { agent, turn: 1, messages: [] }), 'code-pit-guard');
  };

  // The command arrives under `cmd`, `command` or `script` depending on the tool.
  const viaCommand = await drive({ command: MATCHING });
  const viaCmd = await drive({ cmd: MATCHING });
  const viaScript = await drive({ script: MATCHING });
  // A command may also be written across lines: `docker compose\ndown -v` matches
  // `docker compose down` only once the whitespace is collapsed.
  const viaMultiline = await drive({ command: 'docker compose\ndown -v' });
  check(
    'T1',
    'a `trigger:` fires for the command it names — under any argument, across a line break',
    viaCommand.length === 1 &&
      viaCommand[0].startsWith('A ledger already paid for a pit ') &&
      viaCommand[0].includes(`**${heading}**`) &&
      viaCommand[0].includes(`- do not repeat: ${RULE}`) &&
      viaCommand[0].includes(`Full entry: .dsh-code/mistakes.md → \`## ${heading}\`.`) &&
      viaCmd.length === 1 &&
      viaScript.length === 1 &&
      viaMultiline.length === 1 &&
      viaMultiline[0].includes(`- do not repeat: ${SECOND_RULE}`),
    {
      notices: { command: viaCommand.length, cmd: viaCmd.length, script: viaScript.length, multiline: viaMultiline.length },
      headings: [heading, secondHeading],
      text: (viaCommand[0] ?? '').slice(0, 400),
    },
  );

  // The entry names its commands; everything else stays quiet — including a command
  // that matches no entry's trigger at all, with both triggers now in the ledger.
  const noMatch = await drive({ command: "Get-Content 'C:\\temp\\a.txt'" });
  const matchesNothing = await drive({ command: 'pnpm -s build' });
  check(
    'T2',
    'a command the trigger does not name, and one matching no entry, deliver nothing',
    noMatch.length === 0 && matchesNothing.length === 0,
    { notices: { nonMatching: noMatch.length, matchingNothing: matchesNothing.length }, entries: [heading, secondHeading] },
  );

  // Once per session per entry: two identical drives queue one notice, and the same
  // command after that notice was delivered adds nothing.
  const twiceCtx = makeCtx();
  pit.apply(twiceCtx, {});
  const twiceAgent = agentFor(dir, SESSION);
  await preExecute(twiceCtx, execFor(twiceAgent, 'pwsh', { command: MATCHING }));
  await preExecute(twiceCtx, execFor(twiceAgent, 'pwsh', { command: MATCHING }));
  const afterTwoDrives = noticeTexts(await preStep(twiceCtx, { agent: twiceAgent, turn: 1, messages: [] }), 'code-pit-guard');
  await preExecute(twiceCtx, execFor(twiceAgent, 'pwsh', { command: MATCHING }));
  const afterDelivery = noticeTexts(await preStep(twiceCtx, { agent: twiceAgent, turn: 1, messages: [] }), 'code-pit-guard');
  check(
    'T3',
    'the same entry fires once per session, however often the command is driven',
    afterTwoDrives.length === 1 && afterDelivery.length === 0,
    { notices: { afterTwoDrives: afterTwoDrives.length, afterDelivery: afterDelivery.length } },
  );

  // A `trigger:` is a regex, and a regex in a ledger can be a typo. It is inert: it
  // matches nothing, it does not abort the scan for the entries after it, and it
  // does not stop that same entry's own `files:` side from working.
  const brokenDir = project('broken-trigger');
  const brokenHeading = fileMistake(brokenDir, {
    symptom: 'a trigger that cannot compile',
    cause: 'the regex was written by hand and never checked',
    fix: 'an uncompilable trigger counts as no match',
    trigger: '(',
    files: 'lib/ledger.js',
    avoid: 'BROKEN-TRIGGER-RULE',
  });
  const healthyHeading = fileMistake(brokenDir, {
    symptom: 'a good trigger written behind a broken one',
    cause: 'two entries, one of them malformed',
    fix: 'the scan continues past a trigger it cannot compile',
    trigger: 'Get-ChildItem -Recurse',
    avoid: 'GOOD-TRIGGER-RULE',
  });
  const brokenCtx = makeCtx();
  pit.apply(brokenCtx, {});
  const brokenAgent = agentFor(brokenDir, SESSION);
  const brokenDecision = await preExecute(brokenCtx, execFor(brokenAgent, 'pwsh', { command: 'echo (anything)' }));
  const brokenNotices = noticeTexts(await preStep(brokenCtx, { agent: brokenAgent, turn: 1, messages: [] }), 'code-pit-guard');
  await preExecute(brokenCtx, execFor(brokenAgent, 'pwsh', { command: 'Get-ChildItem -Recurse -Force' }));
  const healthyNotices = noticeTexts(await preStep(brokenCtx, { agent: brokenAgent, turn: 1, messages: [] }), 'code-pit-guard');
  await preExecute(brokenCtx, execFor(brokenAgent, 'edit', { file_path: path.join(brokenDir, 'lib', 'ledger.js') }));
  const fileSideNotices = noticeTexts(await preStep(brokenCtx, { agent: brokenAgent, turn: 1, messages: [] }), 'code-pit-guard');
  check(
    'T6',
    'a `trigger:` that does not compile is inert: no notice, no throw, the call proceeds',
    brokenDecision?.kind === 'accept' &&
      brokenNotices.length === 0 &&
      healthyNotices.length === 1 &&
      healthyNotices[0].includes('GOOD-TRIGGER-RULE') &&
      fileSideNotices.length === 1 &&
      fileSideNotices[0].includes('BROKEN-TRIGGER-RULE'),
    {
      decision: brokenDecision?.kind,
      notices: { broken: brokenNotices.length, good: healthyNotices.length, fileSide: fileSideNotices.length },
      headings: [brokenHeading, healthyHeading],
    },
  );

  // The machine-wide ledger (`~/.dsh-code/`, redirected into temp by
  // `DSH_CODE_GLOBAL_DIR` for this run): a pit filed there has to fire here, and its
  // notice has to name *that* file — quoting a host entry as this project's would
  // send the reader to a ledger that does not contain it.
  const globalFile = globalMistakesFile();
  const globalHeading = fileGlobalMistake({
    symptom: 'a teardown command killed the fixture under the probe',
    cause: 'the command has nothing to do with this package',
    fix: 'file it once for the host instead of once per project',
    trigger: 'docker compose down',
    avoid: 'HOST-TRIGGER-RULE',
  });
  const hostDir = project('global-trigger');
  const hostCtx = makeCtx();
  pit.apply(hostCtx, {});
  const hostAgent = agentFor(hostDir, SESSION);
  await preExecute(hostCtx, execFor(hostAgent, 'pwsh', { command: 'docker compose down -v' }));
  const hostNotices = noticeTexts(await preStep(hostCtx, { agent: hostAgent, turn: 1, messages: [] }), 'code-pit-guard');
  // Both ledgers are consulted, in one fixed order: with a project entry carrying the
  // same trigger, the project's rule is announced before the machine-wide one, so the
  // narrower rule is read first.
  const projectRule = 'never run a teardown command from this project either';
  fileMistake(hostDir, {
    symptom: 'the same teardown command was filed against this project too',
    cause: 'this project has its own reason to refuse that command',
    fix: 'record the project-specific half next to the code',
    trigger: 'docker compose down',
    avoid: projectRule,
  });
  const hostOrderCtx = makeCtx();
  pit.apply(hostOrderCtx, {});
  const hostOrderAgent = agentFor(hostDir, SESSION);
  await preExecute(hostOrderCtx, execFor(hostOrderAgent, 'pwsh', { command: 'docker compose down -v' }));
  const hostOrderNotices = noticeTexts(await preStep(hostOrderCtx, { agent: hostOrderAgent, turn: 1, messages: [] }), 'code-pit-guard');
  check(
    'T4',
    'a pit filed only in the machine-wide ledger fires and names that file, and the project ledger is read first',
    hostNotices.length === 1 &&
      hostNotices[0].includes('- do not repeat: HOST-TRIGGER-RULE') &&
      hostNotices[0].includes(`Full entry: ${globalFile} → \`## ${globalHeading}\`.`) &&
      !hostNotices[0].includes('.dsh-code/mistakes.md') &&
      !hostNotices[0].includes('.dsh-code\\mistakes.md') &&
      hostOrderNotices.length === 2 &&
      hostOrderNotices[0].includes(`- do not repeat: ${projectRule}`) &&
      hostOrderNotices[0].includes('Full entry: .dsh-code/mistakes.md') &&
      hostOrderNotices[1].includes('- do not repeat: HOST-TRIGGER-RULE') &&
      hostOrderNotices[1].includes(`Full entry: ${globalFile}`),
    {
      globalOnly: hostNotices.length,
      globalFile,
      heading: globalHeading,
      sourcesInOrder: hostOrderNotices.map((text) => /Full entry: (.*?) → /.exec(text)?.[1] ?? '?'),
      text: (hostNotices[0] ?? '').slice(0, 300),
    },
  );

  const globalFileHeading = fileGlobalMistake({
    symptom: 'a mid-session prompt edit threw away the cache',
    cause: 'the prompt prefix changed while a session was reading it',
    fix: 'batch prompt edits before a restart',
    files: 'lib/prompt.js',
    avoid: 'HOST-FILES-RULE',
  });
  const hostEditDir = project('global-file');
  const hostEditCtx = makeCtx();
  pit.apply(hostEditCtx, {});
  const hostEditAgent = agentFor(hostEditDir, SESSION);
  await preExecute(hostEditCtx, execFor(hostEditAgent, 'edit', { file_path: path.join(hostEditDir, 'lib', 'prompt.js') }));
  const hostEditNotices = noticeTexts(await preStep(hostEditCtx, { agent: hostEditAgent, turn: 1, messages: [] }), 'code-pit-guard');
  check(
    'T5',
    'the machine-wide ledger is consulted on the file side too',
    hostEditNotices.length === 1 &&
      hostEditNotices[0].includes('- do not repeat: HOST-FILES-RULE') &&
      hostEditNotices[0].includes(`Full entry: ${globalFile} → \`## ${globalFileHeading}\`.`),
    { notices: hostEditNotices.length, heading: globalFileHeading, text: (hostEditNotices[0] ?? '').slice(0, 400) },
  );
}

// The override is a setting of this process, so it is put back the way it was found;
// the temp ledger itself goes away with the rest of the scratch directories.
if (globalEnvBefore === undefined) delete process.env[GLOBAL_ENV];
else process.env[GLOBAL_ENV] = globalEnvBefore;

for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
const report = { libDir, passed: checks.length - failed.length, total: checks.length, failed: failed.map((c) => `${c.id} ${c.name}`), checks };
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
// One line, so a captured run (where a long pretty-printed object can be cut)
// still carries the evidence for whichever check failed.
if (failed.length > 0) {
  process.stderr.write(`PIT-PROBE-DETAIL ${JSON.stringify({ failed: failed.map((c) => ({ id: c.id, name: c.name, evidence: c.evidence })) })}\n`);
}
console.log(JSON.stringify({ libDir, passed: report.passed, total: report.total, failed: report.failed }, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
