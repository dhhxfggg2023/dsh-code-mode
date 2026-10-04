/**
 * verify-ledger-fixes.mjs — one verdict for the four ledger fixes (F8, F9, F10, F11),
 * with a control for each so a green check cannot be a check that was never red.
 *
 *   <node> .dsh-code\audits\verify-ledger-fixes.mjs
 *
 * Prints every check, then ONE final line: `ALL-VERIFIED`, or `HAS-PROBLEMS` followed by
 * the problems. Exits non-zero on anything red.
 *
 * HOW IT GETS ITS EVIDENCE, AND WHY IT IS BUILT THIS WAY
 *
 * - The probes are the auditor's own (`.dsh-code/audits/05`, `06`, `12`, plus `03`, `04`
 *   and `13` for the findings outside this task) and the standing suite (`brief-full`,
 *   `guard`, `write-rule`, `audit-verify`, `journal-rotation`) plus
 *   `.dsh-code/audits/probe-debt-coverage.mjs`, whose E2/E3/E5 are the settlement guards
 *   the F10 fix must not move.
 * - Each probe is **imported into this process**, not spawned. That is not a shortcut:
 *   the `code_verify` shell cannot give a child a piped stdio (recorded machine pit,
 *   measured 2026-10-04 — `spawnSync` returns in ~1 ms with nothing written), and this
 *   script has to reach a verdict inside that channel. Importing a probe runs the same
 *   file through the same code with no pipe in the middle; every probe here is plain ESM
 *   that imports `lib/ledger.js` by path. The one probe that ends in `process.exit(...)`
 *   gets that call captured instead of performed, and its verdict read from the captured
 *   code — which is what the shell would have seen.
 * - Every fix has a **control**: the pre-fix behaviour is restored by an exact-anchored
 *   source revert in a *copy* of `lib/ledger.js` under `os.tmpdir()`, the finding's own
 *   probe is run against that copy, and the checks that are supposed to flip must be RED
 *   there. F10 gets a second control for the *vacuous* reading of its fix (resolving the
 *   relative target against the proof's cwd instead of the debt's), which is the reading
 *   that would quietly delete the cross-project guard.
 * - The two findings whose subject is what the *caller* sees — F9's `full: true` and
 *   F11's dropped task ids — are additionally driven through the real tool handlers
 *   (`lib/tool-brief.js`, `lib/tool-record.js`) once, with the host's `defineTool` and
 *   `schemastery` stubbed: the handler body under test is the real one, and the stub only
 *   removes the plugin host those handlers never touch. Same technique as
 *   `.dsh-code/audits/probe-gate-evidence.mjs`. Those drives run inside the same control
 *   loop, so they are shown red against the reverted copy too.
 * - `DSH_CODE_GLOBAL_DIR` is redirected before the first read, so nothing here can touch
 *   the developer's real `~/.dsh-code/`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ledger-fixes-'));
process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(TMP, 'global-'));

const AUDIT = '.dsh-code/audits';
const PROBES = 'probes';
const CONTROLS = [
  [AUDIT, '05-merge-header-duplication.mjs'],
  [AUDIT, '06-budget-invariants.mjs'],
  [AUDIT, '12-settle-and-caps.mjs'],
  [AUDIT, '03-rotation-saturation.mjs'],
  [AUDIT, '04-slug-collapse-merge.mjs'],
  [AUDIT, '13-input-tolerance.mjs'],
  [PROBES, 'brief-full-probe.mjs'],
  [PROBES, 'guard-probe.mjs'],
  [PROBES, 'write-rule-probe.mjs'],
  [PROBES, 'audit-verify-probe.mjs'],
  [PROBES, 'journal-rotation-probe.mjs'],
  [AUDIT, 'probe-debt-coverage.mjs'],
];

/* ------------------------------------------------------------------ running probes */

/** Thrown by a probe that calls `process.exit()`; its code is captured instead. */
class ProbeExit extends Error {}

/**
 * Probes already run in this process, keyed by absolute path.
 *
 * Two findings read the same probe (11 uses probe 12's board section, 9 and 10 use its
 * budget and settle sections), and an ES module is evaluated once per URL — without this
 * cache the second import would return nothing and the check would read an empty string,
 * which looks exactly like a probe that failed to print.
 */
const probeRuns = new Map();

/**
 * Run one probe module in this process and collect everything it printed.
 * @param file - absolute path of the probe.
 * @returns `{ out, exitCode, error }` — `error` is set when the probe threw.
 */
