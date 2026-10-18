/**
 * Ledger administration: list every ledger on this machine, read one ledger file, and
 * move a ledger aside. Pure Node — no `@deepseek-ai/*` import — so a plain-node probe
 * can drive every rule here without a host.
 *
 * Why this exists (2026-10-18): the mode had no way to see its own ledgers. They live in
 * three places (`<repo>/.dsh-code/`, the machine store's `projects/<slug>/`, and the
 * machine ledger at `globalDir()`), a project may keep a *stale* copy in one of them
 * while the running plugin reads the other, and nothing anywhere said so. The settings
 * page this module feeds is the first reader that can show the whole set at once.
 *
 * Three rules this module owns, and owns alone:
 *
 *   1. **Which ledgers exist.** One pass, one shape (`inventoryOf`). It *resolves* rather
 *      than recomputing: `ledger.js` owns where a ledger is, `slugFor`/`projectStoreDir`
 *      own the store's layout, and this module only walks the directories those functions
 *      name. A second slug algorithm here would be the drift this repository has already
 *      paid for twice.
 *   2. **What is wrong with them.** The health flags are the point: `central-dangling`
 *      (the repository points at a ledger that is not there), `not-pointed-at` (a store
 *      copy exists but the repository does not point at it, so the plugin reads the other
 *      one — this is the state *this* checkout is in), `store-orphan` (the project is
 *      gone), `unmigrated`, `locked`.
 *   3. **Whether a delete may proceed.** Computed here, never in the browser: the browser
 *      can only send back an `id` this module produced, so no client-supplied path can
 *      ever reach a rename. `deletionVerdict` is the single owner of the refusal reasons.
 *      The machine ledger is deletable through the same trash-first path as any other
 *      ledger (the page warns that every project shares it), so "单独删除" works for the
 *      machine tab too; only the calling project's own ledger and a live writer are refused.
 *
 * Deletion is **trash-first**. A ledger is the evidence of what this project paid for, and
 * this design's oldest rule is that nothing in a ledger is deleted to make room; so the
 * destructive verb here is `rename`, the trash sits next to what it was taken from, and the
 * only irreversible act (`purgeTrash`) needs the trash directory's own name typed back.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DIRNAME,
  FILES,
  SCOPE,
  globalDir,
  isCentral,
  journalFilesIn,
  projectParents,
  projectStoreDir,
  readTasks,
  siblingProjects,
  slugFor,
} from './ledger.js';

/** The files a ledger is made of, in display order. */
export const LEDGER_FILES = [FILES.project, FILES.tasks, FILES.decisions, FILES.mistakes, FILES.journal];

/** Suffix a trashed directory carries, and the marker file inside it. */
const TRASH_SUFFIX = '.trashed-';
export const TRASH_MANIFEST = 'trash-manifest.json';

/** How much of one file the viewer may read, in characters. */
const VIEW_CHARS = 120000;

/** How many journal lines the viewer returns when the file is too large to read whole. */
const JOURNAL_TAIL_LINES = 400;

