# Audit: values restated at the point of use (2026-10-10)

Produced by a read-only inventory over `lib/`, `probes/` and `cordis.patch.yml`, after two of
the same shape were found and fixed by hand. The shape is: **a value is written down where it is
used instead of being resolved there**, so the copy keeps working while the thing it describes
moves. Both originals were live bugs, not tidiness:

1. `probes/cleanup-migrated-ledgers.mjs` computed the ledger store itself (`DSH_CODE_GLOBAL_DIR ?? ~/.dsh-code`) instead of asking `lib/ledger.js`; after the home moved to `~/.dsh/code` a run without an override resolved a store that no longer exists — and it deleted a file while calling it a duplicate it had never compared. **Fixed** (containment check per file + `projectStoreDir()`).
2. `lib/ledger.js` built every reader-facing pointer with `path.join(DIRNAME, FILES.project)`, so a migrated project was told to read `.dsh-code/project.json`, which does not exist. **Fixed** at `:631`, `:636`, `:2970`, `:3003`, plus `lib/pit-guard.js` notice labels (short relative label where the ledger is still inside the repo, resolved path where it is not), `lib/prompt.js`, `lib/tool-record.js`.

The list below is what is **still open**, ordered by severity. Each line names the owner the
copy should ask. Anything marked *(fixture, fine)* is deliberate: 20+ probes build a `.dsh-code/`
tree in a temp dir on purpose, and migration semantics do not apply to them.

## (a) Restated ledger locations

| where | what it says | why it can mislead | ask |
|---|---|---|---|
| `lib/ledger.js:437` | `No ledger yet at ${path.join(DIRNAME, FILES.project)}` | the only user-facing line on the "no ledger" path; wrong for a migrated project (the correct pattern is used 20 lines above at `:457`) | `ledgerDir(cwd)` |
| `lib/ledger.js:824` | `N older decision(s) in .dsh-code/decisions.md` (handover `## Avoid`) | the handover sends the next session to a path that does not exist | `ledgerPath(cwd,'decisions')` |
| `lib/ledger.js:876`, `:882` | `clipWithNotice` tail hints naming two `.dsh-code/…` files | read exactly when a section was cut and the reader wants the rest | `ledgerPath(cwd, …)` |
| `probes/journal-shape.mjs:25` | default target `<repo>/.dsh-code/journal.jsonl` | prints "no journal at …" on this repo while the journal is in the store | `ledgerPath()` |
| `probes/pit-liveness.mjs:75, :76` | project dir + `~/.dsh-code` | "no findings" over an empty directory is indistinguishable from "healthy"; the file already imports from `../lib/ledger.js` | `ledgerDir()` / `globalDir()` |
| `probes/ledger-census.mjs:17, :18` | same pair | the census reports 0 entries in both scopes | `globalDir()` / `ledgerDir()` |
| `probes/restart-gate-check.mjs:27, :28` | `<repo>/.dsh-code` + `~/.dsh-code/mistakes.md` | its headline "journal events read: 0" is a false negative for the very restart it checks | `ledgerDir()` / `globalDir()` |
| `probes/hard-block-audit.mjs:29, :30` | same pair | the audit's whole output is "which entries can hard-block"; on a migrated project it scans nothing and reports none | `ledgerPath()` / `globalDir()` |
| `probes/retired-entries-audit.mjs:34` | `DSH_CODE_GLOBAL_DIR ?? ~/.dsh-code` | reads a directory that no longer exists, so every current entry looks deleted | `globalDir()` |
| `probes/safe-case-live.mjs:64, :65` and `safe-case-parse.mjs:33, :34` | project + machine pair | the parser that proves safe-cases are readable reads zero entries | `ledgerPath()` / `globalDir()` |
| `probes/field-regex-trace.mjs:60` | machine mistakes file | the diagnostic you reach for when a field regex misbehaves reads nothing | `globalDir()` |
| `probes/splice-machine-ledger.mjs:17, :23` | retired home, and `readFileSync` with no try | hard ENOENT on this host, and its instructions send the operator to copy bytes into a retired directory — **also a deletion candidate** (one-shot; its subject is gone) | `globalDir()` |
| `probes/run-human-walkthrough.mjs:49` | `LEDGER = path.join(WS,'.dsh-code')` | fine for the default temp fixture, wrong when `--dir` points at a real migrated project | `ledgerDir(WS)` |
| `probes/ledger-writer.mjs:10` (docstring) | "children cannot write `~/.dsh-code/`" | a helper's operating rationale names the retired home | `globalDir()` |