async function runProbe(file) {
  const cached = probeRuns.get(file);
  if (cached !== undefined) return cached;
  const chunks = [];
  const write = process.stdout.write;
  const exit = process.exit;
  const exitCode = process.exitCode;
  let captured;
  let error;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  process.exit = (code) => {
    captured = code ?? 0;
    throw new ProbeExit('the probe called process.exit');
  };
  try {
    await import(pathToFileURL(file).href);
  } catch (thrown) {
    if (!(thrown instanceof ProbeExit)) error = `${thrown?.name}: ${thrown?.message}`;
  } finally {
    process.stdout.write = write;
    process.exit = exit;
    process.exitCode = exitCode;
  }
  const result = { file, out: chunks.join(''), exitCode: captured, error };
  probeRuns.set(file, result);
  return result;
}

/* ------------------------------------------------- the real tool entry points */

/**
 * The host resolves `@deepseek-ai/*` through its profile-resolution bootstrap, which only
 * exists inside the host process; plain node cannot resolve those specifiers at all
 * (recorded pit). The two tool modules import `defineTool` and `schemastery` and nothing
 * else from the host, so those are stubbed for the duration of a drive and the handler
 * bodies — the code under test — stay real.
 */
/**
 * A chainable stand-in for `schemastery`: every property is a function, every call
 * returns another one (`z.object({})`, `z.number().default(4000)`). The `apply` trap is
 * load-bearing — without it a call falls through to the empty target function and returns
 * `undefined`, so `z.number().default(...)` dies with "reading 'default'".
 */
