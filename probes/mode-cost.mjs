/**
 * What does running in `code` mode cost in prompt tokens, versus `standard`?
 *
 * Run: node probes/mode-cost.mjs
 *
 * Why this is measurable rather than a guess: the ledger's own claim is that the mode
 * costs "a fixed prefix plus a little per call", and both halves are in the session logs.
 *   - the **system message** it adds (the ledger protocol section in `lib/prompt.js`)
 *     sits in the request prefix on every call;
 *   - the **tool catalog** the host sends carries the six ledger tools' descriptions;
 *   - the **variable** part is `code_brief`'s output, `code_record`/`code_verify` results
 *     and pit notices, which land in the message stream.
 * Only the first two are per-request overhead; the third is per-use. This probe reads the
 * logs and reports both, so the answer is a measurement and not an estimate.
 *
 * Token estimates use ~3.7 bytes/token for English prose. That ratio is approximate; the
 * *relative* comparison between sessions is the load-bearing part, and the exact provider
 * counts are quoted where the log carries them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const BYTES_PER_TOKEN = 3.7;
const approxTokens = (bytes) => Math.round(bytes / BYTES_PER_TOKEN);

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
      /* torn frame */
    }
  }
  return Buffer.concat(parts).toString('utf8');
}
function logs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) logs(full, out);
    else if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(e.name)) out.push(full);
  }
  return out;
}
/** Character count of every string value in a JSON tree — text, not structure. */
function textCost(value, seen = { chars: 0, leaves: 0 }) {
  if (typeof value === 'string') {
    seen.chars += value.length;
    seen.leaves += 1;
  } else if (Array.isArray(value)) {
    for (const item of value) textCost(item, seen);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) textCost(item, seen);
  }
  return seen;
}

const rows = [];
for (const file of logs(path.join(os.homedir(), '.dsh', 'sessions'))) {
  let text;
  try {
    text = decode(file);
  } catch {
    continue;
  }
  if (text.length === 0) continue;
  const row = { dir: path.basename(path.dirname(file)), mtime: fs.statSync(file).mtimeMs, mode: undefined };
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    const type = frame.type ?? frame.kind;
    if (type === 'agent-preset/selected' || type === 'agent-config/selected') {
      const t = textCost(frame.data);
      // `String(...)` rather than `JSON.stringify(...)`: a payload that stringifies to
      // `undefined` (a function, a symbol, or a shape JSON drops) made `row.mode` set-but-
      // undefined, which the report then printed as the literal word `undefined` for every
      // sample. Measured 2026-10-04: 29 of 110 logs carry this frame and all three newest
      // samples rendered as `undefined`, so the line looked like a broken field read.
      const label = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
      row.mode = `${type}: ${String(label ?? '(payload not serialisable)').slice(0, 100)}`;
      row.modeTextChars = t.chars;
    } else if (type === 'system/message') {
      row.systemChars = textCost(frame.data).chars;
      row.systemBytes = line.length;
    } else if (type === 'request/header') {
      const t = textCost(frame.data);
      row.headerTextChars = (row.headerTextChars ?? 0) + t.chars;
      row.headerLeaves = (row.headerLeaves ?? 0) + t.leaves;
    } else if (type === 'tool/result' || type === 'tool/call' || type === 'user/message' || type === 'assistant/message') {
      const t = textCost(frame.data);
      row.varChars = (row.varChars ?? 0) + t.chars;
      // The ledger's own tools are the part this mode adds at *use* time. Counting their
      // results separately is the difference between "the mode costs X per request" (the
      // prefix) and "and Y when you actually use it" (this).
      const name = String(frame.data?.name ?? frame.data?.tool ?? '');
      if (/^code_(brief|record|verify)$/.test(name)) {
        row.ledgerCalls = (row.ledgerCalls ?? 0) + 1;
        row.ledgerChars = (row.ledgerChars ?? 0) + t.chars;
        row.ledgerMax = Math.max(row.ledgerMax ?? 0, t.chars);
      }
    }
  }
  rows.push(row);
}

