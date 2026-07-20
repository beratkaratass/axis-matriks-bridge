param([string]$TaskName = "Axis Matriks Bridge", [switch]$Check)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$uiScript = Join-Path $root "local-windows\Axis-Matriks-Bridge.ps1"
$launcher = Join-Path $root "local-windows\Axis-Matriks-Bridge.vbs"
$envFile = Join-Path $root ".env.matriks"
if (-not (Test-Path $envFile)) { throw "Create $envFile before installing the bridge" }
if (-not (Test-Path $uiScript)) { throw "Bridge UI is missing: $uiScript" }
$settings = ConvertFrom-StringData (Get-Content $envFile -Raw)
if (-not $settings["MATRIKS_SERVER_URL"]) { throw "MATRIKS_SERVER_URL is missing from .env.matriks" }
if (-not $settings["MATRIKS_AGENT_TOKEN"] -or $settings["MATRIKS_AGENT_TOKEN"].Length -lt 32) { throw "MATRIKS_AGENT_TOKEN must be at least 32 characters" }
if ($Check) { Write-Output "Bridge configuration check OK"; exit 0 }

$launcherText = @'
Option Explicit
Dim shell, fso, scriptDir, projectRoot, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDir)
shell.CurrentDirectory = projectRoot
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "\Axis-Matriks-Bridge.ps1"""
shell.Run command, 0, False
'@
[IO.File]::WriteAllText($launcher, $launcherText, [Text.Encoding]::ASCII)

$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "`"$launcher`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $taskSettings -Description "MatriksIQ API and DDE bridge to Axis" -Force | Out-Null
Write-Host "Installed '$TaskName'. The UI will open at logon and start the bridge."
