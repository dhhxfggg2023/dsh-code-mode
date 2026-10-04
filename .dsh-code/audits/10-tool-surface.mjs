/**
 * Audit probe 10 — the tool surface of code_record / code_brief / code_verify.
 *
 * Method: every tool is loaded through the host's real `defineTool` (via
 * `installResolution()`, the acceptance-probe pattern), driven with real arguments,
 * and its returned value is then put through the *harness's own* output contract:
 *
 *   dsh-tools/lib/index.js:3541  createSuccessResult(exec, tool, candidate)
 *   dsh-tools/lib/index.js:3542    const detached = snapshotToolValue(tool.name, candidate);
 *   dsh-tools/lib/index.js:3543    const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
 *   dsh-tools/lib/index.js:3544    if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
 *   dsh-tools/lib/index.js:3548    rendered = tool.output.render(exec.arguments, value)
 *
 * `snapshotToolValue` is `snapshotJsonValue` + the `value is not lossless JSON`
 * failure; both functions and the schema compiler are the harness's own, imported
 * from the archive — nothing here re-implements the ledger logic or the validator.
 *
 * Everything is driven against a throwaway project under os.tmpdir(), and the
 * machine-wide ledger is redirected, so running this probe cannot touch the real
 * `.dsh-code/` of any project.
 *
 * Run:  $env:ELECTRON_RUN_AS_NODE='1'; & '<install>\DeepSeek Harness.exe' .dsh-code/audits/10-tool-surface.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { installResolution, PKG_DIR, ASAR } from '../../probes/paths.mjs';

/** Never let this probe write to the real machine ledger. */
const GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-global-'));
process.env.DSH_CODE_GLOBAL_DIR = GLOBAL_DIR;

await installResolution();

const dshTools = await import('@deepseek-ai/dsh-tools');
/**
 * `@deepseek-ai/dsh-util-values` is not in the profile's shared-resolution set, so it
 * is imported straight out of the archive by path (the Electron binary resolves
 * through app.asar). Same file the harness imports at dsh-tools/lib/index.js:5.
 */
const utilValues = await import(
  pathToFileURL(path.join(ASAR, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-util-values', 'lib', 'index.js')).href
);
const { validateJsonSchemaValue, ToolOutputError } = dshTools;
const { snapshotJsonValue, deepFreeze } = utilValues;

const results = [];
const record = (id, claim, outcome, evidence) => {
  results.push({ id, claim, outcome, evidence });
  console.log(`${outcome === 'PASS' ? 'ok  ' : outcome === 'FAIL' ? 'BAD ' : '--  '} ${id} ${claim}`);
  if (evidence !== undefined) console.log(`       ${JSON.stringify(evidence)?.slice(0, 900)}`);
};

/**
 * The harness's output contract, verbatim (see the header for the four lines this
 * mirrors). Returns `{ ok }` or `{ ok:false, stage, message }`.
 */
function harnessOutput(tool, args, value) {
  const detached = snapshotJsonValue(value);
  if (detached === undefined) {
    return { ok: false, stage: 'snapshot', message: `tool "${tool.name}" returned invalid output: value is not lossless JSON` };
  }
  const violations = validateJsonSchemaValue(tool.output.schema, detached, 'value');
  if (violations.length > 0) {
    return { ok: false, stage: 'schema', message: new ToolOutputError(tool.name, violations).message, violations };
  }
  const frozen = deepFreeze(detached);
  let rendered;
  try {
    rendered = tool.output.render(args, frozen);
  } catch (error) {
    return { ok: false, stage: 'render', message: `output.render failed: ${error.message}` };
  }
  if (snapshotJsonValue(rendered) === undefined) {
    return { ok: false, stage: 'render-json', message: 'output.render returned non-lossless JSON' };
  }
  return { ok: true, detached, rendered };
}

const scratch = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `audit-${tag}-`));
const execFor = (cwd, args) => ({ name: 'audit', arguments: args, agent: { session: { id: 'audit-session', header: { cwd } } } });

async function loadTool(rel, toolName, ctxPatch = {}) {
  const mod = await import(pathToFileURL(path.join(PKG_DIR, rel)).href);
  const registered = [];
  const sections = [];
  const ctx = {
    registered,
    sections,
    tools: { register: (definition) => registered.push(definition) },
    systemPrompt: { section: (s) => sections.push(s) },
    on: () => () => {},
    ...ctxPatch,
  };
  mod.apply(ctx, undefined);
  return { tool: registered.find((d) => d.name === toolName), registered, sections };
}

