/**
 * After moving the ledger home: does the *default* resolution find the new home?
 *
 * Deliberately does NOT set `DSH_CODE_GLOBAL_DIR` — the question is what a fresh process
 * resolves on its own. The earlier version of this diagnostic set the override, which made it
 * unable to see a stale default (the same class of mistake as an assertion that passes for the
 * wrong reason).
 */
import fs from 'node:fs';
import path from 'node:path';

delete process.env.DSH_CODE_GLOBAL_DIR;
delete process.env.DSH_CODE_PROJECTS_DIR;

const ledger = await import('../lib/ledger.js');
const project = 'E:\\projects\\dsh-code-mode';
const directory = ledger.ledgerDir(project);
const machine = ledger.globalDir();
const brief = ledger.brief(project, { session: 'diag-new-home', maxChars: 2500 });
const text = String(brief.text ?? '');

const rows = {
  envOverride: process.env.DSH_CODE_GLOBAL_DIR ?? '(unset)',
  machineDir: machine,
  projectStoreDir: ledger.projectStoreDir(),
  resolvedForProject: directory,
  storeMistakesBytes: (() => {
    try {
      return fs.statSync(path.join(directory, 'mistakes.md')).size;
    } catch {
      return null;
    }
  })(),
  briefSaysNoLedger: /No ledger yet/.test(text),
  briefHasMachineFacts: /## Machine-wide facts/.test(text),
  briefChars: text.length,
  oldHomeStillThere: fs.existsSync('C:\\Users\\dhhxfggg\\.dsh-code'),
};
fs.writeFileSync(`${process.env.TEMP}\\new-home.json`, JSON.stringify(rows, null, 1), 'utf8');
console.log(JSON.stringify(rows, null, 1));
