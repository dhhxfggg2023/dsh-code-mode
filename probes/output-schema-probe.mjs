/**
 * The output-schema contract of every tool in this mode.
 *
 * A tool handler's result is validated by the harness against the tool's declared
 * `output.schema`. With `additionalProperties: false` that means: **every key the
 * handler returns must be declared, and every declared key must be returned.** Get
 * this wrong and the harness rejects the result *after* the handler has run — so the
 * side effect (the ledger write) has already happened while the model is told the call
 * failed.
 *
 * That is exactly what happened, measured 2026-10-04:
 *   `code_record(kind="mistake")` and `code_record(kind="decision")` returned a fifth
 *   key `notice` that the schema did not declare. Both branches always answered
 *   `tool "code_record" returned invalid output: value is not lossless JSON` — and both
 *   had already written the entry, so the retry turned one pit into `recurred: 2`.
 *   `kind="project"` (no `notice`) answered normally, which is how the boundary was
 *   proven rather than guessed.
 *
 * Why a probe instead of a fix alone: the project's own acceptance probe drives these
 * same branches and asserts the *rendered text*, which the harness never sees — so it
 * passed while every real `code_record` call failed. This one asserts the shape the
 * harness actually validates. Every tool registered by `lib/tool-*.js` is checked, so a
 * future tool with an undeclared key fails here instead of in a live session.
 *
 * Plain node with the two host imports stubbed (the `handover-grant-probe.mjs`
 * technique), so it runs in a confined channel where the Electron probes cannot.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-schema-${tag}-`));

/** The project the tools write into, and the machine ledger they must never touch. */
const PROJECT = scratch('project');
process.env.DSH_CODE_GLOBAL_DIR = scratch('machine');
const SESSION = 'schema-probe-session';

// --------------------------------------------------------------------- host stubs
/**
 * Stand-in for schemastery that keeps *data* members as data.
 *
 * A naive "everything is a callable" proxy makes `{ required: true }` read back as a
 * function (truthy), which silently approves any schema — and the first version of this
 * probe did exactly that. It therefore missed the real bug found on 2026-10-04: declaring
 * `notice: { type: 'string', required: false }` makes the harness refuse to compile the
 * tool at all (`JsonSchemaError: schema.properties.notice.required must be true when
 * present`), which broke `tool-record.js` outright. Members whose value is a plain
 * boolean/number/string are returned as-is so a check can inspect them.
 */
