/**
 * Session evidence: what really happened in recorded sessions.
 *
 * Written 2026-10-03 to answer a question no stub could: every compaction check this
 * package had drove a stub or read the preset text, and **none of them read a session a
 * human actually ran**. A real log is the only place that shows the window the host
 * resolved, the occupancy that followed, and whether the engine ever compacted.
 *
 * It was written while a compaction gate (`lib/compact-gate.js`) existed and its first
 * question was "did the gate leave a trace before the engine compacted". That gate and its
 * row were deleted on 2026-10-11 — compaction is the harness's feature and this preset no
 * longer has an opinion about when it happens — so the gate-trace half of this probe was
 * removed with it. What is left is the half that outlived the gate and is *more* relevant
 * now that the engine compacts on its own again: the frames, the counters, the resolved
 * windows, the occupancy they imply, and every `compaction/*` frame.
 *
 * Usage:
 *   node probes/session-evidence.mjs                 # every project dir, newest 3 logs each
 *   node probes/session-evidence.mjs --all           # every log
 *   node probes/session-evidence.mjs --dir <name>    # one project dir under ~/.dsh/sessions
 *   node probes/session-evidence.mjs --path <log>    # one log file
 *
 * It reads and never writes; no temp files, so it runs in a confined channel too.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const ALL = args.includes('--all');
const ONLY_DIR = flag('--dir');
const ONLY_PATH = flag('--path');
const PER_DIR = ALL ? Number.POSITIVE_INFINITY : 3;
/**
 * Only compactions at or after this instant are counted as "after the cutover": a session
 * that compacted before it says nothing about the mode as it is configured today.
 * Default is the moment this preset's compaction wiring was first mounted.
 */
const SINCE = Date.parse(flag('--since') ?? '2026-10-02T14:49:00Z');
/**
 * `--dump <type>` prints the first frames of one type verbatim.
 *
 * The shapes that matter here are read from these frames rather than assumed:
 * `request/context` carries the resolved `contextWindow`, `request/header` carries
 * `{header:{config:…}}`, and the usage counters live on whichever frame happens to
 * carry them. A shape mismatch makes every reading silently absent, which is
 * indistinguishable from "nothing ever crossed the line" — only real frames settle it.
 */
const DUMP = flag('--dump');

