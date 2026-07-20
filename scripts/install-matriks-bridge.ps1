param([string]$TaskName = "Axis Matriks Bridge", [switch]$Check)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$uiScript = Join-Path $root "local-windows\Axis-Matriks-Bridge.ps1"
$launcher = Join-Path $root "local-windows\Axis-Matriks-Bridge.exe"
$legacyLauncher = Join-Path $root "local-windows\Axis-Matriks-Bridge.vbs"
$envFile = Join-Path $root ".env.matriks"
if (-not (Test-Path $envFile)) { throw "Create $envFile before installing the bridge" }
if (-not (Test-Path $uiScript)) { throw "Bridge UI is missing: $uiScript" }
$settings = ConvertFrom-StringData (Get-Content $envFile -Raw)
if (-not $settings["MATRIKS_SERVER_URL"]) { throw "MATRIKS_SERVER_URL is missing from .env.matriks" }
if (-not $settings["MATRIKS_AGENT_TOKEN"] -or $settings["MATRIKS_AGENT_TOKEN"].Length -lt 32) { throw "MATRIKS_AGENT_TOKEN must be at least 32 characters" }
if ($Check) { Write-Output "Bridge configuration check OK"; exit 0 }

$launcherSource = @'
using System;
using System.Diagnostics;
using System.IO;

internal static class Program {
  [STAThread]
  private static void Main() {
    var directory = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    var start = new ProcessStartInfo {
      FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
      Arguments = "-NoProfile -Sta -ExecutionPolicy Bypass -File \"" + Path.Combine(directory, "Axis-Matriks-Bridge.ps1") + "\"",
      WorkingDirectory = Directory.GetParent(directory).FullName,
      UseShellExecute = false,
      CreateNoWindow = true
    };
    Process.Start(start);
  }
}
'@
Remove-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue
Add-Type -TypeDefinition $launcherSource -Language CSharp -OutputAssembly $launcher -OutputType WindowsApplication
[IO.File]::WriteAllText($legacyLauncher, "CreateObject(`"WScript.Shell`").Run `"`"`"$launcher`"`"`", 1, False", [Text.Encoding]::ASCII)

$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $launcher -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $taskSettings -Description "MatriksIQ API and DDE bridge to Axis" -Force | Out-Null
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Desktop")) "Axis Matriks.lnk"))
$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $root
$shortcut.Save()
Write-Host "Installed '$TaskName'. The UI will open at logon and start the bridge."