const anyChain = () => new Proxy(function () {}, { get: () => anyChain(), apply: () => anyChain() });
globalThis.__verifyStubs = { z: anyChain() };
let stubActive = false;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubActive && specifier.startsWith('@deepseek-ai/')) return { url: `verify-stub:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'verify-stub:@deepseek-ai/schemastery') {
      return { format: 'module', shortCircuit: true, source: 'export default globalThis.__verifyStubs.z;' };
    }
    if (url === 'verify-stub:@deepseek-ai/dsh-tools' || url === 'stub:@deepseek-ai/dsh-tools') {
      // The second URL is `.dsh-code/audits/probe-debt-coverage.mjs`'s own stub scheme: it
      // registers module hooks of its own when F10 runs it, later registrations run first,
      // and its resolve hook claims every `@deepseek-ai/*`. It answers schemastery itself
      // and passes the rest through, so this is what keeps the tool drives working after
      // that probe has been imported.
      return { format: 'module', shortCircuit: true, source: 'export const defineTool = (def) => def;' };
    }
    return nextLoad(url, context);
  },
});

const execFor = (cwd) => ({ name: 'verify', arguments: {}, agent: { session: { id: 'verify-session', header: { cwd } } } });

/** Load a tool module out of `root` and hand back the definition it registers. */
async function loadTool(root, file, tool) {
  stubActive = true;
  try {
    const mod = await import(pathToFileURL(path.join(root, 'lib', file)).href);
    const defs = [];
    mod.apply({ tools: { register: (def) => defs.push(def) } }, { maxChars: 4000 });
    const def = defs.find((d) => d.name === tool);
    if (def === undefined) throw new Error(`${file} registered no ${tool}`);
    return def;
  } finally {
    stubActive = false;
  }
}

const scratch = (tag) => fs.mkdtempSync(path.join(TMP, `${tag}-`));

/* ------------------------------------------------------------------ the findings */

/**
 * The four fixes. `verify` turns the evidence into checks; `controls` name the mutant
 * variants and the check ids that MUST be red in each of them. Every other check the
 * finding produces must stay green in that variant — a guard that goes red under the
 * mutation would mean it is not measuring the fix.
 */
const FINDINGS = [
  {
    id: 'F8',
    title: 'a mistakes.md that starts with an entry merges idempotently (entry #1 is not duplicated)',
    probes: [`${AUDIT}/05-merge-header-duplication.mjs`],
    controls: [
      {
        name: 'pre-fix headerOf',
        red: ['F8.b', 'F8.c'],
        revert: [
          {
            from: String.raw`  const [first = ''] = String(text ?? '').split(/\n(?=## )/);
  const preamble = first.trim();`,
            to: String.raw`  const first = String(text ?? '').indexOf('\n## ');
  const preamble = (first === -1 ? '' : text.slice(0, first)).trim();`,
          },
          { from: String.raw`  return preamble.startsWith('## ') ? '' : preamble;`, to: String.raw`  return preamble;` },
        ],
      },
    ],
    verify: (ev) => {
      const { out } = ev.probes['05-merge-header-duplication.mjs'];
      const rows = [...out.matchAll(/^\s*(.+?)\s+entries after 1st=(\d+)\s+after 2nd=(\d+)\s*$/gm)].map((m) => ({
        label: m[1].trim(),
        afterFirst: Number(m[2]),
        afterSecond: Number(m[3]),
      }));
      const occurrences = [...out.matchAll(/'alpha something happened' occurrences: (\d+)/g)].map((m) => Number(m[1]));
      return [
        {
          id: 'F8.a',
          name: 'the probe measured all four mistakes.md layouts (layout guard)',
          flips: false,
          ok: rows.length === 4,
          evidence: { rows: rows.map((r) => r.label) },
        },
        {
          id: 'F8.b',
          name: 'the second repeat of the same pit leaves the entry count unchanged',
          flips: true,
          ok: rows.length === 4 && rows.every((r) => r.afterFirst === r.afterSecond),
          evidence: { rows },
        },
        {
          id: 'F8.c',
          name: 'the merged symptom text appears twice in the file, never three times',
          flips: true,
          ok: occurrences.length === 4 && occurrences.every((n) => n === 2),
          evidence: { occurrences },
        },
      ];
    },
  },
  {
    id: 'F9',
    title: 'briefFull (code_brief full:true) reaches its own ceilings, and stays bounded',
    probes: [`${AUDIT}/06-budget-invariants.mjs`, `${AUDIT}/12-settle-and-caps.mjs`],
    tools: ['tool-brief.js'],
    controls: [
      {
        name: 'pre-fix briefFull',
        red: ['F9.a', 'F9.b', 'F9.d', 'CALLER.F9.b'],
        revert: [
          {
            from: String.raw`  return brief(cwd, { session, full: true });`,
            to: String.raw`  return brief(cwd, { session, maxChars: UNCAPPED_TOTAL });`,
          },
        ],
      },
    ],
    local: (root) => driveFullBrief(root),
    verify: (ev) => {
      const budget = ev.probes['06-budget-invariants.mjs'].out;
      const caps = ev.probes['12-settle-and-caps.mjs'].out;
      const number = (re, text) => {
        const found = re.exec(text);
        return found === undefined ? undefined : Number(found[1]);
      };
      const fullChars = number(/briefFull\(\)\s+-> (\d+) chars, project body (\d+)/, budget);
      const fullBody = number(/briefFull\(\)\s+-> \d+ chars, project body (\d+)/, budget);
      const generousChars = number(/brief\(maxChars: 20000\) -> (\d+) chars, project body (\d+)/, budget);
      const generousBody = number(/brief\(maxChars: 20000\) -> \d+ chars, project body (\d+)/, budget);
      const capsFullChars = number(/briefFull's own text length: (\d+)/, caps);
      const drive = ev.local;
      return [
        {
          id: 'F9.a',
          name: 'the probe reports that briefFull lifts the per-section division',
          flips: true,
          ok: /briefFull lifts the division: true/.test(budget),
          evidence: { line: /.*briefFull lifts the division.*/.exec(budget)?.[0] },
        },
        {
          id: 'F9.b',
          name: "briefFull's own view equals the view at a budget that reaches the ceilings",
          flips: true,
          ok: fullChars !== undefined && fullChars === generousChars && fullBody === generousBody,
          evidence: { fullChars, generousChars, fullBody, generousBody },
        },
        {
          id: 'F9.c',
          name: 'still bounded: the full view stays inside the sum of the section ceilings plus the reserve',
          flips: false,
          ok: fullChars !== undefined && fullChars <= 11000,
          evidence: { fullChars, bound: '10100 (sum of the eight ceilings) + reserve' },
        },
        {
          id: 'F9.d',
          name: 'the full view carries at least one section at its ceiling (probe 12B)',
          flips: true,
          // 1,700 is SECTION_BUDGET.project's ceiling: the divided share this fixture gets
          // is ~700, so reaching 1,700 means the ceilings branch fired inside `full`.
          ok: capsFullChars !== undefined && capsFullChars >= 1700,
          evidence: { fullTextChars: capsFullChars, projectCeiling: 1700, preFixChars: 842 },
        },
        {
          id: 'CALLER.F9.a',
          // A guard, not a discriminator: the pre-fix `briefFull` also beat the default
          // budget (it asked for 8,900 rather than 4,000), which is exactly why
          // `brief-full-probe`'s B2 — "strictly more entries than the default" — was
          // green before this fix and could not see F9 at all. The check that flips is
          // CALLER.F9.b, which compares the full view with the view at a budget that
          // really reaches the ceilings.
          name: 'guard: code_brief(full:true) is still a strictly larger view than the default budget',
          flips: false,
          ok: drive?.error === undefined && drive.fullChars > drive.normalChars,
          evidence: drive,
        },
        {
          id: 'CALLER.F9.b',
          name: "code_brief(full:true) returns exactly the ledger's largest bounded view",
          flips: true,
          ok: drive?.error === undefined && drive.fullChars === drive.generousChars,
          evidence: drive,
        },
        {
          id: 'CALLER.F9.c',
          name: 'the default code_brief still respects the configured budget (guard)',
          flips: false,
          ok: drive?.error === undefined && drive.normalChars <= 4000,
          evidence: drive,
        },
      ];
    },
  },
  {
    id: 'F10',
    title: 'a relative edit target settles against a proof in the project it was recorded in',
    probes: [`${AUDIT}/12-settle-and-caps.mjs`, `${AUDIT}/probe-debt-coverage.mjs`],
    local: (root) => driveRelativeCrossProject(root),
    controls: [
      {
        name: 'pre-fix comparison',
        red: ['F10.b'],
        revert: [{ from: String.raw`  const path = resolveAgainst(comparablePath(target), origin);`, to: String.raw`  const path = comparablePath(target);` }],
      },
      {
        // The literal reading of the fix — "resolve the relative target against the
        // PROOF's cwd" — makes containment true for a proof anywhere, so the
        // cross-project guards must go red here: F10.c is the local fixture, F10.e is
        // probe-debt-coverage's E9, which is the same leak through the real journal shape.
        name: 'vacuous proof-cwd anchor',
        red: ['F10.c', 'F10.e'],
        revert: [
          {
            from: String.raw`  const path = resolveAgainst(comparablePath(target), origin);`,
            to: String.raw`  const path = resolveAgainst(comparablePath(target), proof.cwd);`,
          },
        ],
      },
      {
        // `..` kept as a literal segment: `<root>/../other/a.js` then still has `<root>` as
        // its prefix, so a proof in the project settles a debt on a file beside it.
        name: 'literal dot-dot segments',
        red: ['F10.d'],
        revert: [{ from: String.raw`    if (part === '..') out.pop();`, to: String.raw`    if (part === '..') out.push(part);` }],
      },
    ],
    verify: (ev) => {
      const { out } = ev.probes['12-settle-and-caps.mjs'];
      const coverage = ev.probes['probe-debt-coverage.mjs'].out;
      const rows = out
        .split(/^-- /m)
        .slice(1)
        .filter((block) => /settled by that proof:/.test(block))
        .map((block) => ({ label: block.split('\n', 1)[0].trim(), settled: /settled by that proof: true/.test(block) }));
      const absolute = rows.find((row) => row.label.startsWith('ABSOLUTE'));
      const relative = rows.find((row) => row.label.startsWith('RELATIVE'));
      return [
        {
          id: 'F10.a',
          name: 'the absolute-target control still settles (guard: the fix must not move it)',
          flips: false,
          ok: absolute?.settled === true,
          evidence: { rows },
        },
        {
          id: 'F10.b',
          name: 'a debt recorded with a RELATIVE target settles against a proof in that project',
          flips: true,
          ok: relative?.settled === true,
          evidence: { rows },
        },
        {
          id: 'F10.c',
          name: 'guard: a relative target in project A is NOT settled by a proof in project B',
          flips: false,
          ok: ev.local?.crossProjectSettled === false,
          evidence: ev.local,
        },
        {
          id: 'F10.d',
          name: 'guard: a relative target resolving OUTSIDE the project is not settled by a proof inside it',
          flips: false,
          ok: /^ok {3}E8 /m.test(coverage),
          evidence: { line: /.*E8 .*/.exec(coverage)?.[0]?.slice(0, 200) },
        },
        {
          id: 'F10.e',
          name: 'guard: a proof in ANOTHER project does not settle a relative target recorded here',
          flips: false,
          ok: /^ok {3}E9 /m.test(coverage),
          evidence: { line: /.*E9 .*/.exec(coverage)?.[0]?.slice(0, 200) },
        },
      ];
    },
  },
  {
    id: 'F11',
    title: 'the board cap names the tasks it evicts, to the caller and in the brief',
    probes: [`${AUDIT}/12-settle-and-caps.mjs`],
    tools: ['tool-record.js'],
    local: (root) => driveRecordNotice(root),
    controls: [
      {
        name: 'pre-fix silent cap',
        red: ['F11.a', 'F11.b', 'CALLER.F11.a', 'CALLER.F11.b'],
        revert: [
          { from: String.raw`  for (const gone of removed) {`, to: String.raw`  for (const gone of []) {` },
          { from: String.raw`    removed.length === 0`, to: String.raw`    true` },
        ],
      },
    ],
    verify: (ev) => {
      const { out } = ev.probes['12-settle-and-caps.mjs'];
      const board = /tasks created: (\d+); board holds active=(\d+)/.exec(out);
      const absent = /tasks created but absent from the board: (\[[^\]]*\])/.exec(out)?.[1];
      return [
        {
          id: 'F11.a',
          name: 'the journal records the eviction as a removal of that task id',
          flips: true,
          ok: /the journal mentions the dropped task as removed: true/.test(out),
          evidence: { line: /.*journal mentions the dropped task.*/.exec(out)?.[0] },
        },
        {
          id: 'F11.b',
          name: 'the next briefing names the dropped task',
          flips: true,
          ok: /the brief says anything about the dropped task or a cap on the board: true/.test(out),
          evidence: { line: /.*the brief says anything about the dropped.*/.exec(out)?.[0] },
        },
        {
          id: 'F11.c',
          name: 'guard: the cap still evicts (the fix names the loss, it does not remove the bound)',
          flips: false,
          ok: board?.[1] === '41' && board?.[2] === '40' && absent !== undefined && absent !== '[]',
          evidence: { board: board?.[0], absent },
        },
        {
          id: 'CALLER.F11.a',
          // `summary` is the only free-text key `code_record`'s output schema declares
          // (`additionalProperties: false`), which is why the notice is folded into it
          // rather than returned beside it — see the long note on that schema.
          name: 'code_record(progress) names the dropped task ids in the text it returns',
          flips: true,
          ok: ev.local?.error === undefined && typeof ev.local?.summary === 'string' && ev.local.summary.includes(ev.local.droppedId),
          evidence: ev.local,
        },
        {
          id: 'CALLER.F11.b',
          name: 'the dropped id survives into the text the model is shown',
          flips: true,
          ok: ev.local?.error === undefined && typeof ev.local?.rendered === 'string' && ev.local.rendered.includes(ev.local.droppedId),
          evidence: { rendered: String(ev.local?.rendered ?? '').slice(0, 400), droppedId: ev.local?.droppedId },
        },
        {
          id: 'CALLER.F11.c',
          name: 'guard: the record of the task that was written is still the first thing in the summary',
          flips: false,
          ok: ev.local?.error === undefined && typeof ev.local?.summary === 'string' && ev.local.summary.startsWith(ev.local.writtenId),
          evidence: { summary: String(ev.local?.summary ?? '').slice(0, 200), writtenId: ev.local?.writtenId },
        },
      ];
    },
  },
];

/* ------------------------------------------------- the local (non-probe) checks */

/**
 * F9 through the real tool handler: `code_brief` with and without `full`.
 * @param root - the package tree under test (the real one, or a reverted copy).
 */
async function driveFullBrief(root) {
  try {
    const ledger = await import(pathToFileURL(path.join(root, 'lib', 'ledger.js')).href);
    const dir = scratch('full-brief');
    ledger.initLedger(dir, 'verify-session');
    ledger.writeProject(
      dir,
      {
        commands: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`cmd${i}`, `pnpm run thing-${i} --flag ${'z'.repeat(60)}`])),
        stack: `Node 24, pure ESM (${'s'.repeat(400)})`,
        layout: `lib/ core (${'l'.repeat(400)})`,
        notes: `n${'n'.repeat(1500)}`,
      },
      'verify-session',
    );
    ledger.recordMistake(
      dir,
      { symptom: 'FIXTURE-LONG-PIT', cause: 'LONGCAUSE '.repeat(120).slice(0, 1150), fix: 'fix', files: 'lib/ledger.js:1', avoid: 'LONGRULE '.repeat(120).slice(0, 1150) },
      'verify-session',
    );
    const def = await loadTool(root, 'tool-brief.js', 'code_brief');
    const normal = await def.execute({}, execFor(dir));
    const full = await def.execute({ full: true }, execFor(dir));
    const generous = ledger.brief(dir, { session: 'verify-session', maxChars: 20000 });
    return {
      normalChars: String(normal.brief ?? '').length,
      fullChars: String(full.brief ?? '').length,
      generousChars: generous.text.length,
      fullEqualsGenerous: String(full.brief ?? '') === generous.text,
      omittedSections: full.omittedSections ?? [],
    };
  } catch (error) {
    return { error: `${error?.name}: ${error?.message}` };
  }
}

