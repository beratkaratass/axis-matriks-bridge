param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$CheckMatriksIQ
)
$ErrorActionPreference = "Stop"

$node = (Get-Command node -ErrorAction Stop).Source
$agent = Join-Path $ProjectRoot "scripts\matriks-agent.mjs"
$rtd = Join-Path $ProjectRoot "scripts\matriks-rtd.mjs"
$envFile = Join-Path $ProjectRoot ".env.matriks"
if (-not (Test-Path $agent)) { throw "Matriks agent not found: $agent" }
if (-not (Test-Path $envFile)) { throw "Bridge configuration not found: $envFile" }

$configuredPath = $env:MATRIKS_IQ_PATH
if (-not $configuredPath) {
  $configuredLine = Get-Content $envFile | Where-Object { $_ -match '^\s*MATRIKS_IQ_PATH\s*=' } | Select-Object -Last 1
  if ($configuredLine -match '^\s*MATRIKS_IQ_PATH\s*=\s*(.*?)\s*$') { $configuredPath = $matches[1].Trim('"', "'") }
}
$installLocation = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -eq 'MatriksIQ Veri Terminali' } | Select-Object -ExpandProperty InstallLocation -First 1
$matriksIQ = @($configuredPath, $(if ($installLocation) { Join-Path $installLocation 'MatriksIQ.exe' }), 'C:\MatriksIQ\MatriksIQ.exe') |
  Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if ($CheckMatriksIQ) { if (-not $matriksIQ) { throw 'MatriksIQ.exe was not found' }; Write-Host $matriksIQ; exit 0 }
if (-not (Get-Process -Name MatriksIQ -ErrorAction SilentlyContinue)) {
  if ($matriksIQ) { Start-Process -FilePath $matriksIQ -WorkingDirectory (Split-Path -Parent $matriksIQ) -WindowStyle Normal }
  else { Write-Warning 'MatriksIQ.exe was not found; set MATRIKS_IQ_PATH in .env.matriks' }
}

$agentPattern = [regex]::Escape($agent)
$rtdPattern = [regex]::Escape($rtd)
$owned = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq "node.exe" -and ($_.CommandLine -match $agentPattern -or $_.CommandLine -match $rtdPattern)) -or
  ($_.Name -eq "ssh.exe" -and $_.CommandLine -match "127\.0\.0\.1:13100:127\.0\.0\.1:3100")
}
$owned | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if ($owned) { Start-Sleep -Milliseconds 500 }

$logDir = Join-Path $ProjectRoot "data"
$log = Join-Path $logDir "matriks-agent.log"
New-Item -ItemType Directory -Force $logDir | Out-Null
if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item -Force $log "$log.1" }

Set-Location $ProjectRoot
$utf8 = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = "Continue"
& $node $agent 2>&1 | ForEach-Object {
  [IO.File]::AppendAllText($log, "$($_)`r`n", $utf8)
}
$exitCode = $LASTEXITCODE
exit $exitCode
