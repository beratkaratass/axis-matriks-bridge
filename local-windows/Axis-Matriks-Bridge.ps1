param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$Check
)
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$startScript = Join-Path $ProjectRoot "scripts\start-matriks-bridge.ps1"
$installScript = Join-Path $ProjectRoot "scripts\install-matriks-bridge.ps1"
$agent = Join-Path $ProjectRoot "scripts\matriks-agent.mjs"
$rtd = Join-Path $ProjectRoot "scripts\matriks-rtd.mjs"
$log = Join-Path $ProjectRoot "data\matriks-agent.log"
$serverStatusFile = Join-Path $ProjectRoot "data\matriks-server-status.json"
$updateFile = Join-Path $ProjectRoot "data\matriks-update.json"
$updater = Join-Path $ProjectRoot "local-windows\Update-Matriks-Bridge.ps1"
$taskName = "Axis Matriks Bridge"
$powershell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

foreach ($path in @($startScript, $installScript, $agent, $rtd)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing: $path" }
}

function Get-OwnedProcesses {
  $agentPattern = [regex]::Escape($agent)
  $rtdPattern = [regex]::Escape($rtd)
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.Name -eq "node.exe" -and ($_.CommandLine -match $agentPattern -or $_.CommandLine -match $rtdPattern)) -or
    ($_.Name -eq "ssh.exe" -and $_.CommandLine -match "127\.0\.0\.1:13100:127\.0\.0\.1:3100")
  })
}

