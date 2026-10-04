/**
 * Probe — the regex bound, from the side that had none.
 *
 * The ledger-core audit (2026-10-04, F2) measured `code_brief({topic})` at **21,432 ms** for a
 * 26-character topic when a recorded `trigger:` backtracks, and never returning at 34. The
 * cure already existed in `lib/pattern-matcher.js` (used by `pit-guard`) but `lib/ledger.js`
 * called `new RegExp(trigger).test(query)` bare in two places.
 *
 * This probe exists because the ledger already records the trap in judging this exact fix:
 * *"do not accept a measurement as proof of a bound"* — the first version of that cure was
 * tested with a pattern anchored to a literal space, which returned in 0 ms without the bound
 * ever firing. So the assertions are:
 *
 *   P1  the bound FIRES — the call is timed against a pattern that genuinely backtracks
 *   P2  the bound is what decided it (a source other than `inline`)
 *   P3  a normal pattern still matches once a verdict exists — a bound that kills the feature
 *       is not a fix
 *   P4  the real `brief({topic})` path returns instead of hanging
 *   P5  `matchesExpectation` (code_verify's `expect: 're:…'`) is bounded, and `m` survives
 *   P6  the async worker path `pit-guard` uses still answers, and marks the pair cheap
 *
 * The environment fact that shaped the fix, and that this probe measures rather than assumes:
 * in BOTH host channels a child process that pipes its stdout is refused, so nothing may
 * *depend* on a child. The probe therefore asserts on `spawnDenied` for information and never
 * requires a child verdict.
 *
 * Run:  node probes/pattern-budget-probe.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const { testPattern, testPatternSync } = await import(pathToFileURL(path.join(PKG, 'lib', 'pattern-matcher.js')).href);

// Both ledger scopes are redirected before the first ledger call, so this probe never reads
// or writes the developer's real ledgers.
process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'patbudget-global-'));
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);
const SESSION = 'pattern-budget-probe';

const results = [];
const check = (id, claim, pass, evidence) => {
  results.push({ id, claim, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${id} ${claim}`);
  if (evidence !== undefined) console.log(`       ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`);
};
const turn = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = (tag) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `patbudget-${tag}-`));
  ledger.initLedger(dir, SESSION);
  return dir;
};

/** A pattern that genuinely backtracks, and a subject that genuinely makes it. No literal. */
const EVIL = '(a+)+$';
const LONG = `${'a'.repeat(200)}!`;

console.log('=== P1/P2: the bound fires, and it is the bound that decided ===');
{
  const started = Date.now();
  const result = testPatternSync(EVIL, LONG);
  const ms = Date.now() - started;
  console.log(`   testPatternSync('${EVIL}', 201-char subject) -> ${JSON.stringify(result)} in ${ms} ms`);
  check('P1', 'the bounded call returns fast on a pattern that backtracks catastrophically', ms < 5000, `elapsed ${ms} ms`);
  check('P2', 'the verdict did not come from an unbounded inline test', result.source !== 'inline', { source: result.source });
  check('P2b', 'no verdict yet means no match — it fails closed rather than guessing', result.matched === false, { matched: result.matched });
}
{
  // Information, not an assertion: is a child permitted in this channel at all?
  const probeChild = testPatternSync('zzz-never-matches', 'some ordinary subject');
  console.log(`   channel note: first-call source = ${probeChild.source}${probeChild.error === undefined ? '' : `, error=${probeChild.error}`}`);
}

console.log('\n=== P3: a normal pattern still matches (a bound that kills the feature is not a fix) ===');
{
  const first = testPatternSync('pnpm\\s+test', 'run pnpm test --filter lib');
  await turn(30); // let the pre-warm job land
  const second = testPatternSync('pnpm\\s+test', 'run pnpm test --filter lib');
  check('P3a', 'an ordinary recorded trigger matches once a verdict exists', second.matched === true, { first: first.source, second });
  const miss = testPatternSync('pnpm\\s+test', 'run pnpm build');
  await turn(30);
  const missAgain = testPatternSync('pnpm\\s+test', 'run pnpm build');
  check('P3b', 'and still does not match when it should not', missAgain.matched === false, missAgain);
  check('P3c', 'a proven pair is answered inline', second.source === 'inline' || missAgain.source === 'inline', {
    matchSource: second.source,
    missSource: missAgain.source,
  });
}

