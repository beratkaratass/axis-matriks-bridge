param([string]$TaskName = "Axis Matriks Bridge", [switch]$Check)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot "start-matriks-bridge.ps1"
$envFile = Join-Path $root ".env.matriks"
if (-not (Test-Path $envFile)) { throw "Create $envFile before installing the bridge" }
$settings = ConvertFrom-StringData (Get-Content $envFile -Raw)
if (-not $settings["MATRIKS_SERVER_URL"]) { throw "MATRIKS_SERVER_URL is missing from .env.matriks" }
if (-not $settings["MATRIKS_AGENT_TOKEN"] -or $settings["MATRIKS_AGENT_TOKEN"].Length -lt 32) { throw "MATRIKS_AGENT_TOKEN must be at least 32 characters" }
if ($Check) { Write-Output "Bridge configuration check OK"; exit 0 }

$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $taskSettings -Description "MatriksIQ API and DDE bridge to Axis" -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed and started '$TaskName'. It will run at logon, launch MatriksIQ, and connect the bridge."