function Test-LocalPort([int]$Port) {
  try {
    return [bool]([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
      Where-Object { $_.Port -eq $Port } | Select-Object -First 1)
  } catch { return $false }
}

function Start-Bridge {
  $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`" -ProjectRoot `"$ProjectRoot`""
  Start-Process -FilePath $powershell -ArgumentList $arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden
}

function Stop-Bridge {
  Get-OwnedProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Check) {
  if (-not (Test-LocalPort 1)) { Write-Output "UI check OK: required files found; closed-port check passed" }
  exit 0
}

$form = [Windows.Forms.Form]@{
  Text = "Axis Matriks Koprusu"
  ClientSize = [Drawing.Size]::new(620, 560)
  StartPosition = "CenterScreen"
  FormBorderStyle = "FixedSingle"
  MaximizeBox = $false
  BackColor = [Drawing.Color]::FromArgb(18, 18, 20)
  ForeColor = [Drawing.Color]::White
  Font = [Drawing.Font]::new("Segoe UI", 10)
}

$title = [Windows.Forms.Label]@{
  Text = "AXIS  /  MATRIKS KOPRUSU"
  Location = [Drawing.Point]::new(22, 18)
  AutoSize = $true
  Font = [Drawing.Font]::new("Segoe UI Semibold", 16)
}
$form.Controls.Add($title)

$updated = [Windows.Forms.Label]@{
  Text = "Durum kontrol ediliyor..."
  Location = [Drawing.Point]::new(25, 52)
  AutoSize = $true
  ForeColor = [Drawing.Color]::Gray
}
$form.Controls.Add($updated)

$statusLabels = @{}
$statusNames = [ordered]@{
  matriks = "MatriksIQ"
  bridge = "Veri koprusu"
  dde = "Canli veri (RTD)"
  api = "Emir API"
  server = "Sunucu baglantisi"
}
$y = 86
foreach ($key in $statusNames.Keys) {
  $name = [Windows.Forms.Label]@{
    Text = $statusNames[$key]
    Location = [Drawing.Point]::new(26, $y)
    Size = [Drawing.Size]::new(300, 24)
  }
  $state = [Windows.Forms.Label]@{
    Text = "KAPALI"
    TextAlign = "MiddleRight"
    Location = [Drawing.Point]::new(440, $y)
    Size = [Drawing.Size]::new(150, 24)
    Font = [Drawing.Font]::new("Segoe UI Semibold", 9)
    ForeColor = [Drawing.Color]::Tomato
  }
  $form.Controls.AddRange(@($name, $state))
  $statusLabels[$key] = $state
  $y += 30
}

function New-Button([string]$Text, [int]$X, [int]$Width) {
  $button = [Windows.Forms.Button]@{
    Text = $Text
    Location = [Drawing.Point]::new($X, 247)
    Size = [Drawing.Size]::new($Width, 38)
    FlatStyle = "Flat"
    BackColor = [Drawing.Color]::FromArgb(38, 38, 42)
    ForeColor = [Drawing.Color]::White
    Cursor = [Windows.Forms.Cursors]::Hand
  }
  $button.FlatAppearance.BorderColor = [Drawing.Color]::FromArgb(70, 70, 76)
  $form.Controls.Add($button)
  $button
}

$startButton = New-Button "Baslat" 25 100
$stopButton = New-Button "Durdur" 135 100
$restartButton = New-Button "Yeniden baslat" 245 130
$logButton = New-Button "Log" 385 90
$updateButton = New-Button "Guncelle" 485 105

$autoStart = [Windows.Forms.CheckBox]@{
  Text = "Windows acilinca otomatik baslat"
  Location = [Drawing.Point]::new(27, 300)
  Size = [Drawing.Size]::new(310, 26)
  ForeColor = [Drawing.Color]::White
}
$form.Controls.Add($autoStart)

$logBox = [Windows.Forms.RichTextBox]@{
  Location = [Drawing.Point]::new(25, 340)
  Size = [Drawing.Size]::new(565, 190)
  ReadOnly = $true
  BackColor = [Drawing.Color]::FromArgb(8, 8, 9)
  ForeColor = [Drawing.Color]::Gainsboro
  BorderStyle = "FixedSingle"
  Font = [Drawing.Font]::new("Consolas", 8.5)
  DetectUrls = $false
}
$form.Controls.Add($logBox)

$script:updating = $false
function Set-State([string]$Key, [bool]$On, [string]$OnText = "ACIK") {
  $statusLabels[$Key].Text = $(if ($On) { $OnText } else { "KAPALI" })
  $statusLabels[$Key].ForeColor = $(if ($On) { [Drawing.Color]::MediumSpringGreen } else { [Drawing.Color]::Tomato })
}

function Refresh-Status {
  try {
    $owned = Get-OwnedProcesses
    Set-State "matriks" ([bool](Get-Process -Name MatriksIQ -ErrorAction SilentlyContinue)) "CALISIYOR"
    Set-State "bridge" ([bool]($owned | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match [regex]::Escape($agent) })) "CALISIYOR"
    Set-State "dde" (Test-LocalPort 8948) "BAGLI"
    Set-State "api" (Test-LocalPort 18890) "BAGLI"
    $serverStatus = $null
    $serverStatusReadable = $true
    if (Test-Path -LiteralPath $serverStatusFile) {
      try { $serverStatus = Get-Content -LiteralPath $serverStatusFile -Raw -Encoding UTF8 | ConvertFrom-Json }
      catch { $serverStatusReadable = $false }
    }
    $serverFresh = $serverStatus -and $serverStatus.lastSuccessAt -and
      (([DateTime]::UtcNow - [DateTime]::Parse($serverStatus.lastSuccessAt).ToUniversalTime()).TotalSeconds -lt 20)
    if (-not $serverStatusReadable) {
      # Keep the last visible state if a write is caught between truncate and flush.
    } elseif ($serverFresh -and $serverStatus.active) {
      Set-State "server" $true "AKTIF"
    } elseif ($serverFresh) {
      $statusLabels.server.Text = "YEDEK"
      $statusLabels.server.ForeColor = [Drawing.Color]::Gold
    } else {
      Set-State "server" $false
    }
    $script:updating = $true
    $autoStart.Checked = [bool](Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
    $updateButton.Enabled = (Test-Path -LiteralPath $updateFile) -and (Test-Path -LiteralPath $updater)
    $script:updating = $false
    if (Test-Path -LiteralPath $log) {
      $lines = @(Get-Content -LiteralPath $log -Encoding UTF8 -Tail 60 -ErrorAction SilentlyContinue)
      $logBox.Text = ($lines -join "`r`n") + "`r`n`r`n"
      $logBox.SelectionStart = $logBox.TextLength
      $logBox.ScrollToCaret()
    }
    $updated.Text = "Son kontrol: $(Get-Date -Format 'HH:mm:ss')"
  } catch {
    $updated.Text = "Kontrol hatasi: $($_.Exception.Message)"
  }
}

$startButton.Add_Click({ Start-Bridge; Start-Sleep -Milliseconds 400; Refresh-Status })
$stopButton.Add_Click({ Stop-Bridge; Start-Sleep -Milliseconds 300; Refresh-Status })
$restartButton.Add_Click({ Stop-Bridge; Start-Sleep -Milliseconds 500; Start-Bridge; Refresh-Status })
$logButton.Add_Click({
  if (Test-Path -LiteralPath $log) { Start-Process notepad.exe -ArgumentList "`"$log`"" }
})
$updateButton.Add_Click({
  if (-not $updateButton.Enabled) { return }
  Start-Process -FilePath $powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$updater`" -ProjectRoot `"$ProjectRoot`"" -WorkingDirectory $ProjectRoot
  $form.Close()
})
$autoStart.Add_CheckedChanged({
  if ($script:updating) { return }
  try {
    if ($autoStart.Checked) {
      & $installScript -TaskName $taskName | Out-Null
    } else {
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    }
  } catch {
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, "Axis Matriks", "OK", "Error") | Out-Null
    Refresh-Status
  }
})

$timer = [Windows.Forms.Timer]@{ Interval = 3000 }
$timer.Add_Tick({ Refresh-Status })
$form.Add_Shown({
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    try { & $installScript -TaskName $taskName | Out-Null } catch { $updated.Text = "Baslangic gorevi hatasi: $($_.Exception.Message)" }
  }
  if (-not (Get-OwnedProcesses | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match [regex]::Escape($agent) })) { Start-Bridge }
  Refresh-Status
  $timer.Start()
})
$form.Add_FormClosed({ $timer.Stop(); $timer.Dispose() })
[Windows.Forms.Application]::Run($form)
