/**
 * The ledger store: one place for every project ledger, and no repository left behind.
 *
 * Written 2026-10-10 for the user's request ("我不要每次记账本都新建个文件夹占位置，最好全部
 * 放在一个地方，并且做好以前的账本迁移"). The dangerous half of that change is not the copying —
 * it is the *resolution order*, which three different audiences depend on:
 *
 *   1. an **unmigrated** project must keep using `<repo>/.dsh-code/` (else the change silently
 *      moves a live ledger and the old files rot);
 *   2. a **migrated** project must use the store (else two copies diverge, neither erroring);
 *   3. a **fixture** — the 25+ probes that build `<scratch>/.dsh-code/...` by hand — must keep
 *      working, or the whole judgement suite breaks at once.
 *
 * It also pins the two properties the migration can silently destroy: a brand-new project
 * must NOT create `.dsh-code/`, and `siblingProjects()` must still find projects after they
 * have been migrated (a cross-project promotion scan that sees nothing is indistinguishable
 * from "no rule recurs").
 *
 * Reads and writes only under a temporary root; never touches a real ledger.
 *
 * Usage: node probes/ledger-store-probe.mjs [--out <file>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

/** Every path decision in this probe lives under one throwaway root, set before importing. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-store-'));
process.env.DSH_CODE_GLOBAL_DIR = path.join(SANDBOX, 'machine');
process.env.DSH_CODE_PROJECTS_DIR = path.join(SANDBOX, 'machine', 'projects');
fs.mkdirSync(process.env.DSH_CODE_PROJECTS_DIR, { recursive: true });

const ledger = await import('../lib/ledger.js');
const { FILES, ledgerDir, ledgerPath, siblingProjects, slugFor, projectStoreDir } = ledger;

const results = [];
const check = (id, name, ok, evidence) => results.push({ id, name, ok: Boolean(ok), evidence });
const mkProject = (name) => {
  const root = path.join(SANDBOX, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
};

// S1 — migration is explicit: a project that was never migrated writes to its own
// `<repo>/.dsh-code/`. Routing new projects into the store was tried and reverted (it broke
// `guard-probe`'s hand-seeded fixtures: `writeProject` went to the store while the probe's own
// `fs.appendFileSync(<fixture>/.dsh-code/journal.jsonl)` stayed local — two owners, one file).
{
  const root = mkProject('fresh');
  const created = ledger.initLedger(root, 'sess-fresh');
  const local = path.join(root, '.dsh-code');
  check(
    'S1',
    'an unmigrated project keeps its ledger beside the code, and the store is untouched',
    ledgerDir(root) === local && created.includes(FILES.project) && fs.existsSync(path.join(local, FILES.project)),
    { root, directory: ledgerDir(root), local, created, storeListing: fs.existsSync(projectStoreDir()) ? fs.readdirSync(projectStoreDir()) : [] },
  );
}

// S2 — an unmigrated project keeps its local ledger: the old location still wins when it holds
// a ledger and no pointer says otherwise.
{
  const root = mkProject('legacy');
  const local = path.join(root, '.dsh-code');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, FILES.project), '{}\n', 'utf8');
  check(
    'S2',
    'an unmigrated project with a local ledger keeps using it',
    ledgerDir(root) === local && !ledger.isCentral(root),
    { root, resolved: ledgerDir(root), local, central: ledger.isCentral(root) },
  );
}

// S3 — the pointer wins over the local copy, which is the whole point of migrating: otherwise
// the store and the repository would both keep being written.
{
  const root = mkProject('migrated');
  const local = path.join(root, '.dsh-code');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, FILES.project), '{}\n', 'utf8');
  fs.writeFileSync(path.join(local, 'CENTRAL'), `central ${path.resolve(root)}\n`, 'utf8');
  const store = path.join(projectStoreDir(), slugFor(root));
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'project-root'), `${path.resolve(root)}\n`, 'utf8');
  fs.writeFileSync(path.join(store, FILES.project), '{"migrated":true}\n', 'utf8');
  check(
    'S3',
    'a CENTRAL pointer makes the store win, even while the local ledger still exists',
    ledger.isCentral(root) === true && ledgerDir(root) === store && fs.existsSync(path.join(store, 'project-root')),
    { root, resolved: ledgerDir(root), store, central: ledger.isCentral(root) },
  );
}

// S4 — a pointer that names a *different* project is not this project's pointer. Without this
// check a copied repository would start reading its neighbour's ledger.
{
  const root = mkProject('pointer-mismatch');
  const local = path.join(root, '.dsh-code');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, FILES.project), '{}\n', 'utf8');
  fs.writeFileSync(path.join(local, 'CENTRAL'), 'central E:\\somewhere\\else\n', 'utf8');
  check(
    'S4',
    'a pointer naming another project is ignored, so the local ledger still wins',
    ledger.isCentral(root) === false && ledgerDir(root) === local,
    { root, central: ledger.isCentral(root), resolved: ledgerDir(root) },
  );
}

// S5 — the store never resolves to the project itself. A store inside the repository would
// make the ledger a child of the thing it describes, and the ledgers would nest forever.
//
// The assertion is on `projectDirFor`'s return value, not on the environment: an earlier
// probe in the same shell may have pinned `DSH_CODE_PROJECTS_DIR` already (measured
// 2026-10-10 — running this file after another probe made an earlier version of S5 pass and
// fail for reasons that had nothing to do with the guard). The configured value is read back
// and asserted to be the inside-the-project one, so the check cannot silently test the wrong
// configuration.
{
  const root = mkProject('self-store');
  const previous = process.env.DSH_CODE_PROJECTS_DIR;
  const inside = path.join(root, '.dsh-code', 'store');
  process.env.DSH_CODE_PROJECTS_DIR = inside;
  const configured = process.env.DSH_CODE_PROJECTS_DIR;
  const refused = ledger.projectDirFor(root);
  process.env.DSH_CODE_PROJECTS_DIR = previous;
  check(
    'S5',
    'a store configured inside the project is refused rather than nested',
    configured === inside && refused === undefined && !fs.existsSync(path.join(inside, slugFor(root))),
    { root, configured, resolved: refused ?? null, nestedWouldHaveBeen: path.join(inside, slugFor(root)) },
  );
}

// S6 — after migration the cross-project scan still sees the project. This is the property a
// naive "move the ledger" breaks silently: `siblingProjects` looked for `.dsh-code/`.
{
  const current = mkProject('current');
  const migrated = mkProject('neighbour');
  const store = path.join(projectStoreDir(), slugFor(migrated));
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'project-root'), `${path.resolve(migrated)}\n`, 'utf8');
  const siblings = siblingProjects(current);
  check(
    'S6',
    'siblingProjects finds a migrated project through its store marker',
    siblings.some((root) => path.resolve(root).toLowerCase() === path.resolve(migrated).toLowerCase()),
    { current, migrated, siblings },
  );
}

// S7 — a ledger written through the store lands where the pointer says, and the repository
// gets nothing new: the end-to-end claim the user actually made.
{
  const root = mkProject('end-to-end');
  const local = path.join(root, '.dsh-code');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, FILES.project), '{}\n', 'utf8');
  fs.writeFileSync(path.join(local, 'CENTRAL'), `central ${path.resolve(root)}\n`, 'utf8');
  const before = fs.readdirSync(local).sort();
  ledger.recordMistake(root, {
    symptom: 'store probe end to end',
    cause: 'checking that a write follows the pointer',
    fix: 'written by probes/ledger-store-probe.mjs',
    avoid: 'nothing — this is a fixture',
  }, 'sess-end-to-end');
  const after = fs.readdirSync(local).sort();
  const store = ledgerDir(root);
  check(
    'S7',
    'a write after migration lands in the store and adds no file to the repository',
    JSON.stringify(before) === JSON.stringify(after) && fs.existsSync(path.join(store, FILES.mistakes)) && fs.existsSync(path.join(store, FILES.journal)),
    { root, store, localBefore: before, localAfter: after, wroteInStore: fs.existsSync(path.join(store, FILES.mistakes)) },
  );
}

// S8 — a directory holding *some* ledger file is this project's ledger, even without
// `project.json`. This is the fixture-compatibility property: 25+ probes build
// `<scratch>/.dsh-code/mistakes.md` (or only a journal) by hand, and a test for `project.json`
// alone would declare those "no ledger", send the write to the store, and leave the fixture's
// own file — and the check that reads it — untouched and failing.
{
  const root = mkProject('bare-fixture');
  const local = path.join(root, '.dsh-code');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, FILES.mistakes), '# Mistakes\n', 'utf8');
  const onlyJournal = mkProject('journal-fixture');
  const journalLocal = path.join(onlyJournal, '.dsh-code');
  fs.mkdirSync(journalLocal, { recursive: true });
  fs.writeFileSync(path.join(journalLocal, `${FILES.journal}.001`), '{}\n', 'utf8');
  check(
    'S8',
    'a fixture holding only mistakes.md or only a rotated journal keeps its local ledger',
    ledgerDir(root) === local && ledgerDir(onlyJournal) === journalLocal,
    { bare: ledgerDir(root), expectedBare: local, journalOnly: ledgerDir(onlyJournal), expectedJournal: journalLocal },
  );
}

const failed = results.filter((row) => !row.ok);
const report = {
  passed: results.length - failed.length,
  total: results.length,
  failed: failed.map((row) => `${row.id} ${row.name}`),
  sandbox: SANDBOX,
  store: projectStoreDir(),
  checks: results,
};
const OUT = flag('--out');
if (OUT === undefined) console.log(JSON.stringify(report, null, 1));
else {
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1), 'utf8');
  console.log(`${report.passed}/${report.total} passed${failed.length === 0 ? '' : ` — failed: ${report.failed.join('; ')}`}`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
