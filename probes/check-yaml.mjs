import { PKG_DIR, profileDir } from './paths.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const yaml = await import(pathToFileURL(path.join(profileDir(), 'node_modules', 'js-yaml', 'index.js')).href);
const src = fs.readFileSync(path.join(PKG_DIR, 'cordis.patch.yml'), 'utf8');
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (d) => ({ __jsExpr: d }),
});
const schema = yaml.DEFAULT_SCHEMA.extend([JsExpr]);
const doc = yaml.load(src, { schema });
const row = doc[0].insert[0];
console.log('row id           :', row.id);
console.log('row module       :', row.name);
console.log('config.id        :', row.config.id);
console.log('config.name      :', row.config.name);
console.log('config.order     :', row.config.order);
console.log('plugins count    :', row.config.plugins.length);
console.log('plugin ids       :', row.config.plugins.map((p) => p.id).join(', '));
const mem = row.config.plugins.find((p) => p.id === 'code-memory');
console.log('code-memory kids :', mem.config.map((c) => `${c.id} -> ${c.name}`).join(' | '));
const pwshRow = row.config.plugins.find((p) => p.id === 'tool-pwsh');
console.log('tool-pwsh disabled expr:', JSON.stringify(pwshRow.disabled));
const plan = row.config.plugins.find((p) => p.id === 'planning');
console.log('planning group kids:', plan.config.map((c) => c.id).join(', '), '| isolate:', JSON.stringify(plan.isolate));