const STORE = path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Session logs are a concatenation of independently compressed zstd frames. */
function decode(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 4 || !buf.subarray(0, 4).equals(MAGIC)) return { text: buf.toString('utf8'), frames: 0 };
  const offsets = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offsets.push(i);
    i += 4;
  }
  const parts = [];
  let bad = 0;
  for (let k = 0; k < offsets.length; k += 1) {
    const slice = buf.subarray(offsets[k], k + 1 < offsets.length ? offsets[k + 1] : buf.length);
    try {
      parts.push(zlib.zstdDecompressSync(slice));
    } catch {
      bad += 1;
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: offsets.length, bad };
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.jsonl(\.zstd)?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Only frames *about* a context summary, never a frame that merely quotes the words.
 *
 * The first version of this probe matched the whole line, so a `tool/result` holding
 * this repository's own source (which contains `compaction` and `summariz*`) counted as
 * evidence that a compaction had happened. Measured 2026-10-03: 28 such false hits in a
 * session where nothing compacted. A frame counts only when its *type* is about
 * summarization — parse the line into a frame first, then match the type.
 */
const COMPACTION_TYPE = /(^|[/-])(compaction|summary|summariz)/i;

/** One session log -> the evidence a human would want before believing a claim. */
function inspect(file) {
  const { text, frames, bad } = decode(file);
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const types = new Map();
  const compactionHits = [];
  let requests = 0;
  let parseErrors = 0;
  const leak = [];
  const usage = { input: 0, cached: 0, output: 0, total: 0, seen: 0, maxPrompt: 0 };
  const dumped = [];
  /**
   * The window the host itself resolved, read from every `request/context` frame.
   *
   * This is the number every occupancy reading depends on: a threshold is computed from
   * it, and `dsh-compaction-basic` derives its own line from the same value. A stub with a
   * hand-picked 100,000 makes a mismatch with the installed window invisible — which is
   * exactly why this probe reads the real one.
   */
  const windows = new Map();

  for (const [index, line] of lines.entries()) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      parseErrors += 1;
      if (COMPACTION_TYPE.test(line)) leak.push({ index, sample: line.slice(0, 160) });
      continue;
    }
    const type = String(frame?.type ?? '?');
    types.set(type, (types.get(type) ?? 0) + 1);
    const data = frame?.data ?? {};
    if (DUMP !== undefined && type === DUMP && dumped.length < 2) dumped.push({ type, data, line: line.slice(0, 2000) });
    if (type === 'request/context') {
      const window = Number(data?.contextWindow);
      if (Number.isFinite(window) && window > 0) windows.set(window, (windows.get(window) ?? 0) + 1);
    }

    // Token accounting, whichever frame carries it: those counters are what decide
    // whether the engine is even allowed to reach its 80% threshold.
    const counters = data?.usage ?? data?.message?.usage ?? data?.result?.usage;
    if (counters !== undefined && counters !== null && typeof counters === 'object') {
      usage.seen += 1;
      for (const [key, target] of [
        ['inputTokens', 'input'],
        ['uncachedInputTokens', 'input'],
        ['cachedInputTokens', 'cached'],
        ['cacheReadTokens', 'cached'],
        ['outputTokens', 'output'],
        ['totalTokens', 'total'],
      ]) {
        const value = Number(counters[key]);
        if (Number.isFinite(value)) usage[target] += value;
      }
      // The frame carries that request's token counts, so the largest one seen is the
      // closest a log gets to "how full was the window". `totalTokens` is only trusted
      // when it is present and positive.
      const total = Number(counters.totalTokens);
      const prompt = Number.isFinite(total) && total > 0 ? total : Number(counters.inputTokens ?? 0) + Number(counters.cachedInputTokens ?? 0);
      if (Number.isFinite(prompt) && prompt > usage.maxPrompt) usage.maxPrompt = prompt;
    }

    if (COMPACTION_TYPE.test(type))
      compactionHits.push({ index, type, at: Number(frame?.time), sample: line.slice(0, 160) });

    if (/request/i.test(type)) requests += 1;
  }
  return {
    file,
    bytes: fs.statSync(file).size,
    frames,
    badFrames: bad,
    lines: lines.length,
    parseErrors,
    types: Object.fromEntries([...types.entries()].sort((a, b) => b[1] - a[1])),
    requests,
    usage,
    windows: Object.fromEntries(windows),
    /** Occupancy of the biggest prompt against the window the host resolved for it. */
    maxOccupancy:
      usage.maxPrompt > 0 && windows.size > 0
        ? usage.maxPrompt / Math.max(...windows.keys())
        : undefined,
    compactionHits: compactionHits.length,
    compactionSince: compactionHits.filter((hit) => Number.isFinite(hit.at) && hit.at >= SINCE),
    compactionByType: Object.fromEntries(
      [...compactionHits.reduce((map, hit) => map.set(hit.type, (map.get(hit.type) ?? 0) + 1), new Map()).entries()].sort(
        (a, b) => b[1] - a[1],
      ),
    ),
    compactionSamples: compactionHits.slice(0, 4),
    dumped: dumped.slice(0, 2),
    unparsedCompactionLines: leak.slice(0, 3),
  };
}

