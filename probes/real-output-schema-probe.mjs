/**
 * The one check `output-schema-probe.mjs` cannot make: do `code_record`'s results survive
 * the harness's **own** result pipeline?
 *
 * That probe stubs the host so it can run in a confined channel, and its `resolve` hook
 * rewrites *every* `@deepseek-ai/*` specifier to a stub — including the validator it would
 * need. So it can only ever assert which keys a fake `defineTool` happened to keep, and
 * that is exactly how a real defect survived it: with the stubs, `notice: undefined` looks
 * harmless, while the harness snapshots the raw value first and refuses an `undefined` leaf
 * (`value is not lossless JSON`), then rejects the undeclared key
 * (`"value.notice" is not a declared property`, `additionalProperties: false`).
 *
 * Measured 2026-10-04 through this probe's two halves: the pre-fix shape
 * `{…, notice: undefined}` makes `snapshotJsonValue` return `undefined` and the string
 * variant is refused by `validateJsonSchemaValue`, while the fixed shape passes both. The
 * `control:` cases below are kept in the check so a future reader can see the validator
 * still refuses what it is supposed to refuse — a validator that accepts everything would
 * make the other five cases meaningless.
 *
 * Runs through the Electron binary like the other host-loading probes, because only that
 * process resolves `@deepseek-ai/*` from the asar.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIB_DIR, ASAR, installResolution, tempReport } from './paths.mjs';

const OUT = process.env.DSH_PROBE_REPORT ?? tempReport('real-output-schema-report.json');
await installResolution();

const harness = await import(
  pathToFileURL(path.join(ASAR, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href
);
const values = await import(
  pathToFileURL(path.join(ASAR, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-util-values', 'lib', 'index.js')).href
);
const validate = harness.validateJsonSchemaValue ?? harness.validateJsonSchema;
const snapshot = values.snapshotJsonValue;

const results = [];
const check = (id, name, ok, evidence) => results.push({ id, name, ok: ok === true, evidence });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'real-schema-'));
process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'real-schema-global-'));
const SESSION = 'real-schema-session';
const execFor = (args) => ({ name: 'code_record', arguments: args, agent: { session: { id: SESSION, header: { cwd: root } } } });

const registered = [];
const mod = await import(pathToFileURL(path.join(LIB_DIR, 'tool-record.js')).href);
mod.apply(
  {
    tools: { register: (def) => registered.push(def) },
    systemPrompt: { section: () => {} },
    on: () => () => {},
  },
  undefined,
);
const tool = registered.find((def) => def.name === 'code_record');
const schema = tool.output.schema;

/** The harness's order: snapshot first (it must be lossless), then validate. */
function pipelineVerdict(value) {
  let snapshotResult;
  try {
    snapshotResult = snapshot(value);
  } catch (error) {
    return { ok: false, stage: 'snapshot threw', detail: `${error?.name}: ${error?.message}` };
  }
  if (snapshotResult === undefined) {
    return { ok: false, stage: 'snapshot', detail: 'snapshotJsonValue returned undefined (refused as "not lossless JSON")' };
  }
  let reported;
  try {
    reported = validate(schema, value);
  } catch (error) {
    return { ok: false, stage: 'validate threw', detail: `${error?.name}: ${error?.message}` };
  }
  const list = Array.isArray(reported) ? reported : reported === undefined ? [] : [reported];
  return list.length === 0 ? { ok: true, stage: 'accepted' } : { ok: false, stage: 'validate', detail: JSON.stringify(list).slice(0, 200) };
}

// --- the control first: the validator must still refuse the shapes that broke ----------
// Without this, "all cases pass" would also be true of a validator that accepts anything.
{
  const declaredOnly = { kind: 'progress', scope: 'project', file: 'tasks.json', summary: 'ok' };
  const undefinedLeaf = { ...declaredOnly, notice: undefined };
  const stringLeaf = { ...declaredOnly, notice: 'moved aside' };
  const acceptedFixed = pipelineVerdict(declaredOnly);
  const refusedUndefined = pipelineVerdict(undefinedLeaf);
  const refusedString = pipelineVerdict(stringLeaf);
  check(
    'control:validator-has-teeth',
    'the harness pipeline accepts the four declared keys and refuses an undefined leaf and an undeclared string key',
    acceptedFixed.ok === true && refusedUndefined.ok === false && refusedString.ok === false,
    { acceptedFixed, refusedUndefined, refusedString, validator: typeof validate, snapshot: typeof snapshot },
  );
}

// --- every branch of code_record, through that pipeline --------------------------------
{
  const CASES = [
    ['project', { kind: 'project', patch: { commands: { test: 'node --test' }, stack: 'fixture' } }],
    ['progress-new', { kind: 'progress', title: 'Real schema task', note: 'first write' }],
    ['progress-again', { kind: 'progress', title: 'Real schema task', note: 'second write (merge path)' }],
    ['progress-done', { kind: 'progress', title: 'Real schema task', status: 'done', note: 'closing it' }],
    ['decision', { kind: 'decision', title: 'A decision', body: 'because the schema must accept it', alternatives: 'none' }],
    ['mistake', { kind: 'mistake', symptom: 'A pit', cause: 'c', fix: 'f', avoid: 'a rule long enough to count' }],
    ['verified', { kind: 'verified', cmd: 'node --version', expect: 'v22' }],
  ];
  const rows = [];
  for (const [label, args] of CASES) {
    let value;
    let error;
    try {
      value = await tool.execute(args, execFor(args));
    } catch (thrown) {
      error = `${thrown?.name}: ${thrown?.message}`;
    }
    const verdict = value === undefined ? { ok: false, stage: 'no value' } : pipelineVerdict(value);
    rows.push({
      label,
      executeError: error,
      undeclared: value === undefined ? [] : Object.keys(value).filter((k) => !['kind', 'scope', 'file', 'summary'].includes(k)),
      ...verdict,
      summary: value?.summary?.slice(0, 90),
    });
  }
  check(
    'record:harness-pipeline',
    'every code_record kind produces a result the harness snapshot accepts and the schema validates',
    rows.every((row) => row.ok === true && row.executeError === undefined && row.undeclared.length === 0),
    { rows },
  );
}

fs.rmSync(root, { recursive: true, force: true });
const failed = results.filter((row) => !row.ok);
fs.writeFileSync(OUT, `${JSON.stringify({ passed: results.length - failed.length, total: results.length, failed: failed.map((r) => `${r.id} ${r.name}`), results }, null, 2)}\n`, 'utf8');
for (const row of results) console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.id} ${row.name}`);
console.log(`\n${results.length - failed.length}/${results.length} passed, failed=[${failed.map((r) => r.id).join(', ')}]`);
console.log(`report: ${OUT}`);
process.exitCode = failed.length === 0 ? 0 : 1;
