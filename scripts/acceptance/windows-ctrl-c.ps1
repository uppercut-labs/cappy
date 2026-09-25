# Windows acceptance: a console Ctrl+C cancels `cappy record` cleanly.
#
# Run from an interactive console (Windows Terminal or a console window), not
# over SSH: processes started under SSH inherit an "ignore Ctrl+C" attribute
# that Node does not clear. Requires `npm run build` first.
#
#   pwsh -NoProfile -File scripts/acceptance/windows-ctrl-c.ps1
#
# Expected: exit code 130, error OPERATION_CANCELLED, session status cancelled,
# and no Cappy or simulator processes left running.
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class CappyCtrl {
  [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
  [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
}
"@
$repo = (Resolve-Path "$PSScriptRoot\..\..").Path
$node = (Get-Command node).Source
$project = Join-Path ([IO.Path]::GetTempPath()) ("cappy-ctrl-c-" + [Guid]::NewGuid())
New-Item -ItemType Directory $project | Out-Null
@{
  schemaVersion = 1
  project = @{ id = "ctrl-c"; name = "Ctrl+C acceptance" }
  game = @{ command = $node; args = @("$repo\fixtures\adapter-simulator\dist\bin.js") }
  adapter = @{ port = 0 }
} | ConvertTo-Json -Depth 5 | Set-Content "$project\cappy.config.json"

$start = [Diagnostics.ProcessStartInfo]::new($node)
foreach ($argument in "$repo\packages\cli\dist\bin.js", "record", "--json", "-C", $project) { $start.ArgumentList.Add($argument) }
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$cappy = [Diagnostics.Process]::Start($start)
$stdout = $cappy.StandardOutput.ReadToEndAsync()
for ($i = 0; $i -lt 50 -and -not (Test-Path "$project\.cappy\sessions\*\session.json"); $i++) { Start-Sleep -Milliseconds 200 }
Start-Sleep -Milliseconds 700

# Ignore Ctrl+C in this shell only now, so Cappy does not inherit the setting,
# then deliver it to every process on the console.
[CappyCtrl]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
[CappyCtrl]::GenerateConsoleCtrlEvent(0, 0) | Out-Null

$failures = @()
if (-not $cappy.WaitForExit(15000)) { $failures += "cappy did not exit within 15 s"; $cappy.Kill($true) }
elseif ($cappy.ExitCode -ne 130) { $failures += "exit code $($cappy.ExitCode), expected 130" }
if ($cappy.HasExited) {
  $result = $stdout.Result | ConvertFrom-Json
  if ($result.error.code -ne "OPERATION_CANCELLED") { $failures += "error $($result.error.code), expected OPERATION_CANCELLED" }
  if ($result.data.session.status -ne "cancelled") { $failures += "session $($result.data.session.status), expected cancelled" }
}
Start-Sleep 1
$leftover = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$project*" -or $_.CommandLine -like "*adapter-simulator*" }
if ($leftover) { $failures += "$(@($leftover).Count) process(es) left running"; $leftover | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
Remove-Item $project -Recurse -Force -ErrorAction SilentlyContinue

[CappyCtrl]::SetConsoleCtrlHandler([IntPtr]::Zero, $false) | Out-Null
if ($failures.Count -gt 0) { Write-Output ("FAIL: " + ($failures -join "; ")); exit 1 }
Write-Output "PASS: Ctrl+C cancelled the recording (exit 130, session cancelled, no processes left)"
