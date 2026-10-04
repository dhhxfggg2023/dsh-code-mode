# Verification for the second batch of 2026-10-04 fixes (F1 board, F2 regex, F5 rotation).
# Runs INSIDE code_verify: reports go to $env:TEMP because this channel cannot write the
# workspace, and the script exits non-zero when anything is red.
$node = 'E:\tools\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$exe = 'E:\tools\DSH\DeepSeek Harness.exe'
$P = 'E:\projects\dsh-code-mode\probes'
$A = 'E:\projects\dsh-code-mode\.dsh-code\audits'
$tmp = $env:TEMP
$problems = @()

# --- probes covering the three edited behaviours --------------------------------------
foreach ($n in @('journal-rotation-probe', 'guard-probe', 'audit-verify-probe', 'write-rule-probe',
                 'pit-fire-probe', 'filehit-probe', 'output-schema-probe', 'handover-grant-probe')) {
  $report = Join-Path $tmp "$n.v3.json"
  if (Test-Path $report) { Remove-Item -LiteralPath $report -Force }
  $env:DSH_PROBE_REPORT = $report
  $out = & $node (Join-Path $P "$n.mjs") 2>&1 | Out-String
  $code = $LASTEXITCODE
  $flat = ($out -replace '\s+', ' ').Trim()
  if ($code -ne 0) { $problems += "$n exit=$code :: $($flat.Substring(0, [Math]::Min(300, $flat.Length)))" }
}
Remove-Item Env:DSH_PROBE_REPORT -ErrorAction SilentlyContinue

# --- the auditor's own probes for F1 and F14 -----------------------------------------
foreach ($n in @('01-tasks-json-parseable-malformed', '14-done-task-not-findable')) {
  $probe = Join-Path $A "$n.mjs"
  if (-not (Test-Path $probe)) { $problems += "audit probe missing: $n"; continue }
  $flat = (& $node $probe 2>&1 | Out-String) -replace '\s+', ' '
  $summary = if ($flat -match '(SUMMARY: [^|]{0,110})') { $matches[1] } else { $flat.Substring(0, [Math]::Min(110, $flat.Length)) }
  "audit-probe $n :: $summary"
  if ($n -eq '01-tasks-json-parseable-malformed' -and $flat -notmatch 'SUMMARY: 0/10') { $problems += "F1 probe still reports throwing variants" }
}

# --- F2: the regex bound, and the control that proves it was needed -------------------
# Two halves, because either alone is worthless: a genuinely catastrophic pattern must be
# abandoned (bounded), AND an ordinary pattern must still match. The first attempt used the
# audit's '^ (a+)+$', which is anchored to a literal space and returns in 0 ms — it measured
# nothing while looking like a measurement.
$redos = Join-Path $tmp 'redos-check-v3.mjs'
@'
import { testPattern } from 'file:///E:/projects/dsh-code-mode/lib/pattern-matcher.js';
const subject = 'a'.repeat(28);
const started = Date.now();
const nasty = await testPattern('(a+)+X$', subject);
const nastyMs = Date.now() - started;
const ordinary = await testPattern('Set-Content|Out-File', 'Get-Content a.txt | Set-Content b.txt');
const unrelated = await testPattern('Set-Content|Out-File', 'pnpm test');
console.log('RESULT ' + JSON.stringify({ nastyMs, timedOut: nasty.timedOut, ordinaryMatches: ordinary.matched, unrelatedMatches: unrelated.matched }));
'@ | Set-Content -LiteralPath $redos -Encoding UTF8
$regexOut = ((& $node $redos 2>&1 | Out-String) -replace '\s+', ' ').Trim()
"regex-bound :: $regexOut"
if ($regexOut -notmatch '"timedOut":true') { $problems += "regex bound never fired: $regexOut" }
if ($regexOut -notmatch '"ordinaryMatches":true') { $problems += "regex bound broke an ordinary match: $regexOut" }
if ($regexOut -match '"unrelatedMatches":true') { $problems += "regex bound matched an unrelated command: $regexOut" }

