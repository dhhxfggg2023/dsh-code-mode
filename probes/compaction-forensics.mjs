/**
 * Compaction forensics: why did the engine compact, and what did it keep?
 *
 * The user report (2026-10-10) was not "the card was ignored" but "the engine compacted
 * silently and I lost the context". `session-evidence.mjs` can say *that* it happened (one
 * session compacted with a peak of 68%), but not *which* path released the step. This probe
 * prints the raw frames around the moment, because the answer is in numbers the stubs never
 * see:
 *
 *   - `request/context.data.contextWindow` — the window the host resolved;
 *   - the usage counters on `assistant/message`/`step/end` — the occupancy that would have
 *     been compared against a threshold;
 *   - every `compaction/*` frame — what the engine did and what it kept.
 *
 * It was written while a compaction gate existed and also counted frames whose
 * `message.source.kind === 'code-compact-gate'`; that gate was deleted on 2026-10-11, so the
 * gate-trace column was removed with it. What is left is the engine half, which is *more*
 * relevant now that the engine compacts on its own again.
 *
 * Read-only by construction: it opens logs, decodes them, writes only to stdout.
 *
 * Usage:
 *   node probes/compaction-forensics.mjs --path <log.zstd> [--around <index>] [--window 6]
 *   node probes/compaction-forensics.mjs --list          # logs with a post-mount compaction
 *   node probes/compaction-forensics.mjs --dir <name>    # one dir under ~/.dsh/sessions
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const ONLY_PATH = flag('--path');
const ONLY_DIR = flag('--dir');
const AROUND = Number(flag('--around') ?? '0');
const SEQ_FROM = Number(flag('--from') ?? '0');
const SEQ_TO = Number(flag('--to') ?? '0');
const WINDOW = Number(flag('--window') ?? '4');
const SINCE = Date.parse('2026-10-02T14:49:00Z');
const STORE = path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Session logs are a concatenation of independently compressed zstd frames. */
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
    const slice = buf.subarray(offsets[k], k + 1 < offsets.length ? offsets[k + 1] : buf.length);
    try {
      parts.push(zlib.zstdDecompressSync(slice));
    } catch {
      /* a torn tail frame is not a reason to lose the whole log */
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

function frames(file) {
  return decode(file)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return { index, frame: JSON.parse(line) };
      } catch {
        return { index, frame: { type: '(unparsed)', raw: line.slice(0, 200) } };
      }
    });
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.jsonl(\.zstd)?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const targets = [];
if (ONLY_PATH !== undefined) targets.push(ONLY_PATH);
else if (args.includes('--list')) {
  for (const name of fs.readdirSync(STORE, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    for (const log of walk(path.join(STORE, name.name))) targets.push(log);
  }
} else {
  const dirs = fs
    .readdirSync(STORE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => ONLY_DIR === undefined || entry.name === ONLY_DIR);
  for (const dir of dirs) targets.push(...walk(path.join(STORE, dir.name)));
}

const report = [];
for (const file of targets) {
  let all;
  try {
    all = frames(file);
  } catch (error) {
    report.push({ file, error: String(error?.message ?? error) });
    continue;
  }
  const compactions = [];
  const windows = [];
  let biggest = 0;
  let biggestAt = undefined;
  for (const { index, frame } of all) {
    const type = String(frame?.type ?? '?');
    const data = frame?.data ?? {};
    if (/^compaction/.test(type) || /(^|[/-])(compaction|summar)/i.test(type)) {
      compactions.push({ index, type, at: Number(frame?.time), data });
    }
    if (type === 'request/context') windows.push({ index, window: Number(data?.contextWindow) });
    const counters = data?.usage ?? data?.message?.usage ?? data?.result?.usage;
    const total = Number(counters?.totalTokens);
    const prompt = Number.isFinite(total) && total > 0 ? total : Number(counters?.inputTokens ?? 0) + Number(counters?.cachedInputTokens ?? 0);
    if (Number.isFinite(prompt) && prompt > biggest) {
      biggest = prompt;
      biggestAt = { index, type };
    }
  }
  const post = compactions.filter((hit) => Number.isFinite(hit.at) && hit.at >= SINCE);
  report.push({
    file,
    window: windows.at(-1)?.window ?? null,
    biggestPrompt: biggest,
    biggestAt,
    compactions: compactions.length,
    compactionsSinceCutover: post.length,
    compactionTypes: [...new Set(compactions.map((hit) => hit.type))],
    around: AROUND > 0 ? all.slice(Math.max(0, AROUND - WINDOW), AROUND + WINDOW).map(({ index, frame }) => ({ index, type: frame?.type, line: JSON.stringify(frame).slice(0, 900) })) : undefined,
    /**
     * `--from N --to M` prints a slice verbatim. This is the flag that answers "what was
     * the harness doing at the instant it decided to compact": the frames around
     * `compaction/start` are the only record of that decision, and a summary of them is
     * what loses the one field that matters.
     */
    slice: SEQ_TO > SEQ_FROM
      ? all.slice(SEQ_FROM, SEQ_TO + 1).map(({ index, frame }) => ({ index, type: frame?.type, time: frame?.time, line: JSON.stringify(frame).slice(0, 700) }))
      : undefined,
  });
}

const interesting = report.filter((item) => item.compactionsSinceCutover > 0);
const payload = JSON.stringify(args.includes('--list') ? interesting : report, null, 1);
/**
 * `--out <file>` writes UTF-8 from node.
 *
 * Piping this to a PowerShell `>` redirect produced UTF-16LE and the editor then refused
 * the file as binary — the same trap the machine ledger already carries for redirects.
 * Writing in-process is the one path that cannot be mis-decoded.
 */
const OUT = flag('--out');
if (OUT === undefined) console.log(payload);
else {
  fs.writeFileSync(OUT, payload, 'utf8');
  console.log(`wrote ${payload.length} chars to ${OUT}`);
}
