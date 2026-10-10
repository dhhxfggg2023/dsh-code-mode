/**
 * kill-switch-state — is `DSH_CODE_PIT_HARD` reachable at all in this process?
 *
 * The restart gate lists a kill switch as the escape hatch for the one fail-closed path in
 * this package: "if you get stuck, set `DSH_CODE_PIT_HARD=0` and restart, and every hard
 * block turns off." Testing that sentence properly needs two DSH runs (one with the variable
 * set) and this file cannot do that.
 *
 * What it *can* settle is the precondition every reader of that sentence should check first:
 * **is the variable visible to a process started by the host at all?** A kill switch that the
 * host never passes through to its children is not a switch. This file is therefore the
 * honest half of the check, and it says which half it is in its own output.
 *
 * Run: `node probes/kill-switch-state.mjs`
 * Compare: `pwsh` with `$env:DSH_CODE_PIT_HARD` set must change this output, or the switch
 * that `lib/pit-guard.js:376` reads is not the switch a human can reach.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const value = process.env.DSH_CODE_PIT_HARD;

const out = [];
out.push('# kill-switch-state');
out.push(`- process: node ${process.version} (pid ${process.pid})`);
out.push(`- spawned by: ${process.env.DSH_CODE_BOOT === undefined ? '(DSH_CODE_BOOT unset — not a DSH-spawned boot process)' : `DSH_CODE_BOOT=${process.env.DSH_CODE_BOOT}`}`);
out.push('');
out.push('## the switch itself');
out.push(`- DSH_CODE_PIT_HARD = ${value === undefined ? '(unset)' : JSON.stringify(value)}`);
out.push(`- every hard block is ${value === '0' ? 'DISABLED by this value' : 'ARMED (the guard denies only on `=== "0"`)'}`);
out.push('');
out.push('## what this does and does not prove');
out.push('- proves: whether the variable is present in a process the host starts (the precondition for a human being able to set it at all).');
out.push('- does NOT prove: that setting it to 0 actually disarms the running plugin. That value is read by `lib/pit-guard.js` inside the DSH process (`hardDeny`, `process.env.DSH_CODE_PIT_HARD === "0"`), which this process is not.');
out.push('- to prove that half: set $env:DSH_CODE_PIT_HARD to 0 before launching DSH, then hit a hard-block entry twice in the new session. The second hit must be announced-and-allowed rather than refused.');
out.push('');
out.push('## DSH-related variables visible here');
const dshVars = Object.keys(process.env).filter((key) => key.startsWith('DSH_')).sort();
out.push(dshVars.length === 0 ? '- (none)' : dshVars.map((key) => `- ${key}=${key.includes('TOKEN') || key.includes('KEY') ? '(redacted)' : process.env[key]}`).join('\n'));

// A reminder of what the escape hatch is *for*, taken from the ledger rather than restated.
const guards = path.join(repo, 'lib', 'pit-guard.js');
if (fs.existsSync(guards)) {
  const source = fs.readFileSync(guards, 'utf8');
  const declared = (source.match(/^- hard block:/gm) ?? []).length;
  out.push('');
  out.push(`## in the source (${path.relative(repo, guards)})`);
  out.push(`- reads the value at: ${source.split('\n').findIndex((line) => line.includes('DSH_CODE_PIT_HARD')) + 1} (line number in file)`);
  out.push(`- declarations of \`hard block:\` inside that file: ${declared} (expected 0 — declarations live in ledgers, not in code)`);
}

console.log(out.join('\n'));
