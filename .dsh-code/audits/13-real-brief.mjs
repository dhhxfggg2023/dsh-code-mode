/**
 * Audit probe 13 — read-only look at the REAL project's brief.
 *
 * Written because the audit's in-vivo `code_verify` calls put `ok:true` lines into this project's
 * journal, and `unverifiedExcerpt` (lib/ledger.js:1748) settles debts against the newest
 * non-claimed `ok:true` verification rather than against a proof that names the edited file. This
 * probe reads and prints; `brief()` does not write (lib/ledger.js:318-322).
 *
 * Run:  $env:ELECTRON_RUN_AS_NODE='1'; & '<install>\DeepSeek Harness.exe' .dsh-code/audits/13-real-brief.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { installResolution, PKG_DIR } from '../../probes/paths.mjs';

await installResolution();
const ledger = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'ledger.js')).href);

const brief = ledger.brief(PKG_DIR, { session: 'audit-13-readonly' });
const journal = ledger.readJournalText(PKG_DIR, 'project');
const lines = journal.split('\n').filter((l) => l.trim().length > 0).map((l) => {
  try {
    return JSON.parse(l);
  } catch {
    return { unparsed: l.slice(0, 80) };
  }
});
const verified = lines.filter((l) => l.kind === 'verified');
const unverified = lines.filter((l) => l.kind === 'unverified');
const newestOk = verified.filter((l) => l.ok === true && l.claimed !== true).at(-1);
const newestClaimed = verified.filter((l) => l.claimed === true).at(-1);

console.log('== the real project brief (read-only) ==');
console.log(`chars: ${brief.text.length}  omitted: ${JSON.stringify(brief.omitted ?? [])}`);
console.log(`sections: ${(brief.text.match(/^## .+$/gm) ?? []).map((s) => s.trim()).join(' | ')}`);
console.log('');
console.log(`journal lines: ${lines.length}  verified: ${verified.length}  unverified (debts): ${unverified.length}`);
console.log(`newest ok:true non-claimed verification: ${newestOk?.ts ?? '(none)'}  cmd: ${String(newestOk?.cmd ?? '').slice(0, 110)}`);
console.log(`  its cwd: ${newestOk?.cwd ?? '(none)'}`);
console.log(`newest claimed verification: ${newestClaimed?.ts ?? '(none)'}`);
console.log(`debts (unverified) with ts earlier than that watermark: ${unverified.filter((l) => newestOk !== undefined && String(l.ts) < String(newestOk.ts)).length}`);
for (const debt of unverified.slice(-4)) console.log(`  debt ${debt.ts} edits=${JSON.stringify(debt.edits)?.slice(0, 150)}`);
console.log('');
console.log(`does the brief show "## Turns that changed code and ran nothing"?  ${brief.text.includes('## Turns that changed code')}`);
console.log(`does the brief show "## Failing commands nobody wrote down"?        ${brief.text.includes('## Failing commands nobody wrote down')}`);
console.log(`does the brief name any unverified turn?                          ${/unverified|changed code/.test(brief.text)}`);

// What the *same* read reports if the newest ok:true line is ignored.
const okTs = verified.filter((l) => l.ok === true && l.claimed !== true).map((l) => String(l.ts));
const withoutProbe = ledger.brief(PKG_DIR, { session: 'audit-13-readonly-2' });
console.log('');
console.log(`unverified entries on disk (all): ${unverified.length}`);
console.log(`their ts range: ${unverified.map((l) => l.ts).sort()[0] ?? '-'} … ${unverified.map((l) => l.ts).sort().at(-1) ?? '-'}`);
console.log(`ok:true timestamps seen: ${okTs.join(', ')}`);
fs.writeFileSync(
  path.join(PKG_DIR, '.dsh-code', 'audits', 'report-13-real-brief.json'),
  `${JSON.stringify({ chars: brief.text.length, omitted: brief.omitted, sections: (brief.text.match(/^## .+$/gm) ?? []).map((s) => s.trim()), verifiedCount: verified.length, unverifiedCount: unverified.length, newestOk, debts: unverified.map((l) => ({ ts: l.ts, edits: l.edits })), secondReadChars: withoutProbe.text.length }, null, 2)}\n`,
  'utf8',
);
console.log('report: .dsh-code/audits/report-13-real-brief.json');