/**
 * F10's guard, which no audit probe covers: the same RELATIVE target recorded in project
 * A, a passing proof recorded in project B. Resolving the target against the *proof's*
 * cwd (instead of the debt's own coordinate) would settle this, and that is the false
 * coverage the fix must not introduce.
 * @param root - the package tree under test.
 */
async function driveRelativeCrossProject(root) {
  try {
    const ledger = await import(pathToFileURL(path.join(root, 'lib', 'ledger.js')).href);
    const projectA = scratch('relative-a');
    const projectB = scratch('relative-b');
    ledger.initLedger(projectA, 'verify-session');
    ledger.recordUnverified(projectA, { edits: ['edit lib/target.js'], turn: 1, state: 'none' }, 'earlier-session');
    ledger.journalEvent(projectA, { session: 'earlier-session', kind: 'note', title: 'the other project ran a proof' });
    const journal = path.join(projectA, '.dsh-code', 'journal.jsonl');
    const lines = fs.readFileSync(journal, 'utf8').trimEnd().split('\n');
    lines.push(
      JSON.stringify({ ts: new Date(Date.now() + 1000).toISOString(), session: 'earlier-session', kind: 'verified', cmd: 'pnpm test', cwd: projectB, ok: true }),
    );
    fs.writeFileSync(journal, `${lines.join('\n')}\n`, 'utf8');
    const text = ledger.brief(projectA, { session: 'verify-reader', maxChars: 8900 }).text;
    return { crossProjectSettled: !text.includes('## Turns that changed code'), projectA, projectB };
  } catch (error) {
    return { error: `${error?.name}: ${error?.message}` };
  }
}

