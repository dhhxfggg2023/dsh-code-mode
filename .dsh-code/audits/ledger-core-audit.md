# Audit — `lib/ledger.js` (2442 lines), core of the code-mode / code-ledger plugin pack

> **Status as of 2026-10-04, later the same day: every finding below has been fixed.** This report
> is kept as the record of what was wrong and how each claim was proved — its findings are written
> in the present tense and are **not** a list of live defects.
>
> Fixes: commit `07a4eb4` (the tree's first commit) carried the twelve that were already closed
> when this report was written — F1, F3/F7, F4, F5, F8, F9, F10, F11, F13, F14; commit `5f571ee`
> closed the last two, F2 and F6.
>
> Two of those fixes came with the probe that would have caught them, because the ledger's own
> record says a fix is not fixed until something would notice a regression:
> `probes/pattern-budget-probe.mjs` (F2 — it asserts the bound *fires*, since the sibling cure in
> `pit-guard` had once been "verified" with a pattern that returned in 0 ms without the bound ever
> running) and `probes/repeat-identity-probe.mjs` (F6 — which pins both directions: unrelated pits
> must stop merging, and a genuine repeat must still merge, because an over-exact identity would
> have replaced data loss with ledger bloat). Both are in `debt-audit`'s `RUNNABLE` list.
>
> F2 was still reproducible when the second commit was written: `code_brief({topic})` took
> **21,432 ms** on a 26-character topic and never returned at 34; it now returns in ~7 ms while a
> normal recorded trigger still matches (probe P3a).

Audited: `E:\projects\dsh-code-mode\lib\ledger.js` @ 2026-10-04, plus the call sites in
`lib/tool-brief.js`, `lib/tool-record.js`, `lib/tool-verify.js`, `lib/gate-verify.js`,
`lib/pit-guard.js` where they decide reachability.

Method: every finding below was produced by running a probe that imports the **real**
`lib/ledger.js` (`await import(pathToFileURL(<pkg>/lib/ledger.js).href)` — the module imports
only node builtins, so plain node is enough). Fixtures live in `os.tmpdir()`;
`DSH_CODE_GLOBAL_DIR` is redirected to a hermetic temp dir before the first read, so no probe
touches the developer's real `~/.dsh-code/`. Probe 07 hashes every file in the live
`.dsh-code/` before and after its read-only run and reports `changed: []`.

Probes are in `.dsh-code/audits/`. Re-run any of them with:

```
& 'E:\tools\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' '<pkg>\.dsh-code\audits\NN-*.mjs'
```

The decisive runs were repeated through `code_verify`, so the exit code and the full output are
in `.dsh-code/journal.jsonl`.

**Leftovers, on purpose:** `09b-race-child.mjs`, `10b-race-bigfile-child.mjs` and
`11b-holder.mjs` are helper scripts written by the *first* version of probes 09/10/11, before
they were moved to write their helper in `os.tmpdir()`. `99-cleanup-stale-helpers.mjs` tries to
remove them and cannot: `FAILED: 09b-race-child.mjs -> EPERM` (all three), because **a tool
channel cannot delete a file inside an existing workspace subdirectory** — the project's own
recorded pit, confirmed again here under `danger-full-access`. They are unreferenced by every
current probe; delete them by hand in an unrestricted terminal if they bother you.

**Channel facts measured while doing this** (they cost time and are worth recording):

- `code_verify`'s shell **cannot create a file inside an existing workspace subdirectory**
  (`EPERM ... open '<pkg>\.dsh-code\audits\08b-redos-child.mjs'`, reported as
  `[sandbox denied this command under the session's current file policy]`), while the `pwsh`
  channel can. Probes that write their helper script next to themselves therefore fail there;
  the four spawn-based probes now write their helper into `os.tmpdir()` and run in both channels.
- `code_verify`'s shell **cannot spawn a child whose stdio is piped** (`spawnSync` returned in
  1 ms with `timedOut=false` and no marker file), but `stdio: 'inherit' | 'ignore'` spawns work.
  This is the recorded machine pit, still true under `danger-full-access`.

---

## Findings

