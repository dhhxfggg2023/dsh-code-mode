/**
 * Ledger census: how much is in the ledgers, and how much of it the brief can show.
 *
 * Written 2026-10-03 to size the design instead of guessing at it. The briefing has a
 * fixed budget (`UNCAPPED_TOTAL` 8900 characters across all sections) while both ledgers
 * grow without bound, so the useful question is not "is it big" but "how many entries
 * exist, how long is each, and what fraction can ever be displayed".
 *
 * Reads only; writes nothing; plain node.
 *
 * Usage: node probes/ledger-census.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The census counts entries in *the* ledgers, so it asks where they are instead of assuming:
// `<repo>/.dsh-code` is empty for a migrated project and `~/.dsh-code` was retired on
// 2026-10-10, and this instrument reported 0 entries in both scopes while saying nothing
// about the directories it had actually read.
import { globalDir, ledgerDir } from '../lib/ledger.js';

const GLOBAL_DIR = globalDir();
const PROJECT_DIR = ledgerDir(process.cwd());

const entries = (file) => {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\n(?=## )/)
      .map((block) => block.trim())
      .filter((block) => block.startsWith('## '));
  } catch {
    return [];
  }
};

const field = (block, label) => new RegExp(`^- ${label}: (.*)$`, 'm').exec(block)?.[1]?.trim();

function census(label, dir) {
  const mistakes = entries(path.join(dir, 'mistakes.md'));
  const decisions = entries(path.join(dir, 'decisions.md'));
  const project = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
    } catch {
      return {};
    }
  })();
  const factKeys = Object.keys(project).filter((key) => !['version', 'createdAt', 'updatedAt'].includes(key));
  const total = mistakes.reduce((sum, block) => sum + block.length + 2, 0);
  const again = mistakes.map((block) => block.length + 2);
  const ranked = [...again].sort((a, b) => b - a);
  const triggerCount = mistakes.filter((block) => field(block, 'trigger') !== undefined).length;
  const filesCount = mistakes.filter((block) => field(block, 'files') !== undefined).length;
  console.log(`\n=== ${label}  ${dir}`);
  console.log(`mistake entries      : ${mistakes.length}  (${total} chars, mean ${mistakes.length === 0 ? 0 : Math.round(total / mistakes.length)}, longest ${ranked[0] ?? 0})`);
  console.log(`  with trigger:      : ${triggerCount}`);
  console.log(`  with files:        : ${filesCount}`);
  console.log(`decision entries     : ${decisions.length}  (${decisions.reduce((sum, block) => sum + block.length + 2, 0)} chars)`);
  console.log(`machine fact keys    : ${factKeys.length} ${factKeys.length > 0 ? `(${factKeys.join(', ')})` : ''}`);
  const indexLine = (block) => {
    const heading = block.split('\n', 1)[0].slice(3).trim();
    const trigger = field(block, 'trigger');
    return `- ${heading}${trigger === undefined ? '' : ` [trigger: ${trigger}]`}`;
  };
  const indexChars = mistakes.reduce((sum, block) => sum + indexLine(block).length + 1, 0);
  console.log(`one-line index cost  : ${indexChars} chars for all ${mistakes.length} (proportional part ${mistakes.length === 0 ? 0 : Math.round(indexChars / mistakes.length)}/entry)`);
  console.log(`brief budget         : 8900 chars across every section; machine section ceiling 1100, mistakes ceiling 1400`);
}

census('PROJECT', PROJECT_DIR);
census('GLOBAL ', GLOBAL_DIR);

const journal = path.join(PROJECT_DIR, 'journal.jsonl');
try {
  const lines = fs.readFileSync(journal, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  const kinds = new Map();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
    } catch {
      /* torn line */
    }
  }
  console.log(`\njournal lines: ${lines.length} ${JSON.stringify(Object.fromEntries([...kinds.entries()].sort((a, b) => b[1] - a[1])))}`);
  console.log(`journal bytes: ${fs.statSync(journal).size}`);
} catch {
  console.log('\njournal: missing');
}
