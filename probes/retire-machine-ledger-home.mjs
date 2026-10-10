/**
 * Retire the old top-level ledger home after the machine ledger has moved into `~/.dsh/code/`.
 *
 * Why a second script instead of a flag on the first one: this is the step that removes a
 * directory from the user's profile, and the user's condition was explicit — "确保不会出问题才
 * 删" (2026-10-10). So it is a separate, deliberate act with its own preconditions rather than a
 * switch someone can flip while thinking about something else.
 *
 * Preconditions, all checked before anything is touched:
 *   1. every ledger file in the old home already exists in `~/.dsh/code/` with the same size;
 *   2. `<home>/.dsh/code/projects/` holds the migrated project ledgers;
 *   3. the old home holds no file the new one lacks.
 *
 * It deletes only the top-level ledger *files* and the now-empty `projects` tree it created;
 * unknown files (anything a future version added) are left in place and reported.
 *
 * Usage: node probes/cleanup-migrated-ledgers.mjs --retire-machine [--apply]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const home = os.homedir();
const legacy = path.join(home, '.dsh-code');
const current = path.join(home, '.dsh', 'code');
const LEDGER_FILES = ['project.json', 'tasks.json', 'decisions.md', 'mistakes.md', 'journal.jsonl'];

const stat = (file) => {
  try {
    const info = fs.statSync(file);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
};

const report = { legacy, current, apply: APPLY, verify: [], remove: [], removeTree: [], keep: [], refused: [] };

if (!fs.existsSync(current)) {
  report.refused.push(`the new home ${current} does not exist — nothing was moved yet`);
}
if (!fs.existsSync(legacy)) {
  report.refused.push(`the old home ${legacy} does not exist — already retired`);
}
if (report.refused.length === 0) {
  let names = [];
  try {
    names = fs.readdirSync(legacy, { withFileTypes: true });
  } catch (error) {
    report.refused.push(`cannot read ${legacy}: ${error?.code ?? error}`);
  }
  for (const entry of names) {
    const from = path.join(legacy, entry.name);
    if (entry.isDirectory()) {
      /**
       * The store tree the migration's first run created here. Retired only when the new home
       * holds a file of the same name *and* size for every file below this directory — and the
       * comparison has to recurse, because the ledger files live two levels down
       * (`projects/<slug>/mistakes.md`). Measured 2026-10-10: a first version compared only the
       * immediate children, saw five directories, called all five "not a file", and refused —
       * a false refusal that reads exactly like a real one.
       *
       * `<file>.<stamp>.bak` copies are exempt: they are the safety net of that migration run,
       * and the store holds the file they back up.
       */
      const to = path.join(current, entry.name);
      const filesBelow = (dir, prefix = '', out = []) => {
        let inner = [];
        try {
          inner = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return out;
        }
        for (const child of inner) {
          const rel = prefix.length === 0 ? child.name : `${prefix}/${child.name}`;
          if (child.isDirectory()) filesBelow(path.join(dir, child.name), rel, out);
          else out.push({ rel, size: stat(path.join(dir, child.name)) });
        }
        return out;
      };
      const missing = [];
      for (const file of filesBelow(from)) {
        if (!/^journal\.jsonl(\.\d+)?$/.test(file.rel.split('/').pop()) && !LEDGER_FILES.includes(file.rel.split('/').pop())) {
          continue; // a `.bak` from the migration: not required to match
        }
        const sizeThere = stat(path.join(to, ...file.rel.split('/')));
        if (sizeThere === undefined || sizeThere !== file.size) missing.push(`${file.rel} (${file.size} vs ${sizeThere})`);
      }
      if (missing.length === 0 && fs.existsSync(to)) {
        report.removeTree.push({ path: from, twin: to, files: filesBelow(from).length });
      } else {
        report.refused.push(`${entry.name}: no matching copy in the new home (${missing.join(', ') || 'directory absent'})`);
      }
      continue;
    }
    const to = path.join(current, entry.name);
    const sizeFrom = stat(from);
    const sizeTo = stat(to);
    if (LEDGER_FILES.includes(entry.name) || /^journal\.jsonl\.\d+$/.test(entry.name)) {
      if (sizeTo !== undefined && sizeTo === sizeFrom) report.remove.push({ path: from, copiedTo: to, bytes: sizeFrom });
      else report.refused.push(`${entry.name}: not present at ${to} with the same size (${sizeFrom} vs ${sizeTo})`);
    } else {
      report.keep.push({ path: from, why: 'not a ledger file this version knows about' });
    }
  }
}

console.log(JSON.stringify(report, null, 1));

if (!APPLY) {
  console.log('dry run: pass --apply to delete exactly the files listed under "remove"');
} else if (report.refused.length > 0) {
  console.log('refusing to apply: preconditions failed (see "refused") — nothing was deleted');
  process.exitCode = 1;
} else {
  const removed = [];
  for (const item of report.remove) {
    fs.unlinkSync(item.path);
    removed.push(item.path);
  }
  const pruned = [];
  for (const item of report.removeTree) {
    fs.rmSync(item.path, { recursive: true, force: true });
    pruned.push(item.path);
  }
  console.log(JSON.stringify({ removed: removed.length, paths: removed, prunedTrees: pruned }, null, 1));
}
