/**
 * Pit report: what a session needs in order to *work on* the ledger, rather than a number.
 *
 * The three counters (`triggerHitCounts`, `fileHitCounts`, `pitEvents`) answer "how often".
 * This answers the questions a session about to clean the ledger actually asks, and every
 * one of them is already recorded:
 *
 *   collisions   entries that fired inside the *same* action. Several `trigger_hit` /
 *                `file_hit` events sharing one session and one millisecond mean one action
 *                matched several entries — the redundancy that inflates every published
 *                count and, unlike a repeat, the one thing a merge fixes without losing a
 *                rule. Measured 2026-10-05: one `node -e` matched four entries.
 *   never fired  entries whose coordinates have never once matched, with their age — the
 *                input to "is this rule wrong, or is this domain simply absent here". A
 *                wrong rule and an absent domain look identical in this list, which is
 *                exactly why it lists them together instead of calling them dead.
 *   inert        entries with neither `trigger:` nor `files:`: they *cannot* arrive on their
 *                own, which is a different statement from "they have not arrived yet".
 *   blocks       refusals actually issued (`trigger_block`, 2026-10-05), and which of them
 *                no reader has judged yet — a refusal with no verdict is the one piece of
 *                read-side behaviour nothing can currently correct.
 *
 * Read-only by construction: it observes the ledger and never writes it. `--selftest` runs
 * fixtures under `os.tmpdir()` (machine layer redirected through `DSH_CODE_GLOBAL_DIR`), so
 * the tool is pinned by checks rather than by a human running it once and reading the output.
 *
 * **No arguments means `--selftest`.** `debt-audit` spawns the probes in its list with no
 * arguments and reads the verdict from `DSH_PROBE_REPORT`, so a tool that defaulted to
 * "print a report about whatever cwd you inherited" would hand the audit a wall of markdown
 * and no counts. Asking for a report is explicit:
 *
 *   node probes/pit-report.mjs [--cwd <dir>] [--scope project|global|both] [--json <file>]
 *   node probes/pit-report.mjs --selftest
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIB_DIR, tempReport } from './paths.mjs';

const libDir = process.env.DSH_CODE_MODE_LIB ?? LIB_DIR;
const ledger = await import(pathToFileURL(path.join(libDir, 'ledger.js')).href);

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};

/** One `## ` block's fields, parsed the way `pit-guard` parses them. */
function entriesOf(file, scope) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split(/\n(?=## )/)
    .filter((block) => block.startsWith('## '))
    .map((block) => {
      const field = (label) => {
        const match = new RegExp(`^- ${label}: (.*)$`, 'm').exec(block);
        return match === null ? undefined : match[1].trim();
      };
      const files = (field('files') ?? '')
        .split(/[,;]/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      return {
        heading: block.split('\n', 1)[0].slice(3).trim(),
        trigger: field('trigger'),
        files,
        inert: field('trigger') === undefined && files.length === 0,
        judged: field('last block') !== undefined,
      };
    });
}

/** The dated heading reduced to the entry's identity, so events survive a merge. */
const keyOf = (heading) => ledger.headingKey(heading);

/** The age a heading carries (`## 2026-10-05 · slug`), in days. */
function headingAge(heading, now) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(heading);
  if (match === null) return undefined;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Math.max(0, Math.round((now - at) / 86_400_000));
}

/** Everything the report needs, from the ledger's own readers, one journal read per scope. */
export function buildReport(cwd, now, scopes = ['project', 'global']) {
  const rows = [];
  const collisions = [];
  /**
   * Event counts are keyed by entry identity, and an entry's scope is a property of where it
   * is *filed*, not of where the event was written: `pit-guard` records every hit in the
   * project journal, naming the ledger the entry came from in `source`. So a reader that looks
   * up project-scope events against project-scope entries alone "loses" every machine entry —
   * measured 2026-10-05, when this report called 29 machine entries (28% of all hit events)
   * orphans and reported 96 of 169 collision groups as naming headings that do not exist. They
   * exist; they are in the other file. Blend the maps, and keep the true orphans visible as
   * their own alarm: an event whose entry is in neither ledger is real drift.
   */
  const counts = new Map();
  const collisionKeys = new Map();
  for (const scope of scopes) {
    const events = ledger.pitEvents(cwd, scope);
    for (const [k, v] of events.byHeading) {
      const found = counts.get(k) ?? { triggerHits: 0, fileHits: 0, blocks: 0 };
      found.triggerHits += v.triggerHits;
      found.fileHits += v.fileHits;
      found.blocks += v.blocks;
      counts.set(k, found);
    }
    for (const c of events.collisions) collisionKeys.set(`${c.session}|${c.at}`, { ...c, scope });
  }
  collisions.push(...collisionKeys.values());
  const known = new Set();
  const homeOf = new Map();
  for (const scope of scopes) {
    for (const entry of entriesOf(ledger.ledgerPath(cwd, 'mistakes', scope), scope)) {
      const id = ledger.headingKey(entry.heading);
      known.add(id);
      if (!homeOf.has(id)) homeOf.set(id, scope);
      const c = counts.get(id) ?? { triggerHits: 0, fileHits: 0, blocks: 0 };
      rows.push({
        scope,
        heading: entry.heading,
        trigger: entry.trigger,
        files: entry.files,
        inert: entry.inert,
        ageDays: headingAge(entry.heading, now),
        triggerHits: c.triggerHits,
        fileHits: c.fileHits,
        blocks: c.blocks,
        judged: entry.judged,
      });
    }
  }
  // A collision's own `scope` is the journal it was found in, and every read-side event is
  // written to the project journal — so it can never say which FILE an entry lives in. That
  // distinction is the whole point here: the same subject was filed six times in the machine
  // ledger and once in the project one, and a reader sent to the wrong file edits nothing.
  const candidates = ledger.mergeCandidates(collisions).map((pair) => ({
    ...pair,
    aScope: homeOf.get(pair.aKey),
    bScope: homeOf.get(pair.bKey),
    sameLedger: homeOf.get(pair.aKey) === homeOf.get(pair.bKey),
  }));
  const orphanEvents = [...counts.entries()]
    .filter(([k, v]) => !known.has(k) && v.triggerHits + v.fileHits + v.blocks > 0)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.triggerHits + b.fileHits + b.blocks - (a.triggerHits + a.fileHits + a.blocks));
  return {
    cwd,
    scopes,
    entries: rows.length,
    collisions,
    mergeCandidates: candidates,
    orphanEvents,
    neverFired: rows.filter((r) => !r.inert && r.triggerHits === 0 && r.fileHits === 0),
    inert: rows.filter((r) => r.inert),
    blocks: rows.filter((r) => r.blocks > 0),
    unjudgedBlocks: rows.filter((r) => r.blocks > 0 && !r.judged),
  };
}

