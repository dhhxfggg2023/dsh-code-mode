/**
 * Which target and reservation did the routed requests actually carry?
 *
 * A10/A2 taught me not to assume what `reservedCompletionTokens` was: the engine's line is
 * `min(window × 0.8, window − reserved − 65536)`, and the recorded session compacted at
 * 682,185 of a 1,000,000 window — which the first term alone cannot explain, so `reserved`
 * must have been large or the window must have been smaller. The `request/header` frames are
 * the only place that answers it, and they are what the engine itself reads at request time.
 *
 * Read-only. Usage: node probes/engine-reservation.mjs --path <log.zstd> [--out <file>]
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
const OUT = flag('--out');
const STORE = path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

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
      /* a torn tail frame is not a reason to lose the log */
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const targets = ONLY_PATH !== undefined ? [ONLY_PATH] : walk(STORE);
const rows = [];
for (const file of targets) {
  let text;
  try {
    text = decode(file);
  } catch (error) {
    rows.push({ file, error: String(error?.message ?? error) });
    continue;
  }
  const headers = [];
  const contexts = [];
  const compactions = [];
  let peak = 0;
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    const type = String(frame?.type ?? '');
    const data = frame?.data ?? {};
    if (type === 'request/header')
      // The frame nests what the engine reads at `requestHeader().config` one level deeper.
      headers.push({ seq: frame.seq, at: Number(frame.time), config: data.header?.config ?? data.config ?? data });
    if (type === 'request/context')
      contexts.push({ seq: frame.seq, at: Number(frame.time), provider: data.provider, model: data.model, contextWindow: data.contextWindow });
    if (/^compaction\/(start|end|summary)/.test(type)) compactions.push({ seq: frame.seq, at: Number(frame.time), type });
    const counters = data?.usage ?? data?.message?.usage ?? data?.result?.usage;
    const total = Number(counters?.totalTokens);
    const tokens =
      Number.isFinite(total) && total > 0 ? total : Number(counters?.inputTokens ?? 0) + Number(counters?.cachedInputTokens ?? 0);
    if (Number.isFinite(tokens) && tokens > peak) peak = tokens;
  }
  const maxTokensSeen = [...new Set(headers.map((h) => h.config?.maxTokens).filter((v) => v !== undefined))];
  const window = contexts.at(-1)?.contextWindow;
  rows.push({
    file: path.relative(STORE, file),
    window,
    peak,
    peakRatio: window === undefined ? null : Number((peak / window).toFixed(4)),
    headerCount: headers.length,
    headers: headers.slice(-2).map((h) => ({ seq: h.seq, at: h.at, provider: h.config?.provider, model: h.config?.model, maxTokens: h.config?.maxTokens, raw: JSON.stringify(h.config).slice(0, 400) })),
    maxTokensSeen,
    contexts,
    compactions,
    // What the engine's arithmetic gives for the reservation values actually seen.
    engineThresholds: maxTokensSeen.map((reserved) => ({
      reserved,
      thresholdTokens:
        window === undefined
          ? null
          : Math.floor(Math.min(window * 0.8, window - reserved - 65536)),
    })),
  });
}

const interesting = rows.filter((row) => row.error === undefined && (row.compactions.length > 0 || row.peakRatio >= 0.6));
const payload = JSON.stringify(ONLY_PATH === undefined ? interesting : rows, null, 1);
if (OUT === undefined) console.log(payload);
else {
  fs.writeFileSync(OUT, payload, 'utf8');
  console.log(`wrote ${payload.length} chars to ${OUT}`);
}
