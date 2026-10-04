/**
 * Audit probe 07 — the LIVE ledger, read-only: how close the real brief is to its
 * own budget, what the real journal containment looks like, and whether the
 * findings of this audit are reachable from the data on disk.
 *
 * Nothing here writes: every ledger file is hashed before and after and the two
 * snapshots are compared in the output.
 *
 *   <node> .dsh-code\audits\07-live-ledger-readonly.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..', '..');
const LIVE = path.join(PKG, '.dsh-code');
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);

const snapshot = () => {
  const out = {};
  for (const name of fs.readdirSync(LIVE).sort()) {
    const file = path.join(LIVE, name);
    if (!fs.statSync(file).isFile()) continue;
    out[name] = `${fs.statSync(file).size}:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)}`;
  }
  return out;
};
const before = snapshot();

console.log('=== probe 07: the live ledger, read-only ===');
console.log(`project: ${PKG}`);

// --- 1. margin of the real brief against its own budget ----------------------
const sectionOf = (text, heading) => {
  const at = text.indexOf(heading);
  if (at < 0) return { present: false, chars: 0 };
  const rest = text.slice(at + heading.length);
  const next = rest.search(/\n\n## |\n\n… \(/);
  return { present: true, chars: (next < 0 ? rest : rest.slice(0, next)).trim().length };
};
const HEADINGS = ['## Project', '## Machine-wide facts', '## Task board', '## Recent ledger entries', '## Turns that changed code', '## Failing commands nobody', '## Known mistakes', '## Recent decisions'];
const real = ledger.brief(PKG, { session: 'audit-07', maxChars: 4000 });
console.log(`\n-- brief(PKG, maxChars 4000): ${real.text.length} chars, margin ${4000 - real.text.length}`);
console.log(`   clipped (ends with …): ${real.text.endsWith('…')};  retrieval hint present: ${real.text.includes('This brief is a selection')}`);
console.log(`   omitted: ${JSON.stringify(real.omitted)};  emptySections: ${JSON.stringify(real.emptySections)}`);
for (const heading of HEADINGS) {
  const part = sectionOf(real.text, heading);
  if (part.present) console.log(`   ${heading.padEnd(34)} body ${part.chars} chars`);
}
const fullReal = ledger.brief(PKG, { session: 'audit-07', maxChars: 8900 });
console.log(`   briefFull (8900): ${fullReal.text.length} chars, project body ${sectionOf(fullReal.text, '## Project').chars} (division lifted: ${sectionOf(fullReal.text, '## Project').chars > 1000})`);

// --- 2. the live journal's segment layout ------------------------------------
const files = ledger.journalFiles(PKG, 'project');
console.log('\n-- journal segments (physical order = reader order)');
const tsOf = (line) => {
  try {
    return JSON.parse(line).ts ?? '(no ts)';
  } catch {
    return '(unparseable)';
  }
};
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  console.log(`   ${path.basename(file).padEnd(20)} ${String(fs.statSync(file).size).padStart(8)} B  ${String(lines.length).padStart(6)} lines  first=${tsOf(lines[0])}  last=${tsOf(lines[lines.length - 1])}`);
}
console.log(`   rotations so far: ${files.length - 1} (the order inverts on rotation 2 — see probe 02)`);

// --- 3. reachability census from the real journal and ledger -----------------
const journalText = ledger.readJournalText(PKG, 'project');
const entries = [];
for (const line of journalText.split('\n')) {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith('{')) continue;
  try {
    entries.push(JSON.parse(trimmed));
  } catch {
    entries.push({ kind: '(torn line)' });
  }
}
const kinds = entries.reduce((map, e) => map.set(e.kind, (map.get(e.kind) ?? 0) + 1), new Map());
console.log('\n-- real journal census');
console.log(`   ${entries.length} parsed lines; kinds: ${JSON.stringify([...kinds.entries()].sort((a, b) => b[1] - a[1]))}`);

const unverified = entries.filter((e) => e.kind === 'unverified');
const relativeEdits = [];
for (const entry of unverified) {
  for (const edit of entry.edits ?? []) {
    const token = String(edit).trim().split(/\s+/).at(-1) ?? '';
    if (!/^[a-z]:[\\/]/i.test(token) && !token.startsWith('\\\\') && !token.startsWith('/')) relativeEdits.push(token);
  }
}
console.log(`   unverified entries: ${unverified.length}; edit targets that are NOT absolute: ${relativeEdits.length}${relativeEdits.length > 0 ? ` e.g. ${JSON.stringify(relativeEdits.slice(0, 5))}` : ''}`);
const verified = entries.filter((e) => e.kind === 'verified');
console.log(`   verified entries: ${verified.length}; with a cwd field: ${verified.filter((e) => typeof e.cwd === 'string').length}`);
console.log(`   verified whose cmd names no file and no path separator: ${verified.filter((e) => typeof e.cmd === 'string' && !/[\\/.]/.test(e.cmd)).length}`);

const mistakesText = fs.readFileSync(path.join(LIVE, 'mistakes.md'), 'utf8');
const blocks = mistakesText.split(/\n(?=## )/).map((b) => b.trim()).filter((b) => b.startsWith('## '));
const triggers = blocks.map((b) => /^- trigger: (.*)$/m.exec(b)?.[1]).filter(Boolean);
console.log(`\n-- real mistakes.md: ${blocks.length} entries, ${triggers.length} with a trigger`);
console.log(`   triggers: ${JSON.stringify(triggers)}`);
const slugCensus = new Map();
for (const block of blocks) {
  const symptom = /^- symptom: (.*)$/m.exec(block)?.[1] ?? '';
  const key = ledger.slug(symptom, 'mistake');
  slugCensus.set(key, (slugCensus.get(key) ?? 0) + 1);
}
const collisions = [...slugCensus.entries()].filter(([, count]) => count > 1);
console.log(`   symptom slugs that collide with another entry: ${JSON.stringify(collisions)}`);
const filesFields = blocks.map((b) => /^- files: (.*)$/m.exec(b)?.[1]).filter(Boolean);
console.log(`   files: fields containing a backslash or drive letter: ${filesFields.filter((f) => /[\\]|[a-z]:/i.test(f)).length} of ${filesFields.length}`);

// --- 4. today() vs the local calendar ---------------------------------------
const now = new Date();
const offsetMinutes = -now.getTimezoneOffset();
const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
console.log('\n-- date labels');
console.log(`   ledger.today() = ${ledger.today()}   local calendar date = ${localDate}   utc offset = ${offsetMinutes} min`);
const windowStart = new Date(now);
windowStart.setHours(0, 0, 0, 0);
const disagreeHours = offsetMinutes > 0 ? offsetMinutes / 60 : 0;
console.log(`   hours per local day where today() names YESTERDAY: ${disagreeHours} (00:00-${String(disagreeHours).padStart(2, '0')}:00 local)`);

// --- 5. prove this probe did not write --------------------------------------
const after = snapshot();
const changed = Object.keys({ ...before, ...after }).filter((name) => before[name] !== after[name]);
console.log('\n-- write check');
console.log(`   ledger files hashed before/after: ${Object.keys(before).length}; changed: ${JSON.stringify(changed)}`);
