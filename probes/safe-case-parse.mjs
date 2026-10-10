/**
 * safe-case-parse — does any ledger line actually reach the guard as a `safe case`?
 *
 * Why this exists (2026-10-06): the restart gate promised that a triggered pit would show
 * `- **safe case (check this first):** …` so a reader could settle "matched but safe" in one
 * step. Two `- safe case（…）：…` lines do exist in the machine ledger and one
 * `- 安全情形（…）：…` line exists in the project ledger — and none of them were ever shown.
 *
 * The cause is a label mismatch, and the point of this file is to *measure* it against the
 * real parser instead of reading the regex and assuming. It imports nothing from the package:
 * it applies `lib/pit-guard.js`'s own field expression to each real line of both ledgers and
 * additionally tests the label shapes the ledgers actually use, so the gap is a printed
 * before/after rather than a claim about a regex.
 *
 * Run: `node probes/safe-case-parse.mjs`
 *
 * **Superseded for the verdict by `probes/safe-case-live.mjs` (same day).** This file rebuilds
 * the guard's expression from a captured template literal, and that round trip is lossy for
 * backslashes: it went on reporting `no match` for every shape, including the one the guard
 * itself asks for, while the parser in `lib/pit-guard.js` was in fact reading all four real
 * safe-case lines. `safe-case-live.mjs` spells the expression exactly as the source does and
 * reports `4 of 4`. Keep this file for the per-spelling breakdown; take the verdict from the
 * other one.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
// Resolved, not restated: the parser that proves safe-cases are readable read zero entries
// after the ledger moved (a migrated project's ledger is in the store, and the machine ledger
// left `~/.dsh-code` on 2026-10-10) — so it was green about nothing.
const ledger = await import('../lib/ledger.js');
const files = [
  { label: 'project', file: ledger.ledgerPath(repo, 'mistakes') },
  { label: 'machine', file: path.join(ledger.globalDir(), 'mistakes.md') },
];

/**
 * The expression as `lib/pit-guard.js` applies it, read **out of that file** rather than
 * restated here.
 *
 * This is the whole point of the probe and the first version got it wrong: it hardcoded
 * `^- <label>: (.*)$`, so after the parser was widened to accept the full-width spellings
 * the probe went on reporting `IGNORED` for every real line — it was measuring its own copy
 * of the regex, not the guard's. A reader that carries its own copy of the rule it is
 * checking cannot report that the rule changed. (Same defect as `gate-chance.mjs` hardcoding
 * the gate ratios while `cordis.patch.yml` declared different ones — the plan calls it out in
 * §9, and this is the second occurrence.)
 */
function guardFieldExpression(file = path.join(repo, 'lib', 'pit-guard.js')) {
  const source = fs.readFileSync(file, 'utf8');
  // `const match = new RegExp(\`...\`, 'm').exec(block);` — capture the template literal.
  const found = /const match = new RegExp\(`([^`]+)`,\s*'m'\)/.exec(source);
  if (found === null) throw new Error(`no field() expression found in ${file} — the probe cannot measure what it cannot read`);
  return found[1];
}

const guardExpression = guardFieldExpression();
/** Apply the guard's own expression with the labels it is asked for at each call site. */
const guardField = (labels) => {
  const tried = String(labels).split('/').map((label) => {
    const pattern = guardExpression.replaceAll('${label}', label);
    return { label, re: new RegExp(pattern, 'm') };
  });
  return (block) => {
    for (const { re } of tried) {
      const match = re.exec(block);
      if (match !== null && match[1].trim().length > 0) return match[1].trim();
    }
    return undefined;
  };
};

const readSafeCase = guardField('safe case/安全情形');

/** Candidate label spellings: what the ledgers contain, and what the guard asks for. */
const shapes = [
  { name: 'guard call site: "safe case/安全情形" + ASCII colon', labels: 'safe case/安全情形' },
  { name: 'ledger: "safe case" + full-width parens', labels: 'safe case' },
  { name: 'ledger: Chinese label 安全情形', labels: '安全情形' },
];

const out = [];
out.push('# safe-case-parse — which ledger lines the guard can actually read');

for (const { label, file } of files) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = text.split('\n');
  out.push('');
  out.push(`## ${label}: ${file}`);
  out.push(`- lines: ${lines.length} · bytes: ${text.length}`);

  // What real lines exist that *look* like a safe case to a human reader, and whether the
  // guard's own reader — applied to the line itself, not to a stand-in — gets a value out.
  const humanReadable = lines.filter((line) => /^-\s*(safe case|安全情形)/.test(line));
  out.push(`- lines a human would call a safe case: ${humanReadable.length}`);
  for (const line of humanReadable) {
    const captured = readSafeCase(line);
    out.push(`    ${captured === undefined ? 'IGNORED' : 'PARSES '} │ ${line.replace(/\s+/g, ' ').slice(0, 110)}`);
    if (captured !== undefined) out.push(`             → ${captured.slice(0, 90)}`);
  }

  // The guard's own expression against each spelling a ledger might use.
  for (const shape of shapes) {
    const probe = `- ${shape.labels.split('/')[0]}: A BODY A HUMAN WOULD NEED TO READ`;
    const reader = guardField(shape.labels);
    const captured = reader(probe);
    out.push(`- ${captured === undefined ? 'no match  ' : 'MATCH     '} ${shape.name}`);
  }

  // How many entries the guard can actually read a safe case from, using its own reader.
  const blocks = text.split(/\n(?=## )/).filter((block) => block.startsWith('## '));
  const withSafe = blocks.filter((block) => /^-\s*(safe case|安全情形)/m.test(block));
  const readable = blocks.filter((block) => readSafeCase(block) !== undefined);
  out.push(`- entries carrying a safe case in any spelling: ${withSafe.length} of ${blocks.length}`);
  out.push(`- entries the guard can read one from: **${readable.length}** of ${withSafe.length}`);
}

out.push('');
out.push('## reading');
out.push(`- the expression under test is lifted from \`lib/pit-guard.js\`: \`${guardExpression}\``);
out.push('- a line is `PARSES` when the guard\'s own reader returns a value for it. `IGNORED` means the safe case is written down for humans and never reaches a notice.');
out.push('- this probe carried its own copy of the expression in its first version, so it kept reporting `IGNORED` after the parser was widened. A reader that restates the rule it checks cannot report that the rule changed.');
out.push('- the range of accepted spellings: ASCII colon, full-width colon `：`, an optional parenthetical aside `（…）`, and the Chinese label 安全情形. Anything else is still ignored, and the count above is how a reader finds out.');

console.log(out.join('\n'));
