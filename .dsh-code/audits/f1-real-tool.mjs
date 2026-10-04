/**
 * F1, end to end: does the REAL `code_record` fail its own output schema for the two
 * branches the 2026-10-04 fix did not touch?
 *
 * The audit proved this against the harness's validator source. This drives the real tool
 * through the real registry, exactly as `probes/acceptance-probe.mjs` does, and then runs
 * the harness's own result-construction steps in the order the harness runs them:
 * `snapshotJsonValue` (which the harness calls "lossless JSON") and then schema
 * validation. A tool whose result is rejected AFTER its side effect is worse than one that
 * refuses outright, because the ledger entry is already written when the model is told the
 * call failed.
 *
 * Every write goes to a throwaway root under the OS temp dir, so no real ledger is touched.
 * Read-only with respect to this repository.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIB_DIR, installResolution } from '../../probes/paths.mjs';

const ASAR = 'E:\\tools\\DSH\\resources\\app.asar';
await installResolution();

// The harness's own steps, imported from the installation rather than re-implemented.
const values = await import(
  pathToFileURL(path.join(ASAR, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-util-values', 'lib', 'index.js')).href
);

// The schema validator the harness runs over a tool result. Imported, not re-implemented —
// the whole defect is about which shapes THIS function refuses.
const schemaMod = await import(
  pathToFileURL(path.join(ASAR, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href
);
const validator =
  schemaMod.validateJsonSchemaValue ?? schemaMod.validateJsonSchema ?? values.validateJsonSchemaValue ?? values.validateJsonSchema;
const validatorName = schemaMod.validateJsonSchemaValue
  ? 'dsh-tools.validateJsonSchemaValue'
  : schemaMod.validateJsonSchema
    ? 'dsh-tools.validateJsonSchema'
    : values.validateJsonSchemaValue
      ? 'dsh-util-values.validateJsonSchemaValue'
      : values.validateJsonSchema
        ? 'dsh-util-values.validateJsonSchema'
        : '(none found)';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-real-'));
process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-real-global-'));

const mod = await import(pathToFileURL(path.join(LIB_DIR, 'tool-record.js')).href);
const registered = [];
const ctx = {
  tools: { register: (def) => registered.push(def) },
  systemPrompt: { section: () => {} },
  on: () => () => {},
};
mod.apply(ctx, undefined);
const tool = registered.find((def) => def.name === 'code_record');

const execFor = (args) => ({ name: 'code_record', arguments: args, agent: { session: { id: 'f1-real', header: { cwd: root } } } });

/** Replay what the harness does to a handler's resolved value. */
function harnessVerdict(value, outputSchema) {
  const keys = Object.keys(value);
  let snapshot;
  let snapshotError;
  try {
    snapshot = values.snapshotJsonValue(value);
  } catch (error) {
    snapshotError = `${error?.name}: ${error?.message}`;
  }
  let schemaError;
  if (typeof validator === 'function' && outputSchema !== undefined) {
    try {
      const outcome = validator(outputSchema, value);
      // Validators differ: some throw, some return a list of problems.
      if (Array.isArray(outcome) && outcome.length > 0) schemaError = JSON.stringify(outcome).slice(0, 200);
      else if (outcome === false) schemaError = 'validation returned false';
      else if (typeof outcome === 'string' && outcome.length > 0) schemaError = outcome.slice(0, 200);
    } catch (error) {
      schemaError = `${error?.name}: ${error?.message}`;
    }
  }
  return {
    keys,
    undeclared: keys.filter((key) => !['kind', 'scope', 'file', 'summary'].includes(key)),
    snapshotReturnedUndefined: snapshot === undefined,
    snapshotError,
    schemaError,
  };
}

const rows = [];
const outputSchema = tool.output?.schema;
for (const [label, args] of [
  ['project', { kind: 'project', patch: { commands: { test: 'pnpm test' }, stack: 'fixture' } }],
  ['progress-new', { kind: 'progress', title: 'F1 fixture task', note: 'first' }],
  ['progress-again', { kind: 'progress', title: 'F1 fixture task', note: 'second' }],
  ['mistake (the fixed branch)', { kind: 'mistake', symptom: 'f1 fixture', cause: 'c', fix: 'f', avoid: 'a rule long enough to count' }],
  ['decision (the fixed branch)', { kind: 'decision', title: 'F1 fixture decision', body: 'body', alternatives: 'none' }],
  ['verified', { kind: 'verified', cmd: 'pnpm test', expect: 'pass' }],
]) {
  const value = await tool.execute(args, execFor(args));
  rows.push({ label, summary: value.summary, ...harnessVerdict(value, outputSchema) });
}

// Was the side effect already applied when the verdict above was produced?
const ledgerFiles = fs.existsSync(path.join(root, '.dsh-code')) ? fs.readdirSync(path.join(root, '.dsh-code')) : [];
const board = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.dsh-code', 'tasks.json'), 'utf8'));
  } catch {
    return undefined;
  }
})();

console.log(
  JSON.stringify(
    {
      validatorUsed: validatorName,
      declaredProperties: Object.keys(outputSchema?.properties ?? {}),
      additionalProperties: outputSchema?.additionalProperties,
      rows,
      ledgerFiles,
      taskCount: board === undefined ? 0 : (board.active ?? []).length,
    },
    null,
    2,
  ),
);
fs.rmSync(root, { recursive: true, force: true });