const withSystem = rows.filter((r) => r.systemChars !== undefined);
withSystem.sort((a, b) => b.mtime - a.mtime);
console.log(`logs with a system/message frame: ${withSystem.length} of ${rows.length}`);
console.log('\nnewest 8, system-message text only (this is the per-request prefix the mode owns part of):');
for (const r of withSystem.slice(0, 8)) {
  console.log(
    `  ${r.dir.slice(0, 42).padEnd(44)} systemChars=${String(r.systemChars).padStart(7)} ≈${String(approxTokens(r.systemChars)).padStart(6)} tok   headerText=${String(r.headerTextChars ?? 0).padStart(7)}`,
  );
}
const sizes = withSystem.map((r) => r.systemChars).sort((a, b) => a - b);
const median = sizes[Math.floor(sizes.length / 2)];
console.log(`\nsystem-message text: median ${median} chars ≈ ${approxTokens(median)} tokens; min ${sizes[0]} ≈ ${approxTokens(sizes[0])}; max ${sizes[sizes.length - 1]} ≈ ${approxTokens(sizes[sizes.length - 1])}`);
if (sizes.length >= 2) {
  console.log(`spread between smallest and largest session prompt: ${sizes[sizes.length - 1] - sizes[0]} chars ≈ ${approxTokens(sizes[sizes.length - 1] - sizes[0])} tokens`);
}
const samples = withSystem.slice(0, 3).map((r) => r.mode);
const modeFrames = rows.filter((r) => r.mode !== undefined).length;
if (modeFrames === 0) {  // `agent-preset/selected` / `agent-config/selected` never appeared in any log here, so
  // `row.mode` stays undefined and the old line printed `[ 'undefined', … ]` — a field
  // read that says nothing about the mode. Say what is true instead of printing the hole.
  console.log(
    '\nmode markers: no `agent-preset/selected` or `agent-config/selected` frame in any of the',
    `${rows.length} log(s), so this report cannot name the mode from frames alone. The mode's`,
    'own prompt section is the better evidence: check-prompt-section.mjs reads it out of',
    'system/message frames (11 needles, including the Working habits block).',
  );
} else {
  console.log(`\nmode markers: ${modeFrames} of ${rows.length} log(s) carry a mode frame; first 3:`);
  for (const s of samples) {
    console.log(`  sample typeof=${typeof s} value=${String(s).slice(0, 80)}`);
  }
  const withMode = rows.filter((r) => r.mode !== undefined).slice(0, 3);
  for (const r of withMode) console.log(`  carrier ${r.dir.slice(0, 36).padEnd(38)} mode=${String(r.mode).slice(0, 90)}`);
}

/** Real ledger-tool usage in the sessions that ran this mode. */
const using = rows.filter((r) => (r.ledgerCalls ?? 0) > 0).sort((a, b) => b.mtime - a.mtime);
console.log(`\nsessions that actually called code_brief/code_record/code_verify: ${using.length}`);
for (const r of using.slice(0, 6)) {
  console.log(
    `  ${r.dir.slice(0, 42).padEnd(44)} calls=${String(r.ledgerCalls).padStart(3)} chars=${String(r.ledgerChars).padStart(7)} ≈${String(approxTokens(r.ledgerChars)).padStart(6)} tok  biggest=${String(r.ledgerMax).padStart(6)} ≈${approxTokens(r.ledgerMax ?? 0)} tok`,
  );
}
if (using.length > 0) {
  const totals = using.map((r) => r.ledgerChars).sort((a, b) => a - b);
  const rowsSum = using.reduce((s, r) => s + r.ledgerChars, 0);
  const callsSum = using.reduce((s, r) => s + (r.ledgerCalls ?? 0), 0);
  console.log(
    `\nledger-tool output across those ${using.length} session(s): ${callsSum} call(s), median ${totals[Math.floor(totals.length / 2)]} chars/session ≈ ${approxTokens(totals[Math.floor(totals.length / 2)])} tok, mean ${Math.round(rowsSum / using.length)} chars ≈ ${approxTokens(Math.round(rowsSum / using.length))} tok`,
  );
  console.log(
    `per call: mean ${Math.round(rowsSum / Math.max(1, callsSum))} chars ≈ ${approxTokens(Math.round(rowsSum / Math.max(1, callsSum)))} tokens`,
  );
}