/** Drive one tool call and put the result through the harness contract. */
async function drive(tool, args, cwd) {
  let value;
  let thrown;
  try {
    value = await tool.execute(args, execFor(cwd, args));
  } catch (error) {
    thrown = error;
  }
  if (thrown !== undefined) {
    return { threw: `${thrown.name}: ${thrown.message}`, code: thrown.code, violations: thrown.violations };
  }
  return { value, contract: harnessOutput(tool, args, value) };
}

const { tool: recordTool } = await loadTool('lib/tool-record.js', 'code_record');
const { tool: briefTool } = await loadTool('lib/tool-brief.js', 'code_brief');
const { tool: verifyTool } = await loadTool('lib/tool-verify.js', 'code_verify');

// =============================================================== A: code_record
console.log('\n== A. code_record: every kind through the real output contract ==');
{
  const root = scratch('record');
  // A board the progress branch can move, so `task` resolves.
  fs.mkdirSync(path.join(root, '.dsh-code'), { recursive: true });
  fs.writeFileSync(path.join(root, '.dsh-code', 'tasks.json'), JSON.stringify({ version: 1, active: [{ id: '2026-01-01-existing-task', title: 'Existing task', status: 'active', notes: [] }], done: [], blocked: [] }));

  const CASES = [
    ['project', { kind: 'project', patch: { commands: { test: 'npm test' }, stack: 'node' } }],
    ['progress', { kind: 'progress', title: 'Audit probe task', note: 'note' }],
    ['progress-existing', { kind: 'progress', task: '2026-01-01-existing-task', status: 'active', note: 'moved by probe' }],
    ['decision', { kind: 'decision', title: 'Probe decision', body: 'because the schema must accept it', alternatives: 'none' }],
    ['mistake', { kind: 'mistake', symptom: 'Probe pit symptom long enough to be a locator', cause: 'cause', fix: 'fix', avoid: 'do not do the thing because it breaks' }],
    ['verified', { kind: 'verified', cmd: 'node --version', expect: 'v24' }],
  ];
  for (const [label, args] of CASES) {
    const out = await drive(recordTool, args, root);
    if (out.threw !== undefined) {
      record(`record:${label}`, `code_record(${label}) produces a value the harness accepts`, 'FAIL', { threw: out.threw });
    } else if (out.contract.ok === true) {
      record(`record:${label}`, `code_record(${label}) produces a value the harness accepts`, 'PASS', { keys: Object.keys(out.value), summary: out.value.summary?.slice(0, 90), rendered: out.contract.rendered?.[0]?.text?.slice(0, 120) });
    } else {
      record(`record:${label}`, `code_record(${label}) produces a value the harness accepts`, 'FAIL', { keys: Object.keys(out.value), returned: out.value, stage: out.contract.stage, message: out.contract.message });
    }
  }

  // The corrupt-ledger path makes `notice` a *string*, which is the other half of
  // the same contract (a defined key the schema does not declare).
  const corrupt = scratch('corrupt');
  fs.mkdirSync(path.join(corrupt, '.dsh-code'), { recursive: true });
  fs.writeFileSync(path.join(corrupt, '.dsh-code', 'tasks.json'), '{ "version": 1, "active": [ , ] }');
  fs.writeFileSync(path.join(corrupt, '.dsh-code', 'project.json'), '{ "version": 1, }');
  for (const [label, args] of [
    ['project-corrupt', { kind: 'project', patch: { stack: 'x' } }],
    ['progress-corrupt', { kind: 'progress', title: 'Corrupt board task', note: 'n' }],
  ]) {
    const out = await drive(recordTool, args, corrupt);
    record(
      `record:${label}`,
      `code_record(${label}) produces a value the harness accepts`,
      out.threw === undefined && out.contract.ok === true ? 'PASS' : 'FAIL',
      out.threw !== undefined ? { threw: out.threw } : { keys: Object.keys(out.value), noticeValue: out.value.notice, stage: out.contract.stage, message: out.contract.message },
    );
  }

  // scope=global is the same object with a different ledger directory.
  const g = await drive(recordTool, { kind: 'project', scope: 'global', patch: { hosts: 'probe' } }, root);
  record('record:project-global', 'code_record(kind=project, scope=global) produces a value the harness accepts', g.threw === undefined && g.contract.ok === true ? 'PASS' : 'FAIL', g.threw !== undefined ? { threw: g.threw } : { stage: g.contract.stage, message: g.contract.message });
}

