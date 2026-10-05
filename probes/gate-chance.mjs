/**
 * Gate chance: has the compaction gate ever had an opportunity to fire?
 *
 * Written 2026-10-03, after the user reported "it has never actually taken effect".
 * The 30 checks in `compact-gate-probe.mjs` all drive stubs or read the preset text, so
 * they cannot answer that: they prove the policy is right, not that a real session ever
 * reached the occupancy at which the policy speaks. Two numbers decide it, and neither
 * was ever read from a real session:
 *
 *   - `contextWindow`, which the host records in every `request/context` frame;
 *   - the token count of each request, which decides occupancy against that window.
 *
 * The gate asks at the preset's `gateRatio` and warns once at its `warnRatio` of that window.
 * Both are read out of `cordis.patch.yml` at run time and never hardcoded here — see
 * `declaredRatios`, which exists because they once were.
 * So: find every request at or above the warn line *after the gate was mounted*, and
 * report whether the gate left a trace. Zero traces above the warn line is a finding;
 * zero requests above the warn line means the gate was never given the chance.
 *
 * Reads only; writes nothing; runs on plain node.
 *
 * Usage: node probes/gate-chance.mjs [--since <ISO>] [--mount <ISO>]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

/** When `code-compact-gate` first landed in `cordis.patch.yml` (from the ledger). */
const MOUNT = Date.parse(flag('--mount') ?? '2026-10-02T14:49:00Z');
/** Only requests at or after this instant count. Defaults to the mount. */
const SINCE = Date.parse(flag('--since') ?? new Date(MOUNT).toISOString());
/**
 * The lines this probe measures against come from the preset, never from this file.
 *
 * They used to be two hardcoded constants (`WARN = 0.65`, `GATE = 0.8`), and that is the
 * same defect this project already fixed once in `compact-gate-probe` R1: two copies of one
 * number agreeing with each other while the feature ran on neither. Measured 2026-10-05 —
 * the preset declares 0.6/0.75 (lowered on 2026-10-03 *because* 0.8 sits above the ceiling
 * real sessions reach), while this probe still printed `warn 0.65 / ask 0.8`. It was
 * measuring a gate that no longer exists.
 *
 * The direction of that error is the dangerous one. A warn line *stricter* than the real one
 * reports "no session ever reached the line" for sessions that did — and "it has never
 * happened" is the verdict several mechanisms here rest on, so a probe that manufactures
 * that verdict keeps a working feature looking dead. Read the declaration; print its source.
 */
function declaredRatios() {
  const preset = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cordis.patch.yml');
  try {
    const text = fs.readFileSync(preset, 'utf8');
    const at = text.indexOf('id: code-compact-gate');
    if (at === -1) return { warn: undefined, gate: undefined, source: `${preset} (no code-compact-gate row)` };
    // The row runs until the next `- id:`; the gate's own config keys are flat and unquoted.
    const tail = text.slice(at);
    const end = tail.search(/\n\s*-\s+id:/);
    const row = end === -1 ? tail : tail.slice(0, end);
    const num = (key) => {
      const found = row.match(new RegExp(`${key}:\\s*([0-9]*\\.?[0-9]+)`));
      return found === null ? undefined : Number(found[1]);
    };
    return { warn: num('warnRatio'), gate: num('gateRatio'), source: preset };
  } catch (error) {
    return { warn: undefined, gate: undefined, source: `unreadable: ${error?.message ?? error}` };
  }
}
const DECLARED = declaredRatios();
/** The library's own fallbacks, and only fallbacks — never a stand-in for the declaration. */
const WARN = Number.isFinite(DECLARED.warn) ? DECLARED.warn : 0.65;
const GATE = Number.isFinite(DECLARED.gate) ? DECLARED.gate : 0.8;

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
      /* a torn frame is not evidence for or against the gate */
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

function logs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) logs(full, out);
    else if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every request this log priced, with the window the host resolved for it. */
function observations(file) {
  const seen = [];
  const traces = [];
  let window;
  for (const line of decode(file).split('\n')) {
    if (line.trim().length === 0) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    const data = frame?.data ?? {};
    if (frame.type === 'request/context') {
      const value = Number(data.contextWindow);
      if (Number.isFinite(value) && value > 0) window = value;
      continue;
    }
    if (frame.type === 'system/message' && String(data?.message?.source?.kind ?? '') === 'code-compact-gate') {
      traces.push({ at: Number(frame.time), kind: 'same-turn notice', text: 'gate attached a notice to this step' });
      continue;
    }
    const counters = data?.usage ?? data?.message?.usage ?? data?.result?.usage;
    if (counters !== undefined && counters !== null && typeof counters === 'object') {
      const total = Number(counters.totalTokens);
      const tokens = Number.isFinite(total) && total > 0 ? total : Number(counters.inputTokens ?? 0) + Number(counters.cachedInputTokens ?? 0);
      if (Number.isFinite(tokens) && tokens > 0) seen.push({ at: Number(frame.time), tokens });
    }
  }
  return { seen, traces, window };
}

