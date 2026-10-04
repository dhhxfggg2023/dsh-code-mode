# Verification for the 2026-10-04 edits, designed to run INSIDE code_verify.
#
# Why a file: every probe that writes a report must be pointed at $env:TEMP, because this
# channel cannot write inside the workspace (recorded pit: EPERM on a workspace path from
# code_verify's shell, even under danger-full-access). And why an explicit failure count at
# the end: code_verify reads the exit code of the LAST statement, so a quiet probe failure
# must be turned into a non-zero exit here rather than trusted to propagate.
$node = 'E:\tools\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$exe = 'E:\tools\DSH\DeepSeek Harness.exe'
$P = 'E:\projects\dsh-code-mode\probes'
$tmp = $env:TEMP
$problems = @()

# --- plain-node probes (each honours DSH_PROBE_REPORT) --------------------------------
foreach ($n in @('guard-probe', 'pit-fire-probe', 'filehit-probe', 'output-schema-probe',
                 'audit-verify-probe', 'write-rule-probe', 'journal-rotation-probe',
                 'brief-full-probe', 'promotion-probe', 'handover-grant-probe',
                 'audit-child-env-probe', 'utf8-check')) {
  $report = Join-Path $tmp "$n.verify.json"
  if (Test-Path $report) { Remove-Item -LiteralPath $report -Force }
  $env:DSH_PROBE_REPORT = $report
  $null = & $node (Join-Path $P "$n.mjs") 2>&1
  $code = $LASTEXITCODE
  if ($code -ne 0) { $problems += "$n exit=$code" }
}
Remove-Item Env:DSH_PROBE_REPORT -ErrorAction SilentlyContinue

# syntax-check needs the flag; its unavailable path must not be mistaken for a pass.
$syntaxOut = & $node --experimental-vm-modules (Join-Path $P 'syntax-check.mjs') 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $syntaxOut -notmatch '14/14 parsed') { $problems += "syntax-check: $($syntaxOut -replace '\s+', ' ')" }

# debt-audit runs the whole suite itself, Electron probes included.
$auditReport = Join-Path $tmp 'debt-audit.verify.json'
$env:DSH_PROBE_REPORT = $auditReport
$null = & $node (Join-Path $P 'debt-audit.mjs') 2>&1
$auditCode = $LASTEXITCODE
Remove-Item Env:DSH_PROBE_REPORT -ErrorAction SilentlyContinue
if ($auditCode -ne 0) { $problems += "debt-audit exit=$auditCode" }
if (Test-Path $auditReport) {
  $audit = Get-Content -LiteralPath $auditReport -Raw | ConvertFrom-Json
  if ($audit.failed.Count -gt 0) { $problems += "debt-audit failed: $($audit.failed -join '; ')" }
  $auditLine = "debt-audit $($audit.passed)/$($audit.total)"
} else {
  $problems += 'debt-audit wrote no report'
  $auditLine = 'debt-audit no report'
}

# --- the Electron probes that cover the edited modules --------------------------------
$env:ELECTRON_RUN_AS_NODE = '1'
foreach ($n in @('acceptance-probe', 'compact-gate-probe', 'pit-guard-probe', 'gate-probe',
                 'real-output-schema-probe')) {
  $report = Join-Path $tmp "$n.verify.json"
  if (Test-Path $report) { Remove-Item -LiteralPath $report -Force }
  $env:DSH_PROBE_REPORT = $report
  $out = & $exe --expose-internals (Join-Path $P "$n.mjs") 2>&1 | Out-String
  $code = $LASTEXITCODE
  $flat = ($out -replace '\s+', ' ').Trim()
  if ($code -ne 0) { $problems += "$n exit=$code :: $($flat.Substring(0, [Math]::Min(160, $flat.Length)))" }
  # A non-empty `failed` list is the only failure signal. The first version of this test
  # also matched the bare word FAIL and an EMPTY array, so `"failed": []` on a 24/24 result
  # was reported as five problems — a checker that lies in the direction of red.
  if ($out -match '"failed": \[[^\]]') { $problems += "$n non-empty failed list :: $($flat.Substring(0, [Math]::Min(200, $flat.Length)))" }
  if ($out -match '^\s*FAIL ' -or $out -match '\nFAIL ') { $problems += "$n printed a FAIL line" }
}
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

"$auditLine; problems=$($problems.Count)"
foreach ($p in $problems) { "PROBLEM: $p" }
# Exit code has to come from a statement that actually runs: `code_verify` reads the exit
# code of the LAST statement, so a green suite must end by leaving $? true.
if ($problems.Count -eq 0) { Write-Output 'ALL-VERIFIED' } else { Write-Output 'HAS-PROBLEMS'; exit 1 }