// ======================================================= B: argument validation
console.log('\n== B. code_record argument validation (real defineTool wrapper) ==');
{
  const root = scratch('args');
  const REFUSALS = [
    ['kind-uppercase', { kind: 'Project', patch: {} }, /invalid arguments/],
    ['kind-empty', { kind: '', patch: {} }, /invalid arguments/],
    ['kind-unknown', { kind: 'nonsense', patch: {} }, /invalid arguments/],
    ['scope-global-progress', { kind: 'progress', scope: 'global', title: 'x', note: 'y' }, /task board is project-scoped/],
    ['scope-uppercase', { kind: 'project', scope: 'Global', patch: {} }, /invalid arguments/],
    ['cmd-number', { kind: 'verified', cmd: 42 }, /invalid arguments/],
    ['status-unknown', { kind: 'progress', title: 'x', status: 'closed' }, /invalid arguments/],
    ['patch-not-object', { kind: 'project', patch: 'nope' }, /invalid arguments/],
    ['trigger-invalid-regex', { kind: 'mistake', symptom: 'a'.repeat(40), cause: 'c', fix: 'f', trigger: 'Set-Content|(Out-File' }, /never fire/],
    ['trigger-sample-without-trigger', { kind: 'mistake', symptom: 'a'.repeat(40), cause: 'c', fix: 'f', triggerSample: 'pnpm test' }, /needs `trigger`/],
    ['mistake-no-locator', { kind: 'mistake', symptom: 'short', cause: 'c', fix: 'f' }, /no rule and no way to be found/],
    ['task-unknown', { kind: 'progress', task: 'no-such-task-id', status: 'active' }, /no task on the board matches/],
    ['decision-without-body', { kind: 'decision', title: 't' }, /needs `title` and `body`/],
    ['verified-without-cmd', { kind: 'verified', expect: 'x' }, /needs `cmd`/],
    ['project-without-patch', { kind: 'project' }, /needs `patch`/],
  ];
  for (const [label, args, pattern] of REFUSALS) {
    const out = await drive(recordTool, args, root);
    const message = out.threw ?? 'ACCEPTED (no error thrown)';
    const good = out.threw !== undefined && pattern.test(out.threw);
    record(`args:${label}`, `${label} is refused with a message matching ${pattern}`, good ? 'PASS' : 'FAIL', { message: String(message).slice(0, 220) });
  }
  // The refusal must not have written anything — attribute the creation to the case
  // that caused it, by watching the ledger directory case by case.
  const root3 = scratch('args-side');
  const firstWrite = [];
  for (const [label, args] of REFUSALS) {
    const before = fs.existsSync(path.join(root3, '.dsh-code')) ? fs.readdirSync(path.join(root3, '.dsh-code')) : [];
    await drive(recordTool, args, root3);
    const after = fs.existsSync(path.join(root3, '.dsh-code')) ? fs.readdirSync(path.join(root3, '.dsh-code')) : [];
    if (after.length > before.length) firstWrite.push({ label, created: after.filter((f) => !before.includes(f)) });
  }
  record('args:no-side-effect-on-refusal', 'a refused call leaves no ledger behind', firstWrite.length === 0 ? 'PASS' : 'FAIL', { createdBy: firstWrite, filesNow: fs.existsSync(path.join(root3, '.dsh-code')) ? fs.readdirSync(path.join(root3, '.dsh-code')) : [] });
  if (firstWrite.length > 0) {
    const briefAfterRefusal = await drive(briefTool, {}, root3);
    record('args:refusal-changes-the-brief', 'a project whose only call was REFUSED still briefs as "no ledger yet"', briefAfterRefusal.value?.empty === true ? 'PASS' : 'FAIL', { empty: briefAfterRefusal.value?.empty, firstLine: briefAfterRefusal.value?.brief?.split('\n')[0], head: briefAfterRefusal.value?.brief?.slice(0, 200) });
  }

  // Accepted-but-notable inputs.
  const root2 = scratch('args2');
  const ACCEPT = [
    ['extra-unknown-field', { kind: 'project', patch: { stack: 'x' }, bogusField: 'ignored?' }],
    ['files-backslash', { kind: 'mistake', symptom: 'A pit filed with backslash paths for the probe', cause: 'c', fix: 'f', files: 'lib\\tool-record.js:1, lib\\tool-verify.js\\' }],
    ['files-trailing-separator', { kind: 'mistake', symptom: 'A pit filed with a trailing separator for the probe', cause: 'c', fix: 'f', files: 'lib/' }],
    ['task-as-title', { kind: 'progress', title: 'Audit probe task', status: 'active', note: 'by title' }],
    ['task-as-slug', { kind: 'progress', task: 'audit-probe-task', status: 'active', note: 'by slug' }],
    ['status-done-without-verify', { kind: 'progress', title: 'Audit probe task', status: 'done', note: 'closing' }],
  ];
  for (const [label, args] of ACCEPT) {
    const out = await drive(recordTool, args, root2);
    record(`args:${label}`, `${label}: accepted (record what it did)`, out.threw === undefined ? 'PASS' : 'NOTE', out.threw !== undefined ? { threw: out.threw } : { keys: Object.keys(out.value), summary: out.value.summary?.slice(0, 200), contract: out.contract?.ok === false ? out.contract.message : 'accepted by the output contract' });
  }
  // Title/slug/id must all reach the same task, not create three.
  const board = JSON.parse(fs.readFileSync(path.join(root2, '.dsh-code', 'tasks.json'), 'utf8'));
  record('args:task-identity', 'title, slug and id resolve to one task instead of creating duplicates', board.active.length + board.done.length === 1 ? 'PASS' : 'FAIL', { active: board.active.map((t) => t.id), done: board.done.map((t) => t.id) });

  // `scope=global` + `kind=progress` must be refused *before* it touches the machine
  // ledger, so the machine ledger is pointed at a directory nothing else has used.
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-global-isolated-'));
  process.env.DSH_CODE_GLOBAL_DIR = isolated;
  const globalRefusal = await drive(recordTool, { kind: 'progress', scope: 'global', title: 'x', note: 'y' }, root);
  record('args:global-progress-refused-clean', 'scope=global + kind=progress is refused and writes nothing to the machine ledger', globalRefusal.threw !== undefined && fs.readdirSync(isolated).length === 0 ? 'PASS' : 'FAIL', { threw: globalRefusal.threw, machineLedgerFiles: fs.readdirSync(isolated) });
  process.env.DSH_CODE_GLOBAL_DIR = GLOBAL_DIR;
}

