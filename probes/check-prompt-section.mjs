/**
 * Did the `code-ledger` prompt section actually reach the model?
 *
 * A prompt section is invisible to the model that receives it, so the only
 * evidence is the recorded request. Decode the newest session log and look for
 * the section text that dsh-code-mode/lib/prompt.js supplies — including the
 * "Working habits" block added on 2026-10-01, which is the part most likely to
 * be silently absent.
 *
 * The session log is zstd-compressed on disk, so this walks the storage dir and
 * uses the bundled unzstd helper when needed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROBES_DIR, sessionLogs, tempReport } from './paths.mjs';

const NODE = process.execPath;
const UNZSTD = path.join(PROBES_DIR, 'unzstd.cjs');
const OUT = tempReport("session-latest.jsonl");
const store = path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions');

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
/**
 * `--path <log>` checks one named session log instead of the newest.
 *
 * Added 2026-10-05, because this file is the **only** place that knows how to ask "did this
 * session receive the `code-ledger` section?", and it could only ask about the newest log.
 * The question that actually needs asking is the *opposite* one — does a session that ran on
 * a different preset **lack** the section? — and answering that by hand in a shell is how a
 * second implementation gets born and then forgotten (this repository has paid for owner
 * drift twice: `pattern-matcher`, and the read the handover had to split).
 *
 * It matters because the section's heading is the only per-session marker of "this session
 * ran the `code` preset", so it is the denominator for every zero-evidence claim about a
 * mechanism that only exists in that preset. Measured 2026-10-05: the newest log of this
 * project has 1 `system/message` frame carrying `## Project ledger`; a 2026-09-13 log from
 * another project (recorded before the preset existed) has 1 frame and 0 hits.
 *
 * The default is unchanged — newest log — so existing callers and the `[PASS]` line in
 * TESTING.md (maintenance checkout only) behave exactly as before.
 */
const ONLY_PATH = flag('--path');

/** Newest session log anywhere under the storage root. */
function newestLog(dir) {
  let best;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = newestLog(full);
      if (found !== undefined && (best === undefined || found.mtime > best.mtime)) best = found;
      continue;
    }
    if (!/\.jsonl(\.zstd)?$/.test(entry.name)) continue;
    const mtime = fs.statSync(full).mtimeMs;
    if (best === undefined || mtime > best.mtime) best = { full, mtime };
  }
  return best;
}

const found = ONLY_PATH === undefined ? newestLog(store) : { full: ONLY_PATH, mtime: fs.statSync(ONLY_PATH).mtimeMs };
if (found === undefined) throw new Error(`no session logs under ${store}`);
console.log(`newest log: ${found.full} (${new Date(found.mtime).toISOString()})`);

if (found.full.endsWith('.zstd')) {
  execFileSync(NODE, [UNZSTD, found.full, OUT], { stdio: 'inherit' });
} else {
  fs.copyFileSync(found.full, OUT);
}

const text = fs.readFileSync(OUT, 'utf8');
/**
 * Search only the `system/message` frames — the text the model was actually sent.
 *
 * Until 2026-10-02 this searched the whole log, which can pass on an echo rather than
 * on a request: the section also appears in the model's own replies, in tool-call
 * arguments, and in the system reminder re-injected with a user message. Measured that
 * day: the *newest* frame carrying `## Project ledger` was an assistant message, and a
 * `write` tool argument matched the needles too — so a host that had stopped sending
 * the section could still have passed. Frames arrive as JSONL with `{type, seq, time,
 * data}`; the prompt lives at `data.message`.
 */
const frames = text
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  })
  .filter(Boolean);
const carriers = frames.filter((frame) => frame.type === 'system/message');
const sent = carriers.map((frame) => JSON.stringify(frame.data?.message ?? frame.data)).join('\n');
const needles = {
  'section heading ## Project ledger': '## Project ledger',
  'ledger protocol line': 'Start work with `code_brief`',
  // The machine-wide layer (2026-10-02): a prompt change that never reached a real
  // request is the failure this probe exists for, and these two lines are the part
  // of the protocol that a live host can be missing by a whole restart.
  'ledger protocol: global scope': 'The scope decides where the fact lives',
  'ledger protocol: machine ledger': 'this machine keeps a second one in',
  'Working habits block': '## Working habits',
  'habit: cross-channel attribution': 'A verification result belongs to the context that produced it',
  'habit: green harness': 'A green harness is not a green product',
  'habit: prompt prefix': 'Protect the prompt prefix while a session is live',
  'habit: existing mechanism': 'Look for the mechanism that already exists before you build one',
  'habit: limit attribution': 'A limit found by experiment is not always the limit that protects you',
  'habit: state what you did not verify': 'Stopping without proof is allowed',
};
const result = {};
for (const [label, needle] of Object.entries(needles)) result[label] = sent.includes(needle);
console.log(
  JSON.stringify(
    {
      systemMessages: carriers.length,
      newestSystemMessage: carriers.at(-1) === undefined ? '(none)' : new Date(carriers.at(-1).time).toLocaleTimeString('sv'),
      carrierChars: sent.length,
      needlesFound: Object.values(result).filter(Boolean).length,
      needlesTotal: Object.keys(result).length,
      ...result,
    },
    null,
    2,
  ),
);
const allPresent = Object.values(result).every(Boolean);
/**
 * `[FAIL]` must also be an exit code.
 *
 * Measured 2026-10-05: this file printed `[FAIL]` for a log that never received the section
 * and still exited **0**. Any caller that trusts the exit code — a CI step, a `&&` chain,
 * `debt-audit` — therefore read a *missing* prompt section as success. A judgment that
 * cannot fail a pipeline is a report, not a judgment, and `probes/README.md` states the
 * convention this file was breaking ("每个探针失败时非零退出").
 *
 * The two cases that produce `[FAIL]` are different and both must fail: needles missing
 * from a carrier frame, and *no carrier frame at all* — the second is the failure this
 * probe was originally written for (a host that stopped sending the section, where an
 * echo in the log could still have made the old whole-log search pass).
 */
process.exitCode = allPresent ? 0 : 1;
console.log(
  `\n[${allPresent ? 'PASS' : 'FAIL'}] the code-ledger section, Working habits included, is present in the system prompt the model was sent` +
    (carriers.length === 0 ? ' — but NO system/message frame was found at all, so nothing was actually checked' : ''),
);
