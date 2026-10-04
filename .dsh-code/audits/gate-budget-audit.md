# Audit: the DSH code-mode plugin pack's gate / budget / pit-guard layer

Scope: `lib/compact-gate.js`, `lib/gate-verify.js`, `lib/budget.js`, `lib/pit-guard.js`, and the
debt-settlement half of `lib/ledger.js` they depend on.
Method: every finding below was produced by driving the **real handler** through stubs for its
dependencies, never by re-implementing its logic. Probes live in `.dsh-code/audits/` and their JSON
reports sit next to them. Nothing outside `.dsh-code/audits/` was written.

Host facts the audit leans on (all read out of `E:\tools\DSH\resources\app.asar` with
`probes/asar-read.mjs`):

- `agent/pre-step` signature — `dsh-tool-cordis/lib/types/api-catalog.js:3766`:
  `(payload: { agent, messages, turn, step, signal }, next: () => Promise<PreStepDecision>)`.
- the agent loop's own fallback — `dsh-agent-loop/lib/index.js:911-918`:
  `this.dispatch.waterfall("agent/pre-step", { messages: claimed, ...position, signal }, () => Promise.resolve({ kind: "enter", messages: ... }))`.
- the event bus → `@deepseek-ai/cordis` `EventsService.waterfall` (`cordis/lib/index.js:317-325`).
- `tools/pre-execute` — `dsh-tools/lib/index.js:3225`, decision read at `:3241-3242`
  (`decision.kind`, `decision.reason`, `decision.info`).
- `tools/post-execute` — `dsh-tools/lib/index.js:3504`, decision applied at `:3506-3531`
  (`:3515` throws when an accept decision carries both `value` and `content`).
- `userQuestions.askTimed` — `dsh-user-questions/lib/index.js:613-651`; answer shape from the
  client (`dsh-client-ui-user-questions/lib/client.js:529-532`, `:936-996`):
  `{ answers: [{ id, selected: [label] }] }`.

## Findings

| id | severity | one-line claim | evidence |
|----|----------|----------------|----------|
| **F1** | **wrong-output** | `lib/compact-gate.js` emits both its notices with `next(patch)`; the host's waterfall **discards the patch**, so the 60% warning and the handover instruction never reach the model — while the card is still asked and the answer still consumes the margin. | `probe-waterfall-next.mjs` — A2 FAIL, A4 FAIL, A3/A5/A6/A7 ok; session scan: `code-compact-gate` **0** messages in 110 logs vs `code-pit-guard` **1398**, `code-gate` **8** |
| **F2** | **loses-data** | `lib/gate-verify.js` counts a run tool as evidence **by name only**: a `code_verify` whose expectation did not match, or that exited non-zero, is filed as `proved`, so no `unverified` debt is recorded and no notice is delivered. | `probe-gate-evidence.mjs` — B1 FAIL, B3 FAIL, B2/B4/B5 ok |
| **F3** | **breaks-a-turn** | A recorded `trigger:` whose regex backtracks catastrophically hangs `tools/pre-execute` — synchronously, with no timeout, no length cap, and the pattern tested twice per command. | `probe-regex-hazard.mjs` — 10 / 39 / 151 / 565 / 2385 ms at 17 / 23 / 25 / 27 / 29 chars; control 1 ms |
| **F4** | **wrong-output** | Debt settlement collapses to "a passing verification happened in this project": a bare `code_verify 'echo hi'` recorded at the project root erases the debt on any file in that project — the exact counter-example `unverifiedExcerpt`'s own doc says was measured and fixed. | `probe-debt-coverage.mjs` — E1 FAIL; E1b/E5 ok (a real `pnpm test` settles; an out-of-tree proof does not) |
| **F5** | breaks-a-turn (latent) | The gate has no watchdog of its own: `await measure(...)` and `await askTimed(...)` are unbounded, so a dependency that never settles holds the step forever. The stock answerer defends itself; the model-info lookup depends on the adapter. | `probe-compact-open.mjs` — C8 `held`, C9 `held` |
| **F6** | breaks-a-turn (latent, unlikely) | The *fail-open* branch itself can throw: `JSON.stringify(answer ?? null)` and an unguarded `ctx.logger?.warn?.()` inside the catch, so an unrecognised answer or a throwing logger rejects the hook instead of releasing the step. | `probe-compact-open.mjs` — C20 `threw`, C21 `threw`, C22 `threw` |
| **F7** | cosmetic | `code-budget`'s "head **and** tail" promise silently becomes head-only when `headChars >= maxResultChars - NOTE_RESERVE`; nothing validates the relation at mount. Not live with the mounted config. | `probe-budget-shapes.mjs` — G5 FAIL (398 chars, tail dropped), G5b ok (mounted defaults keep both) |
| **F8** | cosmetic (latent) | When a downstream `tools/post-execute` listener returns an accept decision carrying `value`, budget's `{...downstream, content: trimmed}` produces a decision with **both** keys, which the host rejects with a `TypeError` — turning the tool call into an error result. | `probe-budget-shapes.mjs` — G9 FAIL (`keys: ["kind","value","content"]`); reachability of a value-carrying neighbour **unverified** |
| **F9** | cosmetic (latent) | The gate's callId is `code-compact-gate-${Date.now().toString(36)}`, so two concurrent asks for one agent collide on the same id (`askTimed` throws `DUPLICATE_WAIT` → fail open, no card). | `probe-compact-open.mjs` — C19 `cards: 2`, both callIds identical |

