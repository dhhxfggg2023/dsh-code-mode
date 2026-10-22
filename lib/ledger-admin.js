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
  isJournalSegment,
  journalFilesIn,
  projectParents,
  projectStoreDir,
  readTasks,
  resolveLedgerDir,
  siblingProjects,
  slugFor,
} from './ledger.js';

/** The files a ledger is made of, in display order. */
export const LEDGER_FILES = [FILES.project, FILES.tasks, FILES.decisions, FILES.mistakes, FILES.journal];

/** Suffix a trashed directory carries, and the marker file inside it. */
const TRASH_SUFFIX = '.trashed-';
export const TRASH_MANIFEST = 'trash-manifest.json';

/** Per-entry deletions keep the pre-edit file here, inside the ledger, so one entry can be recovered. */
export const ENTRY_TRASH_DIR = '.entry-trash';

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

/** One `## ` block as a display record: heading, date badge, and `- key: value` fields. */
function markdownEntry(block, index) {
  const lines = block.split('\n');
  const heading = lines[0].replace(/^##\s*/u, '').trim();
  const dated = /^(\d{4}-\d{2}-\d{2})\s*[·:：-]\s*(.*)$/u.exec(heading);
  const date = dated?.[1];
  const title = (dated?.[2] ?? heading).trim();
  const fields = [];
  let current;
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (line.length === 0) {
      current = undefined;
      continue;
    }
    const field = /^-\s*([^:：]{1,40})[:：]\s*(.*)$/u.exec(line);
    if (field !== null) {
      current = { label: field[1].trim(), value: field[2].trim() };
      fields.push(current);
    } else if (current !== undefined) {
      current.value = current.value.length === 0 ? line : `${current.value}\n${line}`;
    }
  }
  return { kind: 'markdown', index, ...(date === undefined ? {} : { date }), title, fields, raw: block };
}

/** Every entry of a markdown ledger file, in file order. */
function markdownEntryList(text) {
  return markdownEntries(text).map((block, index) => markdownEntry(block, index));
}

/** Every record of a journal file, one row per JSONL line. */
function journalEntryList(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        const record = JSON.parse(line);
        const time = record?.ts ?? record?.time ?? record?.at ?? '';
        const kind = record?.kind ?? record?.type ?? record?.event ?? 'event';
        return { kind: 'journal', index, time: typeof time === 'string' ? time : String(time), title: String(kind), raw: line };
      } catch {
        return { kind: 'journal', index, time: '', title: '(invalid JSON)', raw: line };
      }
    });
}

/** The task board as individual rows, active first. */
function taskEntryList(dir) {
  let board;
  try {
    board = JSON.parse(readText(path.join(dir, FILES.tasks)));
  } catch {
    return [];
  }
  const entries = [];
  for (const status of ['active', 'done']) {
    if (!Array.isArray(board?.[status])) continue;
    for (const task of board[status]) {
      const fields = [
        ['id', task?.id],
        ['owner', task?.owner ?? task?.assignee],
        ['updatedAt', task?.updatedAt],
        ['description', task?.description],
      ]
        .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
        .map(([label, value]) => ({ label, value: String(value) }));
      entries.push({
        kind: 'task',
        index: entries.length,
        status,
        title: String(task?.title ?? task?.subject ?? task?.id ?? '(untitled task)'),
        fields,
        raw: JSON.stringify(task, null, 2),
      });
    }
  }
  return entries;
}

/** `project.json` as key/value rows. */
function projectEntryList(dir) {
  let record;
  try {
    record = JSON.parse(readText(path.join(dir, FILES.project)));
  } catch {
    return [];
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return [];
  return Object.entries(record).map(([key, value], index) => ({
    kind: 'project',
    index,
    title: key,
    fields: [{ label: 'value', value: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    raw: `${key}: ${JSON.stringify(value, null, 2)}`,
  }));
}

/** The display records of one ledger file, parsed on the host so the page never guesses. */
function entriesFor(dir, name, text) {
  if (name === FILES.mistakes || name === FILES.decisions) return markdownEntryList(text);
  if (name === FILES.journal) return journalEntryList(text);
  if (name === FILES.tasks) return taskEntryList(dir);
  if (name === FILES.project) return projectEntryList(dir);
  return [];
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

/**
 * The journal segments of one directory, oldest first, live file last.
 *
 * Delegates rather than re-deriving: the ordering rule below (highest number is oldest) is one
 * piece of rotation a second copy gets silently wrong, and this file's copy did — it also
 * matched `.bak` copies as segments. `ledger.js` owns the rule; the console borrows it.
 */
function segmentsOf(dir) {
  return journalFilesIn(dir);
}

/** Whether a ledger directory is one of ours: it holds at least one recognised file. */
function looksLikeLedger(dir) {
  if (LEDGER_FILES.some((name) => statOf(path.join(dir, name)) !== undefined)) return true;
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir).some((name) => isJournalSegment(name));
  } catch {
    return false;
  }
}

/**
 * What the journal proves actually happened, by kind.
 *
 * The journal is the only file here that records *events* rather than conclusions, so it is the
 * only place the console can get "how often did this ledger speak up" from. Counting is by
 * kind rather than by reading lines into objects: a six-megabyte journal parses into thousands
 * of objects and the page only needs totals, and the totals are what tells a user whether a
 * ledger is alive (thousands of trigger hits) or inert (a handful of writes).
 *
 * Cached per directory against the segments' sizes and mtimes, because the console rebuilds
 * every ledger's numbers on each page load and a busy journal is megabytes of text.
 * @param dir - the resolved ledger directory.
 * @returns per-kind counts, the derived totals the page shows, and the journal's time span.
 */
const journalStatsCache = new Map();
const KIND_RE = /"kind":"([a-z_]+)"/gu;
const SESSION_RE = /"session":"([^"]*)"/gu;
const TS_RE = /"ts":"([^"]*)"/gu;

