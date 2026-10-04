/**
 * Control for the F1 fix: does the harness's own validator refuse the pre-fix shapes?
 *
 * "The fixed branches validate cleanly" is only evidence if the same validator fails on the
 * shapes that were returned before. This calls `validateJsonSchemaValue` and
 * `snapshotJsonValue` — the harness's own functions, imported from the installation — on
 * three plain objects that match the three return shapes `lib/tool-record.js` has produced:
 *
 *   A  the fix: four declared keys                              (must pass)
 *   B  pre-fix, normal path: `notice: undefined`                (must be refused)
 *   C  pre-fix, corrupt-ledger path: `notice: '<a string>'`      (must be refused)
 *
 * No module is copied and nothing is written: the shapes are the whole subject.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installResolution } from '../../probes/paths.mjs';

const ASAR = 'E:\\tools\\DSH\\resources\\app.asar';
await installResolution();

const tools = await import(
  pathToFileURL(path.join(ASAR, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href
);
const values = await import(
  pathToFileURL(path.join(ASAR, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-util-values', 'lib', 'index.js')).href
);

// The schema as the module declares it (four properties, additionalProperties: false).
const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true },
    scope: { type: 'string', required: true },
    file: { type: 'string', required: true },
    summary: { type: 'string', required: true },
  },
};

const shapes = {
  'A fixed (four keys)': { kind: 'progress', scope: 'project', file: 'tasks.json', summary: 'ok' },
  'B pre-fix normal (notice: undefined)': { kind: 'progress', scope: 'project', file: 'tasks.json', summary: 'ok', notice: undefined },
  'C pre-fix corrupt (notice: string)': { kind: 'progress', scope: 'project', file: 'tasks.json', summary: 'ok', notice: 'moved aside' },
};

const outcome = {};
for (const [label, value] of Object.entries(shapes)) {
  let snapshot;
  try {
    snapshot = values.snapshotJsonValue(value);
    if (snapshot === undefined) snapshot = 'RETURNED undefined';
  } catch (error) {
    snapshot = `THREW ${error?.name}: ${error?.message}`;
  }
  let validation;
  try {
    const result = tools.validateJsonSchemaValue(schema, value);
    validation = result === undefined ? 'accepted' : JSON.stringify(result).slice(0, 220);
  } catch (error) {
    validation = `THREW ${error?.name}: ${error?.message}`.slice(0, 220);
  }
  outcome[label] = { snapshotJsonValue: typeof snapshot === 'string' ? snapshot : 'ok (value preserved)', validateJsonSchemaValue: validation };
}

console.log(JSON.stringify({ validatorType: typeof tools.validateJsonSchemaValue, outcome }, null, 2));