---

### F1 — the compaction gate's notices are discarded by the real event bus

**Severity: wrong-output** (the feature the file exists for does not reach the model; the second-worst
outcome it can have, after holding a turn).

Code (`lib/compact-gate.js:323-335`, warn stage):

```js
    // One warning per crossing, never a hold.
    if (stage === 'warn') {
      memory.warned = true;
      return next({
        messages: [
          ...(Array.isArray(payloadMessages) ? payloadMessages : []),
          createUserMessage({
            content: [{ type: 'text', text: warningText(ratio, limits, measurement, contextWindow) }],
            source: { kind: 'code-compact-gate', form: 'notice', summary: `context at ${percent(ratio)} of the window` },
          }),
        ],
      });
    }
```

and `:368-387`, handover stage, identical shape: `return next({ messages: [...payloadMessages, createUserMessage({... handoverText ...})] })`.

The host's waterfall (`cordis/lib/index.js:317-325`) is:

```js
	waterfall(...args) {
		const cbs = this.dispatch("waterfall", args);
		const inner = args.pop();
		const next = () => {
			return (cbs.shift() ?? inner)(...args);
		};
		args.push(next);
		return next();
	}
```

`next` is declared with **no parameters**: whatever a listener passes is ignored, the downstream
handlers and the innermost fallback keep receiving the original payload, and the fallback that builds
the step's decision is zero-argument
(`dsh-agent-loop/lib/index.js:915-918`). Every bundled notice-writer uses the other shape, e.g.
`dsh-time-context/lib/index.js:215-231`:

```js
	ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted) return decision;
		...
		return { ...decision, messages: [...decision.messages, createUserMessage({ ... })] };
```

Reproduction (drives the REAL handler on a REAL `@deepseek-ai/cordis` `Context`; only `tokenMeter`,
`llm` and `userQuestions` are stubbed):

```
$env:ELECTRON_RUN_AS_NODE='1'; $env:DSH_ASAR='E:\tools\DSH\resources\app.asar'
& 'E:\tools\DSH\DeepSeek Harness.exe' --max-old-space-size=1024 --expose-internals '.dsh-code\audits\probe-waterfall-next.mjs'
```

```
ok   A1 the REAL handler ran its warn branch (memory.warned set) — the branch is reached
FAIL A2 the warning notice reaches the step: fallback sees it in payload.messages, or it is in the decision
ok   A3 the same bus delivers a message a listener appends AFTER next() (the control)
FAIL A4 the human chose the handover: the instruction reaches the step
ok   A5 a bare next(patch) is discarded by the real bus: the fallback gets the ORIGINAL payload
ok   A6 the fallback is called with exactly one argument (no patch slot)
ok   A7 through the probe-style merging harness the SAME handler DOES deliver the notice (the blind spot)

5/7 passed, failed=[A2, A4]
```

Evidence values from `probe-waterfall-next.out.json`:

- A1 `{"warned":true,"asked":0}` — at 68% the warn branch ran.
- A2 `{"fallbackArgumentCount":2,"fallbackPayloadMessages":0,"decisionMessages":[],"decisionKind":"enter","asked":0}` — the notice is gone.
- A4 `{"granted":0.82,"actionHonoured":true,"fallbackPayloadMessages":0,"decisionMessages":[]}` — the human's
  "Write the handover" was read correctly (`granted` 0.82), the instruction was built, and it did not reach the step.
- A5 `{"receivedMessages":["ORIGINAL"]}` — the patch is dropped.
- A7 `{"messages":["[code-compact-gate] context is at 68% of the window (68,000 of 100,000"]}` — through the
  merging harness the same handler delivers, which is why the package's own 30 checks stay green.

The package's own suite, run while F1 is live (`node probes/handover-grant-probe.mjs`):

```
ok   H4 the instruction still says where the handover goes
ok   H5 the instruction points at a new conversation rather than at being compacted
ok   H6 the step is released with the instruction, never held
ok   H9 the instruction forbids summarising the conversation, and points at the ledger for the rest

12/12 passed, failed=[]
```

