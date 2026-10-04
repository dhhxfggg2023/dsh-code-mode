/**
 * AUDIT PROBE D — did the compaction gate ever actually say anything to a model?
 *
 * `lib/compact-gate.js` emits its two notices as user messages whose `source` is
 * `{ kind: 'code-compact-gate', form: 'notice' | 'instruction' }`. If a notice ever
 * reached a step, the session log for that step carries it. `lib/pit-guard.js` and
 * `lib/gate-verify.js` use the same mechanism (after-next), so their notices are the
 * control: same host, same event, same ledger, different delivery style.
 *
 * Run: node .dsh-code/audits/probe-session-sources.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const STORE = path.join(os.homedir(), '.dsh', 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const KINDS = ['code-compact-gate', 'code-pit-guard', 'code-gate'];

function decode(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 4 || !buf.subarray(0, 4).equals(MAGIC)) return buf.toString('utf8');
  const offsets = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offsets.push(i);
    i += 4;
  }
  const parts = [];
  for (let k = 0; k < offsets.length; k += 1) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(offsets[k], k + 1 < offsets.length ? offsets[k + 1] : buf.length)));
    } catch {
      /* a torn frame is not a record */
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.jsonl(\.zstd)?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(STORE).map((file) => ({ file, mtime: fs.statSync(file).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
const tallies = Object.fromEntries(KINDS.map((kind) => [kind, { messages: 0, logs: new Set(), forms: new Set(), samples: [] }]));
let logsWithSourceField = 0;
let scanned = 0;

for (const { file } of files) {
  let text;
  try {
    text = decode(file);
  } catch {
    continue;
  }
  scanned += 1;
  let hasSource = false;
  for (const line of text.split('\n')) {
    if (!line.includes('"source"')) continue;
    hasSource = true;
    if (!line.includes('"kind":"code-')) continue;
    for (const kind of KINDS) {
      const needle = `"kind":"${kind}"`;
      let at = line.indexOf(needle);
      if (at === -1) continue;
      const tally = tallies[kind];
      tally.messages += 1;
      tally.logs.add(path.relative(STORE, file));
      const formAt = line.indexOf('"form":"', at);
      if (formAt !== -1) tally.forms.add(line.slice(formAt + 8, line.indexOf('"', formAt + 8)));
      if (tally.samples.length < 2) tally.samples.push(line.slice(Math.max(0, at - 120), at + 200));
    }
  }
  if (hasSource) logsWithSourceField += 1;
}

const report = {
  store: STORE,
  logs: files.length,
  scanned,
  logsCarryingAMessageSource: logsWithSourceField,
  newest: files.slice(0, 3).map((entry) => path.relative(STORE, entry.file)),
  kinds: Object.fromEntries(
    Object.entries(tallies).map(([kind, tally]) => [
      kind,
      { messages: tally.messages, logs: tally.logs.size, forms: [...tally.forms], logNames: [...tally.logs].slice(0, 4), samples: tally.samples },
    ]),
  ),
};

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'probe-session-sources.out.json');
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
for (const [kind, tally] of Object.entries(report.kinds)) {
  console.log(`${kind}: ${tally.messages} message(s) in ${tally.logs} log(s), forms=[${tally.forms.join(', ')}]`);
}
console.log(`logs=${report.logs} scanned=${report.scanned} withSourceField=${report.logsCarryingAMessageSource}`);
console.log(`report: ${OUT}`);
