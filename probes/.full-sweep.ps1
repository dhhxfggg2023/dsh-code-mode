# Full suite sweep, 2026-10-04 (danger-full-access channel).
# Written as a file because inline quoted payloads are a recorded pit here.
# Each group runs top-level (not through debt-audit) so the Electron probes are real runs.
$node = '<install>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$install = '<install>'
$P = '<这个包的 checkout>\probes'
$out = Join-Path $env:TEMP 'sweep'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$lines = @()
$summary = { param($name, $code, $text)
  $verdict = ($text -replace '\s+', ' ').Trim()
  if ($verdict.Length -gt 150) { $verdict = $verdict.Substring(0, 150) }
  $script:lines += "[$name] exit=$code :: $verdict"
}

# --- node probes that honour DSH_PROBE_REPORT ---------------------------------------
foreach ($n in @('guard-probe','pit-fire-probe','filehit-probe','output-schema-probe','audit-verify-probe',
                 'write-rule-probe','journal-rotation-probe','brief-full-probe','promotion-probe',
                 'audit-child-env-probe')) {
  $report = Join-Path $out "$n.json"
  Remove-Item Env:DSH_PROBE_REPORT -ErrorAction SilentlyContinue
  $env:DSH_PROBE_REPORT = $report
  $text = & $node (Join-Path $P "$n.mjs") 2>&1 | Out-String
  $code = $LASTEXITCODE
  if (Test-Path $report) {
    $j = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    & $summary $n $code "passed=$($j.passed) total=$($j.total) failed=$($j.failed.Count)"
  } else {
    & $summary $n $code $text
  }
}
Remove-Item Env:DSH_PROBE_REPORT -ErrorAction SilentlyContinue

# --- plain node, needs the flag / no report -----------------------------------------
foreach ($pair in @(@('syntax-check','--experimental-vm-modules'), @('utf8-check',''), @('debt-audit',''), @('build-preset','--check'))) {
  $name = $pair[0]
  $flag = $pair[1]
  $args = @()
  if ($flag -ne '') { $args += $flag }
  $args += (Join-Path $P "$name.mjs")
  $text = & $node @args 2>&1 | Out-String
  $code = $LASTEXITCODE
  $verdict = ($text -replace '\s+', ' ').Trim()
  if ($verdict.Length -gt 150) { $verdict = $verdict.Substring($verdict.Length - 150) }
  & $summary $name $code $verdict
}

# --- Electron probes (top-level, each with its own report) --------------------------
$env:ELECTRON_RUN_AS_NODE = '1'
foreach ($n in @('acceptance-probe','budget-probe','budget-chain-probe',
                 'gate-probe','gate-journal-probe','pit-guard-probe','aegis-activation-probe')) {
  $report = Join-Path $out "$n.json"
  $env:DSH_PROBE_REPORT = $report
  $text = & (Join-Path $install 'DeepSeek Harness.exe') --expose-internals (Join-Path $P "$n.mjs") 2>&1 | Out-String
  $code = $LASTEXITCODE
  & $summary $n $code $text
}
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# --- documents against reality ------------------------------------------------------
foreach ($n in @('check-prompt-section','pit-liveness','check-yaml')) {
  $text = & $node (Join-Path $P "$n.mjs") 2>&1 | Out-String
  $code = $LASTEXITCODE
  $verdict = ($text -replace '\s+', ' ').Trim()
  if ($verdict.Length -gt 150) { $verdict = $verdict.Substring(0, 150) }
  & $summary $n $code $verdict
}

$lines | ForEach-Object { $_ }
Write-Output 'SWEEP-DONE'