H4/H5/H6/H9 pass because that harness merges `next(patch)`
(`probes/handover-grant-probe.mjs:153-164`); the host does not (A5/A6). `probes/compact-gate-probe.mjs`
likewise reports every fail-open case PASS — and those are genuine, matching C1-C14 below.

Corroboration in the live host — the three plugins' injected messages across all 110 recorded sessions
(`node .dsh-code/audits/probe-session-sources.mjs`):

```
code-compact-gate: 0 message(s) in 0 log(s), forms=[]
code-pit-guard: 1398 message(s) in 24 log(s), forms=[notice]
code-gate: 8 message(s) in 6 log(s), forms=[notice]
logs=110 scanned=110 withSourceField=98
```

The detector is demonstrably able to see injected notices (1406 of them from the other two plugins,
which use the after-next shape), and the gate's warning line is 0.6 while the preset's own comment
records 28 sessions peaking in the 75-80% band (`cordis.patch.yml:87-94`) — so the absence of any
`code-compact-gate` message is not "the line was never crossed".

**Refutation attempt — survived.** (1) "The host must merge the patch; the package's probes model it
that way" — refuted by A5/A6 (real bus) and by `cordis/lib/index.js:320` (`next` takes no arguments).
(2) "The loop must read the handler's return value instead" — refuted: what the handler returns *is*
`next(patch)`'s return, which is the zero-argument inner fallback's decision.
(3) "`createUserMessage` in `lib/pit-guard.js`/`lib/gate-verify.js` proves patches work" — no: F1 is
exactly the asymmetry inside this package; pit-guard and gate-verify append after `next()`
(`pit-guard.js:495-497`, `gate-verify.js:275-278`) and their messages *are* in the session logs.

**A fix would touch** `lib/compact-gate.js:326` and `:378` only — take the decision from `await next()`
and append, as the two sibling files already do:

```js
const decision = await next();
if (!Array.isArray(decision?.messages)) return decision;
return { ...decision, messages: [...decision.messages, createUserMessage({ ... })] };
```

The probe to add to the package's suite is the one thing its current harness cannot express: drive
`agent/pre-step` through a real cordis `Context` (or at least assert that the handler's notices come
back in the *returned decision*, not in a merged payload).

---

### F2 — a failed `code_verify` counts as proof

**Severity: loses-data** (the debt that makes unproven work survive the turn is never written).

Code (`lib/gate-verify.js:173-192`):

```js
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    try {
      const agent = exec?.agent;
      if (agent !== undefined && agent !== null) {
        const record = account(agent);
        ...
        } else if (runTools.has(tool)) {
          record.ranAny += 1;
          if (proofTools.has(tool)) record.ranProof += 1;
          else record.commands.push(commandOf(exec.arguments, tool));
```

`_result` is never read, so `evidenceState()` (`:79-82`) answers `'proved'` for *any* `code_verify`
call, and `agent/turn-stopping` (`:299`) then skips `recordUnverified` entirely.
The tool itself reports the failure in its own render (`lib/tool-verify.js:53-65`):
`exit 0, but the expected output never appeared` / `FAILED (exit N)` / `exitCode 0 · expectation not matched · ok false`.
The other half of the package disagrees: `lib/ledger.js:1757` keeps only
`e.kind === 'verified' && e.ok === true` as a settling proof.

Reproduction (`node .dsh-code/audits/probe-gate-evidence.mjs`), one whole turn per case —
edit, run, three more tool calls, `turn-stopping`:

```
FAIL B1 a turn that edited a file and ran ONLY a mismatched code_verify writes an `unverified` debt
       <- {"unverified":0,"gateJournal":"...\"event\":\"run\",\"tool\":\"code_verify\",\"proof\":true,\"ranAny\":1,\"ranProof\":1..."}
ok   B2 the gate journal records that turn as `proved` even though the tool reported ok false
       <- {"turnStopping":["\"event\":\"turn-stopping\",\"state\":\"proved\",\"edits\":1,\"ranAny\":1,\"ranProof\":1,\"turn\":1,\"debt\":false}"],"noticeDelivered":0}
FAIL B3 a code_verify that FAILED (exit 1) also leaves an `unverified` debt
       <- {"unverified":0}
ok   B4 CONTROL: the same turn with a plain pwsh run DOES write the debt and DOES deliver the notice
       <- {"unverified":1, ... "event":"notice-delivered" ...}
ok   B5 the ledger half treats the same failing verification as NO proof (debt stays visible)
       <- "## Turns that changed code and ran nothing ... - 2026-10-04 13:11: write ...\\src\\a.js"
```

