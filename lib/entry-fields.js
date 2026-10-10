/**
 * How one ledger entry's named fields are read — one owner, because the copies drifted.
 *
 * `lib/pit-guard.js` reads `- label: value` lines out of a recorded entry, and that reader was
 * re-implemented in seven other places (`probes/safe-case-parse.mjs`, `safe-case-live.mjs`,
 * `field-regex-trace.mjs`, `hard-block-audit.mjs`, `entry-parse-trace.mjs`, `pit-fire-probe.mjs`,
 * and the narrow `- label: (.*)` shape in `pit-liveness.mjs`, `ledger-census.mjs`, `pit-report.mjs`).
 *
 * On 2026-10-06 the reader in `pit-guard.js` was widened — full-width `：` and `（）`, the Chinese
 * label 安全情形, and a `/`-separated list of accepted spellings — and on 2026-10-10 that widening
 * is what the copies got wrong. Two of them spent the day announcing "the guard can read **0 of
 * 4** real safe cases" while the guard read every one of them: `pit-guard-probe` K10 drives the
 * real module with a real block and stayed green. A reader that restates the rule it checks
 * cannot report that the rule changed — `safe-case-parse.mjs` says exactly that in its own output,
 * one line above the false alarm it was printing.
 *
 * Pure: no imports, no host, no side effects, so a plain-node probe can import it. That is the
 * whole point, and it is the same reason `lib/compact-policy.js` exists.
 */

/**
 * One field's value out of an entry block.
 *
 * The shape it accepts is deliberately wider than the shape any one writer produces: an entry may
 * carry the label in either language, an optional parenthetical aside, and either colon, and it
 * may explain the case across several lines — the first line is returned.
 *
 * @param block - the entry's text, from its heading onwards.
 * @param labels - one label, or several separated by `/`; the first spelling that matches wins.
 * @returns the value, or undefined when no accepted spelling is present.
 */
export function entryField(block, labels) {
  for (const label of String(labels).split('/')) {
    const match = new RegExp(`^- ${label}\\s*(?:[（(][^\\n]*?[）)])?\\s*[:：]\\s*([^\\n]*)$`, 'm').exec(String(block));
    if (match !== null) {
      const value = match[1].trim();
      if (value.length > 0) return value;
    }
  }
  return undefined;
}

/**
 * The spellings a human may use for one field, so a probe can *drive* every accepted shape
 * instead of restating the ones it happens to remember.
 *
 * `probes/safe-case-parse.mjs` needed this the moment its own three candidate spellings turned
 * out to be three shapes nobody writes.
 */
export const FIELD_SPELLINGS = {
  safeCase: ['safe case', '安全情形'],
};
