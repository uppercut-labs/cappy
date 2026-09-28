# Verify the installed executable's Windows Ctrl+C handler in a fresh console.
# A fresh console and an enabled handler avoid SSH's inherited ignore-Ctrl+C flag.
param(
  [Parameter(Mandatory = $true)][string]$EntryPoint,
  [Parameter(Mandatory = $true)][string]$Simulator
)
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CappyPackageConsole {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AllocConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint control, uint group);
}
"@
$EntryPoint = (Resolve-Path $EntryPoint).Path
$Simulator = (Resolve-Path $Simulator).Path
$node = (Get-Command node).Source
$project = Join-Path ([IO.Path]::GetTempPath()) ("cappy-package-ctrl-c-" + [Guid]::NewGuid())
New-Item -ItemType Directory $project | Out-Null
@{
  schemaVersion = 1
  project = @{ id = "package-ctrl-c"; name = "Installed package Ctrl+C" }
  game = @{ command = $node; args = @($Simulator) }
  adapter = @{ port = 0 }
} | ConvertTo-Json -Depth 5 | Set-Content "$project\cappy.config.json"
$cappy = $null
$gameIds = @()
try {
  [CappyPackageConsole]::FreeConsole() | Out-Null
  if (-not [CappyPackageConsole]::AllocConsole()) { throw "Could not allocate a Windows console" }
  if (-not [CappyPackageConsole]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)) { throw "Could not enable Ctrl+C handling" }

  $arguments = @($EntryPoint, "record", "--json", "-C", $project)
  if ($arguments | Where-Object { $_.Contains('"') }) { throw "Test paths cannot contain quotes" }
  $start = [Diagnostics.ProcessStartInfo]::new($node)
  $start.Arguments = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $cappy = [Diagnostics.Process]::Start($start)
  $stdout = $cappy.StandardOutput.ReadToEndAsync()
  $stderr = $cappy.StandardError.ReadToEndAsync()
  $active = $false
  for ($i = 0; $i -lt 50; $i++) {
    if ($cappy.HasExited) { throw "Installed Cappy exited before recording: $($stderr.Result)" }
    $sessions = Get-ChildItem "$project\.cappy\sessions\*\session.json" -ErrorAction SilentlyContinue
    if ($sessions) { $active = $true; break }
    Start-Sleep -Milliseconds 200
  }
  if (-not $active) { throw "Installed Cappy did not create a recording session" }
  Start-Sleep -Milliseconds 700
  $gameIds = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $cappy.Id } | ForEach-Object { $_.ProcessId })
  if ($gameIds.Count -eq 0) { throw "No simulator child was observed during the recording" }

  # Ignore the generated event in this harness after the child inherited handling.
  if (-not [CappyPackageConsole]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)) { throw "Could not protect the test harness" }
  if (-not [CappyPackageConsole]::GenerateConsoleCtrlEvent(0, 0)) { throw "Could not deliver the console Ctrl+C event" }
  if (-not $cappy.WaitForExit(15000)) { throw "Installed Cappy did not exit after Ctrl+C" }
  if ($cappy.ExitCode -ne 130) { throw "Exit $($cappy.ExitCode), expected 130; $($stderr.Result)" }
  $result = $stdout.Result | ConvertFrom-Json
  if ($result.error.code -ne "OPERATION_CANCELLED" -or $result.data.session.status -ne "cancelled") {
    throw "Installed Cappy did not persist a cancelled session"
  }
  Start-Sleep -Milliseconds 500
  $leftover = @(Get-Process -Id $gameIds -ErrorAction SilentlyContinue)
  if ($leftover.Count -gt 0) { throw "Simulator processes remained after cancellation" }
  Write-Output "PASS: installed executable handled Windows console Ctrl+C (exit 130, cancelled session, no simulator processes left)"
} finally {
  if ($cappy -and -not $cappy.HasExited) { Stop-Process -Id $cappy.Id -Force }
  foreach ($gameId in $gameIds) {
    $remaining = Get-Process -Id $gameId -ErrorAction SilentlyContinue
    if ($remaining) { Stop-Process -Id $gameId -Force }
  }
  [CappyPackageConsole]::FreeConsole() | Out-Null
  Remove-Item $project -Recurse -Force
}
