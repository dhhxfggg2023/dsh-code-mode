/**
 * Brief shape: what a briefing actually costs, in full entries and index lines.
 *
 * Written 2026-10-03 so the bound can be inspected instead of argued about. The
 * question this answers: on the real ledgers, how much of the brief is full text,
 * how much is one-line index, and what fraction of the ledger is reachable at all?
 *
 * Reads only; plain node.
 *
 * Usage: node probes/brief-shape.mjs [--chars N] [--topic TEXT]
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const maxChars = Number(flag('--chars') ?? 4000);
const topic = flag('--topic');

const ledger = await import(pathToFileURL(path.join(process.cwd(), 'lib', 'ledger.js')).href);
const root = process.cwd();
const result = ledger.brief(root, { maxChars, session: 'brief-shape', topic });

const counts = (text) => ({
  fullEntries: (text.match(/^## /gm) ?? []).length,
  indexLines: (text.match(/^- \[/gm) ?? []).length,
  sectionChars: text.length,
});
const section = (text, heading) => {
  const at = text.indexOf(heading);
  if (at < 0) return undefined;
  const rest = text.slice(at + heading.length);
  const next = rest.search(/\n\n## |\n\n… \(|\n\nThis brief is a selection/);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
};

console.log(`chars: ${result.text.length} / ${maxChars} budget (hard bound holds: ${result.text.length <= maxChars})`);
console.log(`omittedSections: ${JSON.stringify(result.omitted)}`);
for (const heading of ['## Known mistakes', '## Recent decisions', '## Machine-wide facts (true of this host, every project)']) {
  const body = section(result.text, heading);
  if (body === undefined) {
    console.log(`\n${heading}\n  (absent)`);
    continue;
  }
  const c = counts(body);
  console.log(`\n${heading}\n  ${c.sectionChars} chars, ${c.fullEntries} full entr(ies), ${c.indexLines} index line(s)`);
  console.log(`  first line: ${body.split('\n')[0].slice(0, 120)}`);
}
const hint = result.text.split('\n').find((line) => line.startsWith('This brief is a selection'));
console.log(`\ndiscovery line:\n  ${hint ?? '(missing — nothing tells the reader the rest exists)'}`);
if (topic !== undefined) {
  console.log(`\nquery "${topic}" -> ${/## /.test(result.text) ? 'entries returned' : 'nothing'}`);
  console.log(result.text.slice(0, 600));
}