/**
 * F11 through the real tool handler: 40 tasks on the board, then the 41st through
 * `code_record(kind="progress")` — the caller path that has to hear about the eviction.
 * @param root - the package tree under test.
 */
async function driveRecordNotice(root) {
  try {
    const ledger = await import(pathToFileURL(path.join(root, 'lib', 'ledger.js')).href);
    const dir = scratch('board');
    ledger.initLedger(dir, 'verify-session');
    for (let i = 1; i <= 40; i += 1) ledger.recordTask(dir, { title: `board task number ${i}` }, 'verify-session');
    const def = await loadTool(root, 'tool-record.js', 'code_record');
    const args = { kind: 'progress', title: 'the forty first task' };
    const value = await def.execute(args, execFor(dir));
    const rendered = def.output.render(args, value);
    return {
      summary: String(value.summary ?? ''),
      notice: typeof value.notice === 'string' ? value.notice : undefined,
      rendered: JSON.stringify(rendered),
      droppedId: `${ledger.today()}-board-task-number-1`,
      writtenId: `${ledger.today()}-the-forty-first-task`,
    };
  } catch (error) {
    return { error: `${error?.name}: ${error?.message}` };
  }
}

/* ------------------------------------------------------------------ mechanics */

const checks = [];
const problems = [];
const open = [];