// ============================================================== C: code_brief
console.log('\n== C. code_brief: empty, populated, topic, full, huge ==');
{
  const empty = scratch('brief-empty');
  const out = await drive(briefTool, {}, empty);
  record('brief:empty-project', 'code_brief on a project with no ledger returns a valid value', out.threw === undefined && out.contract.ok === true ? 'PASS' : 'FAIL', out.threw !== undefined ? { threw: out.threw } : { keys: Object.keys(out.value), empty: out.value.empty, omitted: out.value.omittedSections, contract: out.contract.ok === false ? out.contract.message : 'ok' });

  const root = scratch('brief');
  fs.mkdirSync(path.join(root, '.dsh-code'), { recursive: true });
  const many = ['# Mistakes', ''];
  for (let i = 0; i < 200; i += 1) {
    many.push(`## 2026-01-01 · pit-number-${i}`, `- symptom: pit number ${i} about a subject the reader may search for`, `- cause: because ${i}`, `- fix: fix ${i}`, `- do not repeat: do not do thing ${i} because it breaks in a way worth remembering`, '');
  }
  fs.writeFileSync(path.join(root, '.dsh-code', 'mistakes.md'), many.join('\n'));
  fs.writeFileSync(path.join(root, '.dsh-code', 'decisions.md'), `# Decisions\n\n## 2026-01-01 · A decision\n\nbecause\n`);
  fs.writeFileSync(path.join(root, '.dsh-code', 'project.json'), JSON.stringify({ version: 1, createdAt: 'x', commands: { test: 'npm test' }, stack: 'node 24', layout: 'lib/', notes: 'n' }));
  fs.writeFileSync(path.join(root, '.dsh-code', 'tasks.json'), JSON.stringify({ version: 1, active: [{ id: '2026-01-01-t', title: 't', status: 'active', notes: [] }], done: [], blocked: [] }));
  fs.writeFileSync(path.join(root, '.dsh-code', 'journal.jsonl'), `${JSON.stringify({ ts: '2026-01-01T00:00:00Z', kind: 'verified', cmd: 'node --test', ok: true, tail: 'ok' })}\n`);

  for (const [label, args] of [
    ['populated', {}],
    ['topic', { topic: 'pit-number-7' }],
    ['full', { full: true }],
    ['topic-and-full', { topic: 'pit-number-7', full: true }],
    ['huge-ledger', {}],
  ]) {
    const out2 = await drive(briefTool, args, root);
    const ok = out2.threw === undefined && out2.contract.ok === true;
    record(`brief:${label}`, `code_brief(${label}) returns a value the harness accepts and renders`, ok ? 'PASS' : 'FAIL', out2.threw !== undefined ? { threw: out2.threw } : { chars: out2.value.brief.length, omitted: out2.value.omittedSections, empty: out2.value.empty, contract: out2.contract.ok === false ? out2.contract.message : { renderChars: out2.contract.rendered?.[0]?.text?.length } });
  }
  // The declared budget is what the *caller* can rely on; check both paths against it.
  const budgeted = await drive(briefTool, {}, root);
  record('brief:budget', 'the default brief stays inside the declared 4000-character budget', budgeted.value.brief.length <= 4000 ? 'PASS' : 'FAIL', { chars: budgeted.value.brief.length });
  const full = await drive(briefTool, { full: true }, root);
  record('brief:full-is-unbounded', 'code_brief(full) reports how much it returned (no budget claim)', full.value.brief.length > 0 ? 'PASS' : 'FAIL', { chars: full.value.brief.length, omitted: full.value.omittedSections });

  /**
   * The prompt tells the model it can "raise the tool's `maxChars`" — but maxChars is
   * a plugin Config, not a code_brief parameter. If the harness accepts the unknown
   * argument, the model believes it raised the budget while nothing changed.
   */
  const raised = await drive(briefTool, { maxChars: 20000 }, root);
  record(
    'brief:maxchars-argument',
    'passing the maxChars the prompt tells the model to raise actually raises the budget (or is refused)',
    raised.threw !== undefined || raised.value.brief.length > 4000 ? 'PASS' : 'FAIL',
    raised.threw !== undefined ? { threw: raised.threw } : { chars: raised.value.brief.length, parameterNames: Object.keys(briefTool.parameters.properties), acceptedSilently: raised.value.brief.length <= 4000 },
  );

  // The prompt says `topic` accepts "a file, a symptom, a heading fragment, or a `trigger:`".
  // The fixture carries a real `- trigger:` line so a trigger query has something to find.
  const triggerRoot = scratch('brief-trigger');
  fs.mkdirSync(path.join(triggerRoot, '.dsh-code'), { recursive: true });
  fs.writeFileSync(
    path.join(triggerRoot, '.dsh-code', 'mistakes.md'),
    ['# Mistakes', '', '## 2026-01-01 · a shell that rewrites text', '- symptom: Set-Content stringifies a byte array into decimal digits', '- cause: PowerShell pipeline', '- fix: write through node', '- trigger: Set-Content|Out-File|Add-Content', '- do not repeat: do not write file content with PowerShell', '', '## 2026-01-01 · unrelated pit about css', '- symptom: a css pit with no relation', '- cause: c', '- fix: f', '- do not repeat: do not do the css thing at all', ''].join('\n'),
  );
  for (const [label, args, needle] of [
    ['heading-fragment', { topic: 'pit-number-7' }, 'pit-number-7'],
    ['trigger-literal', { topic: 'Set-Content' }, 'Set-Content'],
    ['trigger-prefixed', { topic: 'trigger:Set-Content' }, 'Set-Content'],
    ['file', { topic: 'lib/ledger.js' }, undefined],
  ]) {
    const target = label === 'heading-fragment' ? root : triggerRoot;
    const out = await drive(briefTool, args, target);
    record(
      `brief:topic-${label}`,
      `topic=${JSON.stringify(args.topic)} finds the entry (or reports that it found none)`,
      out.threw === undefined && (needle === undefined || out.value.brief.includes(needle)) ? 'PASS' : 'NOTE',
      { chars: out.value?.brief?.length, mentionsQuery: needle === undefined ? undefined : out.value?.brief?.includes(needle), hasMistakesSection: out.value?.brief?.includes('## Known mistakes'), excerpt: needle === undefined ? out.value?.brief?.slice(-260) : undefined },
    );
  }
}

