/**
 * Does the compaction gate ask *before* the engine compacts?
 *
 * This is the probe the previous two did not have, and the reason the defect survived
 * two user reports (2026-10-03, 2026-10-10):
 *
 *   - `compact-gate-probe.mjs` (35 checks) drives stubs, so it proves the policy is
 *     right and cannot see which line the *engine* uses;
 *   - `gate-chance.mjs` reads real sessions but only knows the gate's declared ratio, so
 *     it could report "the ask line was never reached" as if that were the whole story.
 *
 * What was actually wrong is arithmetic, measured in the installed engine on 2026-10-10:
 *
 *     thresholdTokens = floor(min(window × 0.8, window − reserved − 65536))
 *                        ^^^^^^^^^^^^^^^^^^ always ≥ 0.8 × window
 *     the gate asked at  window × 0.75        ← strictly below the engine's own floor
 *
 * so the engine compacted first, always. This probe pins the relation that must hold:
 * **the ask line is strictly below the mirrored engine line, and below it by enough room
 * to act**, and it also replays the one real session that compacted while the gate was
 * mounted, requiring the ask line to sit below what that session actually reached.
 *
 * Plain node, reads only, writes nothing.
 *
 * Usage: node probes/gate-ahead-of-engine.mjs [--out <file>]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { effectiveAskLine, engineThresholdTokens, resolveLimits } from '../lib/compact-policy.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The preset's declared ratios, read from the file rather than restated here. */
function declared() {
  const text = fs.readFileSync(path.join(PKG, 'cordis.patch.yml'), 'utf8');
  const at = text.indexOf('id: code-compact-gate');
  const row = at === -1 ? '' : text.slice(at, text.indexOf('compaction-basic', at));
  const num = (key) => {
    const found = row.match(new RegExp(`${key}:\\s*([0-9]*\\.?[0-9]+)`));
    return found === null ? undefined : Number(found[1]);
  };
  return { warnRatio: num('warnRatio'), gateRatio: num('gateRatio') };
}

const DECLARED = declared();
const LIMITS = resolveLimits(DECLARED);
const WINDOW = 1_000_000;

const results = [];
const check = (id, name, ok, evidence) => results.push({ id, name, ok: Boolean(ok), evidence });

// A1 — the mirror reproduces the engine's arithmetic on the window this host resolves.
{
  const tokens = engineThresholdTokens(WINDOW, 0);
  check(
    'A1',
    'the mirrored engine line equals the engine formula on a 1,000,000-token window',
    tokens === 800_000,
    { mirrored: tokens, expected: 800_000, formula: 'floor(min(window*0.8, window-0-65536))' },
  );
}

// A2 — the reservation is what usually decides the line. The recorded session on this host
// carried `maxTokens: 256000`, and with the engine's own headroom that gives 678,464 — which
// is the number that session was actually compacted at (682,185). A mirror that ignored the
// reservation (the first version of this probe asserted 720,000 for 65,536) would have
// promised a line 120,000 tokens later than the real one.
{
  const tokens = engineThresholdTokens(WINDOW, 256_000);
  check('A2', 'a request reserving 256,000 output tokens puts the engine line at 678,464', tokens === 678_464, {
    mirrored: tokens,
    window: WINDOW,
    reserved: 256_000,
    recordedCompaction: 682_185,
  });
}

// A3 — the mounted ask line is strictly below the engine's line, with room to act in.
{
  const ask = effectiveAskLine(WINDOW, 65_536, LIMITS.gateRatio);
  const engine = engineThresholdTokens(WINDOW, 65_536);
  check(
    'A3',
    'the ask line is below the engine line, by at least 30,000 tokens',
    ask !== undefined && ask.ratio * WINDOW < engine && engine - ask.ratio * WINDOW >= 30_000,
    { askTokens: Math.round(ask.ratio * WINDOW), askRatio: Number(ask.ratio.toFixed(4)), engineTokens: engine },
  );
}

// A4 — it never asks later than the preset declares, so the mirror cannot silently make
// the gate lazier than the configured policy.
{
  const ask = effectiveAskLine(WINDOW, 65_536, LIMITS.gateRatio);
  check('A4', 'the ask line never exceeds the preset gateRatio', ask.ratio <= LIMITS.gateRatio, {
    askRatio: Number(ask.ratio.toFixed(4)),
    gateRatio: LIMITS.gateRatio,
  });
}