/**
 * @param phase - 'control' | 'fixed' | 'suite'.
 */
function check(phase, owner, { id, name, flips, ok, evidence }) {
  checks.push({ phase, owner, id, name, flips, ok, evidence });
  if (phase !== 'control' && !ok) problems.push(`${id} ${name} :: ${JSON.stringify(evidence)?.slice(0, 300)}`);
  const tag = phase === 'control' ? `control/${owner}` : phase === 'suite' ? 'suite' : owner;
  console.log(`${ok === true ? 'ok  ' : 'BAD '} [${tag}] ${id} ${name}`);
  if (ok !== true) console.log(`       ${JSON.stringify(evidence)?.slice(0, 400)}`);
}

/** Restore the pre-fix behaviour in a copy of the package's `lib/`. */
function buildTree(finding, variant) {
  const root = path.join(TMP, `control-${finding.id}-${variant.name.replace(/[^a-z0-9]+/gi, '-')}`);
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  let source = fs.readFileSync(path.join(PKG, 'lib', 'ledger.js'), 'utf8');
  for (const { from, to } of variant.revert) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      return { root, error: `the revert anchor occurs ${hits}× in lib/ledger.js, so the control is stale: ${JSON.stringify(from.slice(0, 80))}` };
    }
    source = source.replace(from, to);
  }
  fs.writeFileSync(path.join(root, 'lib', 'ledger.js'), source, 'utf8');
  for (const file of finding.tools ?? []) fs.copyFileSync(path.join(PKG, 'lib', file), path.join(root, 'lib', file));
  for (const rel of finding.probes) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(PKG, rel), dest);
  }
  return { root };
}

