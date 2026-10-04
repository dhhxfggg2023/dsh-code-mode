/**
 * Context-cost report: where this session's prompt actually goes.
 *
 * The mode's own premise is that context is the scarce resource, but until now
 * nothing measured it — answering "why did one request suddenly bill a huge
 * uncached input" took three throwaway scripts (2026-10-02: a single request
 * after a DSH restart re-sent 306,313 tokens as *uncached* input, because the
 * plugin edit that made the restart necessary had also changed the system prompt
 * at the front of the prefix, so the provider's cache could not match).
 *
 * It is a report, not a gate: a restart legitimately causes one prefix re-send,
 * and this project forbids an alarm with no settlement path. Read it when a
 * session's cost looks wrong.
 *
 * It also runs a PRE-FLIGHT check: a file whose text lands in the request prefix
 * (the system-prompt section, the tool descriptions and schemas, the preset
 * composition) that was modified *after* the last recorded request means the next
 * restart will invalidate the cached prefix for any conversation that gets
 * resumed — so it says that before the cost is paid, not after.
 *
 *   & '<node>' '<pkg>\probes\context-cost.mjs'
 *
 * Read-only; needs only the newest session log (see paths.mjs `sessionLogs()`).
 * `--all` lists every request instead of the interesting ones.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PKG_DIR, PROBES_DIR, sessionLogs, tempReport } from './paths.mjs';

/** A request that re-sent more than half its prompt uncached was not appended to. */
const RESEND_SHARE = 0.5;
/** New input a normal turn adds; above this is worth naming even without a re-send. */
const BIG_ADD = 40000;

const all = process.argv.includes('--all');
// `sessionLogs()` is newest-first and yields `{ path, mtime }`.
const logs = sessionLogs().filter((entry) => typeof entry?.path === 'string');
if (logs.length === 0) throw new Error('no session logs under ~/.dsh/sessions');
const newest = logs[0];
const decoded = tempReport('context-cost.jsonl');
if (newest.path.endsWith('.zstd')) {
  execFileSync(process.execPath, [path.join(PROBES_DIR, 'unzstd.cjs'), newest.path, decoded], { stdio: 'inherit' });
} else {
  fs.copyFileSync(newest.path, decoded);
}

const frames = fs
  .readFileSync(decoded, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  })
  .filter(Boolean);

/** One row per model call, in order: the first usage object inside each frame. */
const rows = [];
for (const frame of frames) {
  const found = [];
  const walk = (value) => {
    if (value === null || typeof value !== 'object') return;
    if (typeof value.inputTokens === 'number' && typeof value.cacheReadTokens === 'number') found.push(value);
    for (const child of Object.values(value)) walk(child);
  };
  walk(frame.data);
  const usage = found[0];
  if (usage !== undefined) {
    rows.push({
      seq: frame.seq,
      time: frame.time,
      in: usage.inputTokens,
      read: usage.cacheReadTokens,
      write: usage.cacheWriteTokens ?? 0,
      out: usage.outputTokens ?? 0,
    });
  }
}

const at = (ms) => (ms === undefined ? '        ' : new Date(ms).toLocaleTimeString('sv'));
const sum = (key) => rows.reduce((n, row) => n + row[key], 0);
const promptOf = (row) => row.in + row.read;
const isResend = (row) => promptOf(row) > 0 && row.in / promptOf(row) > RESEND_SHARE;
const resends = rows.filter(isResend);
const bigAdds = rows.filter((row) => !isResend(row) && row.in > BIG_ADD);

console.log(`session log : ${newest.path}`);
console.log(`frames      : ${frames.length}   model calls: ${rows.length}`);
console.log(
  `totals      : uncached-input=${sum('in').toLocaleString()}  cache-read=${sum('read').toLocaleString()}` +
    `  cache-write=${sum('write').toLocaleString()}  output=${sum('out').toLocaleString()}`,
);
if (rows.length > 0) {
  const last = rows.at(-1);
  console.log(`final prompt: ${promptOf(last).toLocaleString()} tokens (${at(last.time)})`);
}

/**
 * Pre-flight, before the cost is paid: compare the prompt text that is on disk with
 * the prompt text in the last recorded request.
 *
 * The first version of this check compared a file's mtime against the last request's
 * time — and that baseline is wrong: a conversation keeps issuing requests, so the
 * mtime falls behind the last request within one turn and the check goes quiet
 * exactly when it should warn (measured 2026-10-02: it reported "none" at the very
 * moment the restart that cost 306,313 uncached tokens was pending). The text
 * comparison has no such race: the running host sends whatever it loaded at mount,
 * so "disk ≠ last sent" means a restart will change the prefix.
 */
