/**
 * restart-gate-check — the read side of the 2026-10-05 restart gate.
 *
 * Written at the start of the session that follows the restart, because the four claims
 * this checks were all made *before* the restart and none of them had been observed on a
 * live host yet:
 *
 *   A. `- hard block: N` really refuses the second hit of the session (`trigger_block` in the journal).
 *   B. `DSH_CODE_PIT_HARD` is present in this process at all (the kill switch' s precondition).
 *   C. The machine ledger's retired family is gone (nunif / audit / screenshot / pip pits).
 *   D. `safe case` still travels as far as the notice text.
 *
 * It is a *reader*: it prints what the ledger and journal already hold and never writes.
 * `restart-gate-check` exists as a file rather than an inline `node -e` on purpose — this
 * package's own ledger hard-blocks the second inline `node -e` of a session, so an inline
 * checker would be refused by the very rule it is here to observe.
 *
 * Run: `node probes/restart-gate-check.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
// Resolved, not restated: this checker's headline is "journal events read: N", and against the
// wrong directories it printed 0 — a false negative for the very restart it exists to check.
const ledger = await import('../lib/ledger.js');
const journalDir = ledger.ledgerDir(repo);
const globalMistakes = path.join(ledger.globalDir(), 'mistakes.md');

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0);
}

function events() {
  return fs
    .readdirSync(journalDir)
    .filter((name) => name === 'journal.jsonl' || /^journal\..*\.jsonl$/.test(name))
    .sort()
    .flatMap((name) => readLines(path.join(journalDir, name)))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event !== null);
}

const all = events();
const out = [];
out.push(`# restart-gate-check — ${repo}`);
out.push(`journal events read: ${all.length} (segments: ${fs.readdirSync(journalDir).filter((n) => /^journal.*\.jsonl$/.test(n)).join(', ')})`);

// --- A. the refusal -------------------------------------------------------------------
const blocks = all.filter((event) => event.kind === 'trigger_block');
out.push('');
out.push(`## A. hard block / refusals: ${blocks.length} \`trigger_block\` event(s) in the journal`);
for (const event of blocks.slice(-6)) {
  out.push(`- ${event.at ?? event.ts ?? '(no timestamp)'} hits=${event.hits} declared=${event.declared} ${event.scope ?? ''} ${event.source ?? ''}`);
  out.push(`  heading: ${event.heading}`);
  if (event.command !== undefined) out.push(`  command: ${String(event.command).slice(0, 160)}`);
}
if (blocks.length === 0) out.push('- (none yet — the second hit of a `hard block:` entry has not happened this session)');
const lastAllow = [...all].reverse().find((event) => event.kind === 'trigger_hit' || event.kind === 'file_hit');
out.push(`- most recent ordinary hit (allow path): ${lastAllow === undefined ? '(none)' : `${lastAllow.kind} ${lastAllow.heading ?? ''}`}`);

// --- B. the kill switch' s precondition ------------------------------------------------
const hard = process.env.DSH_CODE_PIT_HARD;
out.push('');
out.push(`## B. DSH_CODE_PIT_HARD in this process: ${hard === undefined ? '(unset — every hard block is armed)' : JSON.stringify(hard)}`);
out.push(`- kill switch ${hard === '0' ? 'IS ON: nothing can refuse' : 'is off: blocks are live'}`);

// --- C. the machine ledger' s retired family -------------------------------------------
const retired = /nunif|screenshot|截图|pip\s+install|\baudit\b/i;
const text = fs.existsSync(globalMistakes) ? fs.readFileSync(globalMistakes, 'utf8') : '';
const headings = text.split(/\n## /).slice(1).map((block) => block.split('\n')[0]);
const stillThere = headings.filter((heading) => retired.test(heading));
out.push('');
out.push(`## C. machine ledger: ${headings.length} entries (${globalMistakes})`);
out.push(`- entries still matching the retired family (nunif/audit/screenshot/pip): ${stillThere.length}`);
for (const heading of stillThere) out.push(`  - ${heading}`);
out.push(`- the code_brief machine section is built from this file; ${headings.length} entries is what it selects from`);

// --- D. `safe case` is on disk and reachable -------------------------------------------
const projectMistakes = path.join(journalDir, 'mistakes.md');
const projectText = fs.existsSync(projectMistakes) ? fs.readFileSync(projectMistakes, 'utf8') : '';
const safeCases = (projectText.match(/^- safe case[^\n]*/gm) ?? []);
const inflected = (projectText.match(/^- 安全情形[^\n]*/gm) ?? []);
out.push('');
out.push(`## D. safe-case lines on disk`);
out.push(`- project \`- safe case:\` lines: ${safeCases.length}`);
for (const line of safeCases) out.push(`  ${line.replace(/\s+/g, ' ').slice(0, 150)}`);
out.push(`- project \`- 安全情形\` lines (same idea, Chinese label): ${inflected.length}`);
out.push(`- reading side: lib/pit-guard.js reads \`field('safe case/安全情形')\` and accepts an optional full-width parenthetical aside plus an ASCII or full-width colon before the value.`);
out.push(`- **the verdict on whether a line reaches a notice is not in this file** — run \`node probes/safe-case-parse.mjs\`, which calls the guard's own reader (\`entryField()\` in \`lib/entry-fields.js\`) on these lines and reports how many it can read (measured 2026-10-10: 4 of 4 project, 7 of 7 machine).`);
out.push(`- the running host still has the pre-fix parser until DSH restarts, so a notice seen in this session may not carry the line yet.`);

console.log(out.join('\n'));
