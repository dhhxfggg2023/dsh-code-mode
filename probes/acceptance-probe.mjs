/**
 * Acceptance probe: can the code-mode preset actually be used?
 *
 * Loads every `lib/*.js` the preset declares, through the host's real tool
 * registry (`defineTool` from @deepseek-ai/dsh-tools, via the same
 * profile-resolution bootstrap the host installs), registers each one, and
 * drives the tools end-to-end against a throwaway project:
 *
 *   code_record  — all five kinds, each returning a rendered result;
 *   code_brief   — a fresh project, then after records exist;
 *   code_verify  — a real command through a stub `ctx.shell`.
 *
 * A module that fails to import or to register breaks the whole preset (its
 * rows never mount), so this is the check that says "the mode loads" rather
 * than "the ledger library works".
 *
 * Report: $env:TEMP\acceptance-report.json (see HANDOVER rule 10/11 for why not
 * the workspace). Run via the `pwsh` tool.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { LIB_DIR, PKG_DIR, tempReport, installResolution } from './paths.mjs';

const MODULES = [
  'lib/prompt.js',
  'lib/tool-brief.js',
  'lib/tool-record.js',
  'lib/tool-verify.js',
  'lib/gate-verify.js',
  'lib/budget.js',
  'lib/pit-guard.js',
  'lib/recite.js',
];
// `DSH_PROBE_REPORT` lets a parent that cannot capture this process's stdout still read
// the verdict — the same override `budget-chain-probe.mjs` already offers. `debt-audit.mjs`
// needs it: it must spawn with `stdio: 'ignore'`, because a confined channel refuses a
// pipe and the whole audit would die with `EPERM: spawn` (measured 2026-10-02, and again
// when Electron probes were first wired in on 2026-10-03).
const OUT = process.env.DSH_PROBE_REPORT ?? tempReport('acceptance-report.json');

// The modules import bare `@deepseek-ai/*`, which only resolve once the host's
// profile-resolution bootstrap is installed (see probes/README.md).
await installResolution();

const checks = [];
const check = (id, name, ok, evidence) => checks.push({ id, name, ok: ok === true, evidence });
const stubCtx = () => {
  const registered = [];
  const sections = [];
  const handlers = [];
  return {
    registered,
    sections,
    handlers,
    tools: { register: (def) => registered.push(def) },
    systemPrompt: { section: (s) => sections.push(s) },
    on: (event, fn) => {
      handlers.push({ event, fn });
      return () => {};
    },
  };
};

// --- every declared module imports and registers -----------------------------
const loaded = {};
for (const rel of MODULES) {
  const ctx = stubCtx();
  try {
    const mod = await import(pathToFileURL(`${PKG_DIR}/${rel}`).href);
    mod.apply(ctx, undefined);
    loaded[rel] = { name: mod.name, registered: ctx.registered.map((d) => d.name), sections: ctx.sections.length, handlers: ctx.handlers.map((h) => h.event) };
    check(`load:${rel}`, `${rel} imports and registers`, true, loaded[rel]);
  } catch (error) {
    loaded[rel] = { error: `${error?.name}: ${error?.message}` };
    check(`load:${rel}`, `${rel} imports and registers`, false, loaded[rel]);
  }
}
check(
  'tools-registered',
  'the preset exposes code_brief / code_record / code_verify',
  ['code_brief', 'code_record', 'code_verify'].every((n) =>
    Object.values(loaded).some((l) => (l.registered ?? []).includes(n)),
  ),
  { seen: Object.values(loaded).flatMap((l) => l.registered ?? []) },
);

// --- drive the tools end-to-end against a throwaway project ------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-accept-'));
const session = 'sess-acceptance';
const execFor = (name, args) => ({ name, arguments: args, agent: { session: { id: session, header: { cwd: root } } } });
const toolFrom = async (rel, toolName) => {
  const mod = await import(pathToFileURL(`${PKG_DIR}/${rel}`).href);
  const ctx = stubCtx();
  mod.apply(ctx, undefined);
  return ctx.registered.find((d) => d.name === toolName);
};

const briefTool = await toolFrom('lib/tool-brief.js', 'code_brief');
const recordTool = await toolFrom('lib/tool-record.js', 'code_record');

const fresh = await briefTool.execute({}, execFor('code_brief', {}));
check('brief:fresh', 'code_brief answers on a project with no ledger', fresh.empty === true && fresh.brief.includes('No ledger yet'), {
  empty: fresh.empty,
  firstLine: fresh.brief.split('\n')[0],
});

const kinds = [
  ['project', { kind: 'project', patch: { commands: { test: 'pnpm test' }, stack: 'Node 24 ESM', layout: 'lib/' } }],
  ['progress-active', { kind: 'progress', title: 'Wire the mode end to end', note: 'acceptance probe' }],
  ['decision', { kind: 'decision', title: 'Ledger in-project', body: 'Travels with the repo.', alternatives: 'Host storage (lost on machine change)' }],
  ['mistake', { kind: 'mistake', symptom: 'probe wrote to the workspace', cause: 'code_verify shell is read-only', fix: 'write to $env:TEMP', files: 'lib/tool-verify.js:80', avoid: 'do not assume both channels have the same rights' }],
  ['verified-claim', { kind: 'verified', cmd: 'pnpm test', expect: 'pass' }],
];
for (const [label, args] of kinds) {
  try {
    const value = await recordTool.execute(args, execFor('code_record', args));
    const rendered = recordTool.output.render(args, value)[0].text;
    check(`record:${label}`, `code_record(${label}) writes and renders`, rendered.includes('Recorded'), {
      summary: value.summary,
      file: value.file.replace(root, '<root>'),
    });
  } catch (error) {
    check(`record:${label}`, `code_record(${label}) writes and renders`, false, { error: `${error?.name}: ${error?.message}` });
  }
}

// done with only a CLAMED verification on file must still be flagged.
try {
  const doneArgs = { kind: 'progress', task: 'Wire the mode end to end', status: 'done', note: 'shipping it' };
  const doneValue = await recordTool.execute(doneArgs, execFor('code_record', doneArgs));
  const board = JSON.parse(fs.readFileSync(path.join(root, '.dsh-code', 'tasks.json'), 'utf8'));
  const onBoard = [...(board.done ?? []), ...(board.active ?? [])].map((t) => t.id);
  const entry = (board.done ?? [])[0];
  const warning = JSON.stringify(entry?.notes ?? []);
  check(
    'record:done-guard',
    'done without a real verification is flagged in the ledger',
    /marked done with no passing code_verify/.test(warning),
    { doneSummary: doneValue.summary, boardIds: onBoard, noteTail: warning.slice(-240) },
  );
} catch (error) {
  check('record:done-guard', 'done without a real verification is flagged in the ledger', false, {
    error: `${error?.name}: ${error?.message}`,
  });
}

// --- write-time validation of the command-side pit trigger -------------------
// Measured 2026-10-02: `matchesTrigger` swallows a pattern that does not compile
// and returns false, so a typo in a `trigger:` meant the pit silently never fired
// and nothing anywhere said so. The write is the only moment anyone is looking at
// the pattern, so the tool must refuse it there.
try {
  const bad = { kind: 'mistake', symptom: 'bad trigger fixture', cause: 'unbalanced group', fix: 'quote it', trigger: 'Set-Content|(Out-File' };
  await recordTool.execute(bad, execFor('code_record', bad));
  check('record:trigger-invalid', 'a trigger that does not compile is rejected at write time', false, {
    note: 'the broken pattern was accepted, so the pit would never fire',
  });
} catch (error) {
  check(
    'record:trigger-invalid',
    'a trigger that does not compile is rejected at write time',
    /never fire/.test(String(error?.message ?? '')),
    { error: String(error?.message ?? error).slice(0, 200) },
  );
}

// A good trigger can be proven at write time instead of trusted: the samples say
// what it does and does not catch.
try {
  const withSamples = {
    kind: 'mistake',
    symptom: 'sample-tested trigger fixture',
    cause: 'a shell that rewrites text',
    fix: 'write through Node',
    trigger: 'Set-Content|Out-File',
    triggerSample: 'Get-Content a.txt | Set-Content b.txt; pnpm test',
  };
  const value = await recordTool.execute(withSamples, execFor('code_record', withSamples));
  check(
    'record:trigger-samples',
    'triggerSample reports which samples the trigger catches and which it misses',
    /1 matched/.test(value.summary) && /1 did NOT match/.test(value.summary) && value.summary.includes('pnpm test'),
    { summary: value.summary },
  );
} catch (error) {
  check('record:trigger-samples', 'triggerSample reports which samples the trigger catches and which it misses', false, {
    error: `${error?.name}: ${error?.message}`,
  });
}

try {
  const orphan = { kind: 'mistake', symptom: 'orphan sample fixture', cause: 'x', fix: 'y', triggerSample: 'pnpm test' };
  await recordTool.execute(orphan, execFor('code_record', orphan));
  check('record:trigger-sample-needs-trigger', 'triggerSample without a trigger is rejected', false, { note: 'accepted silently' });
} catch (error) {
  check('record:trigger-sample-needs-trigger', 'triggerSample without a trigger is rejected', /needs `trigger`/.test(String(error?.message ?? '')), {
    error: String(error?.message ?? error).slice(0, 160),
  });
}

// code_verify through a stub shell must record real evidence.
const verifyTool = await toolFrom('lib/tool-verify.js', 'code_verify');
const shellCalls = [];
const vCtx = stubCtx();
const verifyMod = await import(pathToFileURL(`${PKG_DIR}/lib/tool-verify.js`).href);
verifyMod.apply(
  {
    ...vCtx,
    shell: {
      resolve: (opts) => {
        shellCalls.push(opts);
        return opts;
      },
      execute: async (opts) => ({ result: async () => ({ exitCode: 0, stdout: { text: opts.command.includes('fail') ? '' : 'all tests passed' }, stderr: { text: '' } }) }),
    },
  },
  undefined,
);
const verifyDef = vCtx.registered.find((d) => d.name === 'code_verify');
const verified = await verifyDef.execute({ cmd: 'pnpm test', expect: 'all tests passed' }, execFor('code_verify', {}));
check('verify:pass', 'code_verify runs through ctx.shell and records evidence', verified.ok === true && shellCalls.length === 1, {
  exitCode: verified.exitCode,
  matched: verified.matched,
  ok: verified.ok,
  journal: verified.journal.replace(root, '<root>'),
  workdir: shellCalls[0]?.workdir?.replace(root, '<root>'),
});
const failed = await verifyDef.execute({ cmd: 'pnpm test fail', expect: 'all tests passed' }, execFor('code_verify', {}));
check('verify:fail', 'a real failure is recorded as not-ok', failed.ok === false, { exitCode: failed.exitCode, matched: failed.matched, ok: failed.ok });

// The brief after all that must carry the memory, not just the project block.
const after = await briefTool.execute({}, execFor('code_brief', {}));
check(
  'brief:populated',
  'code_brief carries mistakes, decisions and the verification journal',
  after.brief.includes('## Known mistakes') && after.brief.includes('## Recent decisions') && after.brief.includes('probe wrote to the workspace'),
  { chars: after.brief.length, omitted: after.omittedSections, sections: (after.brief.match(/^## .+$/gm) ?? []).map((s) => s.trim()) },
);
check('brief:budget', 'the brief respects its character budget', after.brief.length <= 4000, { chars: after.brief.length });

// The debt half of the gate: a turn that edited and ran nothing.
const { recordUnverified } = await import(pathToFileURL(`${PKG_DIR}/lib/ledger.js`).href);
recordUnverified(root, { edits: ['write E:\\proj\\src\\x.js'], turn: 1 }, 'sess-other');
const afterDebt = await briefTool.execute({}, execFor('code_brief', {}));
check(
  'brief:debt',
  'an unverified earlier turn surfaces in the next briefing',
  afterDebt.brief.includes('## Turns that changed code and ran nothing') && afterDebt.brief.includes('src\\x.js'),
  { hasDebt: afterDebt.brief.includes('## Turns that changed code'), chars: afterDebt.brief.length },
);

fs.rmSync(root, { recursive: true, force: true });
const report = {
  modules: loaded,
  failed: checks.filter((c) => !c.ok).map((c) => `${c.id} ${c.name}`),
  passed: checks.filter((c) => c.ok).length,
  total: checks.length,
  checks,
};
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ passed: report.passed, total: report.total, failed: report.failed }, null, 2));