const MARK_A = '## Project ledger';
const MARK_B = '## Working habits';
const sectionIn = (text) => {
  const from = text.indexOf(MARK_A);
  const to = text.indexOf(MARK_B, from + 1);
  return from < 0 || to < 0 ? undefined : text.slice(from, to);
};
/** The first string inside a frame that carries the whole section, newest frame first. */
const sectionTextOf = (value) => {
  if (typeof value === 'string') return sectionIn(value) === undefined ? undefined : sectionIn(value);
  if (value === null || typeof value !== 'object') return undefined;
  for (const child of Object.values(value)) {
    const hit = sectionTextOf(child);
    if (hit !== undefined) return hit;
  }
  return undefined;
};
const promptFile = process.env.DSH_CODE_PREFIX_FILE ?? path.join(PKG_DIR, 'lib', 'prompt.js');
const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

let sent;
let sentAt;
// Only a `system/message` frame is the text that was actually SENT. The same section
// also shows up in the model's own replies, in tool arguments and in the system
// reminder re-injected with a user message — comparing against those would compare the
// live text with an echo of itself (measured 2026-10-02: the newest frame carrying
// `## Project ledger` was an assistant message, and a tool argument matched too).
for (let index = frames.length - 1; index >= 0 && sent === undefined; index -= 1) {
  if (frames[index].type !== 'system/message') continue;
  const hit = sectionTextOf(frames[index].data);
  if (hit !== undefined) {
    sent = hit;
    sentAt = frames[index].time;
  }
}
let live;
try {
  // The section is a static template literal; the only escapes in it are backticks.
  const literal = /const SECTION = `([\s\S]*?)`;\n/.exec(fs.readFileSync(promptFile, 'utf8'))?.[1];
  live = literal === undefined ? undefined : sectionIn(literal.replace(/\\`/g, '`'));
} catch {
  live = undefined;
}

console.log('');
if (live === undefined || sent === undefined) {
  console.log(
    `prefix text: could not compare (live=${live === undefined ? 'not found' : sha(live)}, sent=${sent === undefined ? 'not found' : sha(sent)})` +
      ' — one side is missing, so say so rather than implying the prefix is unchanged',
  );
} else if (live === sent) {
  console.log(
    `prefix text: live ${path.relative(PKG_DIR, promptFile)} == the system prompt last sent (${at(sentAt)}, ${live.length} chars, sha ${sha(live)}) — cache-safe`,
  );
} else {
  console.log(
    `prefix text: LIVE DIFFERS from the system prompt last sent (live ${live.length} chars sha ${sha(live)}` +
      ` vs sent ${sent.length} chars sha ${sha(sent)}, sent ${at(sentAt)})`,
  );
  console.log(
    '  The running host still sends the OLD text. After the next restart the prefix changes, and any\n' +
      '  conversation you RESUME cannot match the provider cache anywhere: it re-sends its whole history\n' +
      '  as uncached input (measured 2026-10-02: 306,313 tokens in one request, 66% of that session).\n' +
      '  Start a NEW conversation after the restart instead of resuming one.',
  );
}

const show = (row, index) => {
  const previous = index > 0 ? rows[index - 1] : undefined;
  const gap = previous?.time !== undefined && row.time !== undefined ? Math.round((row.time - previous.time) / 1000) : undefined;
  console.log(
    `  ${at(row.time)}  uncached=${String(row.in).padStart(7)}  cached=${String(row.read).padStart(7)}` +
      `  ${(row.in / Math.max(1, promptOf(row)) * 100).toFixed(1).padStart(5)}% uncached` +
      `${gap === undefined ? '' : `  gap=${gap}s`}`,
  );
};

console.log('');
console.log(`prefix re-sends (uncached share > ${RESEND_SHARE * 100}% — the prompt was not appended to): ${resends.length}`);
for (const row of resends) show(row, rows.indexOf(row));
if (resends.length > 0) {
  console.log(
    '  A re-send happens when everything before the new content changed: a plugin/config edit\n' +
      '  landed in the system prompt, or a session was resumed by a fresh process. It is billed\n' +
      '  at full price for the whole conversation. Batch those edits, and start a NEW conversation\n' +
      '  after the restart instead of resuming one (measured cost of ignoring this: 306,313 tokens).',
  );
}
console.log('');
console.log(`large single turns (uncached > ${BIG_ADD.toLocaleString()}, not a re-send): ${bigAdds.length}`);
for (const row of bigAdds) show(row, rows.indexOf(row));
if (all) {
  console.log('');
  console.log('every request:');
  for (const [index, row] of rows.entries()) show(row, index);
}
