param(
  [string]$ServerUrl,
  [string]$AgentToken,
  [switch]$Check
)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js 22 veya yenisi gerekli: https://nodejs.org" }
$major = [int]((& $node.Source --version).TrimStart("v").Split(".")[0])
if ($major -lt 22) { throw "Node.js 22 veya yenisi gerekli" }

$required = @(
  "scripts\start-matriks-bridge.ps1",
  "scripts\install-matriks-bridge.ps1",
  "scripts\matriks-agent.mjs",
  "scripts\matriks-rtd.mjs",
  "config\bist100-current.txt",
  "config\matriks-symbols.txt",
  "config\matriks-extra-symbols.txt",
  "config\matriks-crypto-symbols.txt",
  "local-windows\Axis-Matriks-Bridge.ps1"
)
foreach ($relative in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $root $relative) -PathType Leaf)) { throw "Eksik dosya: $relative" }
}
if ($Check) { Write-Output "Portable setup check OK"; exit 0 }

if (-not $ServerUrl) {
  $ServerUrl = Read-Host "Sunucu adresi [https://quant.beratkaratas.com]"
  if (-not $ServerUrl) { $ServerUrl = "https://quant.beratkaratas.com" }
}
$uri = $ServerUrl -as [uri]
if (-not $uri -or ($uri.Scheme -ne "https" -and $uri.Host -notin @("localhost", "127.0.0.1", "::1"))) {
  throw "Gecerli bir HTTPS sunucu adresi girin"
}

if (-not $AgentToken) {
  $secure = Read-Host "MATRIKS_AGENT_TOKEN" -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $AgentToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
$AgentToken = $AgentToken.Trim()
if ($AgentToken -match '^MATRIKS_AGENT_TOKEN=(.+)$') { $AgentToken = $matches[1].Trim().Trim('"', "'") }
if ($AgentToken.Length -lt 32) { throw "Token en az 32 karakter olmali" }
$agentId = "windows-$env:COMPUTERNAME"
$hmac = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($AgentToken))
try { $deviceToken = [Convert]::ToBase64String($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("matriks-agent-v1:$agentId"))).TrimEnd("=").Replace("+", "-").Replace("/", "_") }
finally { $hmac.Dispose() }

$content = @(
  "MATRIKS_SERVER_URL=$($uri.AbsoluteUri.TrimEnd('/'))",
  "MATRIKS_AGENT_TOKEN=$deviceToken",
  "MATRIKS_AGENT_ID=$agentId",
  "MATRIKS_HOST=127.0.0.1",
  "MATRIKS_PORT=18890",
  "MATRIKS_REPORT_INTERVAL_MS=5000",
  "MATRIKS_REFRESH_INTERVAL_MS=60000",
  "MATRIKS_DDE_AUTOSTART=1",
  "MATRIKS_REAL_TRADING=0",
  "MATRIKS_DDE_BATCH_SIZE=25",
  "MATRIKS_DDE_BATCH_DELAY_MS=100"
) -join "`r`n"
$envFile = Join-Path $root ".env.matriks"
[IO.File]::WriteAllText($envFile, "$content`r`n", [Text.UTF8Encoding]::new($false))
& icacls.exe $envFile "/inheritance:r" "/grant:r" "$([Security.Principal.WindowsIdentity]::GetCurrent().Name):(F)" | Out-Null

& (Join-Path $root "scripts\install-matriks-bridge.ps1")
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "Axis Matriks.lnk"))
$shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'Axis-Matriks-Bridge.ps1')`""
$shortcut.WorkingDirectory = $root
$shortcut.Save()
Start-Process -FilePath $shortcut.TargetPath -ArgumentList $shortcut.Arguments -WorkingDirectory $root -WindowStyle Hidden
Write-Host "Kurulum tamamlandi. Bu bilgisayar otomatik olarak aktif veya yedek olur."