| id | severity | one-line claim | evidence (command → observed) |
|----|----------|----------------|-------------------------------|
| F1 | breaks-a-turn | A `tasks.json` that **parses** but is not a board (`null`, `"oops"`, `42`, `true`, `["oops"]`, `[7]`) makes `readTasks` throw, so `code_brief` **and** `code_record(progress)` die — and `preserveCorruptFile` never fires because the JSON was valid | `code_verify node .dsh-code\audits\01-tasks-json-parseable-malformed.mjs` → `THROWING VARIANTS: null document \| string document \| number document \| boolean document \| string inside active \| number inside done`; `SUMMARY: 6/10 variants … TypeError`; `.corrupt-* sidecar: false` for all six |
| F2 | breaks-a-turn | A recorded `trigger:` (or a caller's `re:` expect) is compiled and executed with no backtracking bound: `new RegExp(trigger,'i').test(query)` | `code_verify … 08-redos.mjs` → `brief(topic of 26 a's) timedOut=false after 4660 ms`; `brief(topic of 34 a's) -> timedOut= true after 25018 ms \| stages: ["imported","calling-brief"]`; `matchesExpectation('re:(a+)+$', 34 a's) -> timedOut= true after 25017 ms` |
| F3 | breaks-a-turn (+ unbounded disk leak, + the lost record) | The merge path's `writeFileAtomic` takes **no lock** and renames onto the ledger file; if any other process holds that file open the rename fails with `EPERM`, the exception escapes `recordMistake`, and the temp file is left behind | `code_verify … 11-rename-blockers.mjs` → `no holder (control) \| OK \| false`, `fs.openSync(file, "r") \| EPERM: ... \| true`, `fs.openSync(file, "a") — append handle, idle \| EPERM: ... \| true`; end-to-end `code_verify … 10-merge-race-bigfile.mjs` → `merge : error=EPERM: EPERM: operation not permitted, rename …`, `journal lines recording a mistake: 1 (the merge would add one more)`, `temp files left in the ledger dir: ["mistakes.md.tmp-27288"]` (25,257,485 B on disk, verified with `Get-ChildItem`) |
| F4 | wrong-output (the notice is silently lost) | Rotation writes the **newest** content to `.000` while every reader concatenates ascending as oldest-first, so from the 2nd rotation on the journal is chunk-reversed | `code_verify … 02-journal-segment-order.mjs` → `journal.jsonl.000 first=…45.613Z last=…45.614Z`, `journal.jsonl.001 first=…45.607Z`, `adjacent lines whose ts goes BACKWARDS: 1`; `TRUTH … restart IS still pending = true`, `restartPending() answered: undefined <-- NOTICE SILENTLY DROPPED`; `## Recent ledger entries` shows `OLD-SEGMENT` lines, `mentions NEW-SEGMENT: false` |
| F5 | wrong-output (a bound that stops bounding) | The shift loop only ever fills `.000`–`.008`; once `.008` exists every shift is blocked and `rotateJournal` refuses forever, so the live journal grows without bound and every reader concatenates and parses all of it | `code_verify … 03-rotation-saturation.mjs` → rounds 1-9 create `.000`…`.008`; rounds `10/11/12` → `count= 9 max=journal.jsonl.008` with live `543195 / 543293 / 543391` bytes against a `524288` threshold; `readJournalText() … 5431412 chars`; `rotation still works at the end: false` |
| F6 | loses-data (a distinct pit is folded into another) | Merge identity is a 60-char slug over `[a-z0-9\u4e00-\u9fff._-]`, so two different symptoms can share one heading: the second pit merges into the first, its `do not repeat:` rule never reaches `mistakes.md`, and a topic search for its own symptom text finds nothing | `code_verify … 04-slug-collapse-merge.mjs` → `slug("Ошибка при сборке проекта") = "mistake"`; two unrelated pure-Cyrillic symptoms → `second recordMistake -> merged=true recurred=1`, `mistakes.md entries: 1`, `second pit's rule present in mistakes.md: false`, `mistakes section present for that topic: false`; and for a 60-char prefix collision `B: merged=true … "bravo rule kept" reachable from mistakes.md: false` |
| F7 | loses-data (silent, concurrent) | Two concurrent merges both rewrite from their own snapshot: two recorded repeats collapse to one visible increment, because the merge path is not serialized by the lock the append path takes | `code_verify … 10-merge-race-bigfile.mjs` → `merge A: merged=true`, `merge B: merged=true`, `journal recorded 2 mistake line(s) with recurred=[1,1]`, `file says recurred=1 <-- count does not reflect two repeats` |
| F8 | wrong-output (content duplication + file growth) | `headerOf` treats everything before the first `\n## ` as a header, so in a `mistakes.md` that starts with an entry the merge re-emits entry #1 — the stale copy — on every repeat | `code_verify … 05-merge-header-duplication.mjs` → header-present control `entries after 1st=3 after 2nd=3`; `entry first, NO header line … after 1st=3 after 2nd=4` with headings `[…alpha-something, …alpha-something, …]` and `'alpha something happened' occurrences: 3` (was 2); same with a BOM |
| F9 | wrong-output (a mode that cannot do what it says) | `allocateSectionBudget` compares `pool` (budget **minus** reserve) against `UNCAPPED_TOTAL`, and `briefFull` passes exactly `UNCAPPED_TOTAL` — so the ceilings branch can never be taken by the caller that exists to take it, and `code_brief({full:true})` silently behaves like a normal brief | `code_verify … 06-budget-invariants.mjs` → `briefFull() -> 5816 chars, project body 704` vs `brief(maxChars: 20000) -> 6803 chars, project body 1691`; `briefFull lifts the division: false`. Threshold measured by `code_verify … 12-settle-and-caps.mjs`: `8800→676, 8900→676, 8948→1761` |
| F10 | wrong-output (low reachability) | `isAncestorOrSelf` is a prefix comparison of segments, so a **relative** edit target can never match an **absolute** proof cwd — although the code says it can — and the unsettled debt is then described with a false statement | `code_verify … 12-settle-and-caps.mjs` → A/B: `ABSOLUTE target (inside the project the proof ran in) … settled by that proof: true`; `RELATIVE target 'edit lib/ledger.js' … settled by that proof: false` + `… it neither ran in their project subtree nor named their files … (latest: 2026-10-01 00:10 'pnpm test')` |
| F11 | loses-data (low reachability) | `recordTask`'s `slice(0, CAP.tasks)` silently drops the oldest task once a list holds 40 — no journal line, no notice, nothing in the brief | `code_verify … 12-settle-and-caps.mjs` → `tasks created: 41; board holds active=40`, `tasks created but absent from the board: ["2026-10-04-open-task-number-1"]`, `the journal mentions the dropped task as removed: false`, `the brief says anything about the dropped task or a cap on the board: false` |
| F12 | cosmetic | `today()` is a UTC date, so on this host (UTC+8) every record written between 00:00 and 08:00 local carries yesterday's date in its heading, task id and `- last:` line | `code_verify … 07-live-ledger-readonly.mjs` → `utc offset = 480 min`, `hours per local day where today() names YESTERDAY: 8 (00:00-08:00 local)` |
| F13 | cosmetic | `truncate` slices at arbitrary UTF-16 offsets, so a cut can land inside a surrogate pair and emit a lone surrogate (reachable through `shellResult` and `tool-verify`'s `truncate(output, 1500)` → the journal's `tail`) | `code_verify … 13-input-tolerance.mjs` → `truncate('😀'x20, 5) -> 29 chars, lone surrogates: 1`, same for limits 9 and 21 |
| F14 | wrong-output (a duplicate id on the board) | A task sitting in `done` cannot be located: `recordTask` searches `active`+`blocked` only, so moving a done task **by id is refused** while its id is listed in the refusal as "on the board", and moving it **by title creates a second task with the same id** | `code_verify … 14-done-task-not-findable.mjs` → `created done … move by id -> REFUSED: … no task on the board matches "2026-10-04-finish-the-parser" … board now active=0 done=1 blocked=0`; `move by title -> ok … board now active=0 done=1 blocked=1 duplicates=true ids=["2026-10-04-finish-the-parser","2026-10-04-finish-the-parser"]`; the active control moves cleanly by both id and title. Also hit for real in this session: `code_record(kind=progress, task=<exact title of a task I had just created as done>, status=done)` → `no task on the board matches …; on the board: <two other tasks>` |