B2 is the gate's own opt-in debug journal (`DSH_CODE_GATE_JOURNAL`): for a turn whose only run was a
`code_verify` that printed `ok false`, it writes `"proof":true` … `"state":"proved"`, `"debt":false`, and
no `notice-delivered` event at all. B5 shows the ledger half still listing the very same turn as
unproven, i.e. the two halves of one package disagree about what "verified" means.

**Refutation attempt — survived, with one honest caveat.** (1) "`_result` doesn't matter because a failed
run sets `isError`" — irrelevant, `_result` is unused; and the tool's failing outcomes are ordinary
accepts (`tool-verify.js` returns a value, never `isError`). (2) "The evidence is durable anyway" —
*partly* true: `recordVerified` writes the failing run to `journal.jsonl` with `ok:false`, so a reader who
goes looking can find it. What is missing is the mechanism that makes a reader look: no `unverified`
entry and therefore nothing in the next `code_brief`. (3) "This is intended: any real run deserves
credit" — contradicted by the file's own doc (`gate-verify.js:20-29`, "the durable ledger keeps the
distinction between 'tried' and 'proved'") and by `ledger.js:1757`.

**A fix would touch** `lib/gate-verify.js:189-192`: read the result, and give the gate a third state.

```js
} else if (runTools.has(tool)) {
  record.ranAny += 1;
  if (proofTools.has(tool) && proofSucceeded(exec, _result)) record.ranProof += 1;
  else record.commands.push(commandOf(exec.arguments, tool));
```

where `proofSucceeded` refuses a result whose text contradicts it (`ok false`, `not matched`,
`FAILED (exit`, `[sandbox denied`) or whose `isError === true` — the same shape `pit-guard.js:273-279`
already reads. `evidenceState` needs a `'ran'`-like state for "a proof tool ran and did not pass", and
`lib/ledger.js`'s `unverifiedExcerpt` already renders `state === 'ran'` lines.

---

### F3 — a recorded `trigger:` can hang `tools/pre-execute`

**Severity: breaks-a-turn** (a synchronous, uninterruptible hang before the command runs).

Code (`lib/pit-guard.js:204-219`):

```js
function matchesTrigger(trigger, command) {
  try {
    const re = new RegExp(String(trigger), 'i');
    return re.test(command) || re.test(command.replace(/\s+/g, ' '));
  } catch {
    return false;
  }
}
```

and the call site, inside `tools/pre-execute` (`:374-376`): for every entry of both ledgers,
`if (entry.trigger === undefined || !matchesTrigger(entry.trigger, command)) continue;`.
The file's own doc says a trigger that "compiles and matches nothing stays undetectable" (`:379-386`);
the failure mode not considered is a pattern that compiles and matches *expensively*. The `try/catch`
cannot fire: catastrophic backtracking is a hang, not an exception. `code_record`'s write-time check
compiles the pattern and tests it against a sample, which bounds neither input length nor complexity.

Reproduction — the real `tools/pre-execute` handler against a scratch project whose `mistakes.md` carries
one pit with `- trigger: ^(a+)+$`, one `pwsh` call per size, command = `a`×n + `!`:

```
node .dsh-code/audits/probe-regex-hazard.mjs
chars=17 elapsed=10ms
chars=23 elapsed=39ms
chars=25 elapsed=151ms
chars=27 elapsed=565ms
chars=29 elapsed=2385ms
control (linear trigger, 26 words) elapsed=1ms
```

Roughly ×4 per added character: a 40-character command line is minutes, and `matchesTrigger` runs the
pattern **twice** (raw and collapsed), for **every** recorded entry, on **every** shell call.

**Refutation attempt — survived.** (1) "The ledger validates triggers at write time" — it compiles them;
complexity is never measured, and the sample a human supplies at write time is short by construction.
(2) "V8 optimises nested quantifiers" — measured, it does not for this shape. (3) "A user-supplied
pattern is the user's problem" — the pattern is data in a file the guard itself maintains, and the
consequence (a tool call that never starts, with no log line explaining why) is invisible.

**A fix would touch** `lib/pit-guard.js:212-219` (bound the work) and the write path in
`lib/tool-record.js`/`lib/ledger.js` (validate cost, not just syntax). Options, cheapest first: cap the
string handed to `re.test` *and* measure the compiled pattern against a long adversarial sample under a
wall-clock budget at write time, refusing or flagging the entry; precompile each entry's regex once
instead of per call; or move the match into a child process with a kill timeout, since in-process V8
regexes are not interruptible.

---

### F4 — debt settlement collapses to "something passed in this project"

**Severity: wrong-output** (the brief tells the next session the work was proven).

Code (`lib/ledger.js:1571-1584`):