console.log('\n=== P4: the real brief({topic}) path, the one the audit hung ===');
{
  const dir = fixture('brief');
  const topic = `${'a'.repeat(200)}!`;
  const written = ledger.recordMistake(
    dir,
    {
      symptom: `fixture symptom carrying the topic ${topic}`,
      cause: 'fixture',
      fix: 'fixture',
      avoid: 'fixture rule',
      trigger: EVIL,
      files: 'lib/ledger.js',
    },
    SESSION,
  );
  const started = Date.now();
  const brief = ledger.brief(dir, { topic, session: SESSION, maxChars: 4000 });
  const ms = Date.now() - started;
  console.log(`   brief({topic: 201 chars}) -> ${ms} ms, ${String(brief?.text ?? '').length} chars`);
  check('P4a', 'brief() with a pathological recorded trigger and a long topic returns', ms < 5000, `elapsed ${ms} ms`);
  check(
    'P4b',
    'the fixture was really written and searched (so P4a is not vacuous)',
    typeof written.entry === 'string' && String(brief?.text ?? '').includes('fixture symptom carrying the topic'),
    { entryIsHeading: typeof written.entry === 'string', briefChars: String(brief?.text ?? '').length },
  );
}
{
  // The search must still *use* a trigger, not merely avoid hanging on one: a topic that the
  // pattern matches has to outrank a topic that only appears in prose.
  const dir = fixture('rank');
  ledger.recordMistake(
    dir,
    { symptom: 'measured claim about the flaky suite', cause: 'c', fix: 'f', avoid: 'a', trigger: 'pnpm\\s+testrun', files: 'x.js' },
    SESSION,
  );
  await testPattern('pnpm\\s+testrun', 'pnpm testrun'); // prove the pair cheap first
  await turn(30);
  const hit = ledger.brief(dir, { topic: 'pnpm testrun', session: SESSION, maxChars: 4000 });
  const proseOnly = ledger.brief(dir, { topic: 'measured claim', session: SESSION, maxChars: 4000 });
  console.log(`   trigger-topic brief: ${String(hit?.text ?? '').length} chars; prose-topic brief: ${String(proseOnly?.text ?? '').length} chars`);
  check(
    'P4c',
    'a trigger hit is still reachable through the topic search',
    String(hit?.text ?? '').includes('measured claim about the flaky suite'),
    { chars: String(hit?.text ?? '').length },
  );
}

console.log('\n=== P5: code_verify’s expect, and the `m` flag ===');
{
  await testPattern('^ok', 'all good\nok here', 'm');
  await turn(30);
  check('P5a', 're: still matches (with `m`, against a multi-line output)', ledger.matchesExpectation('all good\nok here', 're:^ok') === true);
  check('P5b', 're: still rejects', ledger.matchesExpectation('all good', 're:^ok$') === false);
  const started = Date.now();
  const bounded = ledger.matchesExpectation(`${'a'.repeat(200)}!`, `re:${EVIL}`);
  const ms = Date.now() - started;
  check('P5c', 'a pathological re: expectation is bounded instead of hanging the turn', ms < 5000, `elapsed ${ms} ms, verdict ${bounded}`);
  check('P5d', 'an uncompilable re: still falls back to substring, as before', ledger.matchesExpectation('a literal [unclosed', 're:[unclosed') === true);
  check('P5e', 'a plain string expectation is untouched', ledger.matchesExpectation('exit 0 ok', 'ok') === true && ledger.matchesExpectation('nope', 'ok') === false);
}

console.log('\n=== P6: the async path pit-guard uses is unchanged in contract ===');
{
  const started = Date.now();
  const settled = await testPattern(EVIL, LONG);
  const ms = Date.now() - started;
  check('P6a', 'testPattern still resolves (never rejects) on a runaway pattern', settled.matched === false, { ...settled, ms });
  const normal = await testPattern('pnpm\\s+test', 'run pnpm test');
  check('P6b', 'testPattern still matches a normal pattern', normal.matched === true, normal);
  const again = testPatternSync('pnpm\\s+test', 'run pnpm test');
  check('P6c', 'the async verdict marks the pair cheap for the sync path', again.source === 'inline' && again.matched === true, again);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length === 0 ? '' : ` — failed: ${JSON.stringify(failed.map((f) => f.id))}`}`);
// Write the verdict where `debt-audit.mjs` reads it. It spawns this probe with `stdio:'ignore'`,
// so stdout is unreachable to it; a probe with no report file is recorded as "no conclusion",
// which is how five *passing* probes once read as failures. `DSH_PROBE_REPORT` overrides the
// location for the Electron-style callers; the default name matches this file's stem.
const reportPath = typeof process.env.DSH_PROBE_REPORT === 'string' && process.env.DSH_PROBE_REPORT.length > 0
  ? process.env.DSH_PROBE_REPORT
  : path.join(os.tmpdir(), 'pattern-budget-report.json');
try {
  fs.writeFileSync(reportPath, JSON.stringify({ probe: 'pattern-budget', passed: results.length - failed.length, total: results.length, failed: failed.map((f) => f.id), skipped: [] }, null, 2));
} catch {
  /* a report that cannot be written must not turn a green probe red */
}
process.exit(failed.length === 0 ? 0 : 1);
