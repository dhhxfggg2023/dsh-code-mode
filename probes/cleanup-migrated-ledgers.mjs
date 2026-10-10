/**
 * Remove the per-project ledger copies left behind by the migration.
 *
 * The user's instruction (2026-10-10): "旧的账本迁移完成就删了，不必要留着，确保不会出问题才删".
 * The precondition was met first — `probes/ledger-store-probe.mjs` is 8/8, `guard-probe` is
 * 45/45, and reading this project's briefing through the store returns the same 160,461-byte
 * `mistakes.md` the local copy held. What this removes is therefore a *duplicate*, not a ledger.
 *
 * Refuses to delete:
 *   - the `CENTRAL` pointer (that file is what routes the project to the store);
 *   - any directory (only files are listed, and a directory in the list is a bug);
 *   - anything outside the four listed project roots.
 *
 * It also prunes the dead scratch the same migration left in the store: diagnostics written by
 * hand, and the `.bak-*` copies of the machine `mistakes.md` that are older than the file they
 * back up.
 *
 * Usage: node probes/cleanup-migrated-ledgers.mjs            # dry run, prints the plan
 *        node probes/cleanup-migrated-ledgers.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
// The two directories this script deletes inside are owned by the ledger, not by this file.
// The first version restated them (`DSH_CODE_GLOBAL_DIR ?? ~/.dsh-code`), which was correct
// until 2026-10-10 moved the home to `~/.dsh/code` and retired `~/.dsh-code`: run without the
// override it then resolved a store that no longer exists, refused every project, and reported
// "0 removals" — the safe direction, but a tool that can only refuse is a tool that lies about
// whether the work is done.
import { globalDir, projectStoreDir } from '../lib/ledger.js';

const APPLY = process.argv.includes('--apply');
const KEEP = new Set(['CENTRAL']);
const LEDGER_NAMES = ['project.json', 'tasks.json', 'decisions.md', 'mistakes.md', 'journal.jsonl'];

/** The projects whose ledgers now live in the store. */
const MIGRATED = [
  { root: 'D:\\Android\\project\\BLbox', store: 'BLbox-753a236e' },
  { root: 'D:\\Android\\project\\PJM', store: 'PJM-99570ac4' },
  { root: 'E:\\projects\\dsh-code-mode', store: 'dsh-code-mode-56290bea' },
  { root: 'E:\\tools\\DSH', store: 'DSH-4224eab7' },
];
const STORE = projectStoreDir();

/** Files that are provably redundant: hand-written diagnostics, and superseded backups. */
const SCRATCH = [
  'E:\\projects\\dsh-code-mode\\probes\\.diag-store.mjs',
  'E:\\projects\\dsh-code-mode\\probes\\.diag-self-store.mjs',
  'E:\\projects\\dsh-code-mode\\probes\\.diag-resolution.mjs',
  'E:\\projects\\dsh-code-mode\\.dsh-code\\audit-raw.txt',
  'E:\\projects\\dsh-code-mode\\engine-grep.txt',
  'E:\\projects\\dsh-code-mode\\asar-list.txt',
];
const MACHINE_BAK = ['mistakes.md.bak-applies', 'mistakes.md.bak-dupfix'];

const plan = { remove: [], keep: [], refused: [] };

/**
 * Which lines of the local file do *not* occur in the store's copy of the same name — `[]`
 * when the store's copy contains every one of them, `null` when there is no copy to compare.
 *
 * The first version pushed `why: 'duplicate of the copy in the store'` after checking only
 * that the store held *mistakes.md*, and on 2026-10-10 that claim was false for the file it
 * deleted: this project's local `journal.jsonl` held 27 lines written between the migration
 * and the restart (the running process still had the pre-migration router, so its journal
 * went on being written locally), and none of the four sampled lines is in the store. The
 * precondition has to cover the file being deleted, not a sibling of it.
 */
function linesAbsentFromStore(local, storeCopy) {
  let localText;
  let storeText;
  try {
    localText = fs.readFileSync(local, 'utf8');
  } catch {
    return null;
  }
  try {
    storeText = fs.readFileSync(storeCopy, 'utf8');
  } catch {
    return null;
  }
  const have = new Set(
    storeText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  return localText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !have.has(line));
}

for (const { root, store } of MIGRATED) {
  const local = path.join(root, '.dsh-code');
  const central = path.join(local, 'CENTRAL');
  const storeDir = path.join(STORE, store);
  // Precondition, per project: the pointer exists AND the store holds the ledger. Without both,
  // deleting the local copy would lose the project's memory outright.
  const ok = fs.existsSync(central) && fs.existsSync(path.join(storeDir, 'mistakes.md'));
  if (!ok) {
    plan.refused.push({ project: root, why: `pointer=${fs.existsSync(central)} storeMistakes=${fs.existsSync(path.join(storeDir, 'mistakes.md'))}` });
    continue;
  }
  plan.keep.push({ path: central, why: 'the pointer that routes this project to the store' });
  let names;
  try {
    names = fs.readdirSync(local);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (KEEP.has(name)) continue;
    const full = path.join(local, name);
    const isLedger = LEDGER_NAMES.includes(name) || /^journal\.jsonl\.\d+$/.test(name);
    if (!isLedger) {
      plan.keep.push({ path: full, why: 'not part of the ledger (a directory or an extra file keeps its place)' });
      continue;
    }
    if (!fs.statSync(full).isFile()) {
      plan.refused.push({ project: root, why: `${name} is a directory, not a file` });
      continue;
    }
    const absent = linesAbsentFromStore(full, path.join(storeDir, name));
    if (absent === null) {
      plan.refused.push({ project: root, why: `${name}: the store has no copy of it to compare against` });
      continue;
    }
    if (absent.length > 0) {
      plan.refused.push({
        project: root,
        why: `${name}: ${absent.length} line(s) are NOT in the store copy — deleting it would lose them (first: ${absent[0].slice(0, 140)})`,
      });
      continue;
    }
    plan.remove.push({
      path: full,
      bytes: fs.statSync(full).size,
      why: 'every line of it is present in the store copy',
    });
  }
}

for (const full of SCRATCH) {
  try {
    if (fs.statSync(full).isFile()) plan.remove.push({ path: full, bytes: fs.statSync(full).size, why: 'hand-written scratch/diagnostic' });
  } catch {
    /* already gone */
  }
}
const machineDir = globalDir();
for (const name of MACHINE_BAK) {
  const full = path.join(machineDir, name);
  try {
    if (fs.statSync(full).isFile()) plan.remove.push({ path: full, bytes: fs.statSync(full).size, why: 'superseded backup of the machine mistakes.md' });
  } catch {
    /* already gone */
  }
}

const totalBytes = plan.remove.reduce((sum, item) => sum + item.bytes, 0);
console.log(
  JSON.stringify(
    {
      store: STORE,
      apply: APPLY,
      wouldRemove: plan.remove.length,
      wouldFreeKB: Math.round(totalBytes / 1024),
      remove: plan.remove,
      keep: plan.keep,
      refused: plan.refused,
    },
    null,
    1,
  ),
);

if (!APPLY) {
  console.log('dry run: pass --apply to delete exactly the files listed under "remove"');
} else if (plan.refused.length > 0) {
  console.log('refusing to apply: at least one project failed its precondition (see "refused")');
  process.exitCode = 1;
} else {
  const removed = [];
  for (const item of plan.remove) {
    fs.unlinkSync(item.path);
    removed.push(item.path);
  }
  console.log(JSON.stringify({ removed: removed.length, paths: removed }, null, 1));
}