# --- F5: the saturation control --------------------------------------------------------
# `J5` in the rotation probe passes with a pre-filled highest slot. That only means something
# if the OLD rule fails the same assertion, so the old rule is executed here in isolation:
# shift `.00N` -> `.00(N+1)`, then refuse to rotate when `.000` is still occupied.
$control = Join-Path $tmp 'rotation-control.mjs'
@'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-control-'));
const live = path.join(dir, 'journal.jsonl');
const KEEP = 8;
// The state that stalled the old code: every slot occupied.
for (let i = 0; i <= KEEP; i += 1) fs.writeFileSync(path.join(dir, `journal.jsonl.${String(i).padStart(3, '0')}`), `segment ${i}\n`, 'utf8');
fs.writeFileSync(live, 'x'.repeat(1024), 'utf8');

/** The pre-fix rule, verbatim: shift upward, then bail if `.000` is occupied. */
function oldRotate() {
  for (let index = KEEP - 1; index >= 0; index -= 1) {
    const from = path.join(dir, `journal.jsonl.${String(index).padStart(3, '0')}`);
    const to = path.join(dir, `journal.jsonl.${String(index + 1).padStart(3, '0')}`);
    if (!fs.existsSync(from)) continue;
    if (!fs.existsSync(to)) { try { fs.renameSync(from, to); } catch { /* keep going */ } }
  }
  const target = path.join(dir, 'journal.jsonl.000');
  if (fs.existsSync(target)) return undefined;
  fs.renameSync(live, target);
  return target;
}

/** The fixed rule: retire the oldest slot FIRST, then shift, then place the live file. */
function newRotate() {
  const oldest = path.join(dir, `journal.jsonl.${String(KEEP).padStart(3, '0')}`);
  if (fs.existsSync(oldest)) { try { fs.unlinkSync(oldest); } catch { return undefined; } }
  for (let index = KEEP - 1; index >= 0; index -= 1) {
    const from = path.join(dir, `journal.jsonl.${String(index).padStart(3, '0')}`);
    const to = path.join(dir, `journal.jsonl.${String(index + 1).padStart(3, '0')}`);
    if (!fs.existsSync(from)) continue;
    if (!fs.existsSync(to)) { try { fs.renameSync(from, to); } catch { /* keep going */ } }
  }
  const target = path.join(dir, 'journal.jsonl.000');
  if (fs.existsSync(target)) return undefined;
  fs.renameSync(live, target);
  return target;
}

const oldResult = oldRotate();
const oldRotated = !fs.existsSync(live);
const newResult = newRotate();
const newRotated = !fs.existsSync(live);
const slots = fs.readdirSync(dir).filter((n) => n.startsWith('journal.jsonl.'));
console.log('RESULT ' + JSON.stringify({ oldRotated, newRotated, oldReturned: oldResult ?? null, newReturned: Boolean(newResult), slots: slots.length }));
fs.rmSync(dir, { recursive: true, force: true });
'@ | Set-Content -LiteralPath $control -Encoding UTF8
$controlOut = ((& $node $control 2>&1 | Out-String) -replace '\s+', ' ').Trim()
"rotation-control :: $controlOut"
if ($controlOut -notmatch '"oldRotated":false') { $problems += "control did not reproduce the stall: $controlOut" }
if ($controlOut -notmatch '"newRotated":true') { $problems += "fixed rule still stalls: $controlOut" }

# --- the Electron probes that load the edited modules ---------------------------------
$env:ELECTRON_RUN_AS_NODE = '1'
foreach ($n in @('acceptance-probe', 'pit-guard-probe')) {
  $report = Join-Path $tmp "$n.v3.json"
  if (Test-Path $report) { Remove-Item -LiteralPath $report -Force }
  $env:DSH_PROBE_REPORT = $report
  $out = & $exe --expose-internals (Join-Path $P "$n.mjs") 2>&1 | Out-String
  $code = $LASTEXITCODE
  $flat = ($out -replace '\s+', ' ').Trim()
  if ($code -ne 0) { $problems += "$n exit=$code :: $($flat.Substring(0, [Math]::Min(250, $flat.Length)))" }
  if ($out -match '"failed": \[[^\]]') { $problems += "$n non-empty failed list" }
}
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

"problems=$($problems.Count)"
foreach ($p in $problems) { "PROBLEM: $p" }
if ($problems.Count -eq 0) { Write-Output 'ALL-VERIFIED' } else { Write-Output 'HAS-PROBLEMS'; exit 1 }
