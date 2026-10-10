/**
 * Pit liveness: does every recorded pit still fire, and does it point at something real?
 *
 * Written 2026-10-03 to close the two silent failures this project has carried since the
 * beginning and named in its own design as known limits:
 *
 *   - `trigger:` is a regex written by hand. A pattern that does not compile, or that no
 *     sample of the failure it came from actually matches, means the pit **never fires
 *     and nothing anywhere says so**.
 *   - `files:` is a path written by hand. A path that names no file means the pit never
 *     arrives while you edit the thing it is about — silently, for the same reason.
 *
 * This is deliberately **not** part of `debt-audit.mjs`. That audit checks properties of
 * the shipped package and must stay green on any machine; this checks the *local* ledgers,
 * where an entry legitimately ages (a file is renamed, a tool version changes). Mixing
 * them would make the audit red because of one developer's history — the exact failure
 * documented for `guard-probe`'s D1/E checks, where the developer's real machine ledger
 * turned two hermetic checks red.
 *
 * Failing (exit 1) is therefore reserved for defects that need no judgement call:
 *   - a `trigger:` that does not compile;
 *   - a `trigger:` whose own `triggerSample` proves it does not match the failure it was
 *     recorded from (whatever it matches, it is not that);
 *   - a `triggerSample` with no `trigger`.
 * Everything else — a stale `files:` path, a trigger nothing can prove — is reported as
 * WARN and stays out of the exit code, because "this entry is old" is not "this entry
 * is broken".
 *
 * Usage: node probes/pit-liveness.mjs [--json] [--report <file>] [--roots <dir>[,<dir>…]]
 *
 * `--report` writes the same JSON `--json` prints to a file, for callers that cannot capture
 * a child's stdout: measured 2026-10-06, `spawnSync(cmd, ['/c', '… > file'])` returned with the
 * file 0 bytes under this session's policy, in both `cmd /c` and piping shapes. A probe that
 * offers its own report file removes the need for that capture entirely.
 *
 * `--roots` adds directories to the cross-project promotion **scan**, so that the
 * "reachable" verdict can be exercised on a machine where the condition does not hold.
 * Measured 2026-10-05: this host has exactly one ledged project and `~/.dsh/projects` does
 * not exist, so `roots.size > 1` cannot be satisfied and only the UNREACHABLE branch was
 * ever *seen*. Measured 2026-10-06: that verdict was wrong anyway — the raw scan reported
 * four candidates whose two "projects" were one directory spelled two ways. A verdict whose
 * other branch has never executed is a claim about a branch, not a tested distinction.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The promotion scan is ledger knowledge, so it lives in the library and is tested there.
// A *static* import, not a dynamic one with a joined path: on Windows `import('E:\\...')`
// throws `ERR_UNSUPPORTED_ESM_URL_SCHEME` (only file:/data:/node: URLs are allowed, so a
// raw path needs `pathToFileURL`). `lib/ledger.js` has no bare imports, so plain Node
// resolves it directly and none of that is needed.
import { DIRNAME, crossProjectTriggers, fileHitCounts, globalDir, ledgerDir, siblingProjects, triggerHitCounts } from '../lib/ledger.js';

const args = process.argv.slice(2);
const AS_JSON = args.includes('--json');
/** Optional path this probe writes its JSON report to, for callers that cannot capture stdout. */
const REPORT_FILE = (() => {
  const at = args.indexOf('--report');
  return at === -1 || args[at + 1] === undefined ? undefined : path.resolve(args[at + 1]);
})();
/** Extra directories to include in the promotion scan; see the header for why this exists. */
const EXTRA_ROOTS = (() => {
  const at = args.indexOf('--roots');
  if (at === -1 || args[at + 1] === undefined) return [];
  return args[at + 1]
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry));
})();

const project = process.cwd();
/**
 * Both directories come from the ledger's own resolver, not from this file.
 *
 * This report's entire verdict is "every recorded trigger and `files:` token still resolves",
 * and run over a directory that is not the ledger it finds nothing — which reads exactly like
 * healthy. Both paths here were wrong for this repository: a migrated project's ledger is in
 * the machine's store, not in `<repo>/.dsh-code`, and the machine ledger moved to `~/.dsh/code`
 * on 2026-10-10 while this file still named the retired `~/.dsh-code`.
 */
