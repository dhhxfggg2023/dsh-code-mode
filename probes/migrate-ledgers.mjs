/**
 * Migrate every project ledger into the single store: `<DSH_CODE_HOME>/projects/<slug>/`.
 *
 * Why one store. The ledgers used to be born wherever the agent happened to work:
 * `<repo>/.dsh-code/` per project, plus the machine ledger at `~/.dsh-code/`. The user asked
 * for one place (`2026-10-10`) after watching a `.dsh-code/` appear in every repository.
 *
 * What moves: `project.json`, `tasks.json`, `decisions.md`, `mistakes.md`, `journal.jsonl`
 * and every rotated `journal.jsonl.NNN` segment. What stays: `audits/` (scratch) and the
 * original files themselves — this script **copies**, never deletes, so a mistake here costs
 * a duplicate rather than a ledger.
 *
 * It writes a `project-root` file (the absolute project path) into the destination directory.
 * That file is the *identity*: the reader looks for the directory whose `project-root` equals
 * the project, so nothing has to share a slug algorithm between this script and the reader.
 *
 * Idempotent: a project already in the store is reported and skipped; a destination that
 * already holds a ledger is preserved as `<name>.<timestamp>.bak` before being overwritten.
 *
 * Usage:
 *   node probes/migrate-ledgers.mjs                      # dry run: show the plan
 *   node probes/migrate-ledgers.mjs --apply              # do it
 *   node probes/migrate-ledgers.mjs --apply --root D:\   # where to look for projects
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const HOME = flag('--home') ?? process.env.DSH_CODE_GLOBAL_DIR ?? path.join(os.homedir(), '.dsh-code');
const STORE = path.join(HOME, 'projects');
const LEDGER_FILES = ['project.json', 'tasks.json', 'decisions.md', 'mistakes.md', 'journal.jsonl'];
const ROTATED = /^journal\.jsonl\.\d+$/;

/** Where to look for projects that carry a ledger. Cheap by default; `--root` widens it. */
const roots = args.filter((arg, index) => args[index - 1] === '--root');
const ROOTS =
  roots.length > 0
    ? roots
    : [
        // Where ledgers have actually been seen on the machines this ran on. `--root` widens
        // it; the list is a default, not a description of any one machine.
        'E:\\projects',
        'D:\\Android\\project',
        'E:\\tools',
        path.join(os.homedir(), '.astrbot', 'data', 'plugins'),
      ];

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'target', '.venv', 'venv', '__pycache__']);
const MAX_DEPTH = Number(flag('--depth') ?? '3');

function findLedgers(dir, depth = 0, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  if (entries.some((entry) => entry.isDirectory() && entry.name === '.dsh-code')) out.push(dir);
  if (depth >= MAX_DEPTH) return out;
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    findLedgers(path.join(dir, entry.name), depth + 1, out);
  }
  return out;
}

/** The same shape the reader derives, so a hand-written directory stays recognisable. */
function slugFor(projectRoot) {
  const normal = path.resolve(projectRoot).replace(/\\/g, '/').toLowerCase();
  const base = path.basename(path.resolve(projectRoot)).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'project';
  return `${base}-${createHash('sha256').update(normal).digest('hex').slice(0, 8)}`;
}

/** The project this store directory belongs to, read from its own marker. */
function projectRootOf(directory) {
  try {
    const value = fs.readFileSync(path.join(directory, 'project-root'), 'utf8').trim();
    return value.length === 0 ? undefined : path.resolve(value);
  } catch {
    return undefined;
  }
}

const inStore = new Map();
if (fs.existsSync(STORE)) {
  for (const entry of fs.readdirSync(STORE, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const owner = projectRootOf(path.join(STORE, entry.name));
    if (owner !== undefined) inStore.set(owner.toLowerCase(), entry.name);
  }
}

const projects = [...new Set(ROOTS.flatMap((root) => findLedgers(root)))].sort();
const plan = [];
for (const project of projects) {
  const source = path.join(project, '.dsh-code');
  let names;
  try {
    names = fs.readdirSync(source);
  } catch {
    continue;
  }
  const files = names.filter((name) => LEDGER_FILES.includes(name) || ROTATED.test(name)).sort();
  const already = inStore.get(path.resolve(project).toLowerCase());
  plan.push({
    project,
    source,
    files,
    slug: already ?? slugFor(project),
    alreadyInStore: already !== undefined,
    bytes: files.reduce((sum, name) => {
      try {
        return sum + fs.statSync(path.join(source, name)).size;
      } catch {
        return sum;
      }
    }, 0),
  });
}

console.log(JSON.stringify({ store: STORE, home: HOME, scanned: ROOTS, depth: MAX_DEPTH, apply: APPLY, plan }, null, 1));

/**
 * Preflight: the reader must already know about the store.
 *
 * Without this guard, migrating first would be the worst possible order: the files would sit
 * in the store while every `code_record` kept writing to `<repo>/.dsh-code/`, and the user
 * would watch two copies diverge with no error. The loader constant below is the reader's
 * half of this feature (`lib/ledger.js`), so its absence is a hard stop.
 */
const LEDGER_LIB = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'lib', 'ledger.js');
let readerReady = false;
try {
  readerReady = /PROJECT_STORE_DIRNAME/.test(fs.readFileSync(LEDGER_LIB, 'utf8'));
} catch {
  readerReady = false;
}

if (!APPLY) {
  console.log(`reader ready: ${readerReady ? 'yes' : 'NO — migrate after the reader patch, not before'}`);
  console.log('dry run: pass --apply to copy the ledgers into the store');
} else if (!readerReady) {
  console.log(
    `refusing to migrate: ${LEDGER_LIB} does not read the store yet (no PROJECT_STORE_DIRNAME).\n` +
      'Patch the reader first — otherwise the store and <repo>/.dsh-code/ diverge silently.',
  );
  process.exitCode = 1;
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const done = [];
  for (const item of plan) {
    const target = path.join(STORE, item.slug);
    fs.mkdirSync(target, { recursive: true });
    // A destination that already holds a ledger is archived, never overwritten silently.
    for (const name of item.files) {
      const destination = path.join(target, name);
      if (fs.existsSync(destination) && fs.statSync(destination).size > 0) {
        fs.copyFileSync(destination, `${destination}.${stamp}.bak`);
      }
      fs.copyFileSync(path.join(item.source, name), destination);
    }
    fs.writeFileSync(path.join(target, 'project-root'), `${path.resolve(item.project)}\n`, 'utf8');
    // The pointer is what makes the new location win: `ledgerDir()` reads it before the local
    // directory, so a migrated project stops writing into `<repo>/.dsh-code/` at once.
    fs.writeFileSync(path.join(item.source, 'CENTRAL'), `central ${path.resolve(item.project)}\n`, 'utf8');
    done.push({ project: item.project, slug: item.slug, files: item.files.length, bytes: item.bytes, pointer: path.join(item.source, 'CENTRAL') });
  }
  console.log(JSON.stringify({ migrated: done }, null, 1));
}