```js
function proofCoversTarget(proof, target) {
  const path = comparablePath(target);
  if (path.length < 3) return true; // nothing to match on: do not manufacture a debt
  if (typeof proof.cwd === 'string' && proof.cwd.trim().length > 0) {
    const base = comparablePath(proof.cwd);
    if (base.length > 0 && isAncestorOrSelf(base, path)) return true;
  }
  const needle = path.split('/').at(-1) ?? '';
  if (needle.length < 4) return false;
  return [proof.cmd, proof.tail].some((text) => typeof text === 'string' && text.toLowerCase().includes(needle));
}
```

`proof.cwd` is written by `recordVerified`, and `code_verify` passes it the **project root**
(`lib/tool-verify.js:68`, `const root = ledgerRoot(exec)`), which is an ancestor of every file in the
project. So the structural branch settles anything in-tree regardless of what the command did, and the
rule documented three lines above (`:1736-1744`) — "only for the edits that verification actually
covers … a bare `echo hi` silently deleted this whole section, telling the next reader the work had been
proven" — is not what the code implements for in-tree targets.

Reproduction (`node .dsh-code/audits/probe-debt-coverage.mjs`), with a 25 ms gap so the ISO-timestamp
comparison is decisive:

```
FAIL E1 a bare passing `echo hi` recorded at the project root does NOT settle the debt on that project's lib/a.js
       <- {"debtStillVisible":false,...}   (brief text ends at "verified: echo hi" — the section is gone)
ok   E1b CONTROL: a real project test (`pnpm test`) at the root settles the debt (documented intent)
ok   E2 a proof naming a different path elsewhere leaves the debt visible (and names it)
ok   E3 a proof that did not cover the debt is named in the brief rather than dropped
ok   E4 CONTROL: a proof naming the file settles it
ok   E5 a project-root proof does not settle an edit made OUTSIDE that project (no false coverage across trees)
ok   E6 a FAILING verification leaves the debt visible
ok   E7 a claimed (not independently verified) proof leaves the debt visible
```

**Refutation attempt — survived, but this is the weakest of the real findings.** The counter-argument is
strong and partly right: the doc *wants* a project-level `pnpm test` to cover the project's files, and
`echo hi` cannot be told from `pnpm test` without knowing which command is the real test — which the
ledger *does* record (`commands.test`, and `gate-verify.js:114-122` already reads it). So the narrow
claim I stand behind is: the per-file half of the rule is unreachable for in-tree targets, and the
specific regression the doc says was fixed is still reproducible; the out-of-tree half *is* fixed (E5),
and mismatched proofs are named rather than dropped (E2/E3), which is what the requirement asked for.

**A fix would touch** `lib/ledger.js:1571-1584` (and, if the intent is to keep root-level proofs
covering the project, its doc comment). Two shapes: require the literal branch for in-tree targets unless
the proof's command is the project's declared `commands.test`; or have `code_verify` record what it was
asked to cover (`covers:` argument, defaulting to "the whole project") and settle only against that.

---

### F5 — the gate has no watchdog of its own

