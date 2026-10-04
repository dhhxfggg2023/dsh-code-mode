# Tool-surface audit — `code_record` / `code_brief` / `code_verify` / `prompt.js`

Date: 2026-10-04 · package `E:\projects\dsh-code-mode` · Node 24 under the DSH Electron binary
Files in scope: `lib/tool-record.js`, `lib/tool-brief.js`, `lib/tool-verify.js`, `lib/prompt.js`

## Instrument and method

Every finding below was produced by driving the **real tool objects** (built by the host's real
`defineTool`, loaded through `installResolution()` — the `probes/acceptance-probe.mjs` pattern) and
then putting each returned value through the **harness's own output contract**, imported from the
archive:

```
dsh-tools/lib/index.js:3310   const returned = await tool.execute(exec.arguments, exec);
dsh-tools/lib/index.js:3311   const result = this.createSuccessResult(exec, tool, returned);
dsh-tools/lib/index.js:3541   createSuccessResult(exec, tool, candidate) {
dsh-tools/lib/index.js:3542     const detached = snapshotToolValue(tool.name, candidate);
dsh-tools/lib/index.js:3543     const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
dsh-tools/lib/index.js:3544     if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
dsh-tools/lib/index.js:3548     rendered = tool.output.render(exec.arguments, value);
```

`snapshotToolValue` = `snapshotJsonValue` + the `value is not lossless JSON` failure; both it and
`validateJsonSchemaValue` are the harness's own functions (`@deepseek-ai/dsh-util-values`,
`@deepseek-ai/dsh-tools`), and `tool.output.schema` is the compiler's own output
(`valueSchemaSpecToJsonSchema`, `dsh-tools/lib/index.js:849`). **I replayed those three lines rather
than instantiating a full `ToolRuntime`** (`var ToolRuntime = class extends Service`, needs a real
cordis Context); a live `ToolRuntime` dispatch was out of reach from a probe, so the *dispatch* half
is quoted source and the *validation* half is the real validator. Where a live call was possible it
was made in this session and is labelled as such.

Probes (all under `.dsh-code/audits/`, all run from `E:\projects\dsh-code-mode`):

```
$env:ELECTRON_RUN_AS_NODE='1'; & 'E:\tools\DSH\DeepSeek Harness.exe' '.dsh-code/audits/10-tool-surface.mjs' 2>&1 | Out-String -Width 300
$env:ELECTRON_RUN_AS_NODE='1'; & 'E:\tools\DSH\DeepSeek Harness.exe' '.dsh-code/audits/11-edges.mjs'        2>&1 | Out-String -Width 300
$env:ELECTRON_RUN_AS_NODE='1'; & 'E:\tools\DSH\DeepSeek Harness.exe' '.dsh-code/audits/12-sessionstart.mjs' 2>&1 | Out-String -Width 300
```

