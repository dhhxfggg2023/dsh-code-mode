/**
 * Regenerate or verify dsh-code-mode/cordis.patch.yml against the installed
 * built-in `standard` preset.
 *
 * History: this started as a one-shot generator whose emitted `code-memory`
 * group was wrong twice over — it registered `lib/ledger.js`, which is a pure
 * library with no loader exports and therefore cannot be a plugin row, and it
 * predated `code-gate` and `code-budget`. Re-running it would have silently
 * written a preset that loses two gates and fails to mount. A generator that can
 * destroy the artifact it generates is worse than no generator.
 *
 * So it now does both jobs:
 *   --check (default)  assert the checked-in preset carries every standard entry
 *                      plus exactly the intended additions; exit non-zero on drift
 *   --write            regenerate the file from the extracted standard preset
 *
 * The emitted group is derived from the live file's own `code-memory` rows when
 * they exist, so the two halves cannot disagree again.
 *
 *   & '<node>' 'E:\tools\DSH\.dsh-probe\build-preset.mjs' --check
 *   & '<node>' 'E:\tools\DSH\.dsh-probe\build-preset.mjs' --write
 */
import fs from 'node:fs';
import path from 'node:path';
import { ASAR, PKG_DIR, PROBES_DIR } from './paths.mjs';


const DEST = path.join(PKG_DIR, 'cordis.patch.yml');
const STANDARD_COPY = path.join(PROBES_DIR, "standard.patch.yml");
const HEADER = '# Agent preset standard';
const mode = process.argv.includes('--write') ? 'write' : 'check';

/**
 * The built-in standard declaration, located by its own first line (the asar's
 * recorded offsets are unusable — block packing). `--write` refreshes the
 * extracted copy; `--check` only reads, so a read-only channel can run it.
 */
function standardText() {
  const raw = fs.readFileSync(ASAR).toString('utf8');
  const at = raw.indexOf(HEADER);
  if (at < 0) throw new Error(`built-in standard preset not found in ${ASAR}`);
  const text = raw.slice(at, at + 12000);
  if (mode === 'write') fs.writeFileSync(STANDARD_COPY, text, 'utf8');
  return text;
}

/** Rows at any depth, with name/disabled, keyed for comparison. */
function entries(text) {
  const list = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^( *)- id: (.+?)\s*$/.exec(lines[i]);
    if (m === null) continue;
    const row = { indent: m[1].length, id: m[2].trim(), name: undefined, disabled: undefined };
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = /^( *)- id: /.exec(lines[j]);
      if (next !== null) break;
      const shallower = /^( *)\S/.exec(lines[j]);
      if (shallower !== null && shallower[1].length < row.indent) break;
      const nm = /^ *name: (.+?)\s*$/.exec(lines[j]);
      if (nm !== null && row.name === undefined) row.name = nm[1].trim();
      const dis = /^ *disabled: (.+?)\s*$/.exec(lines[j]);
      if (dis !== null && row.disabled === undefined) row.disabled = dis[1].trim();
    }
    list.push(row);
  }
  return list;
}

const key = (r) => `${r.id} | ${r.name ?? ''} | ${r.disabled ?? ''}`;
/** The declaration row renames itself; everything else must be present verbatim. */
const RENAMED = (k) => k === "preset-standard | '@deepseek-ai/dsh-agent-preset' | ";
/**
 * Rows this preset deliberately changes relative to standard. Each entry needs a
 * reason, because an unexplained difference here is exactly the drift this check
 * exists to catch: `tool-plugin-manager` is shipped disabled so the authoring
 * path is unreachable, and this mode enables it (see the comment in the preset).
 */
const INTENTIONAL = {
  "tool-plugin-manager | '@deepseek-ai/dsh-plugin-manager/tools' | false": true,
};
/** A standard row counts as satisfied when it is present verbatim or intentionally changed. */
function satisfied(row) {
  return INTENTIONAL[key(row)] === true;
}