// A5 — degenerate windows are declined rather than measured wrongly. A window small enough
// that the engine's fixed 65,536-token headroom decides the line (100,000 → 34,464) is not
// priced this way; the gate keeps its declared ratio instead of holding steps at 30%.
{
  const rows = [100_000, 32_768].map((window) => {
    const ask = effectiveAskLine(window, 8192, LIMITS.gateRatio);
    return {
      window,
      askRatio: ask === undefined ? null : Number(ask.ratio.toFixed(4)),
      engineTokens: engineThresholdTokens(window, 8192) ?? null,
      declined: ask === undefined,
    };
  });
  const control = effectiveAskLine(WINDOW, 256_000, LIMITS.gateRatio);
  check(
    'A5',
    'a window too small for the mirror is declined, while a real window is still priced',
    rows.every((row) => row.declined) && control !== undefined && control.ratio < 0.7,
    { declined: rows, control: { window: WINDOW, askRatio: Number(control.ratio.toFixed(4)) } },
  );
}

// A6 — a reservation so large that the engine's own line lands a third of the way into the
// window must NOT be mirrored: asking there would put a card in the middle of ordinary work,
// which is worse than the silent compaction this fix is for. The gate keeps its declared
// ratio instead, and A5's control shows the same window is still priced normally at a sane
// reservation.
{
  const ask = effectiveAskLine(WINDOW, 600_000, LIMITS.gateRatio);
  check(
    'A6',
    'a reservation that pushes the engine line below half the window is declined, not mirrored',
    ask === undefined && engineThresholdTokens(WINDOW, 600_000) === 334_464,
    { ask: ask ?? null, engineTokens: engineThresholdTokens(WINDOW, 600_000), floorRatio: 0.5 },
  );
}

// A7 — no window priced (an adapter that cannot price the model) must not ask a line at
// all: the gate keeps the declared ratio, which is the pre-fix behaviour and safe.
{
  const ask = effectiveAskLine(undefined, 65_536, LIMITS.gateRatio);
  check('A7', 'an unknown window yields no mirrored line, so the declared ratio stands', ask === undefined, {
    ask: ask ?? null,
    gateRatio: LIMITS.gateRatio,
  });
}

/**
 * A8 — the case that actually happened, replayed from the recorded session.
 *
 * `xpic/session-780b999f` reached 682,185 tokens of a 1,000,000-token window with the gate
 * mounted, got the 60% warning, and was compacted by the engine without ever being asked.
 * The fix has to change that session's verdict: with the ask line derived here, that
 * occupancy is *above* the line, so the card appears before the engine fires.
 */
{
  const log = path.join(
    process.env.USERPROFILE ?? '',
    '.dsh',
    'sessions',
    '--E-projects-xpic--',
    'session-780b999f-678e-4be4-860b-b81aa0214e90',
    'session.v4.jsonl.zstd',
  );
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  let peak;
  let reservation;
  try {
    const buf = fs.readFileSync(log);
    const offsets = [];
    let i = 0;
    while ((i = buf.indexOf(MAGIC, i)) !== -1) {
      offsets.push(i);
      i += 4;
    }
    const text = Buffer.concat(
      offsets.map((at, k) =>
        zlib.zstdDecompressSync(buf.subarray(at, k + 1 < offsets.length ? offsets[k + 1] : buf.length)),
      ),
    ).toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      // The request's own reservation, exactly where the engine reads it (the frame nests
      // what `requestHeader().config` returns one level deeper).
      if (frame?.type === 'request/header') {
        const value = Number(frame?.data?.header?.config?.maxTokens ?? frame?.data?.config?.maxTokens);
        if (Number.isFinite(value) && value > 0) reservation = value;
      }
      const counters = frame?.data?.usage ?? frame?.data?.message?.usage ?? frame?.data?.result?.usage;
      const total = Number(counters?.totalTokens);
      const tokens =
        Number.isFinite(total) && total > 0
          ? total
          : Number(counters?.inputTokens ?? 0) + Number(counters?.cachedInputTokens ?? 0);
      if (Number.isFinite(tokens) && tokens > 0 && (peak === undefined || tokens > peak)) peak = tokens;
    }
  } catch (error) {
    check('A8', 'the recorded session that compacted silently is still on disk to replay', false, {
      log,
      error: String(error?.message ?? error),
    });
  }
  if (peak !== undefined) {
    const engine = engineThresholdTokens(WINDOW, reservation);
    const ask = effectiveAskLine(WINDOW, reservation, LIMITS.gateRatio);
    check(
      'A8',
      'the session that was compacted at 682,185 tokens would now be asked before the engine fires',
      ask !== undefined && engine !== undefined && peak >= ask.ratio * WINDOW && peak >= engine,
      {
        recordedPeak: peak,
        recordedRatio: Number((peak / WINDOW).toFixed(4)),
        reservationFromTheLog: reservation ?? null,
        engineTokens: engine ?? null,
        askTokens: ask === undefined ? null : Math.round(ask.ratio * WINDOW),
        askRatio: ask === undefined ? null : Number(ask.ratio.toFixed(4)),
        wasCompacted: true,
      },
    );
  }
}