function render(report) {
  const lines = [];
  lines.push(`# Pit report — ${report.entries} entries across ${report.scopes.join(' + ')}`);
  lines.push('');
  lines.push('Worklist, cheapest first: (1) merge the near-duplicates below — it removes noise');
  lines.push('without losing a rule; (2) judge any unjudged refusal; (3) for each never-fired');
  lines.push('entry decide which of the two it is — a wrong rule, or a domain this machine does');
  lines.push('not have; (4) give the "cannot arrive" entries a coordinate or retire them.');
  lines.push('');
  lines.push(`## Merge candidates (${report.mergeCandidates.length} pair(s)) — same subject, different symptoms`);
  lines.push('');
  if (report.mergeCandidates.length === 0) lines.push('(none — nothing fires together with an overlapping heading)');
  for (const pair of report.mergeCandidates.slice(0, 15)) {
    const where = (scope) => (scope === 'global' ? 'machine' : 'project');
    lines.push(
      `- [${where(pair.aScope)}${pair.sameLedger ? '' : ' + ' + where(pair.bScope)}] overlap ${pair.overlap} on [${pair.shared.join(', ')}] — seen with \`${pair.commands[0]}\``,
    );
    lines.push(`  - ${pair.a}`);
    lines.push(`  - ${pair.b}`);
  }
  lines.push('');
  lines.push(`## Redundant: entries that fired together (${report.collisions.length} action(s))`);
  lines.push('');
  if (report.collisions.length === 0) lines.push('(none recorded — one action has never matched two entries)');
  for (const c of report.collisions.slice(0, 20)) {
    lines.push(`- ${c.headings.length} entries in one action (\`${String(c.cmd).slice(0, 70)}\`):`);
    for (const h of c.headings) lines.push(`  - ${h}`);
  }
  lines.push('');
  lines.push(`## Never fired (${report.neverFired.length}) — a wrong rule and an absent domain look identical here`);
  lines.push('');
  for (const r of report.neverFired.slice(0, 40)) {
    const coord = r.trigger !== undefined ? `trigger: ${r.trigger}` : `files: ${r.files.join(', ')}`;
    lines.push(`- [${r.ageDays ?? '?'}d, ${r.scope}] ${keyOf(r.heading)} — ${coord}`);
  }
  lines.push('');
  lines.push(`## Cannot arrive at all (${report.inert.length}) — no \`trigger:\` and no \`files:\``);
  lines.push('');
  for (const r of report.inert.slice(0, 40)) lines.push(`- [${r.ageDays ?? '?'}d, ${r.scope}] ${keyOf(r.heading)}`);
  lines.push('');
  lines.push(`## Refusals issued (${report.blocks.length}) — of which ${report.unjudgedBlocks.length} nobody has judged`);
  lines.push('');
  if (report.blocks.length === 0) lines.push('(none — no `hard block:` entry has been hit to its threshold)');
  for (const r of report.blocks) {
    lines.push(`- ${r.blocks} refusal(s) [${r.scope}] ${keyOf(r.heading)} — judged: ${r.judged ? 'yes' : '**no**'}`);
  }
  lines.push('');
  lines.push(`## Events with no entry (${report.orphanEvents.length}) — the journal names something neither ledger still holds`);
  lines.push('');
  if (report.orphanEvents.length === 0) lines.push('(none — every recorded hit belongs to an entry that exists)');
  for (const o of report.orphanEvents.slice(0, 20)) {
    lines.push(`- ${o.triggerHits + o.fileHits + o.blocks} event(s) (t${o.triggerHits}/f${o.fileHits}/b${o.blocks}): ${o.id.slice(0, 100)}`);
  }
  lines.push('');
  lines.push('To judge a refusal, add `- last block: <date> <verdict>` to that entry: `still blocked`');
  lines.push('means the rule earned its place, `turned out safe` means it refused honest work.');
  return `${lines.join('\n')}\n`;
}