Machine-readable results: [report-10-tool-surface.json](report-10-tool-surface.json),
[report-11-edges.json](report-11-edges.json),
[report-12-sessionstart.json](report-12-sessionstart.json),
[report-13-real-brief.json](report-13-real-brief.json). Probes: [10-tool-surface.mjs](10-tool-surface.mjs),
[11-edges.mjs](11-edges.mjs), [12-sessionstart.mjs](12-sessionstart.mjs),
[13-real-brief.mjs](13-real-brief.mjs) (read-only look at the real project's ledger), fixture
[exit3.mjs](exit3.mjs).

Final tallies: probe 10 `69/79 checks did not FAIL`, probe 11 `5/10`, probe 12 `2/3`. Every FAIL below
is either a finding or an expectation of mine that the code refuted (each is marked as such).

### Channel note (which shell produced which evidence)

The probes' output above comes from the **`pwsh` channel**. Re-running probes 10 and 11 through
`code_verify` produced `(no output)` with `exitCode 0`, and **did not refresh the report artifacts**
they had just written from `pwsh`, while a script that does *not* call `installResolution()` run the
same way in the same channel does run and print:

```
$ code_verify(cmd: "$env:ELECTRON_RUN_AS_NODE='1'; & 'E:\tools\DSH\DeepSeek Harness.exe' '...\exit3.mjs'; Write-Host \"WITNESS: this shell line runs and prints\"")
VERIFIED
BANNER: this line is printed before the failure
WITNESS: this shell line runs and prints
ERROR: the payload failed
exitCode 0 · expectation matched · ok true
```

So the boundary is not "the Electron binary" but "a probe that installs the profile-resolution
bootstrap" — the same shape as `probes/acceptance-probe.mjs`, and the same pit the machine ledger
already records twice. It is a channel fact, not a defect of this package; it is why no finding below
rests on a probe run taken through `code_verify`. (The mode's own pit guard fired on the first attempt:
`journal.jsonl` holds `trigger_hit … heading "2026-10-04 · the-documented-acceptance-command-through-code_verify-record"`.)

## Findings

| id | severity | one-line claim | evidence |
|---|---|---|---|
| F1 | **breaks-a-turn** | `code_record(kind="project")` and `kind="progress"` still return a 5th key `notice`; the harness rejects the result *after* the ledger write | probe 10 `record:project`, `record:progress`, `record:progress-existing`, `record:project-global`, `record:project-corrupt`, `record:progress-corrupt` |
| F2 | **wrong-output** | a `topic` that matches nothing produces no notice at all, and the `trigger:` form the prompt and the brief's own footer advertise finds nothing | probe 11 `topic:trigger:Set-Content`, `topic:nothing-matches-this-at-all` (full brief text pasted) |
| F3 | **wrong-output** | `code_verify` trusts a single scalar exit code that belongs to the *last statement*, so a `;`-joined command with a failing payload records `exitCode 0` and would record `ok:true`; the journal line does not even carry the exit code | in vivo `code_verify` (render + journal line pasted) |
| F4 | **wrong-output** | the "once per process" guard on `noteSessionStart` compares a value recomputed from two clocks on every call, so it intermittently fails: a repeated `code_brief` appends a duplicate `session_start` and the duplicate rows reach the model | probe 11 `brief:journal-side-effect` (failed) + probe 11 run-2 brief text + probe 12 `guard:boot-value-stable` |
| F5 | **wrong-output** | a *refused* `code_record` still creates the whole ledger (`initLedger` runs before the per-kind argument checks), so the project stops briefing as "No ledger yet" | probe 10 `args:no-side-effect-on-refusal`, `args:refusal-changes-the-brief` |
| F6 | **wrong-output** | `kind="progress"` with the title of a **completed** task silently creates a second task; completed the same day, the two entries share one id and it lands on both `active` and `done` | probe 11 `done:title-creates-a-second-task`, `done:same-day-id-collision` |
| F7 | **wrong-output** | the prompt tells the model it can "raise the tool's `maxChars`"; `maxChars` is a plugin Config, not a parameter — the harness accepts the unknown argument and the brief does not change | probe 10 `brief:maxchars-argument` |
| F8 | cosmetic | the prompt enumerates four `code_record` kinds and never names the fifth (`verified`), which the tool does declare | probe 10 `prompt:kinds:verified-also-exists` |

---

### F1 — `code_record(kind="project"/"progress")` returns an undeclared key; the harness rejects the result after the write (breaks-a-turn)

The two branches the 2026-10-04 fix missed:

```js
// lib/tool-record.js:160-169
if (kind === 'project') {
  if (args.patch === undefined) throw new Error('code_record(kind="project") needs `patch`');
  const written = writeProject(cwd, args.patch, sessionId, scope);
  return Promise.resolve({
    kind,
    scope,
    file: written.file,
    summary: `project fields: ${Object.keys(args.patch).join(', ')}`,
    notice: written.notice,          // <-- 5th key; schema declares four (lib/tool-record.js:125-129)
  });
}
// lib/tool-record.js:171-184
if (kind === 'progress') {
  const { file, task, notice } = recordTask(...);
  return Promise.resolve({ kind, scope, file, summary: ..., notice });   // <-- 5th key
}
```

`notice` is `undefined` in the normal case and a *string* on the corrupt-ledger path:

```js
// lib/ledger.js:1128-1139   writeProject
const notice = read === undefined ? corruptNotice(preserveCorruptFile(file), 'project.json') : undefined;
...
return { file, notice };
// lib/ledger.js:1184 / :1253  recordTask — same shape
```

Reproduction and observed output (probe 10, `== A. code_record ==`):

```
BAD  record:project code_record(project) produces a value the harness accepts
       {"keys":["kind","scope","file","summary","notice"],"returned":{"kind":"project","scope":"project",
        "file":"C:\\Users\\...\\Temp\\audit-record-cHnpFt\\.dsh-code\\project.json",
        "summary":"project fields: commands, stack"},"stage":"snapshot",
        "message":"tool \"code_record\" returned invalid output: value is not lossless JSON"}
BAD  record:progress          ... stage "snapshot", same message, file ...tasks.json
BAD  record:progress-existing ... stage "snapshot", same message
BAD  record:project-global    ... stage "snapshot", same message
BAD  record:project-corrupt   {"keys":[...,"notice"],"noticeValue":"[!] project.json could not be parsed, so it was
        moved aside to ...project.json.corrupt-2026-10-04T13-11-35-542Z and a fresh file was written. ...",
        "stage":"schema","message":"tool \"code_record\" returned invalid output:
        \"value.notice\" is not a declared property (additionalProperties: false)"}
BAD  record:progress-corrupt  ... same, for tasks.json
ok   record:decision          {"keys":["kind","scope","file","summary"], ...}      <- the fixed branches
ok   record:mistake           {"keys":["kind","scope","file","summary"], ...}
ok   record:verified          {"keys":["kind","scope","file","summary"], ...}
```

Why `undefined` is fatal — the harness snaps the raw value **before** validating, and refuses *any*
`undefined` leaf:

```js
// dsh-tools/lib/index.js:2574-2584
function snapshotToolValue(toolName, candidate) {
  const detached = snapshotJsonValue(candidate);
  if (detached === undefined) throw new ToolOutputError(toolName, ["value is not lossless JSON"]);
// dsh-util-values/lib/index.js:104-109
if (typeof current === "number") { ... }
if (typeof current !== "object") return void 0;   // undefined is not an object -> the WHOLE value is refused
```

The failure happens **after** the side effect (line 3310 runs the handler; 3311 validates), so
`project.json` / `tasks.json` were written and the model is told the call failed. `output.render`
never runs, so the model does not even receive the summary. The dead branch in the renderer shows the
intent the schema forbids:

```js
// lib/tool-record.js:142-147
render: (_args, value) => [{
  type: 'text',
  text: `Recorded ${value.kind} (${value.scope}) → ${value.file}\n${value.summary}${value.notice === undefined ? '' : `\n\n${value.notice}`}`,
}],
```

Reproduce: `node .dsh-code/audits/10-tool-surface.mjs` under the Electron binary (above), section A.

What a fix touches: `lib/tool-record.js:168` and `:182` (drop the key, fold the advisory into
`summary` exactly as the decision/mistake branches already do — `:206-209`, `:281-295`) and the dead
`value.notice` at `:145`. No schema change is safe: this harness refuses `required: false`
(`dsh-tools/lib/index.js:603` `authorError(...required must be true when present)`), which is why the
key cannot simply be declared optional.

**Refutation attempt (failed to refute).** Two ways this could be a probe artifact, both checked:
(a) a stub harness that strips `undefined` — it does not; `dispatchToolBody` hands the raw object to
`createSuccessResult` (`:3310-3311`) and there is no JSON round-trip in between. (b) `writeProject`
could return a defined `notice` so the failure is conditional — it does not; the normal path is
`undefined` (`:1133`). The mirror-image claim inside this repo —
`probes/output-schema-probe.mjs:143-152`, "a key whose value is `undefined` **disappears** … a working
fix (`notice: undefined` on two branches) was reported red by this very probe while the real harness
accepted the tool 24/24" — is **not supported**: that probe stubs `@deepseek-ai/*` via `registerHooks`
(`:76-90`) and never calls the harness validator at all, so it cannot see this failure. Survivor.

---

### F2 — a `topic` that matches nothing is silent, and the advertised `trigger:` form matches nothing (wrong-output)

```js
// lib/ledger.js:2176-2179   mistakeExcerpt
const hits = searchEntries([{ dir: ledgerDir(cwd, SCOPE.project), scope: SCOPE.project }], topic)
  .filter((hit) => hit.kind === 'mistakes');
if (hits.length === 0) return { entries: 0, body: undefined };
// lib/ledger.js:395
mistakes: (mistakes.entries ?? 0) > 0,          // entries 0 -> no section, no emptySections entry
// lib/ledger.js:2112-2114   searchEntries
const haystack = block.toLowerCase();
if (!haystack.includes(needle)) continue;        // the gate: query must be a literal substring of the block
```

and the two places that advertise a `trigger:` form:

```
// lib/ledger.js:2157
... Name a file, a symptom, a heading or a `trigger:` in code_brief({topic}) to read any of them in full.
// lib/prompt.js:24
... pass `topic` (a file, a symptom, a heading fragment, or a `trigger:`) to read matching entries from *both* scopes in full ...
```

Reproduction and observed output (probe 11, `== 2 ==`), on a fixture whose single entry carries
`- trigger: Set-Content|Out-File|Add-Content`:

```
ok   topic:Set-Content               {"hasMistakesHeading":true,"mentionsQuery":true,"chars":619}
BAD  topic:trigger:Set-Content       {"hasMistakesHeading":false,"mentionsQuery":false,"chars":308}
       full text of the miss case:
       | ## Project
       | Commands:
       | - test: npm test
       |
       | ## Recent ledger entries
       | - 2026-10-04 13:11 session_start (this session):
       |
       | This brief is a selection, not the ledger: 1 mistake entry and 0 decisions in this project. Name a file,
       |   a symptom, a heading or a `trigger:` in code_brief({topic}) to read any of them in full.
BAD  topic:nothing-matches-this-at-all {"hasMistakesHeading":false,"mentionsQuery":false,"chars":358}
```

Two halves, both visible in that transcript: the query `trigger:Set-Content` finds nothing although an
entry carries exactly that trigger (the literal gate at `:2114` rejects it before the trigger-ranking
at `:2117-2123` can score it), and a miss is **not reported at all** — no heading, no
`… (mistakes exist in the ledger but had no entry to show)` notice, nothing naming the query. The
reader sees a brief that is textually identical to one from a ledger with no mistakes, in a mode whose
stated first principle is "any omission must be said" (`lib/prompt.js:24`). Same omission class one
step over: `full: true` silently discards `topic` (`tool-brief.js:66-69`; probe 10
`brief:topic-and-full` = `brief:full`, 2137 chars both).

What a fix touches: `lib/ledger.js:2176-2184` (report a zero-hit query — e.g. return a body naming the
query and that nothing matched) and `:395` (mark the section as content-bearing when a topic was
asked), plus `searchEntries:2106-2114` if the `trigger:` prefix is meant literally (strip it, or match
against the entry's `trigger` field instead of the rendered block). `lib/prompt.js:24` and
`lib/ledger.js:2157` say which form the reader is being taught.

**Refutation attempt (survived, with one honest caveat).** One could read "a `trigger:`" as "the text
of a trigger" rather than a literal prefix — and the ranking code at `:2117-2123` was clearly written
for a query that is *matched by* a stored pattern, which is a sensible design. But even under that
reading the second half stands: a query that matches nothing is indistinguishable from "the ledger has
no mistakes", and the exact string the footer prints (`trigger:`) returns nothing. Survivor.

---

### F3 — `code_verify` records a scalar exit code that belongs to the last statement (wrong-output)

```js
// lib/tool-verify.js:86-91
const denied = result.sandbox?.denied === true;
const runnerFailed = result.sandbox?.runnerFailed === true;
const exitCode = typeof result.exitCode === 'number' ? result.exitCode : -1;
const aborted = result.aborted === true || result.timedOut === true;
const matched = matchesExpectation(output, args.expect);
const ok = !denied && !runnerFailed && !aborted && exitCode === 0 && matched;
// lib/ledger.js:2431-2432
export function matchesExpectation(output, expect) {
  if (expect === undefined || expect.trim().length === 0) return true;
```

`lib/ledger.js:1406-1427` `recordVerified` then journals
`{ts, session, kind:'verified', cmd, cwd, expect, ok, tail}` — **no exit code, no shell status text**.

Live, in this session, through the real `code_verify` (`node .dsh-code/audits/exit3.mjs` prints a
banner, writes to stderr and calls `process.exit(3)`):

```
$ code_verify(cmd: "node .dsh-code/audits/exit3.mjs; Write-Host AUDIT-LAST-STATEMENT-SUCCEEDED",
              expect: "AUDIT-EXPECTATION-THAT-NEVER-APPEARS")
$ node .dsh-code/audits/exit3.mjs; Write-Host AUDIT-LAST-STATEMENT-SUCCEEDED
exit 0, but the expected output never appeared

BANNER: this line is printed before the failure
AUDIT-LAST-STATEMENT-SUCCEEDED

ERROR: the payload failed

exitCode 0 · expectation not matched · ok false
Logged to E:\projects\dsh-code-mode\.dsh-code\journal.jsonl
```

`exitCode 0` for a command whose payload exited 3. With `expect` omitted — which the tool's own
description invites ("or leave it out to require only exit code 0") — `matched` is `true` and the same
run is `ok: true`. **That is not a prediction: it is in the journal.** The last live call below put a
failing payload and a succeeding statement on one line and was recorded as VERIFIED:

```
$ code_verify(cmd: "$env:ELECTRON_RUN_AS_NODE='1'; & '<install>\DeepSeek Harness.exe' '...\exit3.mjs'; Write-Host \"WITNESS: this shell line runs and prints\"",
              expect: "BANNER: this line is printed before the failure")
VERIFIED

BANNER: this line is printed before the failure
WITNESS: this shell line runs and prints

ERROR: the payload failed

exitCode 0 · expectation matched · ok true
Logged to E:\projects\dsh-code-mode\.dsh-code\journal.jsonl
```

and the line it wrote (`.dsh-code/journal.jsonl`, `ok:true` for a payload that exited 3 and printed
`ERROR: the payload failed` to stderr):

```json
{"ts":"2026-10-04T13:13:13.041Z","session":"e44d7908-...","kind":"verified",
 "cmd":"$env:ELECTRON_RUN_AS_NODE='1'; & 'E:\\tools\\DSH\\DeepSeek Harness.exe' 'E:\\projects\\dsh-code-mode\\.dsh-code\\audits\\exit3.mjs'; Write-Host \"WITNESS: this shell line runs and prints\"",
 "cwd":"E:\\projects\\dsh-code-mode","expect":"BANNER: this line is printed before the failure","ok":true,
 "tail":"BANNER: this line is printed before the failure\nWITNESS: this shell line runs and prints\n\nERROR: the payload failed\n"}
```

That entry also settles unverified debts for paths under `cwd` (`lib/ledger.js:1571-1584` treats a
recorded `cwd` that contains the target as proof), so a false VERIFIED is not merely a wrong label.

The journal line, read back from disk (`.dsh-code/journal.jsonl`):

```json
{"ts":"2026-10-04T13:09:50.723Z","session":"e44d7908-...","kind":"verified",
 "cmd":"node .dsh-code/audits/exit3.mjs; Write-Host AUDIT-LAST-STATEMENT-SUCCEEDED",
 "cwd":"E:\\projects\\dsh-code-mode","expect":"AUDIT-EXPECTATION-THAT-NEVER-APPEARS","ok":false,
 "tail":"BANNER: this line is printed before the failure\nAUDIT-LAST-STATEMENT-SUCCEEDED\n\nERROR: the payload failed\n"}
```

Note what a later reader can and cannot see: `cwd` matches the workdir the shell was resolved with
(`tool-verify.js:80` passes `workdir: root`, `recordVerified` records the same `cwd`) — that half is
honest — but the line carries no exit code, so the two halves of `ok` are not separable afterwards.
Naming the layer: the *number* is the shell service's (it is not even the process's — the bare failing
command, which exits 3, reports `[exit code: 1]`, measured both through the `pwsh` tool and in vivo);
the *defect* is that `code_verify` treats that one scalar as proof of the whole command line.

Reproduce: `code_verify({cmd:"node .dsh-code/audits/exit3.mjs; Write-Host X", expect:"NOPE"})` — then
delete the `expect` and watch `ok` flip to true for the same failing payload.

What a fix touches: `lib/tool-verify.js:80-97` — journal the shell's own status text / exit marker
alongside `ok` (`lib/ledger.js:1406` is the shape to extend), and either refuse a command line with
more than one statement or say in the render which statement the exit code belongs to.
`lib/ledger.js:2410-2422` `shellResult` already knows how to read the `[exit code: N]` marker, so the
mechanism to be honest with exists one file over.

**Refutation attempt (failed to refute).** Tested the pipeline half head-on, expecting the classic
PowerShell truncation story: `& node exit3.mjs`, `… | Out-String` and `… | Select-Object -First 1` each
report `[exit code: 1]` on the `pwsh` channel (the failure is *not* swallowed by a pipe here). The
failure is the `;` form, and it is visible on both channels — the harness's `pwsh` tool reports no
marker at all (i.e. 0) for `cmd /c exit 7; Write-Host leftover`. Survivor.

---

### F4 — the once-per-process guard for `session_start` compares a value that changes between calls (wrong-output, intermittent)

```js
// lib/ledger.js:1020-1048
/** Record that a session has begun, once per process. ...
 *  The guard is the journal's own history: if the newest `session_start` was written by this
 *  same boot, a second briefing is a no-op. Without it every brief appended a line and grew
 *  the journal for nothing. */
export function noteSessionStart(cwd, sessionId, scope, boot = processBootTime()) {   // <-- recomputed per call
  if (!exists(cwd, scope)) return;
  ...
  if (last !== undefined && currentBoot !== undefined && last.processBoot === currentBoot) return;
  appendJournal(cwd, { ts: new Date().toISOString(), session: sessionId, kind: 'session_start', processBoot: currentBoot }, scope);
}
// lib/ledger.js:1012-1017
function processBootTime() {
  const override = process.env.DSH_CODE_BOOT;
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  const uptime = Number(process.uptime?.());
  return Number.isFinite(uptime) && uptime >= 0 ? new Date(Date.now() - uptime * 1000).toISOString() : undefined;
}
```

`processBootTime()` mixes two clocks (`Date.now()` and `process.uptime()`), so its millisecond bucket
is not stable:

```
$ node .dsh-code/audits/12-sessionstart.mjs          # (via the Electron binary)
BAD  guard:boot-value-stable the process identity the guard compares is the same on two calls in one process
       {"b1":"2026-10-04T13:11:54.263Z","b2":"2026-10-04T13:11:54.263Z","b3":"2026-10-04T13:11:54.262Z","distinct":2}
```

and when the recomputed bucket differs from the one stored in the journal, the guard lets the write
through. Measured in the same fixture, two runs of the same probe minutes apart:

```
# run 1 (probe 11, first execution)
ok   brief:journal-side-effect ... {"afterFirstCall":1,"afterSecondCall":1,"kinds":["session_start"]}
# run 2 (probe 11, re-run for the durable report)
BAD  brief:journal-side-effect ... {"afterFirstCall":1,"afterSecondCall":2,"kinds":["session_start","session_start"]}
```

and in that failing run the duplicate rows reach the model, inside the budgeted journal section:

```
| ## Recent ledger entries
| - 2026-10-04 13:11 session_start (this session):
| - 2026-10-04 13:11 session_start (this session):
```

The entry point the audit is about is the read tool doing the write:

```js
// lib/tool-brief.js:63
if (cwd !== undefined) noteSessionStart(cwd, sessionId, 'project');
```

Each duplicate costs a line in a section capped by `CAP.journalTail = 5` and `SECTION_BUDGET.journal`
(`lib/ledger.js:47`, `:140-141`), so repeated briefing evicts the real entries (verifications, task
moves) that the section exists to show.

Reproduce: run `11-edges.mjs` (section 3) several times; the expected journal growth is 1 line per
*process*, observed 1–2 lines in 2–3 runs.

What a fix touches: `lib/ledger.js:1012-1017` (derive the boot identity once per process — a
module-level memo — or coarsen it, e.g. seconds) or `:1043` (compare against the stored value with a
tolerance). `DSH_CODE_BOOT` already exists as the deterministic seam (`:1013`), so a probe can pin the
behaviour either way.

**Refutation attempt (partially refuted, then narrowed).** My first hypothesis was "the guard never
holds"; probe 12 refuted exactly that — four briefs in one process left **one** line
(`sessionStartLinesAfterEachCall:[1,1,1,1]`). So the guard works when the recomputed bucket happens to
match, and fails when it does not: the finding is *intermittent*, not absolute, which is why the two
runs disagree. Survivor, downgraded from "always" to "1 of 3 measured runs".

---

### F5 — a refused `code_record` still initializes the whole ledger (wrong-output)

```js
// lib/tool-record.js:149-159
execute(args, exec) {
  const cwd = ledgerRoot(exec);
  const sessionId = exec.agent?.session?.id;
  const scope = args.scope === SCOPE.global ? SCOPE.global : SCOPE.project;
  if (scope === SCOPE.global && args.kind === 'progress') { throw ... }   // before the write
  initLedger(cwd, sessionId, scope);                                      // <-- creates all five files
  const kind = args.kind;
```

Every per-kind argument error after that point (`trigger` that does not compile, `triggerSample`
without `trigger`, a mistake with no locator, an unknown `task`, `decision` without `body`, …) happens
with the ledger already created:

```
BAD  args:no-side-effect-on-refusal a refused call leaves no ledger behind
       {"createdBy":[{"label":"trigger-invalid-regex",
        "created":["decisions.md","journal.jsonl","mistakes.md","project.json","tasks.json"]}],
        "filesNow":["decisions.md","journal.jsonl","mistakes.md","project.json","tasks.json"]}

# on a fresh project whose ONLY call was that refused one:
BAD  args:refusal-changes-the-brief a project whose only call was REFUSED still briefs as "no ledger yet"
       {"empty":false,"firstLine":"## Machine-wide facts (true of this host, every project)", ...}
```

Before the refused call the same project briefs `empty: true` with
`No ledger yet at .dsh-code/project.json.` (`lib/ledger.js:270-280`); afterwards it briefs as a
populated project, and the journal holds an `init` plus a `project` event for a call the model was told
failed. The two refusal paths that are checked *before* `initLedger` behave correctly:
`scope=global + kind=progress` writes nothing (probe 10 `args:global-progress-refused-clean`,
`machineLedgerFiles: []`).

What a fix touches: `lib/tool-record.js:149-159` — move `initLedger` after the per-kind checks (or
into the branches that actually write). Note `code_brief` deliberately *does not* create a ledger
(`lib/ledger.js:1027-1031`), so the "a read must not create what it reports the absence of" rule
already exists in this codebase to be extended to refused writes.

**Refutation attempt (survived).** Could the creation be attributed to an earlier accepted call in the
same fixture? The probe watches the directory case-by-case (`firstWrite` names
`trigger-invalid-regex` and the exact files that appeared with it), and the second check is on a
project where no call was ever accepted. Survivor.

---

### F6 — a completed task named by title silently becomes a second task, with a shared id if it was closed today (wrong-output)

```js
// lib/ledger.js:1187-1215   recordTask
const wanted = status ?? 'active';
const all = [...board.active, ...board.blocked];          // <-- `done` is not searched
const matches = (t) => norm(t.id) === wantedId || norm(t.title) === wantedId || norm(t.id).endsWith(`-${wantedId}`);
let task = id === undefined ? undefined : all.find(matches);
if (task === undefined && title !== undefined) task = all.find((t) => norm(t.title) === norm(title));
if (task === undefined) {
  if (title === undefined) throw ...;
  if (all.some((t) => norm(t.id).endsWith(`-${norm(title)}`))) throw ...;   // never true for a done task
  task = { id: `${today()}-${slug(title)}`, title, status: wanted, ... };
```

```
BAD  done:title-creates-a-second-task ... {"activeIds":["2026-10-04-already-finished-work"],
       "doneIds":["2026-10-04-already-finished"],"summary":"2026-10-04-already-finished-work [active] Already finished work — reopening?"}
BAD  done:same-day-id-collision ... {"closedSummary":"2026-10-04-a-task-that-was-finished-the-same-day [done] ...",
       "reopenedSummary":"2026-10-04-a-task-that-was-finished-the-same-day [active] ...",
       "idsOnBothLists":["2026-10-04-a-task-that-was-finished-the-same-day"]}
--   done:id-cannot-be-moved  {"threw":"Error: code_record(kind=progress): no task on the board matches
       \"2026-10-04-already-finished\". Pass either the full id or an exact title; on the board: 2026-10-04-already-finished-work"}
```

So a task that has been closed can be neither reopened nor named safely: by id/slug the call is
refused with a message that lists only the *active* board, and by title it produces a duplicate — and
when it was closed the same day the duplicate carries **the same id as the closed entry**, putting one
id on both the `active` and the `done` list. The tool's own description promises the opposite
(`lib/tool-record.js:57`: "Creating a second task when this one exists is refused, so pass this
whenever the task is already on the board").

What a fix touches: `lib/ledger.js:1188` (include `board.done` in the search, or make the refusal
explicit when the only match is closed), `:1210` (the duplicate guard only looks at
active+blocked) and, if a closed task may be reopened, `:1222-1230`. `boardSummary` at `:1881` renders
whatever the two lists hold, so nothing downstream de-duplicates the same id.

**Refutation attempt (survived).** "`done` is terminal, so not finding it is intentional" would explain
the refusal by id — but then the title path should refuse too, and it does not; the result is the
duplicate the description says is refused, plus an id that exists twice. Survivor.

---

### F7 — the prompt tells the model to raise a knob the tool does not have (wrong-output)

```js
// lib/prompt.js:24  (abridged)
... pass `topic` (...) to read matching entries from *both* scopes in full, or raise the tool's `maxChars`.
// lib/tool-brief.js:19-30
parameters: {
  topic: { type: 'string', description: '...' },
  full:  { type: 'boolean', description: '...' },
},
// lib/tool-brief.js:8-13   — `maxChars` is a plugin Config
export const Config = z.object({ maxChars: z.number().default(4000) });
export function apply(ctx, config) { const maxChars = config?.maxChars ?? 4000; ... }
```

`cordis.patch.yml` mounts `code-brief` with no config block (only the id appears, `:165`), so the
default is 4000 and the model has no reachable path to it. The harness's parameter schema is open
(`parameterSchemaSpecToJsonSchema` emits `{type:'object', properties, required?}` with **no**
`additionalProperties: false`, `dsh-tools/lib/index.js:802-811`), so the argument is accepted and
ignored:

```
BAD  brief:maxchars-argument passing the maxChars the prompt tells the model to raise actually raises the budget (or is refused)
       {"chars":1594,"parameterNames":["topic","full"],"acceptedSilently":true}
```

1594 characters for a request that asked for 20000 — no error, no notice, no change. `topic` is the
identical trap: `code_brief({topic, full:true})` drops the topic without saying so (probe 10
`brief:topic-and-full`).

What a fix touches: `lib/prompt.js:24` (say who can raise it — the operator, in the plugin config — or
drop the clause) or `lib/tool-brief.js:19-30` plus `:66-69` (accept `maxChars` as a parameter and pass
it to `brief()`; `lib/ledger.js:260` already honours it).

**Refutation attempt (survived).** Could the harness route unknown arguments into the plugin Config?
No — `defineTool` validates and forwards the raw object to `handler.execute(args, exec)`
(`dsh-tools/lib/index.js:866-870`), and the handler reads only `args.full` / `args.topic`. Survivor.

---

### F8 — the prompt never names the fifth `code_record` kind (cosmetic)

```js
// lib/prompt.js:25
- Write a fact down the moment you learn it, with `code_record`: `kind="project"` for how the project
  runs, `progress` to move a task, `decision` for a choice and why, `mistake` for anything that failed
  and its cause.
// lib/tool-record.js:39
enum: ['project', 'progress', 'decision', 'mistake', 'verified'],
```

```
BAD  prompt:kinds:verified-also-exists prompt claim kinds:verified-also-exists matches the code {"ok":false}
```

The word `verified` does not appear in the section at all (checked against the 4460-character rendered
section). A model that wants to record a command someone else ran has to discover the kind from the
tool description, which does list it (`lib/tool-record.js:26`). Cosmetic, but it is exactly the
"statement that no longer matches the code, and the model acts on it" class.

**Refutation attempt (survived as a real omission, downgraded to cosmetic).** The prompt's *rule* about
verification is elsewhere and correct ("Never claim that a change works without `code_verify`",
`:27`), so the omission does not contradict a rule — it just makes one of five kinds undiscoverable
from the prompt. Survivor as cosmetic.

---

## What I checked and found clean

All items below were driven, not read (probe ids in parentheses; a `PASS` in the report JSON).

**Output contract, all branches and fields**
- Every key each handler returns is declared, and every declared key is returned, for `code_verify`
  (all six) and `code_brief` (all six) on every driven path; `code_record` returns the four core keys
  in all five kinds (the fifth key is F1, on two branches only) (`record:*`, `shape:*`).
- `code_record`'s decision / mistake / verified branches return exactly four keys — including the
  merge path (`merged: true`, `recurred: 1`) and the length-advisory path, where the advisory rides in
  `summary` as the code comments claim (`record:merge-shape`).
- No declared property uses `required: false` anywhere in the three tools (`compile:*`) — the whole
  row still mounts, which is what the 2026-10-04 regression broke.
- No `render` throws on any payload these tools actually produce, and render is only ever called on an
  already-validated value (`dsh-tools/lib/index.js:3543` before `:3548`), so an "error shape" cannot
  reach it. `code_brief`'s `value.omittedSections.length` and `code_verify`'s
  `value.outputTail || '(no output)'` are both guarded (`brief:empty-project`, `verify:*`).

**Input validation (`code_record`)** — all refused before any effect, with a usable message:
wrong-case `kind` (`"Project"`), empty `kind`, unknown `kind`, wrong-case `scope`, unknown `status`,
`patch` not an object, a number where a string is expected (`cmd: 42`), a `trigger` that does not
compile ("so the pit would never fire and nothing would say so"), `triggerSample` without `trigger`,
a mistake with no rule and no coordinate, an unknown `task`, and per-branch missing fields
(`args:*`, 15/15).
- `task` resolves by full id, by bare slug and by exact title to **one** task (`args:task-identity`);
  the refusal message names the board (`args:task-unknown`).
- `files:` with backslashes, with `:line` suffixes and with a trailing separator is accepted and
  stored verbatim (`args:files-backslash`, `args:files-trailing-separator`); the matching side
  normalises both sides identically — `comparablePath` (`lib/ledger.js:1523-1531`, `\`→`/`, trailing
  separators stripped) and pit-guard's `normPath` (`lib/pit-guard.js:109-115`) plus `refersTo`
  (`:130-145`) — so a `files:` path written either way still answers an edit.
- Unknown extra arguments are accepted and ignored (`args:extra-unknown-field`); this is the
  harness's own openness for parameter specs (`dsh-tools/lib/index.js:802-811`), identical for every
  tool in the deployment, not something this package chose.

**`code_verify` failure classification** (`verify:*`, 12/12) — `ok` is false, with no false pass, for:
a mismatch, a nonzero exit, `sandbox.denied`, `sandbox.runnerFailed`, `aborted`, `timedOut`, a missing
`numeric` exit code (→ `-1`), and a killed process. A missing shell service and a shell that throws
(`spawn EPERM`) both surface as errors, and neither is recorded as a pass. A host that reports output
in an unexpected field (`{output: '…'}` instead of `{stdout:{text}}`) fails **safe** — `matched:false`,
`ok:false` — rather than verifying nothing.
- Timeout: `code_verify(cmd:'Start-Sleep -Seconds 20; Write-Host AUDIT-SLEPT-FULL', timeoutMs:2500)`
  → `FAILED (exit 1)`, `(no output)`, `ok false`. Not recorded as a pass.
- Workdir: the journal's `cwd` is the same root the shell was resolved with
  (`tool-verify.js:80` / `ledger.js:1419`), verified on the live journal lines above.
- Truncation is announced, never silent: `truncate` keeps head+tail with `… (N chars omitted) …`
  (`lib/ledger.js:2390-2395`); `matched` is computed on the **full** output, so a truncated tail can
  hide the matching line from the reader but cannot manufacture a match.

**`code_brief`**
- Empty project (`empty:true`, `No ledger yet`, machine section only), populated, `topic`,
  `full`, `topic`+`full`, and a 200-entry ledger: all return validating values inside the declared
  4000-character budget (`brief:empty-project` … `brief:budget`; worst case 1594 chars).
- A heading fragment and a literal trigger text both find their entry and say `matching "<topic>"`
  (`brief:topic-heading-fragment`, `brief:topic-literal`).
- The footer line the prompt promises exists and is accurate: "This brief is a selection, not the
  ledger: N mistake entries and M decisions in this project[, plus K machine-wide pits]"
  (`lib/ledger.js:2145-2158`).
- A `topic` reaches **both** scopes as the prompt claims: `globalExcerpt` searches the machine ledger
  by topic (`lib/ledger.js:2225-2234`), the project half searches `mistakes.md` (`:2176`).
- A project with no ledger is not created by a brief (`lib/ledger.js:1031`, `brief:empty-project`
  shows `empty:true` and no files) — the deliberate asymmetry with F5.

**Prompt section vs code** (`prompt:*`) — the section registers (`code-ledger`, order −50, 4460 chars)
and registers no tools; all five ledger file names match `FILES`; `.dsh-code/` and `~/.dsh-code/`
match `DIRNAME`/`globalDir()`; the machine ledger genuinely has no task board
(`initLedger` skips `tasks.json` for global, `lib/ledger.js:1156`) and `kind="progress"` refuses
global scope; every `code_*` tool the prompt names exists; "These six are the ones" really is six
bullets; "~590k tokens" is consistent with the machine ledger's recorded 587,435; "a fixed character
budget, not a fraction of the ledger" matches `maxChars`/`SECTION_BUDGET`.

**Failure invisibility** — no `catch`, `.catch()`, `process.exit` or `process.exitCode` exists in any
of the four in-scope files (grep), so the "swallowed error / set-but-never-read exit code" class has no
instance here. The one `catch` (`lib/tool-record.js:227`) rethrows with a better message.

## What I did not verify

1. **No live `code_record(kind="project")` or `kind="progress"` call.** F1's mechanism is proven
   against the harness's own validator and dispatch source, and its message class was observed live in
   this project for the sibling branches on 2026-10-04; but I did not issue the failing call itself,
   because it writes `project.json` / `tasks.json` outside `.dsh-code/audits/` and the audit brief
   forbids that. The exact one-line check that would settle it:
   `code_record(kind="project", patch={})` in a session — expected:
   `tool "code_record" returned invalid output: value is not lossless JSON`, with `patch` applied.
2. **No full `ToolRuntime` dispatch.** I replayed `createSuccessResult`'s three lines with the
   harness's own `snapshotJsonValue` / `validateJsonSchemaValue` instead of instantiating the cordis
   `Service`. Anything the *pipeline* adds before validation (post-execute policies, around-wrappers)
   is out of scope of this replay; `normalizeDispatchResult` (`:3573-3584`) re-validates, so it cannot
   rescue F1.
3. **`code_verify` against a *real* failing test suite** — my live runs used a purpose-built fixture
   (`exit3.mjs`) and a `Start-Sleep`. The pipeline-vs-`;` distinction was measured on the `pwsh`
   channel and once in vivo; the `Select-Object -First N` truncation pit is recorded in the machine
   ledger and I did not re-derive its exit-code behaviour beyond the one measurement above.
4. **pit-guard's `files:`/`trigger:` firing** — I verified the normalisation helpers in source and that
   the write path accepts both spellings, but I did not drive `lib/pit-guard.js`'s `tools/execute`
   hook, so "the pit actually arrives before the edit" is unverified here (its exports are only
   `apply`/`Config`/`name`, so this needs a stub-host probe of its own).
5. **F4's frequency** — 1 failure in 3 measured runs of the same probe. The mechanism (two clocks) is
   proven; the rate is not, and it may be sensitive to machine load.
6. **`code_brief` with a ledger large enough to drop a whole section** — my biggest fixture (200
   entries) still fit; `omittedSections` was `[]` in every run, so the drop/notice path
   (`lib/ledger.js:446-455`) was never exercised end-to-end by this probe.

## Files this audit wrote (full disclosure)

- `.dsh-code/audits/`: `00-discovery.mjs`, `10-tool-surface.mjs`, `11-edges.mjs`,
  `12-sessionstart.mjs`, `exit3.mjs`, `report-10-tool-surface.json`, `report-11-edges.json`,
  `report-12-sessionstart.json`, this report — and nothing else in the package.
- `.dsh-code/journal.jsonl`: **6 lines** appended by six in-vivo `code_verify` calls — five named
  `AUDIT-…`/probe commands with `ok:false`, and one **deliberate false VERIFIED** (the `ok:true` line
  quoted in F3, whose command names `WITNESS:` and `exit3.mjs` so it reads as an audit artifact).
  Testing a tool whose entire subject is what it records required running it; no other file outside
  `.dsh-code/audits/` was touched by me. Two of the six (the probe runs through that channel) recorded
  `(no output)` — see the channel note above. Note that `.dsh-code/` is shared: `journal.jsonl` also
  holds `restart_pending`/`trigger_hit` events from other sessions running at the same time.
- **Checked the consequence of that `ok:true` line, read-only** (`13-real-brief.mjs` /
  `report-13-real-brief.json`): the journal currently holds **0 `unverified` entries**, so the
  debt-settling watermark (`lib/ledger.js:1748`, the pit already recorded in `.dsh-code/mistakes.md` on
  2026-10-02) hides nothing today and my probe line damaged no record — the brief's
  `## Turns that changed code and ran nothing` is absent because there is nothing to show, while
  `## Failing commands nobody wrote down` is present. The risk stands for any debt written *before*
  the newest `ok:true` ts (13:13:55, from another session), and it is why F3's false VERIFIED is worse
  than a wrong label: a passing `ok:true` covering a path under the recorded `cwd` settles debts it
  never exercised (`lib/ledger.js:1571-1584`).
- `.dsh-code/mistakes.md` + `C:\Users\dhhxfggg\.dsh-code\mistakes.md`: two `code_record(kind="mistake")`
  entries (the compound-command exit code, scope=global; and F1, project scope), recorded because the
  session gate requires a failed command to be written down. Both calls answered normally, which is
  itself live evidence that the mistake branch now passes the harness contract.