// A9 — the pre-fix line is the control: it must FAIL this same replay, or the probe proves
// nothing about the fix. This is the check that makes A8 evidence instead of an assertion.
{
  const preFixRatio = 0.75;
  const peak = 682_185;
  check(
    'A9',
    'control: the pre-fix 0.75 ask line could not have fired in that session',
    peak < preFixRatio * WINDOW,
    { peak, preFixTokens: Math.round(preFixRatio * WINDOW), gap: Math.round(preFixRatio * WINDOW) - peak },
  );
}

// A10 — anti-duplication: the mirrored numbers must still be the engine's numbers, and the
// plugin must still route its decision through the mirrored line. Both are read from files,
// not restated, because the whole defect was two copies of one number drifting apart.
{
  const policy = fs.readFileSync(path.join(PKG, 'lib', 'compact-policy.js'), 'utf8');
  const gate = fs.readFileSync(path.join(PKG, 'lib', 'compact-gate.js'), 'utf8');
  const engineSrc = [
    path.join(PKG, '.dsh-code', 'reference', 'dsh-compaction-basic.index.js'),
    path.join(process.env.TEMP ?? '', 'compaction-basic.js'),
  ].find((file) => fs.existsSync(file));
  let engineSays = null;
  if (engineSrc !== undefined) {
    const text = fs.readFileSync(engineSrc, 'utf8');
    engineSays = {
      thresholdRatio: /DEFAULT_THRESHOLD_RATIO = ([0-9.]+)/.exec(text)?.[1],
      headroom: /headroomTokens = config\.headroomTokens \?\? (\d+)/.exec(text)?.[1],
      usesClamp: /Math\.floor\(Math\.min\(contextWindow \* policy\.thresholdRatio, pressureBudgetTokens\)\)/.test(text),
    };
  }
  const declared = {
    thresholdRatio: Number(/ENGINE_THRESHOLD_RATIO = ([0-9.]+)/.exec(policy)?.[1]),
    headroom: Number(/ENGINE_HEADROOM_TOKENS = (\d+)/.exec(policy)?.[1]),
  };
  // Two separate facts, because the mirror can be right while the plugin ignores it: the
  // handler must read the derived line off the occupancy, and must hand it to the decision.
  const readsDerivedLine = /occupancy\.askRatio/.test(gate);
  const passesItToTheDecision = /decideStage\([^)]*askRatio/.test(gate);
  check(
    'A10',
    'the mirrored constants still equal the engine source, and the plugin still asks on the mirrored line',
    engineSays !== null &&
      engineSays.usesClamp === true &&
      Number(engineSays.thresholdRatio) === declared.thresholdRatio &&
      Number(engineSays.headroom) === declared.headroom &&
      readsDerivedLine &&
      passesItToTheDecision,
    { engineSource: engineSrc ?? 'not extracted', engineSays, mirrored: declared, readsDerivedLine, passesItToTheDecision },
  );
}

const failed = results.filter((row) => !row.ok);
const report = {
  passed: results.length - failed.length,
  total: results.length,
  failed: failed.map((row) => `${row.id} ${row.name}`),
  declared: DECLARED,
  limits: LIMITS,
  checks: results,
};
const OUT = flag('--out');
if (OUT === undefined) console.log(JSON.stringify(report, null, 1));
else {
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1), 'utf8');
  console.log(`${report.passed}/${report.total} passed${failed.length === 0 ? '' : ` — failed: ${report.failed.join('; ')}`}`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
