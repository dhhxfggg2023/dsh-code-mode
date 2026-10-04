/**
 * Where did the index lines go?
 *
 * Written 2026-10-03, after `brief-shape.mjs` showed every section rendering exactly one
 * full entry and zero index lines on the real ledgers — a briefing that bounds itself by
 * showing one entry and hiding 106 with no way to ask is the failure this work exists to
 * remove, so the arithmetic is printed rather than reasoned about.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ledger = await import(pathToFileURL(path.join(process.cwd(), 'lib', 'ledger.js')).href);
const root = process.cwd();

for (const maxChars of [4000, 6000, 8900, 12000]) {
  const result = ledger.brief(root, { maxChars, session: 'index-diag' });
  const lines = result.text.split('\n');
  console.log(
    `maxChars ${String(maxChars).padStart(5)} -> text ${String(result.text.length).padStart(5)}  indexLines ${lines.filter((l) => l.startsWith('- [')).length}  fullHeadings ${lines.filter((l) => l.startsWith('## ')).length}`,
  );
}

// The sections' own allowances, read out of the same allocation the briefing uses.
const probe = ledger.brief(root, { maxChars: 4000, session: 'index-diag' });
const mistakesHeading = '## Known mistakes';
const at = probe.text.indexOf(mistakesHeading);
console.log(`\nmistakes section starts at ${at}`);
const body = probe.text.slice(at + mistakesHeading.length).split('\n\n')[0];
console.log(`body chars ${body.length}`);
console.log(body.split('\n').slice(0, 6).join('\n'));