const rows = [];
for (const file of logs(STORE)) {
  try {
    const { seen, traces, window } = observations(file);
    if (seen.length === 0 || window === undefined) continue;
    const peak = seen.reduce((best, item) => (item.tokens > best.tokens ? item : best), seen[0]);
    rows.push({
      file,
      window,
      peak,
      ratio: peak.tokens / window,
      last: seen[seen.length - 1],
      traces: traces.length,
      // The gate only speaks about steps that happened after it was mounted.
      afterMount: seen.filter((item) => Number.isFinite(item.at) && item.at >= SINCE).length,
      peakAfterMount: seen
        .filter((item) => Number.isFinite(item.at) && item.at >= SINCE)
        .reduce((best, item) => (best === undefined || item.tokens > best.tokens ? item : best), undefined),
    });
  } catch (error) {
    rows.push({ file, error: String(error?.message ?? error) });
  }
}

const stamp = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : 'when?');
const usable = rows.filter((row) => row.error === undefined);
usable.sort((a, b) => b.ratio - a.ratio);

console.log(`store      : ${STORE}`);
console.log(`gate mount : ${new Date(MOUNT).toISOString()}   warn ${WARN} / ask ${GATE}`);
console.log(`thresholds : declared in ${DECLARED.source}`);
console.log(`logs read  : ${rows.length} (${usable.length} with a resolved window)`);
const windows = new Map();
for (const row of usable) windows.set(row.window, (windows.get(row.window) ?? 0) + 1);
console.log(`windows    : ${JSON.stringify(Object.fromEntries(windows))}`);

console.log('\nfullest windows ever recorded:');
for (const row of usable.slice(0, 8)) {
  console.log(
    `  ${(row.ratio * 100).toFixed(2)}%  peak ${row.peak.tokens} of ${row.window} at ${stamp(row.peak.at)}  traces ${row.traces}  ${row.file.replace(STORE, '~')}`,
  );
}

const aboveWarn = usable.filter((row) => row.ratio >= WARN);
const aboveGate = usable.filter((row) => row.ratio >= GATE);
const afterWarn = usable.filter((row) => row.peakAfterMount !== undefined && row.peakAfterMount.tokens / row.window >= WARN);
const afterGate = usable.filter((row) => row.peakAfterMount !== undefined && row.peakAfterMount.tokens / row.window >= GATE);

/**
 * Where sessions actually end, which is what a threshold has to be chosen against.
 *
 * A gate at 0.8 asks about windows nothing reaches: measured 2026-10-03, 32 sessions
 * passed the warn line and none reached the ask line, with a ceiling at 79.86%. A
 * threshold is only useful if real sessions cross it while they are still running.
 */
if (usable.length > 0) {
  const sorted = [...usable].map((row) => row.ratio).sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  const buckets = new Map();
  for (const ratio of sorted) {
    const key = `${String(Math.floor(ratio * 20) * 5).padStart(2, '0')}-${String(Math.floor(ratio * 20) * 5 + 5).padStart(2, '0')}%`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  console.log('\nper-session peak occupancy distribution:');
  console.log(`  max ${(at(1) * 100).toFixed(2)}%   p95 ${(at(0.95) * 100).toFixed(2)}%   p75 ${(at(0.75) * 100).toFixed(2)}%   median ${(at(0.5) * 100).toFixed(2)}%`);
  for (const [key, count] of [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)))
    console.log(`  ${key} ${'#'.repeat(Math.min(count, 60))} ${count}`);
}

console.log('\nsessions whose biggest prompt reached the warn line (all time):');
for (const row of aboveWarn) console.log(`  ${(row.ratio * 100).toFixed(1)}%  ${stamp(row.peak.at)}  traces ${row.traces}  ${row.file.replace(STORE, '~')}`);
console.log(`  total ${aboveWarn.length}; at or above the ask line: ${aboveGate.length}`);

console.log(`\nsessions whose biggest prompt reached the warn line AFTER the mount (${new Date(SINCE).toISOString()}):`);
for (const row of afterWarn)
  console.log(`  ${((row.peakAfterMount.tokens / row.window) * 100).toFixed(1)}%  ${stamp(row.peakAfterMount.at)}  traces ${row.traces}  ${row.file.replace(STORE, '~')}`);
console.log(`  total ${afterWarn.length}; at or above the ask line: ${afterGate.length}`);

const verdict =
  afterGate.length > 0
    ? usable.filter((row) => afterGate.includes(row)).every((row) => row.traces === 0)
      ? 'FINDING: a mounted-gate session crossed the ask line and the gate left no trace.'
      : 'the gate left traces in sessions that crossed the ask line; inspect them.'
    : afterWarn.length > 0
      ? 'NOT YET DECIDED: sessions crossed the warn line with the gate mounted, but none reached the ask line. A silent warn stage would be a finding; check the trace counts above.'
      : 'NO CHANCE YET: no recorded session reached even the warn line after the gate was mounted, so nothing this gate does has been exercised by real work.';
console.log(`\nverdict: ${verdict}`);