function samePath(a, b) {
  return typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** A file's presence and size, or undefined when it is not a readable file. */
function statOf(file) {
  try {
    const info = fs.statSync(file);
    return info.isFile() ? { bytes: info.size, mtime: info.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Entries of one markdown ledger file: a `## ` heading starts one. */
function markdownEntries(text) {
  return String(text ?? '')
    .split(/\n(?=## )/)
    .map((block) => block.trim())
    .filter((block) => block.startsWith('## '));
}

/** The project root a directory in the store claims, or undefined when it claims none. */
function storeOwner(directory) {
  const value = readText(path.join(directory, 'project-root')).trim();
  return value.length === 0 ? undefined : path.resolve(value);
}

/**
 * The store directory that holds `root`'s ledger, found **without creating anything**.
 *
 * `projectDirFor()` is the writer's answer and creates the directory and its identity
 * marker on the way; an inventory that called it would be a reader that changes what it
 * reports. This is the same resolution restricted to what already exists: the marker a
 * store directory carries *is* the identity, so a directory claiming `root` wins over the
 * derived slug, and the slug is only accepted when that directory is already there.
 */
function storeDirFor(root) {
  const store = projectStoreDir();
  let names;
  try {
    names = fs.readdirSync(store, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(store, entry.name);
    const owner = storeOwner(dir);
    if (owner !== undefined && samePath(owner, root)) return dir;
  }
  const derived = path.join(store, slugFor(root));
  return fs.existsSync(derived) ? derived : undefined;
}

/** The journal segments of one directory, oldest first, live file last. */
function segmentsOf(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const rotated = names
    .filter((name) => name.startsWith(`${FILES.journal}.`) && !name.endsWith('.lock'))
    // Highest number first: rotation shifts `.00N` -> `.00(N+1)` and renames the live file
    // onto `.000`, so the newest segment is `.000` and the oldest is the highest number.
    .sort()
    .reverse()
    .map((name) => path.join(dir, name));
  return [...rotated, path.join(dir, FILES.journal)];
}

/** Whether a ledger directory is one of ours: it holds at least one recognised file. */
function looksLikeLedger(dir) {
  if (LEDGER_FILES.some((name) => statOf(path.join(dir, name)) !== undefined)) return true;
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir).some((name) => name.startsWith(`${FILES.journal}.`) && !name.endsWith('.lock'));
  } catch {
    return false;
  }
}

/** Counts a reader can act on, without handing back the ledger itself. */
function measure(dir) {
  const mistakes = markdownEntries(readText(path.join(dir, FILES.mistakes))).length;
  const decisions = markdownEntries(readText(path.join(dir, FILES.decisions))).length;
  const tasks = readTasksIn(dir);
  const project = (() => {
    try {
      const parsed = JSON.parse(readText(path.join(dir, FILES.project)));
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.keys(parsed).filter((key) => !['version', 'createdAt', 'updatedAt'].includes(key)).length
        : 0;
    } catch {
      return 0;
    }
  })();
  const files = [];
  let bytes = 0;
  let lastWrite = 0;
  for (const name of LEDGER_FILES) {
    const info = statOf(path.join(dir, name));
    if (info === undefined) continue;
    files.push({ name, bytes: info.bytes, mtime: info.mtimeMs });
    bytes += info.bytes;
    if (info.mtime > lastWrite) lastWrite = info.mtime;
  }
  for (const segment of segmentsOf(dir).slice(0, -1)) {
    const info = statOf(segment);
    if (info === undefined) continue;
    bytes += info.bytes;
    if (info.mtime > lastWrite) lastWrite = info.mtime;
  }
  return { counts: { mistakes, decisions, tasksActive: tasks.active, tasksDone: tasks.done, projectFields: project }, files, bytes, lastWrite };
}

/**
 * Tasks of one directory, read here rather than through `readTasks(cwd)`.
 *
 * `readTasks` takes a project root and resolves it, which is the wrong direction for a
 * ledger whose repository no longer exists (or whose repository does not point at it).
 * The shape is the same and the normalisation that matters — filing each task under the
 * list its status says — is done here in three lines; `readTasks` remains the owner of
 * the *live* board the tools write.
 */
function readTasksIn(dir) {
  try {
    const board = JSON.parse(readText(path.join(dir, FILES.tasks)));
    const count = (list, status) => (Array.isArray(board?.[list]) ? board[list].filter((task) => task?.status === status).length : 0);
    return { active: count('active', 'active'), done: count('done', 'done') };
  } catch {
    return { active: 0, done: 0 };
  }
}

/** Whether a writer is inside this ledger right now (a lock left by a dead process counts as absent). */
function lockedNow(dir) {
  for (const name of [FILES.journal, FILES.mistakes, FILES.decisions, FILES.tasks]) {
    const lock = path.join(dir, `${name}.lock`);
    let ageMs;
    try {
      ageMs = Date.now() - fs.statSync(lock).mtimeMs;
    } catch {
      continue;
    }
    // `ledger.js` breaks a lock older than five seconds, so an older one is a crashed
    // writer rather than a live one — reporting it as "locked" would refuse a delete for
    // ever after one crash.
    if (ageMs <= 5000) return true;
  }
  return false;
}

/** One labelled entry, with its health flags and the delete verdict attached. */
function describe({ id, kind, scope, root, dir, cwd }) {
  const measured = measure(dir);
  const health = [];
  if (kind === 'machine') health.push('machine');
  if (kind === 'store') {
    const owner = storeOwner(dir);
    if (owner === undefined) health.push('no-project-root');
    else if (!fs.existsSync(owner)) health.push('store-orphan');
    // "Pointed at" is `isCentral(owner)` *and* the pointer resolving to this directory —
    // the same pair `ledgerDir()` uses to decide which copy a session actually reads. The
    // pointer's payload is the project path, never the store path, so comparing it to `dir`
    // would flag every migrated project as stray.
    const pointedAt = owner !== undefined && fs.existsSync(owner) && isCentral(owner) && samePath(storeDirFor(owner) ?? '', dir);
    if (owner !== undefined && fs.existsSync(owner) && !pointedAt) health.push('not-pointed-at');
    const localDir = owner === undefined ? undefined : path.join(owner, DIRNAME);
    if (localDir !== undefined && looksLikeLedger(localDir) && !isCentral(owner)) health.push('repo-copy-also-live');
  }
  if (kind === 'repo') {
    if (isCentral(root)) health.push('migrated');
    else health.push('unmigrated');
  }
  if (lockedNow(dir)) health.push('locked');
  const verdict = deletionVerdict({ kind, root, dir, cwd });
  return {
    id,
    kind,
    scope,
    root: root ?? '',
    dir,
    label: kind === 'machine' ? '机器账本' : kind === 'repo' ? `${path.basename(root ?? dir)} · 仓库内` : `${path.basename(root ?? dir) || path.basename(dir)} · store`,
    health,
    ...measured,
    deletable: verdict.deletable,
    reason: verdict.reason,
  };
}

/**
 * Whether this ledger may be moved aside, and why not when it may not.
 *
 * The refusals that remain are the ones whose trash would be restored into a directory
 * that is in use again: the ledger of the project the caller is working in is the one its
 * own session is writing, and a ledger with a live lock is being written at this instant.
 * The machine ledger is shared by every project, so the page labels it as such and warns
 * before trashing it, but it is still an ordinary reversible rename — refusing it outright
 * left the machine tab with nothing to manage.
 */
export function deletionVerdict({ kind, root, dir, cwd }) {
  if (typeof root === 'string' && root.length > 0 && typeof cwd === 'string' && samePath(root, cwd)) {
    return { deletable: false, reason: '这是当前项目自己的账本，先切换到别的项目再管理' };
  }
  if (lockedNow(dir)) return { deletable: false, reason: '有会话正在写这个账本（journal 锁还在）' };
  return { deletable: true, reason: undefined };
}

/** Trashed directories sitting directly beside a ledger (store slot or a repository). */
function trashedNear(parent, prefix) {
  let names;
  try {
    names = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) && entry.name.includes(TRASH_SUFFIX))
    .map((entry) => path.join(parent, entry.name));
}

/** The manifest of one trashed directory, or an empty record when it never got one. */
function trashRecord(dir) {
  try {
    const parsed = JSON.parse(readText(path.join(dir, TRASH_MANIFEST)));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** One trashed ledger, as the page shows it. */
function describeTrash(dir) {
  const manifest = trashRecord(dir);
  const measured = measure(dir);
  return {
    id: `trash:${dir}`,
    kind: 'trash',
    scope: manifest.scope === SCOPE.global ? SCOPE.global : SCOPE.project,
    root: typeof manifest.root === 'string' ? manifest.root : '',
    dir,
    label: manifest.scope === SCOPE.global ? '机器账本（回收站）' : `${path.basename(manifest.originalDir ?? dir)}`,
    name: path.basename(dir),
    originalDir: typeof manifest.originalDir === 'string' ? manifest.originalDir : '',
    trashedAt: typeof manifest.trashedAt === 'string' ? manifest.trashedAt : '',
    health: ['trash'],
    ...measured,
  };
}

/**
 * Every ledger this host can see, classified.
 *
 * @param options.cwd - the project asking; its own ledger is listed but not deletable.
 * @returns `{ ledgers, trash, groups }` — `groups` is the project-organised view the page
 *   renders, and `ledgers` is the flat list the action endpoints resolve ids against.
 */
export function inventoryOf({ cwd } = {}) {
  const ledgers = [];
  const trash = [];
  const store = projectStoreDir();
  const machine = globalDir();

  if (fs.existsSync(machine) && looksLikeLedger(machine)) {
    ledgers.push(describe({ id: 'machine', kind: 'machine', scope: SCOPE.global, root: '', dir: machine, cwd }));
  }
  // The machine ledger trashes beside itself (`~/.dsh/code.trashed-<stamp>`), not under the
  // store or a project root, so the walks below would never find it. Read that one parent
  // directly: restore is the only way back, and a trash the page cannot list is a delete.
  for (const dir of trashedNear(path.dirname(machine), path.basename(machine))) trash.push(describeTrash(dir));

  const storeNames = (() => {
    try {
      return fs.readdirSync(store, { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  const owners = [];
  for (const entry of storeNames) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(store, entry.name);
    if (entry.name.includes(TRASH_SUFFIX)) {
      trash.push(describeTrash(dir));
      continue;
    }
    if (!looksLikeLedger(dir)) continue;
    const owner = storeOwner(dir);
    if (owner !== undefined) owners.push(owner);
    ledgers.push(describe({ id: `store:${entry.name}`, kind: 'store', scope: SCOPE.project, root: owner ?? '', dir, cwd }));
  }

  /** Project roots worth looking at: the caller, the store's claims, and the siblings. */
  const roots = new Set();
  if (typeof cwd === 'string' && cwd.length > 0) roots.add(path.resolve(cwd));
  for (const owner of owners) roots.add(path.resolve(owner));
  try {
    for (const sibling of siblingProjects(cwd ?? process.cwd())) roots.add(path.resolve(sibling));
  } catch {
    /* a sibling scan that fails is not a reason to show nothing */
  }

  // A repository whose ledger was moved aside has no `.dsh-code/` any more, so the sibling
  // scan above cannot see it — and its trash is the only way back. Look one level up (the
  // same parents projects live in) for a project that still carries a trashed ledger.
  for (const parent of projectParents(cwd ?? process.cwd())) {
    let entries;
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(parent, entry.name);
      if (trashedNear(candidate, DIRNAME).length > 0) roots.add(candidate);
    }
  }

  for (const root of roots) {
    if (isCentral(root)) {
      // The pointer resolves by *identity marker*, exactly like `ledgerDir()`: the store
      // directory that claims this root, never the payload of `CENTRAL` (which is the
      // project path). A pointer whose store copy is gone is the dangling state.
      if (storeDirFor(root) === undefined) {
        ledgers.push({
          id: `repo:${root}`,
          kind: 'repo',
          scope: SCOPE.project,
          root,
          dir: path.join(projectStoreDir(), slugFor(root)),
          label: `${path.basename(root)} · 指针悬空`,
          health: ['central-dangling'],
          counts: { mistakes: 0, decisions: 0, tasksActive: 0, tasksDone: 0, projectFields: 0 },
          files: [],
          bytes: 0,
          lastWrite: 0,
          deletable: false,
          reason: 'CENTRAL 指向的账本已经不在；这里没有可删的东西',
        });
        continue;
      }
      continue; // a migrated repository is already listed as its store entry
    }
    const dir = path.join(root, DIRNAME);
    if (!looksLikeLedger(dir)) continue;
    ledgers.push(describe({ id: `repo:${root}`, kind: 'repo', scope: SCOPE.project, root, dir, cwd }));
  }

  // Trashed ledgers are found by the same walk that found the live ones: a store ledger is
  // renamed inside the store (`<slug>.trashed-<stamp>`), a repository's ledger is renamed
  // beside its repository (`<root>/.dsh-code.trashed-<stamp>`). Both keep the manifest that
  // says where they came from, so neither needs a second index.
  for (const root of roots) {
    for (const dir of trashedNear(root, DIRNAME)) {
      if (trash.some((record) => samePath(record.dir, dir))) continue;
      trash.push(describeTrash(dir));
    }
  }

  const groups = new Map();
  for (const entry of ledgers) {
    const key = entry.scope === SCOPE.global ? '(machine)' : entry.root || `(unknown) ${entry.dir}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return {
    ledgers,
    trash: trash.sort((a, b) => String(b.trashedAt).localeCompare(String(a.trashedAt))),
    groups: [...groups.entries()].map(([root, entries]) => ({ root, entries })),
    store,
    machine,
    cwd: cwd ?? '',
  };
}

/** The ledger one id names, or undefined. Ids come from {@link inventoryOf} and nowhere else. */
export function resolveLedger(id, options = {}) {
  const found = inventoryOf(options).ledgers.find((entry) => entry.id === id);
  return found;
}

/** The trashed ledger one id names, or undefined. */
export function resolveTrash(id, options = {}) {
  return inventoryOf(options).trash.find((entry) => entry.id === id);
}

/**
 * One file of one ledger, for the viewer.
 *
 * Refuses anything that is not a ledger file name this module knows: the browser sends a
 * name from a fixed list, and a name that is not on it never becomes a path.
 * @returns `{ name, text, bytes, truncated, segments }` — `segments` names the rotated
 *   journal files that were concatenated, so a reader knows the view spans them.
 */
export function readLedgerFile(id, name, options = {}) {
  const entry = resolveLedger(id, options);
  if (entry === undefined) throw new Error(`no ledger with id ${JSON.stringify(String(id))}`);
  if (!LEDGER_FILES.includes(name)) {
    throw new Error(`refusing to read ${JSON.stringify(String(name))}: not one of ${LEDGER_FILES.join(', ')}`);
  }
  if (name === FILES.journal) {
    const segments = segmentsOf(entry.dir).filter((file) => statOf(file) !== undefined);
    const text = segments.map((file) => readText(file)).join('');
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    const kept = lines.slice(-JOURNAL_TAIL_LINES);
    return {
      name,
      text: kept.join('\n'),
      bytes: text.length,
      truncated: kept.length < lines.length,
      segments: segments.map((file) => path.basename(file)),
      lines: lines.length,
    };
  }
  const text = readText(path.join(entry.dir, name));
  return {
    name,
    text: text.length > VIEW_CHARS ? `${text.slice(0, VIEW_CHARS)}\n… (仅显示前 ${VIEW_CHARS} 字符)` : text,
    bytes: text.length,
    truncated: text.length > VIEW_CHARS,
    segments: [],
  };
}

/**
 * Move one ledger aside into a trash directory that sits where the ledger was.
 *
 * Beside, not into a central dump: the rename is then within one directory (so it cannot
 * fail with `EXDEV` on a second drive), the trashed copy stays next to the evidence it
 * belongs to, and the trash is found again by the same walk that found the ledger.
 *
 * The repository's `CENTRAL` pointer is moved aside with it — a pointer left behind would
 * make `ledgerDir()` resolve to a directory that is not there, which is the
 * `central-dangling` state this module already reports as a defect.
 */
export function trashLedger(id, { cwd, session } = {}) {
  const entry = resolveLedger(id, { cwd });
  if (entry === undefined) throw new Error(`no ledger with id ${JSON.stringify(String(id))}`);
  const verdict = deletionVerdict({ kind: entry.kind, root: entry.root, dir: entry.dir, cwd });
  if (!verdict.deletable) throw new Error(verdict.reason ?? 'this ledger may not be deleted');
  if (!fs.existsSync(entry.dir)) throw new Error(`${entry.dir} is not there any more`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.basename(entry.dir);
  const parent = entry.kind === 'repo' ? path.dirname(entry.dir) : path.dirname(entry.dir);
  const target = path.join(parent, `${base}${TRASH_SUFFIX}${stamp}`);
  if (fs.existsSync(target)) throw new Error(`${target} already exists`);

  const manifest = {
    originalDir: entry.dir,
    root: entry.root,
    kind: entry.kind,
    scope: entry.scope,
    trashedAt: new Date().toISOString(),
    session: session ?? '',
    files: entry.files.map((file) => file.name),
    bytes: entry.bytes,
    health: entry.health,
  };
  fs.renameSync(entry.dir, target);
  try {
    fs.writeFileSync(path.join(target, TRASH_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } catch {
    /* the ledger moved; a manifest that cannot be written is reported by the caller's listing */
  }

  let pointerMoved;
  if (entry.kind === 'store' && entry.root.length > 0) {
    const pointer = path.join(entry.root, DIRNAME, 'CENTRAL');
    if (statOf(pointer) !== undefined) {
      pointerMoved = `${pointer}${TRASH_SUFFIX}${stamp}`;
      try {
        fs.renameSync(pointer, pointerMoved);
      } catch {
        pointerMoved = undefined;
      }
    }
  }
  return { ok: true, id, trashedTo: target, manifest, pointerMoved, health: entry.health };
}

/** Move one trashed ledger back where it came from, restoring its pointer when it had one. */
export function restoreTrash(id, options = {}) {
  const record = resolveTrash(id, options);
  if (record === undefined) throw new Error(`no trashed ledger with id ${JSON.stringify(String(id))}`);
  const original = record.originalDir;
  if (original.length === 0) throw new Error('this trash directory has no manifest, so its original path is unknown');
  if (fs.existsSync(original)) throw new Error(`${original} already exists — restore would overwrite it`);
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.renameSync(record.dir, original);
  // The manifest describes the *trash copy*; carrying it back would leave the live ledger
  // with a file it never had, so restore would not be byte-for-byte (L5). Drop it before
  // the caller compares the directory with its pre-trash snapshot.
  try {
    fs.rmSync(path.join(original, TRASH_MANIFEST), { force: true });
  } catch {
    /* an undeletable manifest leaves one stray file; the next trash run overwrites it */
  }

  let pointerRestored = false;
  if (record.kind === 'store' && record.root.length > 0 && fs.existsSync(record.root)) {
    const dir = path.join(record.root, DIRNAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CENTRAL'), `central ${path.resolve(record.root)}\n`, 'utf8');
    pointerRestored = true;
  }
  return { ok: true, restoredTo: original, pointerRestored };
}

/**
 * Delete a trashed ledger for good.
 *
 * The only irreversible act in this module, so it takes the trash directory's own name as
 * the confirmation: a UI that asks "are you sure" can be dismissed by reflex, and a name
 * that has to be typed cannot be sent by a page that did not show the user which one it
 * was about to remove.
 */
export function purgeTrash(id, confirm, options = {}) {
  const record = resolveTrash(id, options);
  if (record === undefined) throw new Error(`no trashed ledger with id ${JSON.stringify(String(id))}`);
  const expected = path.basename(record.dir);
  if (String(confirm ?? '') !== expected) {
    throw new Error(`refusing to purge: type the directory name exactly (${expected})`);
  }
  fs.rmSync(record.dir, { recursive: true, force: true });
  return { ok: true, purged: record.dir, bytes: record.bytes, files: record.files.map((file) => file.name) };
}

/** Re-exported so a caller can name the journal segments of a resolved ledger without resolving again. */
export { journalFilesIn };