function check() {
  const standard = entries(standardText());
  const mine = entries(fs.readFileSync(DEST, 'utf8'));
  const mineIds = new Set(mine.map((r) => r.id));
  const mineKeys = new Set(mine.map(key));
  const standardKeys = new Set(standard.map(key));
  const missing = standard.filter((r) => !mineIds.has(r.id) && !RENAMED(key(r)));
  const added = mine.filter((r) => !standardKeys.has(key(r)) && !satisfied(r) && !standard.some((s) => s.id === r.id));
  const unexpected = added.filter(
    (r) =>
      !(
        key(r) === "preset-code | '@deepseek-ai/dsh-agent-preset' | " ||
        key(r) === 'code-memory | cordis:group | ' ||
        /^code-(prompt|brief|record|verify|gate|budget|pit-guard|compact-gate) \| 'dsh-code-mode\/lib\//.test(key(r))
      ),
  );
  // Every intentional difference must actually be present, or the reason is stale.
  const missingIntentional = Object.keys(INTENTIONAL).filter((k) => ![
    ...mineKeys,
  ].includes(k));
  const ok = missing.length === 0 && unexpected.length === 0 && missingIntentional.length === 0;
  console.log(
    JSON.stringify(
      {
        mode: 'check',
        standardEntries: standard.length,
        codeEntries: mine.length,
        missingFromCode: missing.map((r) => r.id),
        unexpectedAdditions: unexpected.map(key),
        intentionalDifferences: Object.keys(INTENTIONAL),
        staleIntentionalDifferences: missingIntentional,
        additions: added.map(key),
        verdict: ok ? 'code carries every standard entry plus only intended additions' : 'DRIFT',
      },
      null,
      2,
    ),
  );
  if (!ok) {
    console.error('\nRefusing to pass: regenerate with --write only after reviewing the diff.');
    process.exitCode = 1;
  }
}

function write() {
  let y = standardText().replace(/\r\n/g, '\n');
  y = y.replace(
    /^# Agent preset standard:[\s\S]*?# `config\.plugins` by id from the profile patch\.\n/,
    `# 编程模式 (Code Mode): a DSH agent preset for creating and maintaining large projects.\n` +
      `# Same level as the built-in standard/ptc/minimal/cordis presets. The child plugin list is\n` +
      `# copied verbatim from the built-in standard preset, because child rows cannot reference\n` +
      `# another preset's id — a new preset must carry the whole catalog. Two differences:\n` +
      `#   1. persona speaks as the maintainer of a large, long-lived codebase;\n` +
      `#   2. the code-memory group adds the project ledger tools and the briefing prompt section.\n`,
  );
  y = y.replace('    - id: preset-standard\n', '    - id: preset-code\n');
  y = y.replace(
    '        id: standard\n        order: 1\n',
    `        id: code\n        name: 编程模式\n        description: 为大型项目的创造与维护而设：项目账本、开局简报、反重复门禁。\n        order: 5\n`,
  );
  y = y.replace(
    '              prefix: You are a coding agent powered by the {{model}} model.\n',
    '              prefix: You are a coding agent powered by the {{model}} model, working on a large, long-lived codebase.\n',
  );

  // The group rows come from the live file, so regeneration can never drop a
  // plugin that was added by hand (that is how code-gate/code-budget were lost
  // the first time this script would have been re-run).
  const existing = fs.existsSync(DEST) ? fs.readFileSync(DEST, 'utf8') : '';
  const liveGroup = existing.slice(existing.indexOf('- id: code-memory'), existing.indexOf('- id: tool-ask-user'));
  if (!liveGroup.includes('- id: code-')) throw new Error('live preset has no code-memory group to preserve');
  const rows = [...liveGroup.matchAll(/- id: (code-[a-z-]+)\n\s+name: '([^']+)'/g)].map((m) => ({ id: m[1], name: m[2] }));
  if (rows.length === 0) throw new Error('live code-memory group lists no rows');
  if (rows.some((r) => r.name.includes('lib/ledger.js'))) {
    throw new Error('live group registers lib/ledger.js, which cannot be a plugin row');
  }

  const anchor = '          - id: tool-ask-user\n';
  const group = `          - id: code-memory\n            name: cordis:group\n            group: true\n            config:\n${rows
    .map((r) => `              - id: ${r.id}\n                name: '${r.name}'\n`)
    .join('')}`;
  if (!y.includes(anchor)) throw new Error('anchor row tool-ask-user not found');
  y = y.replace(anchor, group + anchor);
  fs.writeFileSync(DEST, y);
  console.log(JSON.stringify({ mode: 'write', wrote: DEST, chars: y.length, preservedRows: rows }, null, 2));
  console.log('Now run with --check to confirm the result.');
}

if (mode === 'write') write();
else check();
