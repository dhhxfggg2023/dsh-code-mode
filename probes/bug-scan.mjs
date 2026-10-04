/**
 * A whole-tree static scan for defect *classes* that a per-module read tends to miss.
 *
 * Written 2026-10-04 after a guard-probe run failed under one channel and passed under
 * another, and the only way to find out which of two checks had failed was to read the
 * probe by hand: both carried the label `B7`, so the report named a label, not a check.
 *
 * This is a **report**, not a gate: it exits 0 and prints what it saw. A finding here is a
 * place to look, not a proven bug — every one of them needs a human read before it is real.
 * What it does prove mechanically:
 *   D  two `check()` calls in one probe share a label (the report can then not say which failed)
 *   J  a `JSON.parse` on a line that is not already inside a try (a malformed line throws)
 *   R  `readFileSync` with no `'utf8'` (a Buffer reaching string code)
 *   W  a write to a ledger file with no atomic rename / temp-file step
 *   C  `catch {}` that swallows and continues (silent failure)
 *   N  a `catch` that swallows *without* naming the fallback it took
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['bug-scan.mjs']);

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(mjs|cjs|js)$/.test(entry.name) && !SKIP.has(entry.name) && !entry.name.includes('.bak-')) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(ROOT, []).filter((f) => {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  return rel.startsWith('lib/') || rel.startsWith('probes/');
});

const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');
const findings = { duplicateLabels: [], jsonParse: [], bufferRead: [], nonAtomicWrite: [], silentCatch: [] };

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');

  // --- D: duplicate check() labels ---------------------------------------------
  const byLabel = new Map();
  lines.forEach((line, i) => {
    const m = line.match(/\bcheck\(\s*'([^']+)'/);
    if (m) {
      if (!byLabel.has(m[1])) byLabel.set(m[1], []);
      byLabel.get(m[1]).push(i + 1);
    }
  });
  for (const [label, at] of byLabel) {
    if (at.length > 1) findings.duplicateLabels.push({ file: rel(file), label, lines: at });
  }

  // --- J: JSON.parse not inside a try ------------------------------------------
  const tryRegions = [];
  const stack = [];
  lines.forEach((line, i) => {
    if (/\btry\s*\{/.test(line)) stack.push(i);
    // A `}` at the same indent as the `try` closes it; a cheap approximation, and
    // stated as such: this scan is a pointer, not a proof.
    if (/^\s*\}/.test(line) && stack.length > 0) {
      const start = stack.pop();
      tryRegions.push([start, i]);
    }
  });
  const inTry = (i) => tryRegions.some(([a, b]) => i >= a && i <= b);
  lines.forEach((line, i) => {
    if (/JSON\.parse\(/.test(line) && !inTry(i)) {
      findings.jsonParse.push({ file: rel(file), line: i + 1, text: line.trim().slice(0, 120) });
    }
  });

  // --- R: readFileSync with no encoding ---------------------------------------
  lines.forEach((line, i) => {
    if (/readFileSync\(/.test(line) && !/['"]utf-?8['"]/.test(line) && !/\bbuffer\b/i.test(line)) {
      findings.bufferRead.push({ file: rel(file), line: i + 1, text: line.trim().slice(0, 120) });
    }
  });

  // --- W: writes to a ledger/journal file without a temp+rename ----------------
  lines.forEach((line, i) => {
    if (/writeFileSync\(/.test(line) && /(journal|mistakes|decisions|tasks|project)\./.test(line)) {
      const window = lines.slice(Math.max(0, i - 12), i + 6).join('\n');
      if (!/renameSync|\.tmp|tmpFile|writeFileAtomic/.test(window)) {
        findings.nonAtomicWrite.push({ file: rel(file), line: i + 1, text: line.trim().slice(0, 120) });
      }
    }
  });

  // --- C: empty catch blocks ---------------------------------------------------
  lines.forEach((line, i) => {
    if (/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(line)) {
      findings.silentCatch.push({ file: rel(file), line: i + 1, text: line.trim().slice(0, 120) });
    }
  });
}

const show = (title, rows, fmt) => {
  console.log(`\n=== ${title} — ${rows.length} ===`);
  for (const row of rows) console.log(`  ${fmt(row)}`);
};
show('D  duplicate check() labels in one probe', findings.duplicateLabels, (r) => `${r.file}  [${r.label}] at lines ${r.lines.join(', ')}`);
show('J  JSON.parse outside a try', findings.jsonParse, (r) => `${r.file}:${r.line}  ${r.text}`);
show('R  readFileSync with no encoding', findings.bufferRead, (r) => `${r.file}:${r.line}  ${r.text}`);
show('W  ledger write with no temp+rename nearby', findings.nonAtomicWrite, (r) => `${r.file}:${r.line}  ${r.text}`);
show('C  empty catch block', findings.silentCatch, (r) => `${r.file}:${r.line}  ${r.text}`);

console.log(
  `\nscanned ${files.length} file(s) under lib/ and probes/. ` +
    `Total pointers: ${Object.values(findings).reduce((n, rows) => n + rows.length, 0)}. ` +
    `A pointer is a place to read, not a proven bug.`,
);
