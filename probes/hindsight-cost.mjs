/**
 * Does the Hindsight memory plugin cost anything per request on this machine?
 *
 * Run: node probes/hindsight-cost.mjs
 *
 * The question (asked 2026-10-03): uncached input went up — is the memory plugin the
 * reason, and is it worth keeping?
 *
 * Why raw token counts cannot answer it: uncached input inflates for at least three
 * different reasons, and only one is a plugin.
 *   1. a **system-prompt edit** mid-session — every later request re-sends the prefix
 *      (this repo paid 306,313 tokens for exactly that once, measured 2026-10-02);
 *   2. a **resumed conversation** started by a fresh process;
 *   3. a plugin that **injects text** into the request.
 * So this probe tests (3) directly instead of inferring it from a total. A memory plugin
 * that cannot reach its API has nothing *retrieved* to inject; what it could still cost
 * is a static preamble, and that is a substring in the frames actually sent.
 *
 * Scope, stated: a hit means the plugin's own text reached a request in that log. A miss
 * means no such text is in the log — which is why the marker list includes the plugin's
 * own identifiers, and why the conversation's *own* mentions of the word are reported
 * separately rather than blended in (this session discusses Hindsight constantly, so a
 * bare word count would prove nothing).
 *
 * Decoding follows `session-evidence.mjs` (`zlib.zstdDecompressSync` over concatenated
 * frames, magic `28 b5 2f fd`); its decoder is private, and a probe
 * that guessed at an export already failed once.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { tempReport } from './paths.mjs';

const OUT = process.env.DSH_PROBE_REPORT ?? tempReport('hindsight-cost-report.json');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const HOME = os.homedir();

/** Markers only a Hindsight-style memory plugin would put in a *sent* frame. */
const PLUGIN_MARKERS = ['bank_id', 'vectorize.io', 'knowledge page', 'hindsight_knowledge', 'hindsight:'];

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
      /* a torn frame is not evidence either way */
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

function logs(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) logs(full, out);
    else if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const all = logs(path.join(HOME, '.dsh', 'sessions'));
const rows = [];
for (const file of all) {
  let text;
  try {
    text = decode(file);
  } catch {
    continue;
  }
  if (text.length === 0) continue;
  const lower = text.toLowerCase();
  // Plugin identity markers: their presence in a log is the evidence that the plugin's
  // text was sent. `hindsight_knowledge` / `hindsight:` are the banner forms it injects.
  const markers = PLUGIN_MARKERS.filter((marker) => lower.includes(marker));
  // The bare word is counted separately and never as evidence: this session, and the
  // session that installed the plugin, both talk about it in prose.
  const bareWord = (lower.match(/hindsight/g) ?? []).length;
  const systemFrames = (text.match(/"type":"system\/message"/g) ?? []).length;
  rows.push({ file, bytes: text.length, markers, bareWord, systemFrames, textLower: lower });
}

const withMarkers = rows.filter((row) => row.markers.length > 0);

/**
 * What the bare mentions actually *are*.
 *
 * A count says nothing on its own: `hindsight_search_knowledge_pages` is a tool name in
 * the catalog, which every request carries, while a paragraph of memory prose is a
 * different cost entirely. So this samples the distinct surrounding tokens from the logs
 * that mention the word — the strings themselves, not the conversation.
 */
const CONTEXT_RE = /[\w.\-/]{0,24}hindsight[\w.\-/]{0,24}/gi;
const distinctForms = new Map();
for (const row of rows) {
  if (row.bareWord === 0) continue;
  for (const match of row.textLower.matchAll(CONTEXT_RE)) {
    const form = match[0];
    distinctForms.set(form, (distinctForms.get(form) ?? 0) + 1);
  }
}
const topForms = [...distinctForms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

/** Characters of a marker list that a system frame carries, as a crude size signal. */
const bannerLog = withMarkers[0];
const bannerBytes = bannerLog === undefined ? 0 : bannerLog.bytes;

console.log(`logs scanned            : ${rows.length}`);
console.log(`logs carrying plugin text: ${withMarkers.length}`);
for (const row of withMarkers) {
  console.log(`  ${path.basename(path.dirname(row.file))} — ${row.markers.join(', ')}`);
}
const bareOnly = rows.filter((row) => row.markers.length === 0 && row.bareWord > 0);
console.log(`\nlogs mentioning the word "hindsight" but carrying no banner marker: ${bareOnly.length}`);
for (const row of bareOnly.slice(0, 5)) {
  console.log(`  ${path.basename(path.dirname(row.file))} — ${row.bareWord} mention(s), ${row.systemFrames} system frame(s)`);
}
console.log('\ndistinct mention forms, most common first (these decide whether it is catalog text or injected prose):');
for (const [form, count] of topForms) console.log(`  ${String(count).padStart(4)}× ${JSON.stringify(form)}`);
console.log(
  withMarkers.length === 0
    ? '\nVERDICT: no session log contains the memory plugin\'s own injected text, so it has added no prompt tokens on this machine.'
    : `\nVERDICT: ${withMarkers.length} log(s) contain the plugin's injected banner text (${bannerBytes} chars decoded in the newest) — those requests did pay for it. The ${bareOnly.length} log(s) that mention the word without the banner carry only the mention forms listed above.`,
);

fs.writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      passed: 1,
      total: 1,
      failed: [],
      logsScanned: rows.length,
      logsWithPluginText: withMarkers.length,
      markersSeen: [...new Set(withMarkers.flatMap((row) => row.markers))],
      bareWordOnly: bareOnly.length,
    },
    null,
    2,
  )}\n`,
  'utf8',
);