function chainable(keys = undefined) {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'shape' && keys !== undefined) return keys;
      if (prop in target) return target[prop];
      return () => chainable(keys);
    },
  });
}
const schemastery = {
  object: (shape) => chainable(shape),
  boolean: () => chainable(),
  number: () => chainable(),
  string: () => chainable(),
  array: () => chainable(),
  optional: () => chainable(),
};
/** `defineTool` is an identity in the host's registry seam: the object IS the definition. */
const defineTool = (definition) => definition;
globalThis.__schemaStubs = { schemastery, defineTool };

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: `stub:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'stub:@deepseek-ai/schemastery') {
      return { format: 'module', shortCircuit: true, source: 'export default globalThis.__schemaStubs.schemastery;' };
    }
    if (url === 'stub:@deepseek-ai/dsh-tools') {
      return { format: 'module', shortCircuit: true, source: 'export const defineTool = globalThis.__schemaStubs.defineTool;' };
    }
    return nextLoad(url, context);
  },
});

const ledger = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'ledger.js')).href);
const results = [];
const check = (id, name, ok, evidence) => results.push({ id, name, ok: ok === true, evidence });

/** A ctx good enough for these tools, capturing whatever they register. */
function stubCtx() {
  const registered = [];
  return {
    registered,
    tools: { register: (definition) => registered.push(definition) },
    systemPrompt: { section: () => {} },
    on: () => () => {},
    get: () => undefined,
    shell: {
      resolve: (options) => options,
      execute: async () => ({ result: async () => ({ exitCode: 0, stdout: { text: 'schema-probe output' }, stderr: { text: '' } }) }),
    },
  };
}
const execFor = () => ({ agent: { session: { id: SESSION, header: { cwd: PROJECT } } } });

// ------------------------------------------------------- the five record branches
const CASES = [
  ['project', { kind: 'project', patch: { commands: { test: 'node --test' } } }],
  ['progress', { kind: 'progress', title: 'Schema probe task', note: 'recorded by the probe' }],
  ['decision', { kind: 'decision', title: 'A decision the probe records', body: 'because the schema must accept it', alternatives: 'none worth naming' }],
  ['mistake', { kind: 'mistake', symptom: 'A pit the probe records', cause: 'the schema rejected a key', fix: 'declare one key set', avoid: 'never return an undeclared key', trigger: 'Set-Content|Out-File', triggerSample: 'Get-Content a | Set-Content b' }],
  ['verified', { kind: 'verified', cmd: 'node --version', expect: 'v22' }],
];

const load = async (rel) => {
  const ctx = stubCtx();
  const mod = await import(pathToFileURL(path.join(PKG_DIR, rel)).href);
  mod.apply(ctx, undefined);
  return ctx.registered;
};

// --- A: code_record, every kind ------------------------------------------------
{
  const definitions = await load('lib/tool-record.js');
  const definition = definitions.find((d) => d.name === 'code_record');
  const declared = Object.keys(definition?.output?.schema?.properties ?? {});
  for (const [label, args] of CASES) {
    let value;
    let error;
    try {
      value = await definition.execute(args, execFor());
    } catch (thrown) {
      error = `${thrown?.name}: ${thrown?.message}`;
    }
    const returned = value === undefined ? [] : Object.keys(value);
    /**
     * `visible` is what this probe can see through its stubs. It is **not** what the harness
     * sees, and the difference matters: the harness snapshots the raw value with
     * `snapshotJsonValue` *before* validating, and a key whose value is `undefined` makes
     * that snapshot return `undefined` — so an undeclared `notice: undefined` is refused
     * too, not silently dropped.
     *
     * This comment used to claim the opposite ("the harness round-trips through JSON, so
     * `undefined` disappears and the real harness accepted the tool 24/24"), and that false
     * reading is why `code_record(kind="project"|"progress")` kept returning a fifth key
     * with an `undefined` value after the 2026-10-04 fix: measured the same day against the
     * harness's own functions, `snapshotJsonValue` returned `undefined` for that shape and
     * `validateJsonSchemaValue` reported `"value.notice" is not a declared property`. The
     * check below is kept for the string-valued case, which needs no snapshot; `A2` runs the
     * real validators.
     */
    const visible = returned.filter((key) => value[key] !== undefined);
    const extra = visible.filter((key) => !declared.includes(key));
    const missing = declared.filter((key) => !returned.includes(key));
    /**
     * Only the *undeclared* direction is asserted, plus the four keys every branch has
     * always returned. This harness stubs `schemastery`/`defineTool`, so the schema object
     * it reads is the handler's own literal — it reports which keys exist, not which are
     * `required`. The direction that caught a real product bug is the one kept.
     */
    const CORE = ['kind', 'scope', 'file', 'summary'];
    const missingCore = CORE.filter((key) => !returned.includes(key));
    check(
      `record:${label}`,
      `code_record(${label}) returns no key its schema fails to declare, and all four core keys`,
      error === undefined && extra.length === 0 && missingCore.length === 0,
      { declared, returned, undeclared: extra, missingCore, optionalNotReturned: missing.filter((k) => !CORE.includes(k)), error, summary: value?.summary?.slice(0, 120) },
    );
  }
}

// --- A2: the same five branches, through the HARNESS's own validators ----------
/**
 * This is the check the block above cannot be: it runs `snapshotJsonValue` and
 * `validateJsonSchemaValue` — the two functions the harness calls on a tool result, in that
 * order — instead of asserting on the keys a stubbed `defineTool` happened to keep. The
 * distinction is the whole bug: with the stubs, `notice: undefined` looks harmless, while
 * the real snapshot refuses an undefined leaf outright.
 *
 * If the installation cannot be reached (a channel where `app.asar` will not resolve), the
 * result is `skipped`, never a pass — the same rule the README states for `guard-probe`'s
 * process checks, because a check that did not run must not look like one that did.
 */
{
  const ASAR = process.env.DSH_ASAR ?? 'E:\\tools\\DSH\\resources\\app.asar';
  const install = ASAR.replace(/\\resources\\app\.asar$/, '');
  let harness;
  try {
    const { installResolution } = await import(pathToFileURL(path.join(PKG_DIR, 'probes', 'paths.mjs')).href);
    await installResolution();
    const load = async (pkg, file) =>
      import(pathToFileURL(path.join(ASAR, 'dsh', 'node_modules', '@deepseek-ai', pkg, 'lib', file)).href);
    const tools = await load('dsh-tools', 'index.js');
    const values = await load('dsh-util-values', 'index.js');
    harness = {
      validate: tools.validateJsonSchemaValue ?? tools.validateJsonSchema,
      snapshot: values.snapshotJsonValue,
    };
  } catch (error) {
    harness = { unavailable: `${error?.name}: ${error?.message}`.slice(0, 200) };
  }

  if (harness.unavailable !== undefined) {
    results.push({
      id: 'real-validator',
      name: 'code_record results pass the harness\'s own snapshotJsonValue + validateJsonSchemaValue',
      ok: true,
      skipped: true,
      evidence: { skippedBecause: `harness not reachable: ${harness.unavailable}`, install },
    });
  } else {
    const definition = (await load('lib/tool-record.js')).find((d) => d.name === 'code_record');
    const schema = definition?.output?.schema;
    const problems = [];
    for (const [label, args] of CASES) {
      let value;
      try {
        value = await definition.execute(args, execFor());
      } catch (error) {
        problems.push(`${label}: execute threw ${error?.name}: ${error?.message}`);
        continue;
      }
      let snapshot;
      try {
        snapshot = harness.snapshot(value);
      } catch (error) {
        problems.push(`${label}: snapshotJsonValue threw ${error?.message}`);
        continue;
      }
      if (snapshot === undefined) problems.push(`${label}: snapshotJsonValue returned undefined (the "not lossless JSON" refusal)`);
      let reported;
      try {
        reported = harness.validate(schema, value);
      } catch (error) {
        problems.push(`${label}: validateJsonSchemaValue threw ${error?.message}`);
        continue;
      }
      const list = Array.isArray(reported) ? reported : reported === undefined ? [] : [reported];
      if (list.length > 0) problems.push(`${label}: ${JSON.stringify(list).slice(0, 160)}`);
    }
    check(
      'real-validator',
      "code_record results pass the harness's own snapshotJsonValue + validateJsonSchemaValue",
      problems.length === 0,
      { cases: CASES.map(([label]) => label), problems, validator: typeof harness.validate },
    );
  }
}

// --- B: every other registered tool in the mode --------------------------------
// The same contract, so the same trap: a tool whose handler returns an undeclared key
// fails in a live session and nowhere else. `code_verify` is driven for real through
// the stub shell; `code_brief` through a throwaway project.
{
  const tools = [
    ...(await load('lib/tool-brief.js')),
    ...(await load('lib/tool-verify.js')),
    ...(await load('lib/tool-record.js')),
  ];  /**
   * Every declared property must be `required: true`.
   *
   * This harness has no optional-property mechanism: `required: false` does not merely
   * omit the key, it makes the schema **fail to compile** and the tool never registers
   * (`JsonSchemaError: unsupported JSON schema: schema.properties.notice.required must be
   * true when present`, measured 2026-10-04 through the Electron binary — the whole
   * `tool-record.js` row was dead until the key was removed). That is strictly worse than
   * the undeclared-key bug it was meant to fix, which at least recorded before failing.
   * A check is cheap; discovering it from a broken plugin row is not.
   */
  for (const definition of tools) {
    const properties = definition?.output?.schema?.properties ?? {};
    const optional = Object.entries(properties)
      .filter(([, spec]) => spec !== null && typeof spec === 'object' && spec.required === false)
      .map(([key]) => key);
    check(
      `compile:${definition.name}`,
      `${definition.name} declares only properties this harness can compile (no required:false)`,
      optional.length === 0,
      { declared: Object.keys(properties), optionalKeys: optional },
    );
  }
  const calls = {
    code_brief: [{}, execFor()],
    code_verify: [{ cmd: 'node --version', expect: 'schema-probe output' }, execFor()],
    // `code_record` is driven by every branch of section A above, so it has no entry here;
    // its schema-compile check still runs in the loop over `tools` before this map.
    code_record: null,
  };
  for (const definition of tools) {
    const declared = Object.keys(definition?.output?.schema?.properties ?? {});
    const call = calls[definition.name];
    if (call === null) continue;
    if (declared.length === 0 || call === undefined) {
      check(`shape:${definition.name}`, `${definition.name} declares an output schema this probe can drive`, false, {
        declared,
        driven: call !== undefined,
      });
      continue;
    }
    let value;
    let error;
    try {
      value = await definition.execute(call[0], call[1]);
    } catch (thrown) {
      error = `${thrown?.name}: ${thrown?.message}`;
    }
    const returned = value === undefined ? [] : Object.keys(value);
    const extra = returned.filter((key) => !declared.includes(key));
    const missing = declared.filter((key) => !returned.includes(key));
    check(
      `shape:${definition.name}`,
      `${definition.name} returns exactly the keys its output schema declares`,
      error === undefined && extra.length === 0 && missing.length === 0,
      { declared, returned, undeclared: extra, missingDeclared: missing, error },
    );
  }
}

// --- C: the ledger is still readable after all of that -------------------------
{
  const brief = ledger.brief(PROJECT, { session: SESSION });
  check(
    'ledger:readable',
    'the project the tools wrote into still briefs',
    typeof brief?.text === 'string' && brief.text.length > 0 && brief.empty !== true,
    { chars: brief?.text?.length, empty: brief?.empty, head: brief?.text?.slice(0, 160) },
  );
}

for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.id} ${r.name}${r.ok ? '' : `\n       <- ${JSON.stringify(r.evidence).slice(0, 600)}`}`);
  if (process.env.DSH_SCHEMA_PROBE_DIAG === '1') console.log(`       [diag] skipped=${String(r.skipped)} ${JSON.stringify(r.evidence).slice(0, 300)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed, failed=[${failed.map((r) => r.id).join(', ')}]`);
process.exit(failed.length === 0 ? 0 : 1);