function journalStats(dir) {
  const segments = segmentsOf(dir).filter((file) => statOf(file) !== undefined);
  const signature = segments
    .map((file) => {
      const info = statOf(file);
      return `${path.basename(file)}:${info.bytes}:${info.mtime}`;
    })
    .join('|');
  const cached = journalStatsCache.get(dir);
  if (cached !== undefined && cached.signature === signature) return cached.value;

  const byKind = {};
  const sessions = new Set();
  /**
   * The triples that could each have produced one notice: `(session, source, heading)`.
   *
   * `fired` counts matches, and a match is written per entry per command — so one entry whose
   * `trigger:` is `^` adds a line to every command ever run, and a fact filed twice in one ledger
   * adds two. Measured 2026-10-22 on this host: PetDock's 9431 raw matches came from 225 entries
   * over 27 sessions, and a third of them were one `^` entry stored under two headings. The guard
   * itself only *speaks* once per entry per session (`announce`, `lib/pit-guard.js:431`), so the
   * deliverable count is the number of distinct triples — that is what the page shows first now.
   */
  const notices = new Set();
  let lines = 0;
  let blocks = 0;
  let firstAt = '';
  let lastAt = '';
  for (const file of segments) {
    const text = readText(file);
    if (text.length === 0) continue;
    const rows = text.split('\n');
    lines += rows.filter((line) => line.trim().length > 0).length;
    for (const match of text.matchAll(KIND_RE)) byKind[match[1]] = (byKind[match[1]] ?? 0) + 1;
    for (const match of text.matchAll(SESSION_RE)) sessions.add(match[1]);
    for (const match of text.matchAll(TS_RE)) {
      if (firstAt === '') firstAt = match[1];
      lastAt = match[1];
    }
    for (const line of rows) {
      if (!line.includes('trigger_hit') && !line.includes('file_hit') && !line.includes('trigger_block')) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event === null || typeof event !== 'object') continue;
      // A refusal is delivered every time it happens — it is the tool result, not a queued
      // notice — so it is counted rather than de-duplicated.
      if (event.kind === 'trigger_block') {
        blocks += 1;
        continue;
      }
      if (event.kind !== 'trigger_hit' && event.kind !== 'file_hit') continue;
      // `source` is absent from `file_hit` events written before 2026-10-22; those collapse per
      // session, which under-counts only where one heading exists in both ledgers.
      notices.add(`${event.session ?? ''}\u0001${event.source ?? ''}\u0001${event.heading ?? ''}`);
    }
  }
  const count = (kind) => byKind[kind] ?? 0;
  const value = {
    lines,
    sessions: sessions.size,
    firstAt,
    lastAt,
    byKind,
    totals: {
      /**
       * How often the ledger actually spoke up: at most one per entry per session, plus every
       * refusal. This is the number to read as "它生效了多少次".
       */
      notices: notices.size + blocks,
      /**
       * Raw matches, one per entry per command or edit. Kept because it is the only number that
       * shows a broad `trigger:` (or a twice-filed entry) doing damage, and `pit-liveness` needs
       * to know a coordinate has matched at all.
       */
      fired: count('trigger_hit') + count('file_hit') + count('trigger_block'),
      triggerHit: count('trigger_hit'),
      fileHit: count('file_hit'),
      blocked: count('trigger_block'),
      /** Entries actually written into the ledger's own files. */
      records: count('mistake') + count('decision') + count('verified') + count('task') + count('project') + count('init'),
      mistakes: count('mistake'),
      decisions: count('decision'),
      verified: count('verified'),
      tasks: count('task'),
      project: count('project'),
      /** What the ledger admits it did not record, and what is waiting on a restart. */
      unrecorded: count('mistake_unrecorded'),
      unverified: count('unverified'),
      restartPending: count('restart_pending'),
    },
  };
  journalStatsCache.set(dir, { signature, value });
  return value;
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
  return {
    counts: { mistakes, decisions, tasksActive: tasks.active, tasksDone: tasks.done, projectFields: project },
    files,
    bytes,
    lastWrite,
    stats: journalStats(dir),
  };
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
    // "Pointed at" is the same question `resolveLedgerDir()` answers: given this project, is
    // *this* the directory its ledger is read from? The pointer's payload is the project path,
    // never the store path, so comparing the raw pointer to `dir` would flag every migrated
    // project as stray. Since 2026-10-18 the store is found by its `project-root` marker as
    // well, so a migrated project with no pointer left is healthy rather than red.
    //
    // Resolved without side effects on purpose: this runs on every inventory, and the writing
    // variant of this check is what deleted four freshly written pointers during the
    // migration (see `resolveLedgerDir`).
    const resolved = owner === undefined ? '' : resolveLedgerDir(owner, SCOPE.project);
    const pointedAt = owner !== undefined && fs.existsSync(owner) && samePath(resolved, dir);
    if (owner !== undefined && fs.existsSync(owner) && !pointedAt) health.push('not-pointed-at');
    const localDir = owner === undefined ? undefined : path.join(owner, DIRNAME);
    if (localDir !== undefined && looksLikeLedger(localDir) && !samePath(resolved, dir)) health.push('repo-copy-also-live');
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
    /** What it was called where it used to live — the shorter of the two names the page shows,
     *  and the one a user is most likely to type back. */
    originalName: typeof manifest.originalDir === 'string' ? path.basename(manifest.originalDir) : '',
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
          stats: { lines: 0, sessions: 0, firstAt: '', lastAt: '', byKind: {}, totals: {} },
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
    const entries = entriesFor(entry.dir, name, kept.join('\n'));
    return {
      name,
      text: kept.join('\n'),
      bytes: text.length,
      truncated: kept.length < lines.length,
      segments: segments.map((file) => path.basename(file)),
      lines: lines.length,
      entries,
      entryCount: entries.length,
    };
  }
  const text = readText(path.join(entry.dir, name));
  const entries = entriesFor(entry.dir, name, text);
  return {
    name,
    text: text.length > VIEW_CHARS ? `${text.slice(0, VIEW_CHARS)}\n… (仅显示前 ${VIEW_CHARS} 字符)` : text,
    bytes: text.length,
    truncated: text.length > VIEW_CHARS,
    segments: [],
    entries,
    entryCount: entries.length,
  };
}