// --------------------------------------------------------------------- self test

/** Build a `mistakes.md` body from entry objects, so no fixture text is hand-typed twice. */
const fixture = (entries) =>
  ['# Mistakes', '']
    .concat(
      entries.flatMap((e) => [
        `## ${e.heading}`,
        `- symptom: ${e.symptom ?? 's'}`,
        `- do not repeat: ${e.avoid ?? 'rule'}`,
        ...(e.files === undefined ? [] : [`- files: ${e.files}`]),
        ...(e.trigger === undefined ? [] : [`- trigger: ${e.trigger}`]),
        ...(e.hard === undefined ? [] : [`- hard block: ${e.hard}`]),
        ...(e.lastBlock === undefined ? [] : [`- last block: ${e.lastBlock}`]),
        '',
      ]),
    )
    .join('\n');

const FIXTURES = [
  { heading: '2026-10-05 · a-tracked-file-was-deleted-as-a-read-only-assertion', trigger: 'alpha' },
  { heading: '2026-10-04 · a-tracked-file-deleted-while-asserting-read-only', trigger: 'alpha' },
  { heading: '2026-10-04 · fired-alone', trigger: 'beta' },
  { heading: '2026-10-03 · never-fired-here', trigger: 'zzz-never' },
  { heading: '2026-10-02 · no-coordinates', },
  { heading: '2026-10-05 · refused-unjudged', trigger: 'gamma', hard: 2 },
  { heading: '2026-10-05 · refused-and-judged', trigger: 'delta', hard: 2, lastBlock: '2026-10-06 still blocked' },
];