Severity counts: **breaks-a-turn 3** (F1, F2, F3) · **loses-data 3** (F6, F7, F11) ·
**wrong-output 6** (F4, F5, F8, F9, F10, F14) · **cosmetic 2** (F12, F13).

---

## F1 — a `tasks.json` that parses but is not a board kills both task tools

```js
1084: function normalizeBoard(board) {
1085:   if (board === undefined) return board;
1086:   for (const key of ['active', 'done', 'blocked']) if (!Array.isArray(board[key])) board[key] = [];
...
1090:     for (const task of board[key]) {
1091:       if (task === undefined || task === null || seen.has(task)) continue;
...
1094:       task.status = status;
1105: export function readTasks(cwd) {
1106:   return normalizeBoard(readJson(ledgerPath(cwd, 'tasks'), undefined));
1107: }
```

`readJson` (524-530) catches only a **parse** failure. `null` reaches line 1086 and
`board[key]` throws `Cannot read properties of null (reading 'active')`; a string/number/boolean
reaches the assignment on 1086 and throws `Cannot create property 'active' on string 'oops'`
(this is an ES module, so the implicit strict mode applies); a string or number **inside** an
array reaches 1094 and throws `Cannot create property 'status' on string 'oops'`.
`readTasks` is called by `brief` (372, via `boardSummary` 1882) and by `recordTask` (1180) —
before `preserveCorruptFile` can run (1184), which is itself only reached for *unparseable*
JSON. So the file is never set aside and the tool cannot repair it: `code_brief` fails on every
call and `code_record(kind="progress")` fails with the same TypeError.

Reproduction (probe 01): 10 fixtures, each an initialized ledger whose `tasks.json` was
overwritten with one variant; `readTasks`, `brief` and `recordTask` are called and the
`.dsh-code` directory is listed for a `.corrupt-*` sidecar. Result: 6/10 throw, 0 sidecars.
Array documents and `{"active":[null]}` degrade (they read as empty lists).

Fix would touch: `normalizeBoard` — guard the document (`if (board === null || typeof board !== 'object') return undefined`) and skip non-object elements at 1090-1094; or `readTasks` —
validate the parsed value and route a non-board to the `preserveCorruptFile` path `recordTask`
already has. Refuted? No: reachable from a hand edit, a truncated-but-valid write
(`null` is a legitimate JSON document), or any other writer of that file; demonstrated on the
real readers, not a re-implementation.

## F2 — an unbounded regex from the ledger (or from `expect`) hangs the turn

```js
2117:         if (trigger !== undefined) {
2118:           try {
2119:             patternHit = new RegExp(trigger, 'i').test(query);
2120:           } catch {
2121:             patternHit = false;
2122:           }
2123:         }
...
2434:   if (needle.startsWith('re:')) {
2435:     try {
2436:       return new RegExp(needle.slice(3), 'm').test(output);
2437:     } catch {
2438:       return output.includes(needle.slice(3));
2439:     }
```

The `try` catches a pattern that does not compile; it does not bound a pattern that compiles
and backtracks. `searchEntries` searches the project's *and* the machine's mistakes and
decisions, so one recorded `trigger:` is executed on every `code_brief({topic})` call whose
topic also appears in that entry's text; `matchesExpectation` does the same with the caller's
`expect`, which `code_verify` passes straight through (`tool-verify.js:95`). The write side
checks compilation only (`tool-record.js:226`), so `(a+)+$` is accepted and recorded.