/**
 * Copy one ledger file into the ledger's own entry trash before an entry edit.
 * @returns the backup file path, so the page can tell the user where the old bytes are.
 */
function backupEntryFile(dir, name, stamp) {
  const backupDir = path.join(dir, ENTRY_TRASH_DIR);
  fs.mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, `${name}.${stamp}`);
  fs.copyFileSync(path.join(dir, name), target);
  return target;
}

/** Which segment and line one kept journal index names. */
function journalTarget(dir, index) {
  const files = segmentsOf(dir).filter((file) => statOf(file) !== undefined);
  const all = [];
  for (const file of files) {
    readText(file)
      .split('\n')
      .forEach((line, lineIndex) => {
        if (line.trim().length > 0) all.push({ file, line: lineIndex });
      });
  }
  const offset = Math.max(0, all.length - JOURNAL_TAIL_LINES);
  const target = all[offset + index];
  if (target === undefined) throw new Error(`no journal entry at index ${index}`);
  return target;
}

/** Remove one `## ` block while preserving the bytes around it. */
function dropMarkdownBlock(text, index) {
  const parts = String(text).split(/\n(?=## )/u);
  const at = (parts[0].startsWith('## ') ? 0 : 1) + index;
  if (at >= parts.length) throw new Error(`no markdown entry at index ${index}`);
  const removed = parts[at];
  parts.splice(at, 1);
  return { next: parts.join('\n'), removed };
}

/**
 * Delete one entry of one ledger file.
 *
 * The unit the page shows is the unit the page can remove: one `## ` block, one task, one
 * project field, or one journal line. The pre-edit file is copied to
 * `<ledger>/.entry-trash/<file>.<stamp>` first — this is the one place in the console where
 * a write is not a rename, so the old bytes have to stay reachable. A ledger with a live
 * writer is refused: rewriting a file under a session that is appending to it would lose
 * that session's record.
 *
 * @returns `{ ok, id, file, index, removed, backup }` — `removed` is the entry as the page
 *   rendered it and `backup` is the pre-edit copy's path.
 */
export function removeEntry(id, file, index, options = {}) {
  const entry = resolveLedger(id, options);
  if (entry === undefined) throw new Error(`no ledger with id ${JSON.stringify(String(id))}`);
  if (!LEDGER_FILES.includes(file)) {
    throw new Error(`refusing to edit ${JSON.stringify(String(file))}: not one of ${LEDGER_FILES.join(', ')}`);
  }
  if (lockedNow(entry.dir)) throw new Error('有会话正在写这个账本，先停掉那个会话再删条目');
  const position = Number(index);
  if (!Number.isInteger(position) || position < 0) throw new Error('entry index must be a non-negative integer');
  const parsed = readLedgerFile(id, file, options);
  if (position >= parsed.entries.length) throw new Error(`no entry at index ${position} in ${file}`);
  const removed = parsed.entries[position];
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  let backup;

  if (file === FILES.journal) {
    const target = journalTarget(entry.dir, position);
    backup = backupEntryFile(entry.dir, path.basename(target.file), stamp);
    const lines = readText(target.file).split('\n');
    lines.splice(target.line, 1);
    fs.writeFileSync(target.file, lines.join('\n'), 'utf8');
  } else {
    backup = backupEntryFile(entry.dir, file, stamp);
    const target = path.join(entry.dir, file);
    const text = readText(target);
    if (file === FILES.mistakes || file === FILES.decisions) {
      fs.writeFileSync(target, dropMarkdownBlock(text, position).next, 'utf8');
    } else if (file === FILES.tasks) {
      const board = JSON.parse(text);
      const active = Array.isArray(board?.active) ? board.active : [];
      const done = Array.isArray(board?.done) ? board.done : [];
      if (position < active.length) active.splice(position, 1);
      else done.splice(position - active.length, 1);
      board.active = active;
      board.done = done;
      fs.writeFileSync(target, `${JSON.stringify(board, null, 2)}\n`, 'utf8');
    } else if (file === FILES.project) {
      const record = JSON.parse(text);
      const key = Object.keys(record)[position];
      if (key === undefined) throw new Error(`no entry at index ${position} in ${file}`);
      delete record[key];
      fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    }
  }
  return { ok: true, id, file, index: position, removed, backup };
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
 * Is the typed confirmation the same answer as one of the printed ones?
 *
 * Compared as *text a person typed*, not as a filesystem path: no `path.resolve`, so a stray
 * relative string can never be folded into the ledger's location against the process cwd.
 * What is folded away is what a person may reasonably retype differently — surrounding
 * whitespace, `/` instead of `\` on Windows, a trailing separator, and (Windows only) letter
 * case.
 */
function sameAnswer(printed, typed) {
  const fold = (value) => {
    const raw = String(value ?? '').trim();
    if (process.platform !== 'win32') return raw;
    return raw.replace(/\//g, '\\').replace(/[\\/]+$/u, '').toLowerCase();
  };
  const left = fold(printed);
  const right = fold(typed);
  return left.length > 0 && left === right;
}

/**
 * Delete a trashed ledger for good.
 *
 * The only irreversible act in this module, so it takes a name as the confirmation: a UI
 * that asks "are you sure" can be dismissed by reflex, and a name that has to be typed
 * cannot be sent by a page that did not show the user which one it was about to remove.
 *
 * Four answers are accepted, and all four are printed on the card: the trash directory's
 * current name, its original name, and either of the two full paths the page displays. They
 * all identify this one ledger, so the confirmation still cannot be sent for a ledger the
 * user was not shown — while a page that shows the *old* path (which is what a user reads
 * first) is no longer punishing them for typing what they were looking at.
 */
export function purgeTrash(id, confirm, options = {}) {
  const record = resolveTrash(id, options);
  if (record === undefined) throw new Error(`no trashed ledger with id ${JSON.stringify(String(id))}`);
  const current = path.basename(record.dir);
  const original = typeof record.originalName === 'string' && record.originalName.length > 0 ? record.originalName : path.basename(record.originalDir ?? '');
  const accepted = [current, original, record.dir, record.originalDir].filter((value) => typeof value === 'string' && value.length > 0);
  if (!accepted.some((value) => sameAnswer(value, confirm))) {
    throw new Error(`refusing to purge: type its directory name (${current}) or its original location to confirm`);
  }
  fs.rmSync(record.dir, { recursive: true, force: true });
  return { ok: true, purged: record.dir, bytes: record.bytes, files: record.files.map((file) => file.name) };
}

/** Re-exported so a caller can name the journal segments of a resolved ledger without resolving again. */
export { journalFilesIn };