const ledgers = [
  { scope: 'project', dir: ledgerDir(project) },
  { scope: 'global', dir: globalDir() },
];

const field = (block, label) => new RegExp(`^- ${label}: (.*)$`, 'm').exec(block)?.[1]?.trim();
const heading = (block) => block.split('\n', 1)[0].replace(/^##\s*/, '').trim();

/** Entries of one markdown ledger file. */
const entries = (file) => {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\n(?=## )/)
      .map((block) => block.trim())
      .filter((block) => block.startsWith('## '));
  } catch {
    return [];
  }
};

const failures = [];
const warnings = [];
const rows = [];

for (const { scope, dir } of ledgers) {
  const file = path.join(dir, 'mistakes.md');
  for (const block of entries(file)) {
    const trigger = field(block, 'trigger');
    const sample = field(block, 'triggerSample');
    const files = field(block, 'files');
    const row = { scope, heading: heading(block), trigger, sample, files };

    if (trigger !== undefined) {
      let pattern;
      try {
        pattern = new RegExp(trigger, 'i');
      } catch (error) {
        failures.push({ ...row, problem: 'trigger does not compile', detail: String(error?.message ?? error) });
        rows.push(row);
        continue;
      }
      if (sample !== undefined) {
        // The same semantics `code_record` uses at write time: a sample matches if the
        // pattern hits the raw text or the whitespace-collapsed text.
        const samples = sample
          .split(';')
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        const matched = samples.filter((text) => pattern.test(text) || pattern.test(text.replace(/\s+/g, ' ')));
        row.samples = samples.length;
        row.matched = matched.length;
        if (samples.length > 0 && matched.length === 0) {
          failures.push({
            ...row,
            problem: 'no triggerSample matches this trigger, so the pit cannot fire on the failure it was recorded from',
            detail: samples.slice(0, 3),
          });
        }
      }
      // How often the pattern was actually seen in a recorded command line. Reported,
      // never a failure: a pit can be correct and simply not have recurred yet.
      row.everSeen = undefined;
    } else if (sample !== undefined) {
      failures.push({ ...row, problem: 'triggerSample without trigger: nothing to match it against' });
    }

    if (files !== undefined) {
      /**
       * `files:` is written by a human, so a token may carry a `:line` suffix, a
       * parenthetical note ("E:\proj\lib\x.js（ACL，不是包内文件）"), or be a placeholder
       * ("(no package file: a one-off command)"). Those are notes *about* the pit, not
       * paths, and treating them as paths made this check report 20 warnings of which
       * most were its own artifacts (measured on the first run, 2026-10-03). A checker
       * that cries wolf is how a real broken path gets ignored later.
       */
      const tokens = files
        .split(',')
        .map((part) => part.trim())
        // A trailing parenthetical note or markdown link, then a `:line` or `:line-line`
        // suffix, then any remaining brace/quote noise. Order matters: `report.json]`
        // and `budget-{log.txt` are both artifacts of writing a list by hand.
        .map((part) =>
          part
            .replace(/\[[^\]]*\]\([^)]*\)\s*$/, '')
            .replace(/[（(].*$/, '')
            .replace(/:\d+(-\d+)?$/, '')
            .replace(/[[\]{}"']/g, '')
            .trim(),
        )
        .filter((part) => part.length > 0)
        .filter((part) => /[\\/]|\.\w{1,6}$/.test(part));
      const missing = tokens.filter((token) => {
        if (path.isAbsolute(token)) return !fs.existsSync(token);
        return !fs.existsSync(path.join(project, token));
      });
      row.filesTotal = tokens.length;
      row.filesMissing = missing;
      if (missing.length > 0) {
        /**
         * A relative path in a **machine-wide** pit is not a broken pointer.
         *
         * Global pits are written while working in some *other* repository, so their
         * `files:` entries are relative to that project and can never resolve here —
         * measured 2026-10-03: 9 of the first 11 warnings were exactly that. Reporting
         * them as broken is the noise that teaches a reader to ignore the report, which
         * is how a genuinely dead path survives later. They are counted separately, and
         * only a project-scope path that no longer exists is listed for action.
         */
        const crossProject = scope === 'global' && missing.every((token) => !path.isAbsolute(token));
        if (crossProject) {
          row.crossProject = missing;
        } else {
          warnings.push({
            ...row,
            problem: 'files: names no file right now (renamed, deleted, or written for another machine)',
            detail: missing.slice(0, 3),
          });
        }
      }
    }
    rows.push(row);
  }
}

/**
 * Hits, counted from the events the gate actually wrote — not replayed.
 *
 * Until 2026-10-03 this re-matched every `trigger:` regex against every `cmd` in the
 * journal. That was a *proxy* for "has this pit ever fired", and it diverges from the
 * product in both directions: a command quoted inside an unrelated entry matched as if it
 * had been run, and `cmd` is truncated to 200 characters, so a trigger matching the tail
 * of a long command was counted as never seen. The gate now records a real `trigger_hit`
 * when it announces an entry, and the file side records `file_hit`; this reads those, so
 * the statistic and the feature finally agree.
 */
const triggerHits = triggerHitCounts(project, 'project');
const fileHits = fileHitCounts(project, 'project');
for (const row of rows) {
  if (row.trigger !== undefined) row.everSeen = triggerHits.get(row.heading) ?? 0;
  if (row.files !== undefined) row.filesSeen = fileHits.get(row.heading) ?? 0;
}

const triggers = rows.filter((row) => row.trigger !== undefined);
const fileKeyed = rows.filter((row) => row.files !== undefined);
/** A `files:` entry whose path resolves but has never matched an edit: present, never useful. */
const blindFiles = fileKeyed.filter((row) => (row.filesMissing ?? []).length === 0 && (row.filesSeen ?? 0) === 0);

/**
 * Entries with **no arrival coordinate at all** — neither a `trigger:` nor a `files:`.
 *
 * A pit can only reach someone at the moment it applies by one of those two routes: the
 * `trigger:` intercepts the command about to run, the `files:` intercepts the edit about to
 * happen. An entry with neither can do neither — it can only appear in a briefing, where it
 * competes for room on recency alone and, being cold, stops being shown.
 *
 * Measured 2026-10-05, and the contrast is the finding: this project's ledger is 3/73
 * (4.1%) while the **machine-wide** one — read at the start of every session in *every*
 * project — is **39/91 (42.9%)**. The reason looks structural rather than careless: a pit
 * about the *machine* (a shell quirk, a sandbox rule, a hosts redirect, the two channels'
 * different rights) usually has no file to name, so `files:` cannot honestly be written for
 * it — while a pit about this repository almost always has one.
 *
 * Reported, never failed on: the write-side warning already fires when such an entry is
 * recorded (the no-`files:`-and-no-`trigger:` notice in `lib/ledger.js`), so what this adds
 * is the **stock** that warning never measured — a growing one is what to act on, not one
 * entry. It is the same distinction the rest of this file keeps drawing: "cannot arrive" is
 * not "has not arrived yet".
 */
const inertByScope = ['project', 'global']
  .map((scope) => {
    const all = rows.filter((row) => row.scope === scope);
    return { scope, entries: all.length, inert: all.filter((row) => row.trigger === undefined && row.files === undefined).length };
  })
  .filter((entry) => entry.entries > 0);
const inertTotal = inertByScope.reduce((sum, entry) => sum + entry.inert, 0);
const entriesTotal = inertByScope.reduce((sum, entry) => sum + entry.entries, 0);
const neverSeen = triggers.filter((row) => (row.everSeen ?? 0) === 0);
const crossProject = rows.filter((row) => (row.crossProject ?? []).length > 0);

/**
 * Cross-project promotion: a rule that fires in several *different* projects is a
 * machine fact misfiled as a project one.
 *
 * The scope decision has a mechanical answer the design already states — pass
 * `scope="global"` when it would bite you again in a *different* project — and until
 * now nothing measured "different project". `everSeen` above replays each trigger
 * against recorded commands, but only inside this project, so a pit that bites in three
 * repositories looked identical to one that bit three times in this one.
 *
 * The scan itself lives in `lib/ledger.js` (`crossProjectTriggers`) so it is ledger
 * knowledge with one owner and a direct test; this file only reports it. Reported, never
 * failed on: filing a fact in the wrong scope is a judgement the human makes, and a
 * second project is a prompt to look, not a defect that should paint a probe red.
 */
/**
 * The roots the promotion scan can see, and whether its condition is satisfiable at all.
 *
 * `crossProjectTriggers` keeps only rules whose hits span **more than one** project, so
 * with a single scanned root that filter cannot pass — yet the report below used to say
 * `no cross-project promotion candidates`, which reads as "nothing has crossed a boundary
 * yet" while the truth was "this machine cannot cross one".
 *
 * Measured 2026-10-05: `E:\projects` holds exactly one directory with a ledger, and
 * `~/.dsh/projects` does not exist at all — zero siblings, so the promotion report was
 * **structurally unreachable, not empty**. That is the same shape as the compaction gate
 * sitting at 0.8 (a guard placed where real work cannot reach it), and the fix is the one
 * this repository keeps re-learning: say **which** of "no data" and "data says none" you
 * mean. `unverified` vs `unjudgeable`, `assert` vs `control` — same distinction.
 */
/**
 * Fold the spellings of one project root that the journal happens to contain.
 *
 * Measured 2026-10-06, while disposing of `crossProjectTriggers` (the task's item 3): the
 * report said `UNREACHABLE, not empty` — "this machine has one ledged project, so a rule can
 * never span two" — and in the same run listed **four** promotion candidates whose two
 * "projects" were `E:\projects\dsh-code-mode` and `E:/projects\dsh-code-mode`. Same directory,
 * two spellings.
 *
 * The cause is structural rather than a typo: `entry.root` is recorded verbatim by whoever
 * wrote the `trigger_hit`, and the same session can pass a backslash root while the ledger
 * layer passes a forward-slash one — `crossProjectTriggers` then does `roots.add(root)` on the
 * raw string, and a set cannot see that its two members are one project. Every path helper in
 * this package normalises before comparing; this was the one comparison that did not.
 *
 * So the UNREACHABLE verdict was **false**: the condition is not unsatisfiable here, it is
 * satisfied *spuriously*. That is a worse failure than the ambiguity the disposal set out to
 * fix, because it turns a phantom into a recommendation ("consider recording it with
 * scope=global") for rules that never crossed anything.
 */
const dedupeRoots = (roots) => {
  const byKey = new Map();
  for (const root of roots) {
    if (typeof root !== 'string' || root.trim().length === 0) continue;
    const key = root
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (!byKey.has(key)) byKey.set(key, root.trim().replace(/\\/g, '/'));
  }
  return [...byKey.values()];
};

const scannedRoots = [...new Set([project, ...siblingProjects(project), ...EXTRA_ROOTS])];
const scanned = dedupeRoots(scannedRoots);
/** The raw scan, before spellings of one root are folded; >1 does not mean two projects. */
const rawPromotions = crossProjectTriggers(scannedRoots);
const promotions = rawPromotions
  .map((rule) => ({ ...rule, roots: dedupeRoots(rule.roots) }))
  .filter((rule) => rule.roots.length > 1);
/** What the raw scan called cross-project, and what survives folding. */
const spuriousPromotions = rawPromotions.filter((rule) => dedupeRoots(rule.roots).length <= 1);
/** The filter needs hits in *two* projects; one root cannot satisfy it however hard it tries. */
const promotionReachable = scanned.length > 1;

if (AS_JSON || REPORT_FILE !== undefined) {
  const report = JSON.stringify({ failures, warnings, triggers: triggers.length, neverSeen: neverSeen.length, crossProject: crossProject.length, crossProjectReach: { rootsScanned: scannedRoots.length, distinctRoots: scanned.length, reachable: promotionReachable, roots: scanned, extraRoots: EXTRA_ROOTS, phantomPromotions: spuriousPromotions.length }, canNotArrive: { total: inertTotal, of: entriesTotal, byScope: inertByScope }, promotions }, null, 2);
  if (AS_JSON) console.log(report);
  if (REPORT_FILE !== undefined) {
    /**
     * A report that cannot be written must fail loudly rather than look like a clean run:
     * a caller reading the file would otherwise see a stale one and believe it.
     */
    try {
      fs.writeFileSync(REPORT_FILE, `${report}\n`, 'utf8');
    } catch (error) {
      console.error(`could not write the report to ${REPORT_FILE}: ${error.message}`);
      process.exitCode = 1;
    }
  }
} else {
  console.log(`pit liveness — ${rows.length} entr(ies), ${triggers.length} with a trigger`);
  for (const { scope, dir } of ledgers) console.log(`  ${scope.padEnd(7)} ${dir}`);
  if (failures.length === 0) console.log('\nno broken triggers: every recorded pattern compiles and matches its own sample');
  for (const failure of failures) console.log(`\nFAIL [${failure.scope}] ${failure.heading}\n  ${failure.problem}\n  ${JSON.stringify(failure.detail ?? '')}`);
  if (warnings.length > 0) {
    console.log(`\n${warnings.length} stale pointer(s) worth acting on — a \`files:\` path in *this* project that no longer exists:`);
    for (const warning of warnings) console.log(`  WARN [${warning.scope}] ${warning.heading}: ${JSON.stringify(warning.detail)}`);
  } else {
    console.log('\nno stale pointers: every project-scope `files:` path still resolves');
  }
  console.log(
    `${crossProject.length} entr(ies) skipped as cross-project: a machine-wide pit's *relative* path belongs to whichever repository it was written in, so it cannot resolve here and is not a defect`,
  );
  console.log(
    `triggers never seen in a recorded command: ${neverSeen.length}/${triggers.length}${neverSeen.length > 0 ? ` — ${neverSeen.slice(0, 8).map((row) => `[${row.scope}] ${row.heading}`).join('; ')}${neverSeen.length > 8 ? `; … ${neverSeen.length - 8} more` : ''}` : ''}`,
  );
  console.log(
    `file-keyed entr(ies) that have never matched an edit: ${blindFiles.length}/${fileKeyed.length}${blindFiles.length > 0 ? ` — a resolving path that nothing has arrived for yet, which is not a defect (the file may simply not have been touched since the pit was recorded)` : ''}`,
  );
  if (blindFiles.length > 0 && blindFiles.length <= 8) {
    for (const row of blindFiles) console.log(`  BLIND [${row.scope}] ${row.heading}`);
  }
  console.log(
    `entr(ies) with no arrival coordinate at all (neither \`trigger:\` nor \`files:\`): ${inertTotal}/${entriesTotal}${inertByScope.length === 0 ? '' : ` — ${inertByScope.map((entry) => `${entry.scope} ${entry.inert}/${entry.entries}`).join(', ')}`} — neither route can reach a reader at the moment one applies, so these only compete for briefing space`,
  );
  if (promotions.length > 0) {
    console.log(
      `\n${promotions.length} rule(s) have fired in more than one *project* — a machine fact filed per project, which pays for it again in every one. Consider recording it with \`code_record(scope="global")\`; this is a prompt to look, not a defect:`,
    );
    for (const rule of promotions) {
      console.log(`  PROMOTE ${rule.heading} — ${rule.roots.length} project(s): ${rule.roots.join(', ')}`);
    }
  } else if (!promotionReachable) {
    console.log(
      `\nno cross-project promotion candidates: **UNREACHABLE, not empty** — the scan can see ${scannedRoots.length} project(s) with a ledger, and a promotion needs a hit in two, so this filter cannot pass here. Nothing is wrong with any entry; it needs a second project with its own \`${DIRNAME}\`.`,
    );
  } else {
    console.log(
      `\nno cross-project promotion candidates: 0 across the ${scannedRoots.length} ledged project(s) scanned — the condition **was** satisfiable and nothing met it.`,
    );
  }
  if (spuriousPromotions.length > 0) {
    console.log(
      `Phantom ${spuriousPromotions.length} promotion(s) collapsed: the raw scan counted two spellings of one root as two projects (measured 2026-10-06: \`E:\\projects\\dsh-code-mode\` and \`E:/projects/dsh-code-mode\`), so \`roots.size > 1\` is satisfiable here *spuriously*. Folded by separator and case before the count. The same fold belongs in \`crossProjectTriggers\` (lib/ledger.js:1242) — until it is there, any caller of that function sees phantoms:`,
    );
    for (const rule of spuriousPromotions) {
      console.log(`  PHANTOM ${rule.heading} — ${rule.roots.join(' == ')}`);
    }
  }
}
process.exitCode = failures.length === 0 ? 0 : 1;