const targets = [];
if (ONLY_PATH !== undefined) {
  targets.push(ONLY_PATH);
} else {
  const dirs = fs
    .readdirSync(STORE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => ONLY_DIR === undefined || name === ONLY_DIR);
  for (const name of dirs) {
    const logs = walk(path.join(STORE, name))
      .map((full) => ({ full, mtime: fs.statSync(full).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, PER_DIR);
    targets.push(...logs.map((log) => log.full));
  }
}

const report = targets.map((file) => {
  try {
    return inspect(file);
  } catch (error) {
    return { file, error: String(error?.message ?? error) };
  }
});

for (const entry of report) {
  const short = entry.file.replace(STORE, '~');
  if (entry.error !== undefined) {
    console.log(`\n=== ${short}\n    ERROR ${entry.error}`);
    continue;
  }
  const stamp = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '?');
  console.log(`\n=== ${short}`);
  console.log(
    `    ${Math.round(entry.bytes / 1024)}KB, zstd frames ${entry.frames} (bad ${entry.badFrames}), lines ${entry.lines}, requests ${entry.requests}`,
  );
  const u = entry.usage ?? {};
  console.log(
    `    tokens (summed over ${u.seen ?? 0} usage frame(s)): input ${u.input ?? 0}, cached ${u.cached ?? 0}, output ${u.output ?? 0}, total ${u.total ?? 0}, biggest single prompt ${u.maxPrompt ?? 0}`,
  );
  console.log(`    frame types:           ${JSON.stringify(entry.types)}`);
  console.log(`    windows resolved:      ${JSON.stringify(entry.windows)}`);
  console.log(
    `    peak occupancy:        ${entry.maxOccupancy === undefined ? 'unknown' : `${(entry.maxOccupancy * 100).toFixed(2)}% of ${Math.max(...Object.keys(entry.windows).map(Number))}`}`,
  );
  console.log(`    compaction frames:     ${entry.compactionHits} ${JSON.stringify(entry.compactionByType)}`);
  console.log(`    compaction AFTER ${new Date(SINCE).toISOString()}: ${entry.compactionSince?.length ?? 0}`);
  for (const hit of entry.compactionSamples) console.log(`      ${stamp(hit.at)} [${hit.type} #${hit.index}] ${hit.sample}`);
}

/**
 * The verdict this probe exists for: sessions that really compacted after the cutover, and
 * how full their windows actually got before it happened.
 */
if (DUMP !== undefined) {
  console.log(`\n=== dump of ${DUMP} frames (first two per log)`);
  for (const entry of report) {
    for (const frame of entry.dumped ?? []) console.log(`  ${entry.file.replace(STORE, '~')}\n${frame.line}\n`);
  }
}

const eligible = report.filter((entry) => (entry.compactionSince?.length ?? 0) > 0);
const ranked = report
  .filter((entry) => typeof entry.maxOccupancy === 'number')
  .sort((a, b) => b.maxOccupancy - a.maxOccupancy)
  .slice(0, 5);
console.log(`\n=== verdict (cutover at ${new Date(SINCE).toISOString()})`);
console.log(`logs read: ${report.length}`);
console.log('fullest windows ever recorded (occupancy of the biggest prompt against the resolved window):');
for (const entry of ranked) {
  console.log(
    `  ${(entry.maxOccupancy * 100).toFixed(1)}%  peak ${entry.usage.maxPrompt} of ${Math.max(...Object.keys(entry.windows).map(Number))}  ${entry.file.replace(STORE, '~')}`,
  );
}
console.log(`sessions that compacted after the cutover: ${eligible.length}`);
for (const entry of eligible) {
  console.log(
    `  ${entry.file.replace(STORE, '~')}\n     compaction frames after cutover: ${entry.compactionSince.length}, biggest prompt: ${entry.usage?.maxPrompt ?? 0}`,
  );
}
console.log(
  eligible.length === 0
    ? 'NO EVIDENCE EITHER WAY: no recorded session compacted after the cutover.'
    : 'sessions compacted after the cutover; the frames above are the record of when and how full they were.',
);

const totals = report.reduce(
  (acc, entry) => ({
    logs: acc.logs + (entry.error === undefined ? 1 : 0),
    compaction: acc.compaction + (entry.compactionHits ?? 0),
  }),
  { logs: 0, compaction: 0 },
);
console.log(`\nsummary: ${totals.logs} log(s), ${totals.compaction} compaction-ish frame(s)`);
