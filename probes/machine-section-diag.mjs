/**
 * Diagnostic for the tight-budget machine section (B1 in audit-verify-probe.mjs).
 *
 * Prints the machine ledger's contents, the section `globalExcerpt` returns at a small
 * cap, and the whole briefing — so a red check can be read instead of guessed at.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-diag-${tag}-`));

const machine = scratch('machine');
process.env.DSH_CODE_GLOBAL_DIR = machine;
const ledger = await import(pathToFileURL(path.join(PKG_DIR, 'lib', 'ledger.js')).href);
const SESSION = 'diag-session';

const root = scratch('proj');
ledger.initLedger(root, SESSION);
ledger.recordMistake(
  root,
  { symptom: 'AUDIT-C2 a long machine pit', cause: 'overrun fixture', fix: 'bound the block', avoid: undefined, trigger: 'audit-c2-trigger' },
  SESSION,
  ledger.SCOPE.global,
);
const machineMistakes = path.join(machine, 'mistakes.md');
fs.writeFileSync(machineMistakes, `${fs.readFileSync(machineMistakes, 'utf8')}\n- do not repeat: ${'Q'.repeat(900)}\n`, 'utf8');
ledger.writeProject(root, { audit_c2_fact: 'F'.repeat(400) }, SESSION, ledger.SCOPE.global);

const excerpt = ledger.globalExcerpt(200, undefined, ledger.factRecency(ledger.SCOPE.global));
const brief = ledger.brief(root, { session: SESSION, maxChars: 200 });
const tiny = ledger.brief(root, { session: SESSION, maxChars: 60 });

console.log(
  JSON.stringify(
    {
      machineDir: machine,
      machineFiles: fs.readdirSync(machine),
      mistakesChars: fs.statSync(machineMistakes).size,
      excerpt200: { chars: excerpt?.length, head: excerpt?.slice(0, 260) },
      brief200: { chars: brief.text.length, empty: brief.empty, omitted: brief.omitted, text: brief.text },
      brief60: { chars: tiny.text.length, omitted: tiny.omitted, text: tiny.text.slice(0, 200) },
    },
    null,
    2,
  ),
);