async function evidenceFor(finding, root) {
  const probes = {};
  for (const rel of finding.probes) probes[path.basename(rel)] = await runProbe(path.join(root, rel));
  const local = finding.local === undefined ? undefined : await finding.local(root);
  return { root, probes, local };
}

/* ------------------------------------------------ phase 1: the controls (red first) */

console.log(`verify-ledger-fixes — node ${process.version}, package ${PKG}`);
console.log(`temp: ${TMP}`);
console.log('\n=== controls: the pre-fix behaviour restored, each finding\'s own probe re-run ===');
for (const finding of FINDINGS) {
  for (const variant of finding.controls) {
    const tree = buildTree(finding, variant);
    if (tree.error !== undefined) {
      problems.push(`${finding.id} control ${variant.name}: ${tree.error}`);
      console.log(`BAD  [control/${finding.id}] ${variant.name} :: ${tree.error}`);
      continue;
    }
    const ev = await evidenceFor(finding, tree.root);
    const results = finding.verify(ev);
    const red = new Set(variant.red);
    for (const result of results) {
      const expected = red.has(result.id) ? result.ok === false : result.ok === true;
      const label = red.has(result.id) ? 'must be RED' : 'must stay green';
      check('control', finding.id, {
        id: `${result.id} (${variant.name})`,
        name: `${result.name} — ${label}`,
        flips: result.flips,
        ok: expected,
        evidence: { observed: result.ok, expected: red.has(result.id) ? 'red' : 'green', detail: result.evidence },
      });
    }
    for (const probe of Object.values(ev.probes)) {
      if (probe.error !== undefined && !/probe-debt-coverage|ENOENT|EPERM/.test(probe.error)) {
        problems.push(`${finding.id} control ${variant.name}: the probe threw after printing: ${probe.error}`);
      }
      if (probe.exitCode !== undefined && probe.exitCode !== 0) {
        problems.push(`${finding.id} control ${variant.name}: the probe exited ${probe.exitCode}`);
      }
    }
  }
}

/* ------------------------------------------------------ phase 2: the fixed code */

console.log('\n=== the four fixes, against the package as it stands ===');
for (const finding of FINDINGS) {
  const ev = await evidenceFor(finding, PKG);
  for (const result of finding.verify(ev)) check('fixed', finding.id, result);
  for (const probe of Object.values(ev.probes)) {
    if (probe.error !== undefined && !/EPERM|ENOENT/.test(probe.error)) {
      problems.push(`${finding.id} probe ${path.basename(probe.file)} threw after printing: ${probe.error}`);
    }
  }
}

/* ------------------------------------------------------------ phase 3: the suite */

console.log('\n=== the standing suite, and the auditor\'s probes for the findings outside this task ===');
const suite = {};
for (const [dir, name] of CONTROLS) {
  const file = path.join(PKG, dir, name);
  suite[name] = await runProbe(file);
  if (suite[name].error !== undefined && !/EPERM|ENOENT/.test(suite[name].error)) {
    // `probe-debt-coverage.mjs` writes its report next to itself, which the code_verify
    // shell may refuse; that is a note, not a verdict, as long as the checks printed.
    (name === 'probe-debt-coverage.mjs' ? open : problems).push(`probe ${name}: threw after printing: ${suite[name].error}`);
  }
}
const out = (name) => suite[name].out;
const at = (name, re) => re.exec(out(name))?.[0];