Reproduction (probe 08): a fixture `mistakes.md` entry whose symptom contains
`'a'.repeat(34) + '!'` and whose `trigger:` is `(a+)+$`; the topic is that same 35-character
fragment. In-process cost grows ~4× per two extra characters (14 a's 1.1 ms → 24 a's 141 ms);
through the real `brief()`: 18 a's 61 ms, 22 a's 332 ms, **26 a's 4660 ms**, 34 a's never
returns (killed at 25 s with the child's marker at `calling-brief`). `matchesExpectation` with
the same pattern and input also never returns.

Fix would touch: `searchEntries` (2119) and `matchesExpectation` (2436) — bound the subject
(e.g. test a truncated query/output) or the pattern, reject nested quantifiers at write time in
`tool-record.js`, or run the test in a worker with a timeout. `pit-guard.js:214` has the same
shape on a *hotter* path (every run-tool command line, every recorded trigger); I did not
reproduce it separately (labelled unverified below).

Refuted? Partly, and the refutation is the honest part of this finding: it needs a recorded
pathological pattern, and today's ledger has none — the live `mistakes.md` holds 7 triggers
(`node\s+(-e|--eval)|python\s+-c`, `ELECTRON_RUN_AS_NODE`, `installResolution`, …), all benign.
The hazard is latent, not live.

## F3 / F7 — the merge path takes no lock: EPERM + a leaked temp file, and silent lost updates

```js
1304:   const priorIndex = existing.findIndex((block) => block.split('\n', 1)[0].trim().endsWith(`· ${pitSlug}`));
...
1316:     const header = headerOf(readFile(file));
1317:     writeFileAtomic(file, `${header.length === 0 ? '' : `${header}\n\n`}${next.join('\n\n')}\n`);
...
1378: /** Write a whole ledger file without ever leaving it half-written. */
1379: function writeFileAtomic(file, text) {
1380:   const temp = `${file}.tmp-${process.pid}`;
1381:   fs.writeFileSync(temp, text, 'utf8');
1382:   fs.renameSync(temp, file);
1383: }
```

The append path serializes itself (`appendBlock` 606 → `appendLocked` 625-667, lock file
`<file>.lock`); the merge path above does **not** take that lock, and `renameSync` onto a file
another process holds open fails on Windows (`MoveFileEx` without a share-delete grant). There
is no `try/finally`, so the temp file survives the failure. The previous audit's C1 ("does the
merge path hold the lock?") was left *unproven* by `probes/audit-verify-probe.mjs` E1, which
correctly noted it needs two processes. These two probes are that missing proof, plus a failure
mode E1 could not see.

Reproduction A (deterministic, probe 11): hold the destination open from a second process and
perform exactly what `writeFileAtomic` does.

```
no holder (control)                      | OK            | false
fs.openSync(file, "r")                   | EPERM: ...    | true
fs.openSync(file, "r+")                  | OK            | false
fs.openSync(file, "a") — append handle, idle | EPERM: ... | true
another process appending in a loop      | OK / EPERM   | (intermittent: `appendFileSync` closes between calls)
```

Reproduction B (end-to-end, probe 10): a 24.1 MB / 91,382-entry `mistakes.md`, one process
merging a repeat, one appending a new pit (released 40 ms into the merge's ~150 ms
read→rename window via a rendezvous). The merge threw
`EPERM: operation not permitted, rename '…\mistakes.md.tmp-27288' -> '…\mistakes.md'`;
the journal holds only the append (`journal lines recording a mistake: 1 (the merge would add
one more)`); `mistakes.md.tmp-27288` (25,257,485 B) was left next to the ledger file. Probe 09
measures the window at ordinary sizes (merge 4-12 ms, append 2-10 ms) and honestly **could not**
lose an append there in 5 pairs (0/5) — the sub-millisecond overlap needed is not reliably
reachable without widening the window, which is why the deterministic probe 11 and the 24 MB
probe 10 carry this finding.

Reproduction C (lost update, probe 10): two merges released together on the same fixture. Both
succeed, `journal recorded 2 mistake line(s) with recurred=[1,1]`, and
`file says recurred=1` — two repeats of a pit are visible as one increment, which is exactly the
signal the merge exists to accumulate. No error, no notice.

Fix would touch: `recordMistake`'s merge branch — take `appendLocked`'s lock around
read+rewrite (or reuse a shared `rewriteLocked`), wrap `writeFileAtomic` in `try/finally` that
unlinks `temp`, and retry the rename once. `writeFileAtomic` is called only from 1317, so the
blast radius is one call site.

## F4 — rotation writes `.000` = newest, readers read `.000` first

```js
 678:  * @returns absolute paths, oldest segment first, the live file last.
 689:   const rotated = names
 690:     .filter((name) => name.startsWith(`${live}.`) && !name.endsWith('.lock'))
 691:     .sort()
 692:     // `journal.jsonl.000` … `journal.jsonl.009`: string sort is chronological because
 693:     // the width is fixed, which is why the index is padded rather than zero-prefixed.
 694:     .map((name) => path.join(dir, name));
 695:   return [...rotated, path.join(dir, live)];
...
 741:   for (let index = JOURNAL_KEEP - 1; index >= 0; index -= 1) {
 742:     const from = path.join(dir, `${base}.${String(index).padStart(3, '0')}`);
 743:     const to = path.join(dir, `${base}.${String(index + 1).padStart(3, '0')}`);
 744:     if (!fs.existsSync(from)) continue;
 745:     try {
 746:       if (!fs.existsSync(to)) fs.renameSync(from, to);
...
 751:   const target = path.join(dir, `${base}.000`);
 752:   try {
 753:     if (fs.existsSync(target)) return undefined; // shift failed; stay on the live file
 754:     fs.renameSync(file, target);
```

`.000` receives the file that was live — i.e. the newest content — while `.001`… hold older
content, so ascending order is *reverse* chronological and `readJournalText` (709-720) returns
the segments in that order.

Reproduction (probe 02): fixture rotated twice through the real `journalEvent`; markers
`OLD-SEGMENT` / `NEW-SEGMENT` make the order visible, and the ledger's own `ts` fields are the
independent truth. Observed: `.000 first=…45.613Z`, `.001 first=…45.607Z`,
`adjacent lines whose ts goes BACKWARDS: 1`; the newest event pair is
`session_start 13:16:45.608Z` (in `.001`) and `restart_pending 13:16:45.613Z` (in `.000`), so
`restartPending` — which scans backwards (982-996) — hits the *older* `session_start` first and
answers `undefined`: **a dormant `lib/` change is reported as settled**, the exact failure the
function's own comment says two earlier attempts had. The same inversion makes the briefing's
`## Recent ledger entries` show the oldest segment's tail and omit the newest
(`mentions OLD-SEGMENT: true; mentions NEW-SEGMENT: false`).

Today's live ledger has had exactly **one** rotation, so it is still in order
(`.000` = 2026-10-02T04:20 → 2026-10-04T12:31; live = 12:35 → 13:20) — the defect is one
rotation away, not hypothetical: `journal.jsonl` is at 319,460 B of a 524,288 B threshold.

Fix would touch: either `rotateJournal` (name the new segment with the *highest* index and shift
the rest down) or `journalFiles` (return `rotated.reverse()`), and the two comments then
disagree with the code either way; a probe should pin the order.

## F5 — rotation stops after nine segments

```js
  66: const JOURNAL_ROTATE_BYTES = 512 * 1024;
  67: const JOURNAL_KEEP = 8;
...
 741:   for (let index = JOURNAL_KEEP - 1; index >= 0; index -= 1) { … }
```

The loop can only ever move `.007` → `.008`, so once `.008` exists every `to` is occupied, the
loop moves nothing, `.000` is still occupied at 753, and `rotateJournal` returns `undefined` —
permanently. `appendJournal` (761-766) then just appends to the live file, whose size is the
only thing rotation was protecting. The function's doc (57-64) promises "the cost of a read is
bounded by the segment size", and `JOURNAL_KEEP` is described as a guard against a pathological
writer, not as a stop.

Reproduction (probe 03): 12 rotations driven through the real API. Rounds 1-9 create
`.000`…`.008`; rounds 10, 11, 12 create nothing and the live file grows
`543195 → 543293 → 543391` bytes against the 524,288 threshold, with
`readJournalText() … 5431412 chars` that every in-module reader parses
(`unverifiedExcerpt`, `unrecordedMistakes`, `verifyCount`, `restartPending`, `factRecency`).
The live ledger has used 1 of those 9 rotations.

Fix would touch: `rotateJournal` — the last index needs an owner decision (drop the oldest
segment with a recorded notice, or raise `JOURNAL_KEEP` and let the shift reach it), and the
`.000 … .009` comment needs to match whatever is chosen.

## F6 — merge identity is a lossy 60-character slug, so different pits become one

```js
1110: export function slug(text, fallback = 'untitled') {
1111:   const s = String(text ?? '')
1112:     .trim()
1113:     .toLowerCase()
1114:     .replace(/[^a-z0-9\u4e00-\u9fff._-]+/g, '-')
1115:     .replace(/^-+|-+$/g, '')
1116:     .slice(0, 60);
1117:   return s.length > 0 ? s : fallback;
1118: }
...
1297:   const pitSlug = slug(symptom, 'mistake');
1298:   const signature = `## ${today()} · ${pitSlug}`;
1299:   const existing = markdownEntries(readFile(file));
1304:   const priorIndex = existing.findIndex((block) => block.split('\n', 1)[0].trim().endsWith(`· ${pitSlug}`));
```

Two separate collapses: (a) `.slice(0, 60)` — symptoms that agree for 60 slug characters are the
same pit; (b) the character class keeps only ASCII alphanumerics, `._-` and CJK — a symptom
written in Cyrillic, Greek, Hebrew, Arabic or accented Latin (with no Latin word or digit)
becomes the empty string and takes the `'mistake'` fallback, so **every** such symptom shares one
heading.

Reproduction (probe 04): two unrelated pure-Cyrillic symptoms —
`Ошибка при сборке проекта: сборка не начинается` and `Установка падает при запуске сервера` —
produce `merged=true recurred=1`, `mistakes.md entries: 1`, the second pit's rule
(`never install two plugins with disjoint peer ranges …`) absent from `mistakes.md`, and
`brief({topic: 'Установка падает при запуске'})` finds **nothing** (`mistakes section present
for that topic: false`). The 60-char variant is the same: `variant ALPHA` and `variant BRAVO`
share a slug, and `"bravo rule kept" reachable from mistakes.md: false`.

Honest reachability, because I refuted myself twice here: my first two attempts did **not**
merge — a digit (`шаге 3`) or a Latin word (`peer`) survives `slug()` and gives the two
symptoms different slugs. The collision needs both symptoms to be free of Latin letters and
digits. The live ledger has no colliding slugs today (probe 07: `symptom slugs that collide
with another entry: []`), so this is latent here and would bite a non-CJK, non-English project
immediately. Also note the tool *does* tell the writer `MERGED into the entry that already
describes this pit (now recurred 1×)` (`tool-record.js:284`), but for two unrelated pits that
sentence is false, and the second rule is then only in the journal — which nothing indexes by
rule.

Fix would touch: `slug` (use `\p{L}\p{N}` with the `u` flag, and stop truncating — or key the
merge on a hash of the full symptom) and `recordMistake`'s `priorIndex` match, which could
compare the stored `- symptom:` line instead of a derived heading.

## F8 — a `mistakes.md` without a header line duplicates its first entry on every merge

```js
1372: function headerOf(text) {
1373:   const first = String(text ?? '').indexOf('\n## ');
1374:   return (first === -1 ? '' : text.slice(0, first)).trim();
1375: }
...
1316:     const header = headerOf(readFile(file));
1317:     writeFileAtomic(file, `${header.length === 0 ? '' : `${header}\n\n`}${next.join('\n\n')}\n`);
```

`markdownEntries` (1934-1939) parses complete `## ` blocks; `headerOf` assumes everything before
the first `\n## ` is a header. When the file *starts* with an entry, that entry is both "the
header" and block #0, so the rewrite emits it twice — and the copy carried through `header` is
the stale one, because the updated copy came from `next[priorIndex]`.

Reproduction (probe 05): four fixtures, two repeats each of the same pit
(`- do not edit` … `# Mistakes` header present vs absent, each with and without a BOM).

```
header+entry (as initLedger writes it)   entries after 1st=3  after 2nd=3
entry first, NO header line              entries after 1st=3  after 2nd=4
BOM + header+entry                       entries after 1st=3  after 2nd=3
BOM + entry first, NO header             entries after 1st=3  after 2nd=4
```

and the duplicated entry's symptom text appears 3× instead of 2×, file 487 → 624 bytes. The
next repeat merges into the *first* (stale) copy again and duplicates it again, so the file grows
without bound while the entry count is wrong. `initLedger` always writes a `# Mistakes` line, so
this needs a hand-written or tool-written file that begins directly with an entry — plausible
for a file the mode documents as hand-editable Markdown.

Fix would touch: `headerOf` — return only the text before the first line that *starts* with
`## ` at offset 0 (i.e. treat a leading block as an entry), or have the merge rebuild the file
from `markdownEntries` plus an explicit preamble field.

## F9 — `briefFull` can never reach the ceilings branch it exists for

```js
 152: const UNCAPPED_TOTAL = 8900;
...
 172: function allocateSectionBudget(budget, reserved = 0) {
 173:   const keys = Object.keys(SECTION_BUDGET);
 174:   const pool = Math.max(1, budget - reserved);
...
 182:   if (pool >= UNCAPPED_TOTAL) for (const key of keys) allowance[key] = SECTION_BUDGET[key][1];
...
 802: export function briefFull(cwd, { session } = {}) {
 803:   return brief(cwd, { session, maxChars: UNCAPPED_TOTAL });
 804: }
```

`brief` always reserves at least `24 * ceil(8/4) = 48` characters
(`reserve`, 323-326), so `pool = 8900 - 48 - hint - restartNotice < UNCAPPED_TOTAL` for the one
caller that passes `UNCAPPED_TOTAL`. `briefFull`'s doc (787-797) and the tool's `full` parameter
describe exactly the branch that never runs ("Lift the per-section division and show every whole
entry a section can hold").

Reproduction (probe 06B/12B): a fixture whose sections have content to spend. Project body by
`maxChars`: `8800 → 676`, `8900 → 676`, **`8948 → 1761`**, `20000 → 1761` (1761 is that
section's practical celling; its allowance jumps from a divided share to its 1700 ceiling).
`briefFull() -> 5816 chars, project body 704` vs `brief(maxChars: 20000) -> 6803 chars, project
body 1691`; `briefFull lifts the division: false`. With a hint present the threshold is higher
still (the hint's own length is reserved too).

Fix would touch: line 182 (`budget >= UNCAPPED_TOTAL`) or line 803 (pass
`UNCAPPED_TOTAL + reserve`, e.g. `2 * UNCAPPED_TOTAL`), and whichever is chosen, the comment at
151-152 should say what it actually means.

## F10 — a relative edit target can never be settled structurally

```js
1549: function isAncestorOrSelf(candidate, target) {
1550:   const a = pathSegments(candidate);
1551:   const b = pathSegments(target);
1552:   if (a.length === 0 || b.length === 0) return false;
1553:   const short = a.length <= b.length ? a : b;
1554:   const long = a.length <= b.length ? b : a;
1555:   return short.every((segment, index) => segment === long[index]);
1556: }
...
1574:   if (typeof proof.cwd === 'string' && proof.cwd.trim().length > 0) {
1575:     const base = comparablePath(proof.cwd);
1576:     // A recorded `cwd` is a path, so segment containment is an ancestor
1577:     // relationship even when one side is absolute and the other relative
1578:     // (`e:/projects/p/lib/x.js` vs `lib/x.js`).
1579:     if (base.length > 0 && isAncestorOrSelf(base, path)) return true;
```

The comparison is anchored at the *start* of the longer path, so a relative target
(`['lib','ledger.js']`) is compared against the absolute path's root
(`['e:','projects',…]`) and can never match; the comment claims the opposite. What remains is
the literal basename fallback (1581-1583), which needs the proof's command or output to name the
file — `pnpm test` does not. The unsettled debt is not just shown, it is described wrongly.

Reproduction (probe 12A), an A/B with one variable:

```
ABSOLUTE target (inside the project the proof ran in)
   proof: cmd 'pnpm test', cwd '<fixture>'      settled by that proof: true
RELATIVE target `edit lib/ledger.js`
   proof: cmd 'pnpm test', cwd '<fixture>'      settled by that proof: false
   … 1 earlier unproven turn(s) are still in journal.jsonl: a verification was recorded
   after them, but it neither ran in their project subtree nor named their files …
```

Reachability: `gate-verify.js:182-184` records the edit tool's argument verbatim
(`${tool} ${target}`), so a model that writes `edit lib/ledger.js` produces exactly this input;
the live journal has 1 `unverified` entry and its target is absolute, so the case is latent
here. Fix would touch: `editTargets`/`proofCoversTarget` — resolve the target against the
recorded cwd before comparing, or compare on trailing segments when one side is relative.

## F11 — the board cap drops the oldest task without a word

```js
1248:   board.active = board.active.slice(0, CAP.tasks);
1249:   board.done = board.done.slice(0, CAP.tasks);
1250:   board.blocked = board.blocked.slice(0, CAP.tasks);
```

New tasks are unshifted, so `slice(0, 40)` keeps the newest 40 and discards the 41st, oldest
first. Nothing in `recordTask` reports it, and the eviction is not journalled (the `task` journal
line describes the task being written, not the one removed).

Reproduction (probe 12C): 41 `recordTask` calls → `board holds active=40`,
`tasks created but absent from the board: ["2026-10-04-open-task-number-1"]`,
`the journal mentions the dropped task as removed: false`,
`the brief says anything about the dropped task or a cap on the board: false`. The creation line
is still in the journal, so the task is recoverable only by hand-reading a rotated JSONL file.
Fix would touch: `recordTask` — refuse the 41st with an error, or evict with a `task_dropped`
journal line plus a line in the tool summary; the brief becomes honest for free once the journal
says so.

## F12 — `today()` is a UTC date

```js
1120: export function today() {
1121:   return new Date().toISOString().slice(0, 10);
1122: }
```

On this host (`utc offset = 480 min`) every heading (`## ${today()} · ${slug}`), task id
(`${today()}-${slug}`) and `- last:` line written between 00:00 and 08:00 local names the
previous day — 8 hours of every day (probe 07). Nothing breaks; the ledger's dates disagree with
the human's calendar for a third of the day. Fix would touch: `today()` (format from local
time) and nothing else.

## F13 — `truncate` cuts inside a surrogate pair

```js
2390: export function truncate(text, limit = CAP.resultChars) {
2391:   const s = String(text ?? '');
2392:   if (s.length <= limit) return s;
2393:   const head = Math.floor(limit * 0.6);
2394:   return `${s.slice(0, head)}\n… (${s.length - limit} chars omitted) …\n${s.slice(-(limit - head))}`;
2395: }
```

`s.slice` works on UTF-16 code units, so an astral character straddling `head` (or the tail
boundary) is emitted as half a pair. Measured (probe 13B): `truncate('😀'.repeat(20), 5)` → 29
characters containing **1 lone surrogate**; the same for limits 9 and 21. Reachable through
`shellResult` (2420, limit 6000) into `recordVerified`'s `tail` (`tool-verify.js:95,107`, limit
1500) and into the journal. Cosmetic: the visible damage is one mangled character.
`shapeEntries` did not cut a pair in the same test (it returned the whole entry instead).
Fix would touch: `truncate` — step back to a boundary with
`/[\uD800-\uDBFF]$/.test(head)`-style checks, or use `Array.from`.

## F14 — a task in `done` cannot be found, and moving it by title duplicates its id

```js
1188:   const all = [...board.active, ...board.blocked];
...
1190:   // `task` may arrive as the full id (`2026-10-01-fix-the-parser`), as the title
1191:   // the human used, or as a slug built from that title — a caller reaching for
1192:   // "which task" naturally passes the title, and refusing that while the task is
1193:   // plainly on the board is a trap, not a safeguard. A date-prefixed id resolves
1194:   // through the bare slug too. Ambiguity with no title to disambiguate is the
1195:   // only case still refused.
1196:   const wantedId = norm(id);
1197:   const matches = (t) =>
1198:     norm(t.id) === wantedId ||
1199:     norm(t.title) === wantedId ||
1200:     norm(t.id).endsWith(`-${wantedId}`);
1201:   let task = id === undefined ? undefined : all.find(matches);
1202:   if (task === undefined && title !== undefined) task = all.find((t) => norm(t.title) === norm(title));
...
1210:     if (all.some((t) => norm(t.id).endsWith(`-${norm(title)}`))) {
```

`all` excludes `board.done`, so a finished task is invisible to both lookups *and* to the
duplicate guard at 1210. The comment above promises the opposite ("plainly on the board … a
trap"), and `probes/audit-verify-probe.mjs` C2 asserts "a done task can still be moved by
passing its id" — but that probe's C1 call had already moved its fixture task into `active`
(reusing the same task object), so the done case was never actually exercised. This is a false
green in the existing suite, not a disagreement with it.

Reproduction (probe 14), same title, one variable — where the task lives:

```
-- created active (id 2026-10-04-finish-the-parser)
   move by id    -> ok (2026-10-04-finish-the-parser)     board active=0 done=0 blocked=1 duplicates=false
   move by title -> ok (2026-10-04-finish-the-parser)     board active=0 done=0 blocked=1 duplicates=false
-- created done (id 2026-10-04-finish-the-parser)
   move by id    -> REFUSED: code_record(kind=progress): no task on the board matches
                    "2026-10-04-finish-the-parser". Pass either the full id or an exact title
                    board now active=0 done=1 blocked=0 duplicates=false
   move by title -> ok (2026-10-04-finish-the-parser)
                    board now active=0 done=1 blocked=1 duplicates=true
                    ids=["2026-10-04-finish-the-parser","2026-10-04-finish-the-parser"]
```

The refusal's own next sentence lists the pattern it could not match
(`…; on the board: 2026-10-04-finish-the-parser`), and the same refusal happened for real in this
session when I tried to annotate the audit task I had just created as `done`: the tool answered
`no task on the board matches "<its exact title>"` while `tasks.json` held it. The duplicate id
is the worse half: two rows sharing one id make every later by-id operation ambiguous, and the
id is derived (`${today()}-${slug(title)}`), so the same title on the same day always collides.

Fix would touch: line 1188 — search `active`+`blocked`+`done` for the lookup and the duplicate
guard, while keeping the *filing* decision to `status` (that part is already correct). The
existing C2 check should be rebuilt so its fixture leaves the task in `done`.

---

## What I checked and found clean (with the measurement, not an assumption)

Driven by probe 13 unless stated otherwise; all through the real readers.

- **CRLF** in `tasks.json` or `mistakes.md`: parses, `brief` works, a merge round-trips
  (2 entries before and after). `fieldOf`'s `(.*)$` captures the `\r`, and `.trim()` removes it.
- **BOM**: harmless on its own. `markdownEntries`' `.trim()` strips U+FEFF (it is JS whitespace),
  so a BOM'd first entry is *visible* — 3/3 entries seen and the brief shows the first entry's
  symptom and rule. My initial prediction that a BOM hides entry #1 was **refuted by
  measurement** (probe 05b); the only BOM effect I found is that it participates in F8's
  duplication when the file also has no header.
- **A malformed / non-object journal line**: a torn half-written JSON line, a bare `null`, `42`,
  `"restart_pending"`, `["verified"]`, and an object with `kind` but no `ts` — `brief`,
  `restartPending` and `factRecency` all survive every one of them (`ok` in all 21 cells). My
  reading of `factRecency`/`restartPending` suggested `null.kind` would throw; it cannot,
  because each of those readers pre-filters on a literal substring (e.g.
  `line.includes('"kind":"project"')`) that only an object line carries, and a property *read*
  on a primitive does not throw. Recorded here as a refutation of my own reading.
- **Entry shapes**: an entry with no fields, a file holding only `# Mistakes`, an empty file, a
  heading containing `C:\proj\lib\a.js:12`, an emoji heading, and a body line that itself starts
  with `## ` — all degrade: the brief renders, the entry count is what you would expect, and a
  following `recordMistake` succeeds.
- **A 24 MB ledger** (probe 10): `brief`-adjacent reads/`recordMistake` work; the merge's
  read→parse→rewrite window is ~140 ms at that size (vs 4-12 ms at 60 KB / 1.2 MB, probe 09).
  Large files are handled, but they widen F3/F7's window.
- **Windows paths in `files:`**: the live ledger has 36 of 41 `files:` fields with a backslash or
  drive letter and they are normalised correctly by `comparablePath` (`\`→`/`, `:line` stripped,
  lowercased, trailing separators dropped); `isAncestorOrSelf` is segment-wise, so the
  `p1-a` vs `p1-b` trap is genuinely prevented (probe 12A's absolute control settles correctly).
- **`slug()` on real symptoms**: no two of the live 45 entries collide today (probe 07).
- **The live brief's margin** (probe 07, read-only, `changed: []`): 3292 chars of a 4000 budget —
  not clipped, hint present, `omitted: []`, no empty sections. So the composition overrun that
  this audit looked for is *not* happening on the real ledger today.
- **`shapeEntries`' "one whole entry" exception** (limit 30 → a 976-char entry): I did **not**
  report it as a finding. The prior audit's C3 raised it and `probes/audit-verify-probe.mjs` A1
  refuted it as documented behaviour (the doc block at 2076-2088 spells the exception out, with
  `HARD_ENTRY_CHARS` as the ceiling); the exported function's summary line at 2016 still says
  "never exceeds `limit`", and that is a doc/code disagreement, not a defect I could turn into
  harm at any budget I could reach through the tool (best constructed case: 3515/4000).
- **`recordTask`'s "done with no verification" note**, `preserveCorruptFile`/`corruptNotice`
  (the 2026-10-04 fix for unparseable JSON), and `normalizeBoard`'s re-filing of a
  contradictory board still behave as documented (`recordTask` matching by id, title or
  slug-suffix works for all three forms **while the task is open** — see F14 for the `done`
  case, which is the one place that lookup fails).
- **`probes/audit-verify-probe.mjs` C1** ("a task already on the board is reused rather than
  duplicated, including a done one") holds only because its fixture's first call moved the task
  into `active` before the second call; the *done* row of F14's matrix is the untested case, so
  C1 and C2 are green and F14 is real. Not a refutation of the probe's other checks.
- **Dead code, not defects**: `readTail` (571) and `windowEntries` (590) have no callers left
  (`grep` over the package: only their definitions and a comment at 215/1926 mention them);
  `restartPending` (963-969), `recentJournal` (1896) and `verifyCount` (2371) still carry the
  "readJournalText never throws" `try/catch` that 1668-1670 documents as unreachable. Harmless,
  worth deleting.

## Refuted, and why

- **"A BOM hides the first entry"** — false; `.trim()` strips U+FEFF (probe 05b: 3/3 entries
  visible, brief shows the entry).
- **"Any Russian symptom collides"** — false as stated. Digits and Latin letters survive
  `slug()`, so two symptoms that differ by an identifier or a number do **not** merge; my first
  two attempts (`шаге 3`, `… peer`) refuted themselves. F6's mechanism needs both symptoms free
  of Latin letters and digits.
- **"A `null`/scalar journal line throws in `factRecency`/`restartPending`"** — false; the cheap
  substring pre-filters keep non-object lines out of the property reads (probe 13).
- **"`isAncestorOrSelf` mishandles every absolute/relative pair"** — false; the absolute case
  works (probe 12A control). Only the relative-target/absolute-cwd direction is broken. My first
  12A fixture pointed the absolute target *outside* the proof's subtree and looked like a second
  failure — that was my fixture, not the code.
- **"`truncate` with a limit of 0 returns the whole string"** — true of the function
  (`s.slice(-(0))` is `s.slice(0)`), but unreachable: the only callers pass a default 6000
  (2420), 1500 (`tool-verify.js:95`) or `SHOWN` (`tool-verify.js:107`). Not reported.
- **"`clip(body, 1)` returns 2 characters"** — true (`Math.max(1, limit - 1)` + the ellipsis),
  but `limit` is `allowance - heading.length - 2`, and reaching 1 needs a caller-supplied
  `maxChars` of ~1; the tool's `maxChars` is a config default of 4000. Not reported.
- **"The final `clip` can silently truncate the brief at the default 4000"** — I could not make
  it happen: the richest fresh fixture I built (fat `project.json`, one long entry per
  entry-bearing section, both journal debts, six machine pits) reached 3515 chars, and the live
  ledger sits at 3292 with an 850→708 char margin. Demonstrated only at configured budgets
  (at `maxChars: 1800` the text ends with `…` and `omitted: []`, i.e. a truncated sentence with
  no report). Downgraded to this note rather than a finding — the missing part is a *reachable*
  default-budget case, and the code's own comment (463-473) treats the final clip as intended.

## What I did NOT verify

- `pit-guard.js:214`'s `matchesTrigger` (F2's shape on the hotter path). It needs the stub-host
  pattern (`tools/post-execute` events) to drive, and I anchored F2 to the two `ledger.js` call
  sites I could run directly. The mechanism is identical; the *frequency* claim is unverified.
- The **F3/F7 interleaving at everyday ledger sizes**: probe 09's five append∥merge pairs on the
  live-scale (60 KB) and 1.2 MB fixtures all kept the appended pit (0/5). F3 is therefore
  demonstrated deterministically at the mechanism level (probe 11) and end-to-end at 24 MB
  (probe 10); its *probability* at 67 KB is a measured window (4-12 ms) I did not manage to hit.
- **Rotated-segment concurrency**: `rotateJournal` runs outside `appendLocked`, so two processes
  can rotate the same journal at once (segment reordering is likely, loss is not — the renames
  never overwrite). I read the interleaving out of the code and did not reproduce it.
- **The tool layer end to end** (`code_brief`'s `execute`, `code_record`'s handler, the harness's
  rendering of a thrown handler). Every finding is driven through the library functions those
  handlers call, in the same argument shapes; the wrapper's own stub-host wiring is not exercised.
- **`briefFull` through the real tool** (`full: true`): I proved the branch is unreachable by
  calling `brief(cwd, {maxChars: 8900})` directly, which is exactly what `briefFull` does.
- **F12's practical effect on a record written between 00:00 and 08:00 local** — the arithmetic is
  demonstrated (UTC+8, 8 hours/day) but no fixture was written at that wall-clock time.
- **`DSH_CODE_BOOT` / `noteSessionStart` / `crossProjectTriggers` / `siblingProjects` /
  `appendGateJournal`**: read, not exercised.