async function selfTest() {
  const checks = [];
  const check = (id, name, ok, evidence) => checks.push({ id, name, ok: ok === true, evidence });
  const before = process.env.DSH_CODE_GLOBAL_DIR;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pit-report-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pit-report-proj-'));
  process.env.DSH_CODE_GLOBAL_DIR = home;
  try {
    fs.mkdirSync(path.join(cwd, '.dsh-code'), { recursive: true });
    const mistakes = path.join(cwd, '.dsh-code', 'mistakes.md');
    fs.writeFileSync(mistakes, fixture(FIXTURES), 'utf8');

    // One action (same session, same millisecond) touching two entries; one action touching
    // one; and two refusals, one of which the entry has a verdict for.
    const action = '2026-10-05T12:00:00.000Z';
    const hit = (heading, extra = {}) =>
      ledger.journalEvent(cwd, { kind: 'trigger_hit', ts: action, session: 's1', root: cwd, heading, source: 'x', cmd: 'run alpha', ...extra }, 'project');
    hit('2026-10-05 · a-tracked-file-was-deleted-as-a-read-only-assertion');
    hit('2026-10-04 · a-tracked-file-deleted-while-asserting-read-only');
    hit('2026-10-04 · fired-alone');
    ledger.journalEvent(cwd, { kind: 'file_hit', ts: action, session: 's1', root: cwd, heading: '2026-10-05 · a-tracked-file-was-deleted-as-a-read-only-assertion', target: 'a.js' }, 'project');
    for (const heading of ['2026-10-05 · refused-unjudged', '2026-10-05 · refused-and-judged']) {
      ledger.journalEvent(cwd, { kind: 'trigger_block', ts: action, session: 's1', root: cwd, heading, source: 'x', cmd: 'run gamma', hits: 2, declared: 2 }, 'project');
    }

    const now = Date.UTC(2026, 9, 6);
    const report = buildReport(cwd, now);
    const slug = (part) => report.neverFired.find((r) => r.heading.includes(part));
    check('P1', 'entries that fired in one action are reported together', report.collisions.length === 1 && report.collisions[0].headings.length === 3, { collisions: report.collisions.map((c) => c.headings) });
    check('P2', 'a file hit and a trigger hit in the same action are one collision, not two', report.collisions.filter((c) => c.headings.some((h) => h.includes('fired-alone'))).length === 1 && report.collisions.length === 1, { collisions: report.collisions.length });
    check('P3', 'an entry whose coordinate never matched is listed, with its age', slug('never-fired-here')?.ageDays === 3, { row: slug('never-fired-here') });
    check('P4', 'an entry that did match is not listed as never fired', slug('fired-alone') === undefined && slug('read-only-assertion') === undefined, { wrong: [slug('fired-alone') !== undefined, slug('read-only-assertion') !== undefined] });
    check('P5', 'an entry with no coordinates is "cannot arrive", not "never fired"', report.inert.length === 1 && report.inert[0].heading.includes('no-coordinates') && slug('no-coordinates') === undefined, { inert: report.inert.map((r) => r.heading) });
    check('P6', 'refusals are reported, and the one with no verdict is flagged', report.blocks.length === 2 && report.unjudgedBlocks.length === 1 && report.unjudgedBlocks[0].heading.includes('refused-unjudged'), { unjudged: report.unjudgedBlocks.map((r) => r.heading) });
    check(
      'P11',
      'two entries of one subject, worded differently, come out as one merge candidate',
      report.mergeCandidates.length === 1 &&
        report.mergeCandidates[0].overlap >= 0.34 &&
        report.mergeCandidates[0].shared.some((w) => w.includes('tracked')) &&
        report.mergeCandidates[0].commands.length === 1,
      { candidates: report.mergeCandidates.map((c) => ({ overlap: c.overlap, shared: c.shared, commands: c.commands.length })) },
    );

    const text = render(report);
    const sectionOf = (title) => {
      const at = text.indexOf(`## ${title}`);
      if (at === -1) return '';
      const rest = text.slice(at);
      const end = rest.indexOf('\n## ', 1);
      return end === -1 ? rest : rest.slice(0, end);
    };
    check('P7', 'the "never fired" section names the unfired entry and not the fired one', sectionOf('Never fired').includes('never-fired-here') && !sectionOf('Never fired').includes('fired-alone'), { section: sectionOf('Never fired') });
    check('P8', 'the collision section names both entries of the pair', sectionOf('Redundant').includes('read-only-assertion') && sectionOf('Redundant').includes('fired-alone'), { section: sectionOf('Redundant') });

    const journalBefore = fs.readFileSync(path.join(cwd, '.dsh-code', 'journal.jsonl'), 'utf8');
    const again = buildReport(cwd, now);
    check('P9', 'reporting writes nothing to the ledger it reports on', fs.readFileSync(path.join(cwd, '.dsh-code', 'journal.jsonl'), 'utf8') === journalBefore && again.entries === report.entries, { entries: again.entries });

    // The machine ledger holds an entry whose hits were written into the *project* journal —
    // which is what `pit-guard` does, naming the entry's file in `source`. Before this was
    // pinned, the report looked up project events against project entries only and called 29
    // machine entries (~28% of all hits) orphans. The fix must be visible in both directions:
    // the count reaches the machine row, and the orphan list stays for genuine drift.
    // `DSH_CODE_GLOBAL_DIR` IS the ledger directory (`globalDir() + /mistakes.md`); adding a
    // `.dsh-code` level under it makes the machine file invisible, which is how this fixture
    // first made P12 red for the wrong reason.
    fs.writeFileSync(
      path.join(home, 'mistakes.md'),
      fixture([{ heading: '2026-10-05 · a-tracked-file-deleted-while-asserting-read-only', trigger: 'alpha' }]),
      'utf8',
    );
    const crossScope = buildReport(cwd, now);
    const machineRow = crossScope.neverFired.concat(crossScope.blocks).find((r) => r.scope === 'global');
    check(
      'P12',
      'a machine entry hit by a project-journal event is counted, not reported as an orphan',
      crossScope.entries === FIXTURES.length + 1 &&
        crossScope.orphanEvents.length === 0 &&
        machineRow === undefined &&
        !crossScope.neverFired.some((r) => r.scope === 'global'),
      {
        entries: crossScope.entries,
        orphans: crossScope.orphanEvents.map((o) => o.id),
        neverFiredGlobal: crossScope.neverFired.filter((r) => r.scope === 'global').length,
      },
    );

    // The control that makes P6 meaningful: the flag must be able to go the other way.
    // The verdict is added the way a human would add it — by editing the entry — and the
    // fixture builder is what shapes the entry, so the two cannot disagree (the first
    // version replaced a text pattern the fixture never emitted, and P10 caught it).
    const patched = fs
      .readFileSync(mistakes, 'utf8')
      .replace(/(- hard block: 2\n)(?=- symptom:)/g, '$1- last block: 2026-10-06 turned out safe\n');
    fs.writeFileSync(mistakes, patched, 'utf8');
    const judged = buildReport(cwd, now);
    check(
      'P10',
      'giving a refusal a verdict clears its flag — the check can go both ways',
      judged.unjudgedBlocks.length === 1 && judged.unjudgedBlocks[0].heading.includes('refused-unjudged'),
      { unjudged: judged.unjudgedBlocks.length, patched: patched.includes('last block: 2026-10-06 turned out safe') },
    );
  } finally {
    if (before === undefined) delete process.env.DSH_CODE_GLOBAL_DIR;
    else process.env.DSH_CODE_GLOBAL_DIR = before;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  const failed = checks.filter((c) => !c.ok);
  const report = { probe: 'pit-report', passed: checks.length - failed.length, total: checks.length, failed: failed.map((c) => `${c.id} ${c.name}`), checks };
  const out = process.env.DSH_PROBE_REPORT ?? tempReport('pit-report-report.json');
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (failed.length > 0) process.stderr.write(`PIT-REPORT-DETAIL ${JSON.stringify({ failed: failed.map((c) => ({ id: c.id, evidence: c.evidence })) })}\n`);
  console.log(JSON.stringify({ passed: report.passed, total: report.total, failed: report.failed }, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
}

// Only run the CLI when this file is the entry point: the self-test below imports `lib/`, and
// a reader (or a debugging session) must be able to import `buildReport` without side effects.
const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isEntryPoint) {
  /* imported: export only */
} else if (args.includes('--selftest') || args.length === 0) {
  await selfTest();
} else {
  const cwd = argOf('--cwd', process.cwd());
  const scopeArg = argOf('--scope', 'both');
  const scopes = scopeArg === 'both' ? ['project', 'global'] : [scopeArg];
  const report = buildReport(cwd, Date.now(), scopes);
  const jsonOut = argOf('--json', undefined);
  if (jsonOut !== undefined) fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(render(report));
}