const suiteChecks = [
  {
    id: 'S1',
    name: 'brief-full-probe: `full` still makes strictly more entries reachable, and is still bounded',
    ok: /^ok\s+B1/m.test(out('brief-full-probe.mjs')) && /^ok\s+B2/m.test(out('brief-full-probe.mjs')) && /^ok\s+B3/m.test(out('brief-full-probe.mjs')) && /4\/4 passed, failed=\[\]/.test(out('brief-full-probe.mjs')),
    evidence: { summary: at('brief-full-probe.mjs', /\d+\/\d+ passed, failed=\[[^\]]*\]/) },
  },
  {
    id: 'S2',
    name: 'guard-probe: every standing guard passes (nothing was weakened to make this pass)',
    ok: /"failed":\s*\[\s*\]/.test(out('guard-probe.mjs')),
    evidence: { summary: at('guard-probe.mjs', /\{\s*"passed":[\s\S]{0,200}?\}/) },
  },
  {
    id: 'S3',
    name: 'write-rule-probe: 12/12 (the restart notice and the write-side advisories)',
    ok: /12\/12 passed, failed=\[\]/.test(out('write-rule-probe.mjs')),
    evidence: { summary: at('write-rule-probe.mjs', /\d+\/\d+ passed, failed=\[[^\]]*\]/) },
  },
  {
    id: 'S4',
    name: 'audit-verify-probe: 7/7 and exit 0',
    ok: /7\/7 passed, failed=\[\]/.test(out('audit-verify-probe.mjs')) && (suite['audit-verify-probe.mjs'].exitCode ?? 0) === 0,
    evidence: { summary: at('audit-verify-probe.mjs', /\d+\/\d+ passed, failed=\[[^\]]*\]/), exitCode: suite['audit-verify-probe.mjs'].exitCode },
  },
  {
    id: 'S5',
    name: 'journal-rotation-probe: 5/5 (rotation still bounded, order still written order)',
    ok: /5\/5 passed, failed=\[\]/.test(out('journal-rotation-probe.mjs')),
    evidence: { summary: at('journal-rotation-probe.mjs', /\d+\/\d+ passed, failed=\[[^\]]*\]/) },
  },
  {
    id: 'S6',
    name: 'probe-debt-coverage: the settlement rules the F10 fix must not move are green (E1 inverted 2026-10-04, E8/E9 added with it)',
    ok: ['E1', 'E1b', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9'].every((id) =>
      new RegExp(`^ok   ${id} `, 'm').test(out('probe-debt-coverage.mjs')),
    ),
    evidence: {
      failed: [...out('probe-debt-coverage.mjs').matchAll(/^FAIL (\S+) /gm)].map((m) => m[1]),
      summary: at('probe-debt-coverage.mjs', /\d+\/\d+ passed, failed=\[[^\]]*\]/),
    },
  },
  {
    id: 'S7',
    name: 'audit 03: journal rotation still works after the shift loop saturates (F5, fixed before this task)',
    ok: /rotation still works at the end: true/.test(out('03-rotation-saturation.mjs')),
    evidence: { line: at('03-rotation-saturation.mjs', /rotation still works at the end: \w+/) },
  },
  {
    id: 'S8',
    name: 'audit 13: every hand-editable shape still reads and merges, with no lone surrogate',
    ok:
      !/THREW/.test(out('13-input-tolerance.mjs')) &&
      !/lone surrogates: [1-9]/.test(out('13-input-tolerance.mjs')) &&
      (out('13-input-tolerance.mjs').match(/merge ok/g) ?? []).length >= 8,
    evidence: { loneSurrogateLines: [...out('13-input-tolerance.mjs').matchAll(/.*lone surrogates:.*/g)].map((m) => m[0].trim()) },
  },
  {
    id: 'S9',
    name: 'audit 04 ran (its finding, F6, is outside this task and still open)',
    ok: /SUMMARY/.test(out('04-slug-collapse-merge.mjs')),
    evidence: { lines: [...out('04-slug-collapse-merge.mjs').matchAll(/^\s{3}(?:non-ASCII-Latin|unrelated pit|60-char).*$/gm)].map((m) => m[0].trim()) },
  },
];
for (const result of suiteChecks) check('suite', 'SUITE', { flips: false, ...result });

/**
 * Findings outside this task, reported rather than asserted. They are red on purpose:
 * fixing them is not what this script verifies, and pretending otherwise by asserting
 * nothing would let them disappear silently.
 */
const f6 = [...out('04-slug-collapse-merge.mjs').matchAll(/^\s{3}(?:unrelated pit merged|60-char prefix collision).*$/gm)].map((m) => m[0].trim());
for (const line of f6) open.push(`F6 (open, outside this task) ${line}`);
open.push(
  'probe-debt-coverage E1 was INVERTED 2026-10-04 (it asserted the superseded "a bare `echo hi` must not settle" rule, contradicting decisions.md and its own control E1b); the coverage guards it was reaching for are now E5 (absolute, cross-tree), E8 (`..` resolves outside the project) and E9 (relative target, proof in another project), all green.',
);

/* ------------------------------------------------------------------ the verdict */

console.log('\n=== open items (not caused by these four fixes, not asserted green) ===');
for (const item of open) console.log(`--  ${item}`);
console.log(`\nchecks: ${checks.filter((c) => c.phase === 'control').length} control, ${checks.filter((c) => c.phase === 'fixed').length} fixed, ${checks.filter((c) => c.phase === 'suite').length} suite`);
if (problems.length === 0) {
  console.log('ALL-VERIFIED');
  process.exitCode = 0;
} else {
  for (const problem of problems) console.log(`PROBLEM ${problem}`);
  console.log(`HAS-PROBLEMS ${problems.length}`);
  process.exitCode = 1;
}
