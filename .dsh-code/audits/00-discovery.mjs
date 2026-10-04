/**
 * Audit probe 00 — discovery.
 *
 * Question: what does the *real* `@deepseek-ai/dsh-tools` expose, and where does the
 * harness actually validate a tool handler's returned value against `output.schema`?
 * Everything later in this audit needs to drive that real seam instead of a stub.
 *
 * Run:  node .dsh-code/audits/00-discovery.mjs
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installResolution, PKG_DIR } from '../../probes/paths.mjs';

await installResolution();

const tools = await import('@deepseek-ai/dsh-tools');
console.log('dsh-tools exports:', Object.keys(tools).sort().join(', '));
try {
  const resolved = import.meta.resolve('@deepseek-ai/dsh-tools');
  console.log('resolved url:', resolved);
} catch (error) {
  console.log('resolve failed:', error.message);
}

// Which of these look like the output-validation seam?
for (const [name, value] of Object.entries(tools)) {
  console.log(`  ${name}: ${typeof value}`);
}

// The real defineTool: does it compile the schema eagerly (which is how a
// `required: false` property kills the whole tool row)?
const z = (await import('@deepseek-ai/schemastery')).default;
console.log('schemastery keys:', Object.keys(z).sort().join(', '));

const good = tools.defineTool({
  name: 'audit_probe_good',
  description: 'x',
  parameters: { a: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { a: { type: 'string', required: true } } },
    render: () => [],
  },
  execute: async () => ({ a: 'ok' }),
});
console.log('good definition compiled. keys:', Object.keys(good).sort().join(', '));
console.log('good.output keys:', Object.keys(good.output ?? {}).sort().join(', '));
console.log('good.output.schema type:', typeof good.output?.schema, Array.isArray(good.output?.schema));

// Can we find a validator on the definition?
for (const key of ['validate', 'validateOutput', 'outputSchema', 'handler', 'execute']) {
  console.log(`  definition.${key}:`, typeof good[key]);
}
console.log('PKG_DIR', PKG_DIR);
console.log('probe ok');
