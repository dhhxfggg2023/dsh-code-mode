/**
 * field-regex-trace — print the exact characters of the guard's field expression.
 *
 * Written 2026-10-06 while fixing the `safe case` label mismatch, because the probe that was
 * supposed to make the fix observable reported `no match` on every shape *including* the
 * shape the guard itself asks for. Two candidates had to be told apart and a console echo
 * cannot do it:
 *
 *   1. the expression lifted out of `lib/pit-guard.js` is not the expression the guard runs
 *      (extraction bug), or
 *   2. the expression is right and the probe assembles it wrongly (`${label}` substitution).
 *
 * Both are string-shape questions, so this prints the string as `JSON.stringify` shows it —
 * one backslash stays one backslash, where a template echo would silently turn `\\s` into
 * `\\\\s` and make a correct pattern *look* wrong. It also runs the assembled pattern against
 * one real ledger line per shape, so a verdict comes with the input that produced it.
 *
 * Run: `node probes/field-regex-trace.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(repo, 'lib', 'pit-guard.js'), 'utf8');

// The exact assignment, shown raw so the extraction can be judged instead of trusted.
const assignment = /const match = new RegExp\([^\n]*?\n?[^\n]*?exec\(block\)/.exec(source)?.[0] ?? '(not found)';
const literal = /new RegExp\(`([^`]*)`/.exec(source)?.[1];

console.log('# field-regex-trace');
console.log('## the assignment as it stands in lib/pit-guard.js');
// Printed as character codes, not through a string escaper.
//
// `JSON.stringify` is what this probe used first, and it is why this probe was wrong: a
// correct pattern holding one backslash (`\s`) serialises as `"\\\\s"` — four backslashes —
// which reads as a pattern holding two, i.e. as a bug. That false reading sent me to "fix" a
// line of source that was already right. Backslash count is the whole question here, so the
// answer must not pass through an escaper.
const codes = (text) =>
  [...text]
    .map((char) => {
      const code = char.codePointAt(0);
      if (char === '\\') return 'BACKSLASH';
      if (code < 0x20) return `U+${code.toString(16).padStart(4, '0')}`;
      return char;
    })
    .join(' ');
console.log(`- backslashes in the whole assignment: ${(assignment.match(/\\/g) ?? []).length}`);
console.log('- character codes:');
console.log(`  ${codes(assignment)}`);
console.log('');
console.log('## the template literal lifted out of it');
console.log(`- length: ${literal?.length}`);
console.log(`- backslashes: ${(literal?.match(/\\/g) ?? []).length}`);
console.log(`- contains the substitution token: ${literal?.includes('${label}')}`);
console.log(`- character codes: ${codes(literal ?? '')}`);

// Resolved: this diagnostic is what you reach for when a field regex misbehaves, and the
// machine ledger left `~/.dsh-code` on 2026-10-10 — it was reading a directory that is gone.
const machineFile = path.join((await import('../lib/ledger.js')).globalDir(), 'mistakes.md');
const realLine = fs
  .readFileSync(machineFile, 'utf8')
  .split('\n')
  .find((line) => line.startsWith('- safe case')) ?? '(no real line found)';
console.log('');
console.log('## one real ledger line, character-exact');
console.log(JSON.stringify(realLine.slice(0, 120)));

for (const label of ['safe case', '安全情形']) {
  const pattern = literal.replaceAll('${label}', label);
  console.log('');
  console.log(`## label ${JSON.stringify(label)}`);
  console.log(`- pattern: ${JSON.stringify(pattern)}`);
  let re;
  try {
    re = new RegExp(pattern, 'm');
  } catch (error) {
    console.log(`- COMPILE FAILED: ${error.message}`);
    continue;
  }
  const match = re.exec(realLine);
  console.log(`- against the real line: ${match === null ? 'NO MATCH' : `MATCH → ${JSON.stringify(match[1].slice(0, 70))}`}`);
}
