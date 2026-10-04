/**
 * Probe — what a pit's heading is an identity *for*.
 *
 * The ledger-core audit (2026-10-04, F6) measured two ways the heading merged things that are
 * not the same pit: `.slice(0, 60)` truncated it, and any symptom outside `[a-z0-9\u4e00-\u9fff]`
 * reduced to nothing and got the shared fallback slug `mistake`. In both cases the second pit
 * was folded into the first, its `do not repeat:` rule never reached `mistakes.md`, and a topic
 * search for its own words found nothing.
 *
 * The fix appends a digest of the whole input whenever the slug would otherwise be lossy. That
 * cure has its own failure mode, which is why this probe is not a copy of audit probe 04: a
 * heading is ALSO the key a genuine repeat merges on, so if identity becomes *too* exact then
 * re-describing a pit appends a duplicate instead of incrementing `recurred:` — the exact way a
 * ledger becomes unreadable, and the reason the merge exists at all. So:
 *
 *   R1  the same symptom twice still MERGES — the feature the fix could have broken
 *   R2  unrelated pits that share a slug prefix no longer merge, and the second one's rule is
 *       in the file and reachable
 *   R3  a non-Latin symptom gets its own stable identity instead of the shared fallback
 *   R4  a reworded repeat is NOT silently folded away, and the writer is told which entry it
 *       looks like (the honest middle between merging everything and merging nothing)
 *   R5  an input that fits in the slug keeps the old slug exactly, so every existing heading,
 *       task id and search term still resolves
 *   R6  the advisory is folded into `summary` — never returned as a key of its own, because
 *       `output.schema` has `additionalProperties: false` and the rejection lands after the write
 *
 * Run:  node probes/repeat-identity-probe.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
process.env.DSH_CODE_GLOBAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'repeatid-global-'));
const ledger = await import(pathToFileURL(path.join(PKG, 'lib', 'ledger.js')).href);
const SESSION = 'repeat-identity-probe';

const results = [];
const check = (id, claim, pass, evidence) => {
  results.push({ id, claim, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${id} ${claim}`);
  if (evidence !== undefined) console.log(`       ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`);
};
const fixture = (tag) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `repeatid-${tag}-`));
  ledger.initLedger(dir, SESSION);
  return dir;
};
const mistakes = (dir) => fs.readFileSync(path.join(dir, '.dsh-code', 'mistakes.md'), 'utf8');
const headings = (text) => text.split('\n').filter((line) => line.startsWith('## '));

console.log('=== R1: a genuine repeat still merges (the feature the fix could have broken) ===');
{
  const dir = fixture('repeat');
  const pit = {
    symptom: 'pnpm test fails on a clean checkout because the lockfile is stale',
    cause: 'lockfile out of date',
    fix: 'pnpm install',
    avoid: 'never trust a lockfile you did not regenerate',
    files: 'package.json',
  };
  const first = ledger.recordMistake(dir, pit, SESSION);
  const second = ledger.recordMistake(dir, pit, SESSION);
  console.log(`   first merged=${first.merged} recurred=${first.recurred}; second merged=${second.merged} recurred=${second.recurred}`);
  check('R1a', 'the same symptom recorded twice merges instead of appending', second.merged === true, second);
  check('R1b', 'and the recurred count is 1 (not 0, not 2)', second.recurred === 1, { recurred: second.recurred });
  check('R1c', 'the file holds exactly one entry for it', headings(mistakes(dir)).length === 1, { headings: headings(mistakes(dir)) });
}

console.log('\n=== R2: unrelated pits sharing a slug prefix stay separate, and both rules are readable ===');
{
  const dir = fixture('prefix');
  const base = 'guarded operation reports failure while writing the very long ledger entry';
  const a = ledger.recordMistake(dir, { symptom: `${base} -- variant ALPHA`, cause: 'alpha cause', fix: 'alpha fix', avoid: 'alpha rule kept', files: 'lib/a.js' }, SESSION);
  const b = ledger.recordMistake(dir, { symptom: `${base} -- variant BRAVO`, cause: 'bravo cause', fix: 'bravo fix', avoid: 'bravo rule kept', files: 'lib/b.js' }, SESSION);
  const text = mistakes(dir);
  check('R2a', 'the second pit did not merge into the first', a.merged === false && b.merged === false, { a: a.merged, b: b.merged });
  check('R2b', 'both rules are in mistakes.md', text.includes('alpha rule kept') && text.includes('bravo rule kept'));
  check('R2c', 'both entries exist', headings(text).length === 2, { headings: headings(text) });
}

console.log('\n=== R3: a non-Latin symptom gets its own identity, stably ===');
{
  const dir = fixture('cyrillic');
  const one = ledger.recordMistake(
    dir,
    { symptom: 'Ошибка при сборке проекта: сборка не начинается', cause: 'tsc не найден в PATH', fix: 'прописать путь', avoid: 'never rely on a global tsc: pin it in devDependencies', files: 'package.json' },
    SESSION,
  );
  const two = ledger.recordMistake(
    dir,
    { symptom: 'Установка падает при запуске сервера', cause: 'two plugins require different ranges', fix: 'align the ranges', avoid: 'never install two plugins with disjoint peer ranges', files: 'cordis.patch.yml' },
    SESSION,
  );
  const again = ledger.recordMistake(
    dir,
    { symptom: 'Ошибка при сборке проекта: сборка не начинается', cause: 'tsc не найден в PATH', fix: 'прописать путь', avoid: 'never rely on a global tsc: pin it in devDependencies', files: 'package.json' },
    SESSION,
  );
  const text = mistakes(dir);
  console.log(`   entry one: ${one.entry}\n   entry two: ${two.entry}\n   repeat of one: merged=${again.merged}`);
  check('R3a', 'two unrelated non-Latin pits get different headings', one.entry !== two.entry, { one: one.entry, two: two.entry });
  check('R3b', 'the second pit is really in the file', text.includes('disjoint peer ranges'));
  check('R3c', 'the same non-Latin symptom still merges on its own heading', again.merged === true, { merged: again.merged, recurred: again.recurred });
  check('R3d', 'the heading is not the bare fallback word', !/· mistake$/.test(one.entry), { entry: one.entry });
}

console.log('\n=== R4: a reworded repeat is reported, not folded away and not silent ===');
{
  const dir = fixture('reworded');
  ledger.recordMistake(
    dir,
    { symptom: 'the ledger write fails with EPERM when another process holds the file open', cause: 'no lock', fix: 'take the lock', avoid: 'never give a read-modify-write its own write primitive', files: 'lib/ledger.js' },
    SESSION,
  );
  const reworded = ledger.recordMistake(
    dir,
    { symptom: 'the ledger write fails with EPERM when another process holds the file open!!', cause: 'no lock', fix: 'take the lock', avoid: 'route both writers through one lock', files: 'lib/ledger.js' },
    SESSION,
  );
  console.log(`   reworded -> merged=${reworded.merged}, hint=${JSON.stringify(String(reworded.repeatHint ?? '').slice(0, 120))}`);
  check('R4a', 'a differently punctuated repeat is still written (nothing is folded away silently)', reworded.merged === false);
  check('R4b', 'and the writer is told which entry it looks like', typeof reworded.repeatHint === 'string' && reworded.repeatHint.includes('recurred:'), { hint: reworded.repeatHint });
  check('R4c', 'both entries are present, so no rule was lost', headings(mistakes(dir)).length === 2);
}

console.log('\n=== R5: an input that fits keeps the old slug exactly (backward compatibility) ===');
{
  const cases = [
    ['pnpm test fails on a clean checkout', 'pnpm-test-fails-on-a-clean-checkout'],
    ['重启 DSH 后缓存整段失效', '重启-dsh-后缓存整段失效'],
    ['winpty mangles the pipe', 'winpty-mangles-the-pipe'],
  ];
  const wrong = cases.filter(([input, expected]) => ledger.slug(input) !== expected);
  check('R5', 'short ASCII/CJK slugs are byte-identical to the previous implementation', wrong.length === 0, { wrong });
  check('R5b', 'a task id built from a short title still matches the old shape', /^\d{4}-\d{2}-\d{2}-winpty-mangles-the-pipe$/.test(`${ledger.today()}-${ledger.slug('winpty mangles the pipe')}`), {
    id: `${ledger.today()}-${ledger.slug('winpty mangles the pipe')}`,
  });
}

console.log('\n=== R6: the advisory rides in `summary`, never as a key of its own ===');
{
  const source = fs.readFileSync(path.join(PKG, 'lib', 'tool-record.js'), 'utf8');
  const returned = [...source.matchAll(/return Promise\.resolve\(\{([^}]*)\}\)/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
  console.log(`   returned key sets: ${JSON.stringify(returned)}`);
  const bad = returned.filter((keys) => /notice|repeatHint/.test(keys));
  check('R6a', 'no handler returns `notice` or `repeatHint` as a property', bad.length === 0, { bad });
  const declared = [...source.matchAll(/^\s{4,}(\w+): \{/gm)].map((m) => m[1]);
  console.log(`   declared output properties seen in the file: ${JSON.stringify([...new Set(declared)])}`);
  check('R6b', 'repeatHint is fed into the summary array', /written\.repeatHint/.test(source));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length === 0 ? '' : ` — failed: ${JSON.stringify(failed.map((f) => f.id))}`}`);
process.exit(failed.length === 0 ? 0 : 1);