**Severity: breaks-a-turn (latent)** — the class the file promises never to have ("No answerer, a dead
UI, a timeout, an unrecognised answer or any internal error falls through to the engine", `:44-47`).

Code (`lib/compact-gate.js:302-316` and `:339-354`):

```js
    try {
      occupancy = await measure(ctx, agent, signal);   // -> await llm.resolveModelInfo(...)
      ...
    } catch { return next(); }
    ...
      answer = await questions.askTimed(
        { questions: [question], agent, signal },
        `code-compact-gate-${Date.now().toString(36)}`,
        limits.askTimeoutMs,
      );
```

Both awaits are unbounded: `askTimeoutMs` is *passed to* the answerer, never enforced here, and nothing
bounds `resolveModelInfo`.

Reproduction (`node .dsh-code/audits/probe-compact-open.mjs`, `held` = neither resolved nor called
`next()` within 250-400 ms):

```
held      C8   askTimed never settles (an answerer that never answers)      {"asked":1}
held      C9   llm.resolveModelInfo never settles (an adapter that hangs)   {"asked":0}
```

**Refutation attempt — split, and this is why the finding is marked latent.** For the ask half the
stock host defends itself: `dsh-user-questions/lib/index.js:613-651` wraps the wait in
`TimedQuestionWait` (`:297-336`), which arms a host-side `setTimeout` while no client holds the wait and
re-arms it when a client's claim is released (a disconnect aborts the claim), then maps `ASK_TIMED_OUT`
to `{ pending: true }` — which the gate handles (C3 `released`). So "an answerer that never answers" is
*not* reachable through the shipped service; it is reachable if `userQuestions` is replaced, and the
plain "answerer that hangs" model is exactly what `ctx.get('userQuestions')` re-reads at every step
(the file deliberately avoids `inject`). For the model half nothing defends it: `resolveModelInfo` ends
at an adapter's own `resolveModel` (`dsh-llm/lib/index.js:2101-2104`) with the caller's `signal` and no
timeout — a stalled adapter holds the step. I did not measure a real adapter stalling it (**unverified**
for reachability; the hold itself is measured in C9).

**A fix would touch** `lib/compact-gate.js:306` and `:344`: race each await against a local timer
(`Promise.race([call, timeout])`) and fall through on expiry, so the gate's fail-open does not depend on
a service honouring a parameter.

---

### F6 — the fail-open branch can throw

**Severity: breaks-a-turn (latent, unlikely)**.

Code (`lib/compact-gate.js:349-353` and `:395-398`):

```js
    } catch (error) {
      ctx.logger?.warn?.(
        `${NOTICE_MARKER} could not ask (${error?.code ?? error?.message ?? error}); falling through to the engine`,
      );
      return next();
    }
    ...
    ctx.logger?.warn?.(`${NOTICE_MARKER} unrecognised answer ${JSON.stringify(answer ?? null)}; falling through to the engine`);
    return next();
```

Reproduction (`node .dsh-code/audits/probe-compact-open.mjs`):

```
threw     C20  fail-open path with a logger that throws                  {"error":"Error: logger exploded"}
threw     C21  unrecognised answer containing a cycle (JSON.stringify in the warn log)
                                                                        {"error":"TypeError: Converting circular structure to JSON ..."}
threw     C22  unrecognised answer containing a BigInt                  {"error":"TypeError: Do not know how to serialize a BigInt"}
```

An exception out of an `agent/pre-step` listener rejects the step's waterfall; the loop's `kick()`
swallows it (`dsh-agent-loop/lib/index.js:887-901`) and the turn ends — the one outcome the file's
contract rules out.

**Refutation attempt — survived only as a robustness defect.** The stock answer path is JSON (a remote
RPC), so a cycle or a BigInt cannot arrive from the shipped UI; `ctx.logger` is the host's logger and
does not throw. Both are third-party/in-process surfaces. Reachability judged **unlikely**; what is
certain is that the two lines whose whole job is "never break the turn" are themselves unguarded.

**A fix would touch** `lib/compact-gate.js:350` and `:397`: a `try { … } catch {}` around both log
calls, and a stringifier that cannot throw (`String(answer)` / a depth-limited replacer).

---

### F7 — `code-budget`'s head+tail can degrade to head-only

**Severity: cosmetic.**

Code (`lib/budget.js:98-114`):

```js
  const budget = Math.max(0, Math.min(limits.maxResultChars - NOTE_RESERVE, limits.headChars + limits.tailChars));
  let remaining = Math.max(0, Math.min(limits.headChars, budget));
```

When `headChars >= maxResultChars - NOTE_RESERVE`, `budget` is filled by the head and `keepTail` is all
zeros, so the "head and the tail" note is literally false. `resolveLimits` (`:51-59`) validates types,
not the relation.

Reproduction (`node .dsh-code/audits/probe-budget-shapes.mjs`):

```
FAIL G5 an oversized result comes back as {kind:"accept", content} no longer than maxResultChars, keeping head and tail
       <- {"kind":"accept","chars":396,"head":"line 0 yyyyyyyyyyyyyyyyyyyy\nline 1 yyyyy","tail":"— offset/limit, ..."}
ok   G5b with the defaults code-budget is mounted with, the kept text has BOTH a head and a tail
       <- {"chars":16221,"head":"line 0 ...","tail":"... do not re-run it the same way."}
ok   G8 with maxResultChars below NOTE_RESERVE the result is still bounded by the cap (or the note, whichever is larger)
```

**Refutation attempt — succeeded, for the live profile.** `cordis.patch.yml:173` mounts `code-budget`
with **no** `config:`, so the library defaults apply (24000 / 12000 / 4000), where both ends survive —
G5b passes. The trap needs a config edit (`maxResultChars` lowered, `headChars` raised), which is exactly
what the neighbouring `tool-result-pruner` row does with 4096/1024 (`cordis.patch.yml:104-107`), so it is
a plausible future edit rather than a present defect.

**A fix would touch** `lib/budget.js:100-107`: derive the head budget from the cap
(`head = Math.min(headChars, Math.max(0, budget - Math.min(tailChars, budget)))`), or say in the config
docs that `headChars + NOTE_RESERVE` must stay below `maxResultChars`.

---

### F8 — the trimmed decision can carry both `value` and `content`

**Severity: cosmetic (latent).**

Code (`lib/budget.js:184-191`):

```js
        const trimmed = trimContent(downstream.content, limits);
        if (trimmed !== undefined) return { ...downstream, content: trimmed };
```

`downstream` is whatever the rest of the `tools/post-execute` chain returned. The host accepts an accept
decision that replaces `content` **or** `value`, never both
(`dsh-tools/lib/index.js:3515`: `throw new TypeError("tools/post-execute accept decision cannot replace both value and content")`),
and a throw there is caught by the tool dispatch and turned into an error result.

Reproduction (`node .dsh-code/audits/probe-budget-shapes.mjs`):

```
FAIL G9 when a downstream post-execute decision carries `value`, the trimmed decision does not carry both keys (host rejects that)
       <- {"keys":["kind","value","content"],"both":true}
```

**Refutation attempt — inconclusive on reachability, and I am labelling it so.** I confirmed the shape is
produced; I did **not** confirm that any mounted plugin returns a value-carrying accept decision today.
The bundled peers I read all avoid it: `dsh-spill-policy` guards explicitly
(`if (decision.kind !== "accept" || Object.hasOwn(decision, "value") || …) return decision;`, `lib/index.js:239`),
`dsh-tool-fs-search:848-863` and `dsh-hooks-claude-code:265-289` return `content`/`additionalContexts`
only. So: reachability **unverified**, hazard real (the host type allows `value`).

**A fix would touch** `lib/budget.js:190`: `const { value, ...rest } = downstream; return { ...rest, content: trimmed };`
(or skip trimming when `value` is present, as spill-policy does).

---

### F9 — a `Date.now()`-keyed callId

**Severity: cosmetic (latent).** `lib/compact-gate.js:346`:
`` `code-compact-gate-${Date.now().toString(36)}` `` — the id is the key `askTimed` uses for its
per-agent wait map (`dsh-user-questions/lib/index.js:616-617` throws `DUPLICATE_WAIT` when it repeats).
Reproduction (`node .dsh-code/audits/probe-compact-open.mjs`):

```
observed  C19  two pre-steps in flight for the same agent: how many cards?
            {"cards":2,"callIds":["code-compact-gate-mutublwk","code-compact-gate-mutublwk"],"kinds":["released","released"]}
```

Both asks in the same millisecond get the same id; with the stock service the second throws
`DUPLICATE_WAIT` and falls open (no card, one warning line). I found no stock path that runs two
pre-steps concurrently for one agent, so **reachability is unverified**; the collision itself is measured.
A fix would touch `:346` — a monotonic counter or `randomUUID()`.

---

## What I checked and found clean

Every item below was executed, not read.

**`lib/compact-gate.js` — fail-open and memory (probe `probe-compact-open.mjs`, 22 cases).**
`released` (the step went through) for: no `userQuestions` service at all (C1, with the warn log);
`askTimed` rejecting with `DELEGATED_CALLER` (C2 — the path a sub-agent session takes); `askTimed`
resolving `{pending:true}` (C3); `{answers:[]}` (C4); a free-text answer (C5); a numeric index inside
`selected` (C6 — see the note below); `null` (C7); `resolveModelInfo` rejecting (C10); an unknown
context window (C11 — no question is asked at all, which is right); `tokenMeter` missing (C12),
throwing (C13) or returning no `totalTokens` (C14); `"Compact now"` (C18 — no annotation, no grant, the
engine below compacts). Warning economics: the notice fires on the first step above `warnRatio` and not
on the next one, and re-arms only after occupancy drops back under it (C15: 1 / 0 / 0 / 1 notices).
Grant economics: `"Let me continue"` at 82% covers the following step at the same occupancy and asks
again at 88% (C16). The handover: takes the margin (0.82), re-arms the warning (`warned === false`),
and the next step does not ask again (C17) — the recorded design fix holds. `decideStage`'s
millionth-rounding boundary is covered by the package's own P4/P5 and by C16 here; I re-ran the
package's `handover-grant-probe.mjs` (12/12 pass) and `compact-gate-probe.mjs` (all fail-open cases
PASS) for contrast, not as evidence of the host's behaviour.