Docs carrying the old layout (human-facing only, no code path): `INSTALL.md:29,30,91,93,107,180`,
`OVERVIEW.md:61,62`, `DESIGN.md:18,24,61,67`, `HANDOVER.md:12,60,75,88,89,94`, `TESTING.md:163`.
`HANDOVER.md` is itself a stale handover and should be rewritten, not patched.

## (b) Restated numbers (drift risk, nothing visibly wrong today)

- `cordis.patch.yml:93` — the comment claims the 0.6 warning is "a full 15 points ahead"; the derived ask line on this host is ~0.6485, so the live gap is ~5 points and is manufactured by `WARN_AHEAD_RATIO`. Owner: the code path that computes it (or delete the sentence).
- `lib/compact-policy.js:61-62` — `ENGINE_THRESHOLD_RATIO` / `ENGINE_HEADROOM_TOKENS` mirror the installed engine; nothing detects an engine upgrade (the existing probe compares the mirror with another literal of the same number). Owner: `dsh-compaction-basic` in app.asar.
- `lib/compact-policy.js:20, :27` (0.65 / 0.8) vs `cordis.patch.yml:96-97` (0.6 / 0.75) — two owners of "the lines"; the fallback is what `apply()` uses with no config, and `probes/compact-gate-probe.mjs:157, :173-175, :188, :209, :500` asserts the fallback literals.
- `cordis.patch.yml:105` — `thresholdChars: 8192` is declared for a pruner that `lib/budget.js` does not read (it reads `maxResultChars`/`headChars`/`tailChars`, defaults 24000/12000/4000). Whether the host rejects or ignores the unknown key, the preset describes a limit that is not in force.
- `lib/ledger.js:3571` truncates head/tail at a bare `0.6` while `lib/budget.js:30-31` declares 12000/4000 for the same job.
- `lib/ledger.js:758` `Math.floor(room * 0.55)` splits `HANDOVER_BUDGET`; `lib/ledger.js:1693` `overlap < 0.34` is an unnamed threshold; `lib/pattern-matcher.js:89` `SYNC_MAX_SUBJECT = 4096` mirrors a host bound nobody recorded.
- `probes/budget-chain-probe.mjs:107,108,113` hand-copies 12000/4000/24000 instead of importing the constants.
- `probes/gate-live-line.mjs:171` and `probes/handover-grant-probe.mjs:113` hand-copy the mounted ratios; `probes/gate-chance.mjs:54-72` already reads them from `cordis.patch.yml` and is the owner to use.

## (c) Numbers shown to a human/agent, measured against the wrong quantity

- `probes/ledger-census.mjs:63` prints "brief budget: 8900 chars"; the real ceilings are `SECTION_BUDGET` (`lib/ledger.js:262-272`, summing to 10,100) and `briefFull` uses the ceiling branch. "8900" is the figure `lib/ledger.js:283-285` itself calls smaller than the sum it should cover.
- `lib/ledger.js:206, :2192` and `lib/tool-record.js:312` repeat "8,900 characters" in prose that justifies the entry-length rule and a refusal message.
- `lib/compact-gate.js:59, :62` describes "default 0.65" and "default 0.8, the value the engine itself uses" — neither the mounted declaration (0.6/0.75) nor the effective mirrored line (~0.6485), and it contradicts `lib/compact-policy.js:54-59`.
- `probes/engine-reservation.mjs:109` re-implements `floor(min(window*0.8, window - reserved - 65536))` inline, in the probe whose job is to measure where real sessions compacted.
- `probes/gate-live-line.mjs:191-192` asserts the integers 648,464 / 678,464 outright; they are a function of the live window, the reservation and `ENGINE_MARGIN_TOKENS`, so a margin change makes the probe fail for arithmetic reasons.

## Not a finding (corrected during the audit)

`probes/gate-ahead-of-engine.mjs` imports `effectiveAskLine`/`engineThresholdTokens` from
`lib/compact-policy.js:31`, so its `800_000`/`678_464` expectations are a shared function's
return value, not a second implementation. Only its `WINDOW = 1_000_000` fixture constant
remains, which is a fixture.

## Known red, unrelated to this list

`probes/pit-guard-probe.mjs` J6 has been failing since the brief's section was renamed: the
assertion still looks for `## Failing commands nobody wrote down` while the code prints
"Earlier turns ran these, they failed, and the turn recorded no mistake". Proved pre-existing by
running the probe against the `HEAD` copy of `lib/pit-guard.js` (35/36, same single failure).
Fixing it is blocked this session by the `hard block: 2` entry that names this probe file —
which is the same design flaw as the barrier itself: a `files:`-keyed hard block refuses the
*second* legitimate edit to that file for the rest of the session.
