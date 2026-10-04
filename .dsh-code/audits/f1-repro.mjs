/**
 * Does the harness's lossless-JSON step reject an `undefined` leaf, and does
 * `code_record(kind="project"|"progress")` hand it one?
 *
 * Both halves are read from the installed harness rather than paraphrased: the schema
 * `lib/tool-record.js` declares, the validator the harness runs over a tool result, and
 * what the two branches actually return. The claim under test (from the 2026-10-04
 * tool-surface audit) is that the 2026-10-04 fix covered the `mistake`/`decision`
 * branches and left `project`/`progress` returning a fifth key, so an ordinary call is
 * answered with an error AFTER the ledger write already happened.
 *
 * This script only READS the harness and the library. It writes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';

const ASAR = 'E:\\tools\\DSH\\resources\\app.asar';
const record = fs.readFileSync('E:\\projects\\dsh-code-mode\\lib\\tool-record.js', 'utf8');

// --- 1. what the module declares as its output schema ---------------------------------
const schemaStart = record.indexOf('output:');
const schemaChunk = record.slice(schemaStart, schemaStart + 1400);
const props = [...schemaChunk.matchAll(/^\s{6,}([a-zA-Z_$][\w$]*):\s*\{\s*type:/gm)].map((m) => m[1]);
const requiredBlocks = [...schemaChunk.matchAll(/([a-zA-Z_$][\w$]*):\s*\{\s*type:\s*'[^']+',[^}]*required:\s*(true|false)/gs)].map(
  (m) => `${m[1]}=${m[2]}`,
);
console.log('declared output properties:', JSON.stringify(props));
console.log('declared required flags    :', JSON.stringify(requiredBlocks));
console.log('additionalProperties:false :', /additionalProperties:\s*false/.test(schemaChunk));

// --- 2. does the harness refuse an undefined leaf? ------------------------------------
const utilPath = path.join(ASAR, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-util-values', 'lib', 'index.js');
const util = fs.readFileSync(utilPath, 'utf8');
const snapStart = util.indexOf('snapshotJsonValue');
const snap = util.slice(snapStart, snapStart + 1800);
const refusesUndefined = /undefined/.test(snap) && /(throw|Error|reject)/.test(snap);
console.log('\nsnapshotJsonValue refuses undefined:', refusesUndefined);
console.log('--- snapshotJsonValue excerpt ---');
console.log(
  snap
    .split('\n')
    .filter((line) => /undefined|throw|function|const snapshotJsonValue/.test(line))
    .slice(0, 12)
    .join('\n'),
);

// --- 3. which branches return a `notice` key -----------------------------------------
const noticeLines = record
  .split('\n')
  .map((line, index) => ({ line: line.trim(), no: index + 1 }))
  .filter((row) => /^notice[,:]/.test(row.line) || /notice:\s*written\.notice/.test(row.line));
console.log('\nbranches returning `notice`:', JSON.stringify(noticeLines));