// ============================================================= D: code_verify
console.log('\n== D. code_verify through a stub shell (the harness-side branches) ==');
{
  const root = scratch('verify');
  /** Resolve/execute stub that replays whatever the host shell would report. */
  const shellStub = (result) => ({
    shell: {
      resolve: (options) => options,
      execute: async () => ({ result: async () => result }),
    },
  });
  const CASE = [
    ['pass-no-expect', { exitCode: 0, stdout: { text: 'all good' }, stderr: { text: '' } }, { cmd: 'node --test' }, true],
    ['mismatch', { exitCode: 0, stdout: { text: 'all good' }, stderr: { text: '' } }, { cmd: 'node --test', expect: 'never printed' }, false],
    ['nonzero', { exitCode: 3, stdout: { text: 'x' }, stderr: { text: 'boom' } }, { cmd: 'node --test', expect: 'boom' }, false],
    ['denied', { exitCode: 0, stdout: { text: 'x' }, stderr: { text: '' }, sandbox: { denied: true } }, { cmd: 'node --test' }, false],
    ['runnerFailed', { exitCode: 0, stdout: { text: 'x' }, stderr: { text: '' }, sandbox: { runnerFailed: true } }, { cmd: 'node --test' }, false],
    ['timedOut', { exitCode: 0, stdout: { text: 'x' }, stderr: { text: '' }, timedOut: true }, { cmd: 'node --test' }, false],
    ['aborted', { exitCode: 0, stdout: { text: 'x' }, stderr: { text: '' }, aborted: true }, { cmd: 'node --test' }, false],
    ['no-exit-code', { stdout: { text: 'x' }, stderr: { text: '' } }, { cmd: 'node --test' }, false],
    ['stdout-missing', { exitCode: 0, stderr: { text: '' } }, { cmd: 'node --test' }, true],
    ['killed-as-one', { exitCode: 1, stdout: { text: 'x' }, stderr: { text: '' } }, { cmd: 'node --test' }, false],
  ];
  for (const [label, result, args, expectOk] of CASE) {
    const { tool } = await loadTool('lib/tool-verify.js', 'code_verify', shellStub(result));
    const out = await drive(tool, args, root);
    const ok = out.threw === undefined && out.value.ok === expectOk;
    record(`verify:${label}`, `code_verify records ok=${expectOk} for the ${label} shell result`, ok ? 'PASS' : 'FAIL', out.threw !== undefined ? { threw: out.threw } : { exitCode: out.value.exitCode, matched: out.value.matched, ok: out.value.ok, tail: out.value.outputTail?.slice(0, 80), contract: out.contract?.ok === false ? out.contract.message : 'accepted' });
  }
  // No shell service at all: does the caller learn, or does it get a success shape?
  const { tool: noShell } = await loadTool('lib/tool-verify.js', 'code_verify', { shell: undefined });
  const out = await drive(noShell, { cmd: 'node --test' }, root);
  record('verify:missing-shell', 'code_verify refuses loudly when the host shell service is absent', out.threw !== undefined && /shell service is unavailable/.test(out.threw) ? 'PASS' : 'FAIL', { threw: out.threw ?? 'ACCEPTED', value: out.value });
  // A shell whose execute throws (spawn EPERM is a recorded reality on this host).
  const throwing = await loadTool('lib/tool-verify.js', 'code_verify', { shell: { resolve: (o) => o, execute: async () => { throw new Error('spawn EPERM'); } } });
  const out2 = await drive(throwing.tool, { cmd: 'node --test' }, root);
  record('verify:shell-throws', 'code_verify surfaces a shell that cannot spawn (nothing is recorded as a pass)', out2.threw !== undefined ? 'PASS' : 'FAIL', { threw: out2.threw ?? 'ACCEPTED' });
  // A result object whose shape differs from what the tool assumes.
  const odd = await loadTool('lib/tool-verify.js', 'code_verify', { shell: { resolve: (o) => o, execute: async () => ({ result: async () => ({ exitCode: 0, output: 'text in another field' }) }) } });
  const out3 = await drive(odd.tool, { cmd: 'node --test', expect: 'text in another field' }, root);
  record('verify:output-shape', 'code_verify notices when the shell reports output in an unexpected field', out3.threw === undefined && out3.value.matched === false ? 'NOTE' : 'PASS', { value: out3.value === undefined ? out3.threw : { matched: out3.value.matched, ok: out3.value.ok, tail: out3.value.outputTail } });
}

