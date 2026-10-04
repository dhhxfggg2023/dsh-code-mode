/**
 * Compress *long* timers so an observation window can see a deadline that is minutes
 * away — the control for audit F5 on the audit's own probe.
 *
 * Why it exists. `probe-compact-open.mjs` mounts the gate with the mounted
 * `askTimeoutMs` (120000 ms) and observes each step for 250–400 ms, so C8/C9
 * ("askTimed never settles" / "resolveModelInfo never settles") can only report
 * `held` there — before the repair because nothing bounded the await, and after it
 * because 120000 ms outlasts the window. The repair is therefore visible on that probe
 * only if the deadline itself is made short enough to fall inside the window, which is
 * what this preload does — and it does it to the gate's timer, not to the probe:
 *
 *     $env:DSH_SCALE_LONG_TIMERS='1000'   # divide timers >= floor by 1000
 *     node --import ./.dsh-code/audits/temp-report-sink.mjs \
 *          --import ./.dsh-code/audits/scale-long-timers.mjs \
 *          .dsh-code/audits/probe-compact-open.mjs
 *
 * Only delays at or above `DSH_SCALE_FLOOR_MS` (default 1000 ms) are scaled, so the
 * probe's own hold windows (250–500 ms) and its stubbed answerer's 120 ms delay — the
 * clock the probe measures *with* — are untouched. The scaled timer is the deadline
 * under test: it is armed by the gate from `limits.askTimeoutMs`, and nothing else in
 * either process arms a timer of a second or more.
 *
 * Inert unless `DSH_SCALE_LONG_TIMERS` is a number greater than 1.
 */
const factor = Number(process.env.DSH_SCALE_LONG_TIMERS ?? '0');
const floor = Number(process.env.DSH_SCALE_FLOOR_MS ?? '1000');

if (Number.isFinite(factor) && factor > 1 && Number.isFinite(floor) && floor > 0) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = function setTimeout(handler, delay, ...args) {
    const ms = Number(delay);
    const scaled = Number.isFinite(ms) && ms >= floor ? Math.max(1, Math.round(ms / factor)) : delay;
    return realSetTimeout(handler, scaled, ...args);
  };
  process.stderr.write(`[scale-long-timers] timers >= ${floor} ms are divided by ${factor}\n`);
}