**The answer shape.** The shipped UI sends `{ answers: [{ id, selected: [label] }] }`
(`dsh-client-ui-user-questions/lib/client.js:529-532`, `:936-996`), which `chosenAction` reads through
the `first.selected[0]` string path — verified against that shape (C17/A4 read the label correctly).
Note, not a defect: an index sent *inside* `selected` (`{selected:[2]}`) is not accepted (C6 returns
`-1` → unrecognised → fail open) even though the doc says an index is the reading that "cannot be
wrong"; the shipped client sends labels, so this is fragility, not a live bug.

**`lib/gate-verify.js`.** `tools/post-execute`'s real signature is `(exec, result, next)`
(`dsh-tools/lib/index.js:3504`), so pit-guard's `failureOf(result)` is reading the right argument.
The after-next notice pattern works end to end (B4 shows `notice-delivered`). The pwsh path records the
debt with `state:'ran'` and names the commands (B4). A turn with edits and *no* run still records
`state:'none'` (B4's control plus the package's own gate-probe).

**`lib/budget.js` (`probe-budget-shapes.mjs`).** The deny shape matches what the host reads —
`{kind:'deny', reason, info:{name,code,reason}}` with the marker in the reason (G1); a ranged read of the
same oversized file is allowed (G2); a missing target neither throws nor denies (G3, `statSync` with
`throwIfNoEntry:false`); non-read tools pass through (G4); a result under the cap is returned as the same
object (G6); a `deny` from another plugin is not rewritten (G7); a cap below the note reserve still
returns something bounded (G8).

