import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { DIRNAME, FILES, globalDir, isCentral, journalEvent, ledgerPath, ledgerRoot, noteRestartPending, recordMistakeDebt } from './ledger.js';
import { testPattern } from './pattern-matcher.js';

/**
 * The package's own root, found from this module's location.
 *
 * Used to recognise an edit to a file this *mode* is made of — `lib/*.js` — because that is
 * the edit whose effect a running host does not have: child plugin modules are imported
 * once, at mount, so a change to this file is dormant until DSH restarts. Recorded rather
 * than remembered, since the alternative is a human keeping it in their head.
 */
function packageRoot() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return undefined;
  }
}

/**
 * The pit guard: make the mistakes the ledger already paid for arrive *at the
 * moment of the decision*, not only at the start of the session.
 *
 * The mode already records mistakes (`code_record(kind="mistake")` writes
 * symptom/cause/fix/`files:`/do-not-repeat into `.dsh-code/mistakes.md`) and
 * already reads them (`code_brief` renders `## Known mistakes`). What was
 * missing is the third leg: nothing consulted that file while the agent was
 * about to edit the very file a past mistake names, so "don't do that again"
 * stayed an intention. Measured on this package 2026-10-02: the plugin that
 * exists to record pits had no ledger of its own, and its own lessons lived in a
 * hand-written LESSONS.md — the recording half alone does not change behaviour.
 *
 * 1. Read side (`tools/pre-execute` + `agent/pre-step`): an action that a known
 *    mistake names queues one notice, delivered before the next step, carrying
 *    that entry's do-not-repeat rule and its location. Entry text, not a pointer:
 *    a model does not open a file to follow an index. One notice per entry per
 *    session, because a warning that fires on every edit is a warning the model
 *    learns to ignore. Two ledgers are consulted — this project's and the
 *    machine-wide one — and two fields decide it: `files:` against the edit
 *    target, `trigger:` (an explicit regex, never a similarity guess) against the
 *    command line of a run-tool call.
 * 2. Write side (`tools/post-execute` + `agent/turn-stopping`): a turn that ran
 *    a command which failed and ended without recording a single mistake is
 *    appended to the journal as an unrecorded-mistake debt, which the next
 *    `code_brief` opens with. Recording that mistake settles it. This is the
 *    same shape as the unverified debt in `gate-verify.js`: a turn that is
 *    already ending cannot be stopped, so the ledger is what makes it survive.
 *
 * Everything here is advisory. Nothing blocks a call, and every handler swallows
 * its own errors, because a guard that breaks a turn is worse than a pit.
 */

export const name = 'code-pit-guard';

/** How long a `trigger:` may take inline before it is handled by the bounded worker. */
const PATTERN_INLINE_BUDGET_MS = 50;

/** Tool names that change one file, and whose target can be read off the args. */
const DEFAULT_EDIT_TOOLS = ['edit', 'write', 'multiedit', 'apply_patch', 'str_replace'];
/** Tool names that run a command, and report a failure through their result. */
const DEFAULT_RUN_TOOLS = ['pwsh', 'bash', 'shell', 'code_verify'];
/** A failing command run that produced no output still needs some signature. */
const NO_OUTPUT = '(no output)';

export const Config = z.object({
  /** Turn the guard off without unmounting the tools. */
  enabled: z.boolean().default(true),
  editTools: z.array(z.string()).default(DEFAULT_EDIT_TOOLS),
  runTools: z.array(z.string()).default(DEFAULT_RUN_TOOLS),
});

/** Per-agent accounting for the current turn; weak so it dies with the agent. */
const state = new WeakMap();

function account(agent) {
  let record = state.get(agent);
  if (record === undefined) {
    record = {
      cwd: undefined,
      session: undefined,
      turn: undefined,
      /**
       * Entries already announced to THIS agent, keyed `source#heading`. The
       * de-duplication is per agent object, not per session id: two agents sharing
       * a session each get the notice (measured 2026-10-02 by pit-guard-probe T1).
       * In the host one agent object per session makes both readings the same.
       */
      announced: new Set(),
      /**
       * 本 agent 内每条 `hard block:` 条目**被匹配到几次**，键同样是 `source#heading`。
       * 数的是"匹配到几次"，不是"通知过几次"：`announced` 在第一次命中后就永久为真，
       * 拿它当计数会让第二次以后的每一次都拒绝，而 N=2 的契约是"第二次才拒绝"。
       */
      hardHits: new Map(),
      /** Notices collected since the last step, waiting to be delivered. */
      pending: [],
      /** Failures seen this turn: `{ cmd, signature }`, first occurrence only. */
      failures: [],
    };
    state.set(agent, record);
  }
  return record;
}