// ================================================================= E: prompt.js
console.log('\n== E. prompt section: does it still describe this code? ==');
{
  const { sections, registered } = await loadTool('lib/prompt.js', 'code_prompt');
  const text = typeof sections[0]?.text === 'string' ? sections[0].text : undefined;
  const names = registered.map((d) => d.name);
  record('prompt:registered', 'prompt.js registers its section and no tools', names.length === 0 && text !== undefined ? 'PASS' : 'FAIL', { sectionName: sections[0]?.name, order: sections[0]?.order, chars: text?.length, tools: names });

  const ledger = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'ledger.js')).href);
  const FILES = ledger.FILES;
  const habits = text.slice(text.indexOf('## Working habits'));
  const claims = [
    ['file:project.json', text.includes('project.json') && String(FILES.project).includes('project.json')],
    ['file:tasks.json', text.includes('tasks.json') && String(FILES.tasks).includes('tasks.json')],
    ['file:decisions.md', text.includes('decisions.md') && String(FILES.decisions).includes('decisions.md')],
    ['file:mistakes.md', text.includes('mistakes.md') && String(FILES.mistakes).includes('mistakes.md')],
    ['file:journal.jsonl', text.includes('journal.jsonl') && String(FILES.journal).includes('journal.jsonl')],
    ['dir:.dsh-code', text.includes('`.dsh-code/`') && ledger.DIRNAME === '.dsh-code'],
    ['machine-dir', text.includes('`~/.dsh-code/`') && path.join(os.homedir(), '.dsh-code').endsWith(`.dsh-code`)],
    ['budget:fixed-not-fractional', /bounded by construction \(a fixed character budget, not a fraction of the ledger\)/.test(text)],
    ['budget:maxchars-is-a-config', /raise the tool.{0,3}s `maxChars`/.test(text)],
    ['tool:code_brief', text.includes('`code_brief`')],
    ['tool:code_record', text.includes('`code_record`')],
    ['tool:code_verify', text.includes('`code_verify`')],
    ['kinds:four-named', ['project', 'progress', 'decision', 'mistake'].every((k) => text.includes(k))],
    ['kinds:verified-also-exists', /\bverified\b/.test(text)],
    ['habits:six', (habits.match(/^- \*\*/gm) ?? []).length === 6],
    ['close:ledger-count-line', /ends with a line naming how many entries exist in each scope/.test(text)],
    ['close:topic-or-maxchars', /pass `topic` .* or raise the tool.{0,3}s `maxChars`/.test(text)],
  ];
  for (const [id, ok] of claims) record(`prompt:${id}`, `prompt claim ${id} matches the code`, ok ? 'PASS' : 'FAIL', { ok });

  // Does the prompt name any tool that is not registered anywhere in the mode?
  const allTools = [];
  for (const rel of ['lib/tool-brief.js', 'lib/tool-record.js', 'lib/tool-verify.js']) {
    const { registered: r } = await loadTool(rel, 'none');
    allTools.push(...r.map((d) => d.name));
  }
  const named = [...text.matchAll(/`(code_[a-z_]+)`/g)].map((m) => m[1]);
  const missing = [...new Set(named)].filter((n) => !allTools.includes(n));
  record('prompt:tool-names-exist', 'every code_* tool the prompt names is registered by this package', missing.length === 0 ? 'PASS' : 'FAIL', { named: [...new Set(named)], registered: allTools, missing });
}

console.log('\n--------------------------------------------------------------');
const bad = results.filter((r) => r.outcome === 'FAIL');
console.log(`${results.length - bad.length}/${results.length} checks did not FAIL; failing ids: ${bad.map((r) => r.id).join(', ') || '(none)'}`);
/** Durable report next to this probe when the directory is writable, else temp. */
const report = JSON.stringify({ probe: '10-tool-surface', results, globalDir: GLOBAL_DIR }, null, 2);
const durable = path.join(PKG_DIR, '.dsh-code', 'audits', 'report-10-tool-surface.json');
try {
  fs.writeFileSync(durable, `${report}\n`, 'utf8');
  console.log(`report: ${durable}`);
} catch (error) {
  console.log(`report (workspace not writable: ${error.code}): ${path.join(os.tmpdir(), 'audit-10-report.json')}`);
}
fs.writeFileSync(path.join(os.tmpdir(), 'audit-10-report.json'), report);
