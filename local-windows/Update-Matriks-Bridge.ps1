param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = "Stop"

$updateFile = Join-Path $ProjectRoot "data\matriks-update.json"
if (-not (Test-Path -LiteralPath $updateFile)) { throw "Guncelleme bilgisi bulunamadi" }
$update = Get-Content -Raw -Encoding UTF8 $updateFile | ConvertFrom-Json
if ($update.url -notmatch '^https://' -or $update.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "Gecersiz guncelleme bilgisi" }

$tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd("\") + "\"
$stage = [IO.Path]::GetFullPath((Join-Path $env:TEMP "axis-matriks-update-$([guid]::NewGuid().ToString('N'))"))
if (-not ($stage + "\").StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Invalid update path" }
$zip = "$stage.zip"
$files = @(
  "scripts\start-matriks-bridge.ps1", "scripts\install-matriks-bridge.ps1",
  "scripts\matriks-agent.mjs", "scripts\matriks-order.mjs", "scripts\matriks-rtd.mjs",
  "config\bist100-current.txt", "config\matriks-symbols.txt",
  "config\matriks-extra-symbols.txt", "config\matriks-crypto-symbols.txt",
  "local-windows\Axis-Matriks-Bridge.ps1", "local-windows\Axis-Matriks-Bridge.cmd",
  "local-windows\Kurulum.ps1", "local-windows\Kurulum.cmd", "local-windows\Update-Matriks-Bridge.ps1"
)
try {
  Invoke-WebRequest -UseBasicParsing -Uri $update.url -OutFile $zip
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -ne $update.sha256) { throw "Guncelleme imzasi eslesmedi" }
  Expand-Archive -LiteralPath $zip -DestinationPath $stage
  foreach ($relative in $files) {
    $source = Join-Path $stage $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Paket eksik: $relative" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $ProjectRoot $relative) -Force
  }
  Remove-Item -LiteralPath $updateFile -Force
  & (Join-Path $ProjectRoot "scripts\install-matriks-bridge.ps1") | Out-Null
  Start-Process (Join-Path $ProjectRoot "local-windows\Axis-Matriks-Bridge.exe") -WorkingDirectory $ProjectRoot
} finally {
  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