/** Inlined so the guard still works when `apply` is called without validated config. */
function resolveLists(config) {
  return {
    editTools: new Set(config?.editTools ?? DEFAULT_EDIT_TOOLS),
    runTools: new Set(config?.runTools ?? DEFAULT_RUN_TOOLS),
  };
}

/** Normalise a path for comparison: separators unified, case folded, trimmed. */
function normPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Whether a recorded path token refers to the file being edited.
 *
 * A recorded token may be relative, may carry a `:line` suffix, and may be a
 * bare filename; the edited target may be absolute. The test is deliberately
 * anchored on a path-segment boundary (`…/${token}`) so a token like `a.js`
 * cannot match `data.json`, while `lib/prompt.js` still matches
 * `E:/projects/dsh-code-mode/lib/prompt.js`.
 * @param target - normalised path of the file being edited.
 * @param token - one recorded path, possibly with a line suffix.
 */
function refersTo(target, token) {
  const raw = String(token ?? '').trim().replace(/^[`"'([]+|[`"'),.\]]+$/g, '');
  if (raw.length === 0 || raw.length < 3) return false;
  const withLine = raw.replace(/:\d+(?:-\d+)?$/, '');
  const path = normPath(withLine);
  if (path.length === 0) return false;
  if (target === path) return true;
  return target.endsWith(`/${path}`);
}

/** Target file of an edit call, as a normalised path, or undefined. */
function editTarget(args, cwd) {
  const value = args?.file_path ?? args?.path ?? args?.target;
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const raw = value.trim().replace(/\\/g, '/');
  const absolute = /^[a-z]:\//i.test(raw) || raw.startsWith('/') ? raw : `${String(cwd ?? '').replace(/\\/g, '/')}/${raw}`;
  return normPath(absolute);
}

/**
 * Complete `## ` entries of one mistakes file, with the fields the guard needs.
 *
 * `files:` is answered against an edit target; `trigger:` is answered against the
 * command line of a run-tool call, for a pit that has nothing to do with a file
 * (a shell that mangles a pipe, a flag that changes meaning). `source` is carried
 * so the notice names the ledger the entry actually lives in: a machine-wide pit
 * quoted as if it were this project's would send the reader to the wrong file.
 */
function mistakeEntries(file, source) {
  let text;
  try {
    text = String(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  return text
    .split(/\n(?=## )/)
    .map((block) => block.trim())
    .filter((block) => block.startsWith('## '))
    .map((block) => {
      const heading = block.split('\n', 1)[0].slice(3).trim();
      /**
       * Read one `- label: value` field off an entry.
       *
       * `labels` is a list of accepted spellings and may carry a translation. That exists
       * because `- safe case:` was read with `^- safe case: (.*)$` while **every** safe case
       * actually written in either ledger used a full-width delimiter
       * (`- safe case（2026-10-05 实测补记）：…` in the machine ledger, `- 安全情形（…）：…`
       * in this project's) — so the field parsed to `undefined` on all four lines and the
       * notice the mechanism was built to deliver was never delivered once. Measured
       * 2026-10-06 by `probes/safe-case-parse.mjs`: 4 lines a human would call a safe case,
       * 0 readable by the guard. The `pit-guard-probe` `K10` case stayed green through all
       * of it because its fixture used the spelling the parser wanted — a fixture written
       * in the reader's own dialect cannot test a reader.
       *
       * A leading bracket is accepted because a parenthetical aside is how these ledgers
       * date a later correction (`safe case（2026-10-05 实测补记）：…`). A bare list of
       * alternatives was rejected in its favour: an entry may legitimately name one case
       * and then explain it across lines, and taking the first line keeps the notice short.
       * `[^\n]*` rather than `.*` on purpose — `.` crosses newlines under `m`, so a field
       * with a stray prefix used to swallow the following `- symptom:` line into its value.
       */
      const field = (labels) => {
        for (const label of String(labels).split('/')) {
          const match = new RegExp(`^- ${label}\\s*(?:[（(][^\\n]*?[）)])?\\s*[:：]\\s*([^\\n]*)$`, 'm').exec(block);
          if (match !== null) {
            const value = match[1].trim();
            if (value.length > 0) return value;
          }
        }
        return undefined;
      };
      const files = (field('files') ?? '')
        .split(/[,;]/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      /**
       * `- hard block: N` 让**这一条**从"提醒"升级成"拒绝"，而这是本项目第一次让
       * pit-guard 挡住动作，所以形状刻意做窄（2026-10-05，用户拍板后实施）：
       *
       * 1. **按条声明，不是全局开关。** 硬拦只对写下了这一行的条目生效。理由是"事实错"
       *    与"判断错"要分开：事实错（删跟踪文件、把 JSON 内联进 `node -e`）该硬拦，
       *    判断错（`Select-Object -First`、`[regex]::Matches` 这类"命中但安全"）硬拦
       *    只会挡路——而后者正是同一天量到的噪声来源。
       * 2. **N 是"第几次命中才拒绝"，从 1 数。** N=2 的含义写在账本里给读者看：第一次
       *    命中给你通知（你可以说"不是同一情况"继续），第二次才拒绝。
       * 3. **不是全局 fail-closed**：只在这一条被匹配、且本 agent 的命中计数达到 N 时拒绝，
       *    其余一切路径仍是 fail-open（`return next()`），与文件头那句"Everything here is
       *    advisory"的其余部分不冲突。
       * 4. **kill switch**：`DSH_CODE_PIT_HARD=0` 让全部硬拦失效（仍需重启生效），因为这条
       *    路径是 fail-closed、而 fail-closed 故障的代价是**卡住一个回合**。
       */
      const hard = Number.parseInt(field('hard block') ?? '', 10);
      return {
        heading,
        files,
        trigger: field('trigger'),
        avoid: field('do not repeat'),
        symptom: field('symptom'),
        /**
         * `- safe case:` 让条目自己说明"命中但它其实是安全的"那种情形。
         *
         * 存在的理由是本项目反复量到的副作用：trigger 是正则，匹配的是**命令行文本**，
         * 所以一条写得比真实失效面宽的规则会不断在安全情形下响（2026-10-05 我在一个会话里
         * 撞了三次：`??=` 出现在 JS 字符串里、`[regex]::Matches` 模式里没有括号、
         * `Select-Object -First` 的上游全是 cmdlet）。一个总在安全情形下响的警告会训练人
         * 忽略它，而**收紧 trigger 表达不出那个前提**（有些前提正是"命令里有没有引号"这种
         * 正则自己看不到的东西）。所以出路是把这个字段送到读者面前，让他一条命令就判断完。
         */
        safeCase: field('safe case/安全情形'),
        hard: Number.isFinite(hard) && hard > 0 ? hard : undefined,
        source,
      };
    });
}

/**
 * Every ledger consulted before an action: this project's, then the machine's.
 *
 * The project label used to be the constant `.dsh-code/mistakes.md`, and after the ledger moved
 * into the machine's project store (2026-10-10) every notice therefore sent the reader to a file
 * that no longer exists — the same restated-path defect as the briefing's pointers, in the one
 * message whose whole job is "go read the full entry".
 *
 * It is not simply replaced by the absolute path: a project whose ledger still sits beside its
 * code says so in the short form a human can read at a glance, and only a *migrated* project
 * (the one whose ledger really is elsewhere) pays for the full path. Both are derived from the
 * same resolved file, so neither can drift from where the guard actually reads.
 */
function mistakeSources(cwd) {
  const projectFile = ledgerPath(cwd, 'mistakes');
  const projectLabel = isCentral(cwd) ? projectFile : path.relative(cwd, projectFile).split(path.sep).join('/');
  return [
    { file: projectFile, label: projectLabel },
    { file: path.join(globalDir(), FILES.mistakes), label: path.join(globalDir(), FILES.mistakes) },
  ];
}

/** The command line of a run-tool call, raw; `''` when the call is not recognisable. */
function runCommand(exec) {
  const args = exec?.arguments ?? {};
  const value = args.cmd ?? args.command ?? args.script;
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Whether a recorded `trigger:` matches this command.
 *
 * The expression is used verbatim, case-insensitively, against the raw command and
 * against its whitespace-collapsed form (a multi-line command is one line here).
 * A trigger that does not compile is a mistake in the ledger, never a reason to
 * break the turn.
 *
 * A trigger that compiles but *backtracks* is the other mistake, and until 2026-10-04 it
 * was the more expensive one: the pattern ran here synchronously and unbounded, twice per
 * command, so a nested-quantifier expression held `tools/pre-execute` for seconds — the
 * gate/budget audit measured 10 / 39 / 151 / 565 / 2385 ms at 17 → 29 characters (≈×4 per
 * character). The inline attempt below still handles every ordinary pattern with no
 * machinery; a pattern that proves expensive is remembered and every later match for it goes
 * to a bounded worker instead, where a runaway match is abandoned rather than suffered.
 */
const expensivePatterns = new Set();

function matchesTrigger(trigger, command) {
  const pattern = String(trigger);
  const collapsed = command.replace(/\s+/g, ' ');
  const inline = () => {
    const re = new RegExp(pattern, 'i');
    return re.test(command) || re.test(collapsed);
  };
  if (!expensivePatterns.has(pattern)) {
    const started = Date.now();
    try {
      const matched = inline();
      // A cheap pattern stays cheap forever; the budget is generous because a legitimate
      // match on a long command line can take a few milliseconds.
      if (Date.now() - started < PATTERN_INLINE_BUDGET_MS) return Promise.resolve(matched);
    } catch {
      return Promise.resolve(false); // does not compile: a ledger mistake, never a crash
    }
    expensivePatterns.add(pattern);
  }
  return Promise.all([testPattern(pattern, command), testPattern(pattern, collapsed)]).then(([whole, flat]) => {
    const timedOut = whole.timedOut || flat.timedOut;
    return timedOut ? false : whole.matched === true || flat.matched === true;
  });
}

/**
 * Compact form for several entries that one action matched at once.
 *
 * Measured 2026-10-05 over this project's own journal: a command trips 1.5 entries on average,
 * but a *file edit* trips up to fourteen — and every one of those is an entry that names one of
 * this package's own core files, which is correct (a session editing the engine should be told
 * what the engine's rules are) and still unusable as fourteen full paragraphs in one step.
 *
 * The shape keeps what the reader needs to decide and drops what they can fetch: the rules, one
 * line each, plus the pointer. What is *not* dropped is the count — a reader told "here are 14"
 * can go look; a reader shown a truncated list and no number cannot.
 */
function fileClusterNotice(entries, target, label) {
  const head = `Changing \`${target}\` in ${label} matched **${entries.length} recorded pits at once**. Each rule in one line; the full entry is one read away.`;
  const lines = entries.map(
    (entry) => `- **${entry.heading}** — ${(entry.avoid ?? '(no rule recorded)').replace(/\s+/g, ' ').slice(0, 220)}${entry.safeCase === undefined ? '' : ` — safe case: ${String(entry.safeCase).replace(/\s+/g, ' ').slice(0, 140)}`}`,
  );
  return [
    head,
    '',
    ...lines,
    '',
    `Full entries: ${[...new Set(entries.map((entry) => entry.source))].join(' + ')}. Either follow a rule, or say plainly why this change is not the same case.`,
  ].join('\n');
}

/** Queue one notice per entry per session; false when it was already announced. */
function announce(record, entry, text) {
  const key = `${entry.source}#${entry.heading}`;
  if (record.announced.has(key)) return false;
  record.announced.add(key);
  record.pending.push(text);
  return true;
}

/**
 * What to do about one entry that matched the action about to run.
 *
 * Returns a refusal when the entry declares `hard block:` and this session has now
 * hit it that many times; otherwise queues the usual notice and returns undefined.
 * When it refuses it does **not** also queue a notice: the refusal text is the
 * explanation, one is enough.
 */
function handleMatch(record, entry, why, context, coordinate) {
  const denial = hardDeny(record, entry, why, coordinate, context);
  if (denial !== undefined) return denial;
  const text = pitNotice(entry, why);
  announce(record, entry, text);
  // A caller that is clustering several matches for one action needs to know exactly what was
  // queued so it can replace those texts and nothing else — matching on the notice's opening
  // words would also sweep up unrelated notices that happen to start the same way.
  if (Array.isArray(context?.collect)) context.collect.push({ entry, text });
  return undefined;
}

/** The text explaining a refusal; it becomes the tool result the model sees. */
function denyNotice(entry, why, coordinate, hits) {
  return `A recorded pit refused this ${why} — the entry declares \`hard block: ${entry.hard}\`, and this is hit ${hits} of this session.

**${entry.heading}**
- do not repeat: ${entry.avoid ?? '(the entry records no rule)'}${entry.symptom === undefined ? '' : `\n- symptom it came from: ${entry.symptom}`}

It was reached by: ${coordinate}.

Full entry: ${entry.source} → \`## ${entry.heading}\`. The call did not run. Do not retry it as-is: take the other path the entry names, or — if you believe this is not the same case — say so plainly and ask the human to reword the entry. \`DSH_CODE_PIT_HARD=0\` disables every hard block, but that needs a DSH restart to take effect.`;
}

/**
 * Whether this hit must be refused rather than announced.
 *
 * Counts *hits*, not notices: the first hit of a `hard block: N` entry is announced
 * and allowed (the reader gets to say "not the same case"), and only the Nth hit is
 * refused. `entry.hard` is undefined for every entry that does not declare it, which
 * is every entry written before 2026-10-05 — so this returns undefined for them and
 * the call proceeds exactly as it always did. That is the compatibility boundary.
 *
 * The return is consumed by `dsh-tools`: `gate.kind === 'deny'` makes the whole
 * result `Error: <reason>` with `isError: true` (`dsh-tools/lib/index.js:3241-3256`),
 * so this must be a **decision object**, not a message — and `reason` is a string.
 * Returning it without calling `next()` also vetoes the rest of the waterfall
 * (`cordis/lib/index.js:317-325`), which is why the command really never runs.
 *
 * Declaring this as an object rather than emitting the text keeps the fail-open
 * shape of this file intact: if anything here throws, the caller's catch runs
 * `next()` and the command proceeds.
 *
 * @param record - per-agent accounting ({@link account}).
 * @param entry - one parsed ledger entry.
 * @param why - the phrase the refusal quotes ("command you are about to run").
 * @param coordinate - the field that actually reached this entry, quoted in the refusal.
 *   It is a parameter because the two sides of this handler match on *different* fields —
 *   an edit matches `files:`, a command matches `trigger:` — while the refusal text used to
 *   claim `trigger:` in both cases. Measured 2026-10-06: an edit to `lib/ledger.js` was
 *   refused by an entry whose `trigger:` is `Remove-Item[^;]*-ErrorAction\s+SilentlyContinue`
 *   and whose `files:` names `lib/ledger.js`. The refusal was correct (the file side found
 *   it) and its explanation was false, which sent a reader looking for how a `Remove-Item`
 *   pattern could match an edit — three steps spent proving that it cannot, while the real
 *   coordinate was printed nowhere.
 * @param context - `{command}`, `{target}`, `{collect}` for the hit record and clustering.
 */
function hardDeny(record, entry, why, coordinate, context) {
  if (entry.hard === undefined) return undefined;
  if (process.env.DSH_CODE_PIT_HARD === '0') return undefined;
  /**
   * A `files:` match may only refuse work when the entry is *about* editing that file.
   *
   * An entry whose subject is a command — it declares `trigger:` — names files to say where that
   * subject lives, not to forbid editing them. Refusing an edit on that basis turns the entry
   * into a permanent edit barrier: measured 2026-10-10, the second legitimate edit to
   * `probes/pit-guard-probe.mjs` in one session was refused by an entry whose rule is about a
   * `Remove-Item` command line, which left a red probe unfixable without a restart. The entry
   * still *announces* itself on every edit (that is what the notice side is for); what it does
   * not get is the power to stop work its own subject does not cover. A `hard block:` therefore
   * counts the action the entry is about, and only that action.
   */
  const editSide = typeof context?.target === 'string' && context?.command === undefined;
  if (editSide && typeof entry.trigger === 'string' && entry.trigger.length > 0) return undefined;
  const key = `${entry.source}#${entry.heading}`;
  const hits = (record.hardHits.get(key) ?? 0) + 1;
  record.hardHits.set(key, hits);
  if (hits < entry.hard) return undefined;
  /**
   * Record the refusal where the other two read-side events already live.
   *
   * Without this, a refusal leaves no trace anywhere: the notice path writes
   * `trigger_hit`/`file_hit`, and this path — the only one that actually stops work —
   * wrote nothing. Measured 2026-10-05: adding the feature and then asking the ledger
   * whether it had ever blocked anything was unanswerable, which is the same silent
   * failure this file already fixed once for `trigger:` ("a mistyped trigger never
   * matches and nothing anywhere says so").
   *
   * `turned-out` stays empty on purpose: whether a refusal was *right* is a judgement
   * no code here can make, so it is recorded later by whoever decides, as a field on
   * the entry (`- last block: …`), not invented here.
   */
  try {
    journalEvent(
      record.cwd,
      {
        kind: 'trigger_block',
        session: record.session,
        root: record.cwd,
        heading: entry.heading,
        source: entry.source,
        cmd: (context?.command ?? '').slice(0, 200),
        target: (context?.target ?? '').slice(0, 200),
        hits,
        declared: entry.hard,
      },
      'project',
    );
  } catch {
    /* a refusal must not depend on the statistic being writable */
  }
  return { kind: 'deny', reason: denyNotice(entry, why, coordinate, hits) };
}

/**
 * The notice for one known mistake touching what is about to happen. It quotes
 * the recorded rule verbatim and says where the full entry lives, so acting on
 * it needs no extra read.
 */
function pitNotice(entry, why) {
  return `A ledger already paid for a pit ${why}.

**${entry.heading}**
- do not repeat: ${entry.avoid ?? '(the entry records no rule)'}${entry.safeCase === undefined ? '' : `\n- **safe case (check this first):** ${entry.safeCase}`}${entry.symptom === undefined ? '' : `\n- symptom it came from: ${entry.symptom}`}

Full entry: ${entry.source} → \`## ${entry.heading}\`. Either follow that rule, or say plainly why this change is not the same case — silently walking into a recorded pit is the one thing this ledger exists to prevent.`;
}

/** One line naming a failing command, for the notice and the journal. */
function failureLine(failure) {
  return `- \`${failure.cmd}\` failed — ${failure.signature}`;
}

function reminder(failures) {
  return `This turn ran ${failures.length === 1 ? 'a command' : `${failures.length} commands`} that failed, and nothing has been recorded as a mistake yet:

${failures.map(failureLine).join('\n')}

An error you worked through is exactly what \`mistakes.md\` is for. Before you finish, record it — \`code_record(kind="mistake", symptom=…, cause=…, fix=…, files=…, avoid=…)\` — with the real cause you found, not the first thing that looked wrong. Recording it settles this debt; saying nothing leaves it in the ledger, where the next session sees it as an unpaid pit.`;
}

/**
 * Read the model-visible text of a tool result. Used only to recognise a
 * failure, so anything unreadable means "no signal", never "success".
 */
function resultText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

/**
 * Whether a run-tool call failed. The shell tools report a nonzero exit inside
 * their text (`[exit code: N]`) and a failed call as `isError`; a successful
 * foreground command carries no marker at all.
 */
function failureOf(result) {
  const text = resultText(result);
  const marker = /\[exit code: (-?\d+)\]/i.exec(text);
  const exitCode = marker === null ? (result?.isError === true ? 1 : 0) : Number(marker[1]);
  if (result?.isError === true || exitCode !== 0) return { text, exitCode };
  return undefined;
}

/**
 * A stable-ish signature for "the same failure again": the command, plus the
 * first line of output that looks like an error. Deliberately conservative —
 * only an identical command with an identical first error line repeats, so
 * legitimate re-runs (a script, a restarted service) never look like a loop.
 */
function failureSignature(cmd, text) {
  const command = String(cmd ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const line = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /error|exception|failed|fatal|denied|找不到|cannot|EPERM|ENOENT/i.test(l));
  return `${command} → ${(line ?? NO_OUTPUT).replace(/\s+/g, ' ').slice(0, 200)}`;
}

/** @param ctx - plugin context; listeners are scoped to it and disposed with it. */
export function apply(ctx, config) {
  if (config?.enabled === false) return;
  const { editTools, runTools } = resolveLists(config);

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const agent = exec?.agent;
      const tool = typeof exec?.name === 'string' ? exec.name : '';
      if (agent !== undefined && agent !== null && (editTools.has(tool) || runTools.has(tool))) {
        const record = account(agent);
        const cwd = ledgerRoot(exec);
        record.cwd = cwd;
        record.session = exec.agent?.session?.id ?? record.session;
        const sources = mistakeSources(cwd);
        // An edit answers `files:`; a command answers `trigger:`. Two sides of the
        // same ledger, because a pit can be about a file or about a command.
        if (editTools.has(tool)) {
          const target = editTarget(exec?.arguments ?? {}, cwd);
          if (target !== undefined) {
            const label = String(exec.arguments?.file_path ?? exec.arguments?.path ?? exec.arguments?.target).trim();
            /**
             * Editing a file this mode is made of leaves the host running the old code.
             *
             * The rule is already written down as iron rule 3 ("changed `lib/*.js` needs a
             * restart"), and this repo has paid for forgetting it — a session edited the
             * system prompt, another resumed, and one request re-sent 306,313 uncached
             * tokens. Recording it here means the *briefing* says it, so the fact survives
             * both this context window and the human's attention.
             */
            // Both sides normalised before they are compared.
            //
            // `target` is already `normPath`-ed (lowercased, `/`); the root was not, and
            // the test joined a raw `path.sep`. On Windows that made the condition
            // *always* false: `e:/projects/dsh-code-mode/lib/prompt.js` is never equal to
            // nor prefixed by `E:\projects\dsh-code-mode\`. Measured 2026-10-04 end to end
            // through this very handler — editing a `lib/*.js` of this package wrote no
            // `restart_pending`, and the whole journal (live + 528 KB rotated segment)
            // held **zero** `"kind":"restart_pending"` events. The feature this comment
            // block exists for had never once fired.
            const root = normPath(packageRoot());
            // Only the rows the host imports at mount can be dormant: the preset names files in
            // `lib/`, and `cordis.patch.yml` is the declaration itself. The condition used to be
            // "anywhere under the package root", so editing a probe, the README, or the ledger's
            // own journal recorded a restart — and the briefing then advised the human to open a
            // NEW conversation, which is the expensive advice this notice exists to give for a
            // real reason. Measured 2026-10-10: a one-line fixture under `.dsh-code/` produced it.
            const mounted = /\/lib\/[^/]*\.js$/.test(target) || target === `${root}/cordis.patch.yml`;
            if (root.length > 0 && target.startsWith(`${root}/`) && mounted) {
              try {
                noteRestartPending(cwd, [target], record.session);
              } catch {
                /* a failed note must never block the edit */
              }
            }
            /**
             * Record that a `files:` pit actually arrived, for the same reason triggers do.
             *
             * The trigger side has had a hit record since 2026-10-03; the file side has not,
             * and `files:` is the wider half — 31 of this project's 35 pits are file-keyed.
             * `pit-liveness.mjs` could only ask "does this path still exist", never "has this
             * pit ever arrived", so a blind `files:` entry (a path that resolves but never
             * matches an edit) was as invisible as a mistyped trigger. The record is written
             * in the same pass as the notice, so the two can never disagree.
             */
            const matched = [];
            for (const source of sources) {
              for (const entry of mistakeEntries(source.file, source.label)) {
                if (!entry.files.some((token) => refersTo(target, token))) continue;
                try {
                  journalEvent(
                    cwd,
                    { kind: 'file_hit', session: record.session, root: cwd, heading: entry.heading, target: target.slice(0, 200) },
                    'project',
                  );
                } catch {
                  /* the notice matters more than the statistic */
                }
                const denial = handleMatch(record, entry, `in ${label}, the file you are about to change`, { target, collect: matched }, `\`files: ${entry.files.join(', ')}\``);
                if (denial !== undefined) return denial;
              }
            }
            // One edit routinely matches several entries — up to fourteen on this package's own
            // core files, where every rule about the engine names the engine. Those are clustered
            // into one notice that keeps every rule and drops the prose, because fourteen full
            // entries in one step is the same information delivered unusably.
            if (matched.length > 1) {
              const queued = new Set(matched.map((found) => found.text));
              record.pending = record.pending.filter((text) => !queued.has(text));
              record.pending.push(fileClusterNotice(matched.map((found) => found.entry), target, label));
            }
          }
        }
        if (runTools.has(tool)) {
          const command = runCommand(exec);
          if (command.length > 0) {
            for (const source of sources) {
              for (const entry of mistakeEntries(source.file, source.label)) {
                if (entry.trigger === undefined || !(await matchesTrigger(entry.trigger, command))) continue;
                /**
                 * Record the hit, because a trigger that never fires is invisible.
                 *
                 * A mistyped `trigger:` is this design's documented silent failure: the
                 * pattern simply never matches and nothing anywhere says so. Compiling it
                 * at write time (`code_record`) rules out the malformed ones, but a pattern
                 * that compiles and matches nothing stays undetectable — there was no
                 * statistic for "this trigger has never matched anything". This line is the
                 * evidence side of that; `pit-liveness.mjs` reads it and reports the
                 * entries that have never fired.
                 *
                 * Deliberately outside the try/catch below: a journal that cannot be
                 * written is not a reason to skip the notice.
                 */
                try {
                  // `root` is what makes the cross-project signal possible: a rule that
                  // fires in several different projects is a *machine* fact misfiled as a
                  // project one, and only the root can tell those apart.
                  journalEvent(
                    cwd,
                    {
                      kind: 'trigger_hit',
                      session: record.session,
                      root: cwd,
                      heading: entry.heading,
                      source: source.file,
                      cmd: command.slice(0, 200),
                    },
                    'project',
                  );
                } catch {
                  /* the notice matters more than the statistic */
                }
                const denial = handleMatch(
                  record,
                  entry,
                  `about the command you are about to run (it matches this entry's \`trigger: ${entry.trigger}\`)`,
                  { command },
                  `\`trigger: ${entry.trigger}\``,
                );
                if (denial !== undefined) return denial;
              }
            }
          }
        }
      }
    } catch {
      /* a broken pit lookup must never block an edit or a command */
    }
    return next();
  });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const agent = exec?.agent;
      const tool = typeof exec?.name === 'string' ? exec.name : '';
      if (agent !== undefined && agent !== null && runTools.has(tool)) {
        const failure = failureOf(result);
        if (failure !== undefined) {
          const record = account(agent);
          record.cwd = exec.agent?.session?.header?.cwd ?? record.cwd;
          record.session = exec.agent?.session?.id ?? record.session;
          const cmd = String(exec?.arguments?.cmd ?? exec?.arguments?.command ?? tool).replace(/\s+/g, ' ').trim();
          const signature = failureSignature(cmd, failure.text);
          if (!record.failures.some((seen) => seen.signature === signature)) {
            record.failures.push({ cmd: cmd.slice(0, 200), signature });
          }
        }
      }
    } catch {
      /* failure accounting is best-effort */
    }
    return next();
  });

  ctx.on('agent/pre-step', async (payload, next) => {
    const notices = [];
    try {
      const agent = payload?.agent;
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      if (agent !== undefined && agent !== null) {
        if (messages.some((message) => message?.source?.kind === 'user')) {
          // A new human instruction starts a new session's worth of attention:
          // forgetting what was already announced is the safer direction here,
          // because a repeated warning is a smaller failure than a silenced one.
          state.delete(agent);
        } else {
          const record = account(agent);
          if (record.turn === undefined) {
            record.turn = payload.turn;
          } else if (record.turn !== payload.turn) {
            record.turn = payload.turn;
            record.pending = [];
            record.failures = [];
          }
          const queued = record.pending.splice(0, record.pending.length);
          for (const text of queued) {
            notices.push(
              createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'code-pit-guard', form: 'notice', summary: 'a known mistake touches this action' },
              }),
            );
          }
          if (record.failures.length > 0 && record.pending.length === 0) {
            notices.push(
              createUserMessage({
                content: [{ type: 'text', text: reminder(record.failures) }],
                source: {
                  kind: 'code-pit-guard',
                  form: 'notice',
                  summary: `${record.failures.length} failing command(s) unrecorded`,
                },
              }),
            );
          }
        }
      }
    } catch {
      notices.length = 0;
    }
    const decision = await next();
    if (notices.length === 0 || !Array.isArray(decision?.messages)) return decision;
    return { ...decision, messages: [...decision.messages, ...notices] };
  });

  ctx.on('agent/turn-stopping', ({ agent }) => {
    try {
      const record = state.get(agent);
      if (record !== undefined && record.failures.length > 0 && typeof record.cwd === 'string') {
        recordMistakeDebt(
          record.cwd,
          { failures: record.failures, turn: record.turn },
          record.session,
        );
      }
    } catch {
      /* memory is best-effort; a failed write must not fail the turn */
    }
    state.delete(agent);
  });
}