**`lib/ledger.js` debt settlement (`probe-debt-coverage.mjs`).** A failing proof leaves the debt visible
(E6), a `claimed` proof does not settle it (E7), an out-of-tree proof does not settle it and *is named*
in the "… N earlier unproven turn(s)" line rather than dropped (E2/E3/E5) — the requirement that
mismatched proof be named rather than silently dropped holds. Measured, and noted because it is
load-bearing for any future test: `unverifiedExcerpt` compares ISO timestamps with `proof.ts > when`, so
a proof written in the **same millisecond** as the debt does not settle it. Not reachable in the real
flow (the debt is written at `turn-stopping`, after any proof of that turn), but a probe that records
both without a gap measures the clock, not the rule — my first version of E1/E2/E3 did exactly that and
had to be fixed.

**Live evidence that the framework works.** During this audit the pit guard fired on my own commands
twice and delivered a real notice (the `Select-Object -First` and `ELECTRON_RUN_AS_NODE` entries, plus
the `-ErrorAction SilentlyContinue` trigger at the start) — i.e. `matchesTrigger`, `announce`, the
per-notice dedup and the after-next delivery all work in this very session, which is the positive
control for F1's negative result. I complied with the pit and did **not** diagnose the `[exit code: 1]`
that came with complete output as a failure.

**Session evidence (`probe-session-sources.mjs`).** 110 logs, 98 carrying message sources:
`code-pit-guard` 1398 notices in 24 logs, `code-gate` 8 in 6, `code-compact-gate` 0 in 0.

---

## What I did not verify

- I did not drive the **real agent loop** end to end (a live turn through `ReActLoop.preStep`); F1 is
  proven at the level of the real event bus plus the real handler plus the loop's own zero-argument
  fallback, read from source. A live session with a >75% context and an answerer would close the last
  gap.
- I did not observe the gate's card being asked in a live session. As a sub-agent, `askTimed` would
  throw `DELEGATED_CALLER` for me (C2 covers that path by stub, and the host source at
  `dsh-user-questions/lib/index.js:146-155` confirms the rule).
- Reachability of F5's model-info hang (adapter-dependent) and of F8's value-carrying neighbour
  (no mounted producer found) are **unverified**; only the code paths are measured.
- I did not exercise `lib/pit-guard.js`'s `restart_pending` note, `noteRestartPending`, or
  `code_record`'s write-time trigger validation (read only).
- I did not test `pit-guard`'s mistake-debt settlement against a real failing-command turn in the host
  (the journal in this repository does contain `mistake_unrecorded` events, which is consistent with the
  code, but I did not reproduce one here).
- No fix was applied: this was read-only outside `.dsh-code/audits/`, so nothing here is verified as a
  repair. The ledger pit-guard's debt for my own `ELECTRON_RUN_AS_NODE` command is deliberately left
  unpaid rather than written to `.dsh-code/mistakes.md`, which the read-only constraint covers.

## Probe inventory (all under `.dsh-code/audits/`)

| file | what it drives | report |
|------|----------------|--------|
| `probe-waterfall-next.mjs` | real `@deepseek-ai/cordis` `Context` + real `compact-gate.js` pre-step handler | `probe-waterfall-next.out.json` |
| `probe-gate-evidence.mjs` | real `gate-verify.js` post-execute / pre-step / turn-stopping + real `ledger.js` | `probe-gate-evidence.out.json` |
| `probe-compact-open.mjs` | real `compact-gate.js` pre-step handler, 22 dependency/answer shapes | `probe-compact-open.out.json` |
| `probe-session-sources.mjs` | the 110 recorded session logs (`~/.dsh/sessions`) | `probe-session-sources.out.json` |
| `probe-debt-coverage.mjs` | real `ledger.js` `recordUnverified`/`recordVerified`/`brief` | `probe-debt-coverage.out.json` |
| `probe-regex-hazard.mjs` | real `pit-guard.js` pre-execute handler vs a catastrophic `trigger:` | `probe-regex-hazard.out.json` |
| `probe-budget-shapes.mjs` | real `budget.js` pre/post-execute handlers | `probe-budget-shapes.out.json` |
