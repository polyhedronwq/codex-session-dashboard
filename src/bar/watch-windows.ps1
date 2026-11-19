# Watches for Codex windows appearing/disappearing and logs every change with a
# timestamp, so a spontaneous pop-up can be correlated afterwards.
#
# Writes to: %USERPROFILE%\.codex-bar\windows.log
# Stop with: stop-watch.cmd  (or kill the powershell process running this file)

$ErrorActionPreference = 'SilentlyContinue'
$logPath = Join-Path $env:USERPROFILE '.codex-bar\windows.log'
$pidFile = Join-Path $env:USERPROFILE '.codex-bar\watch.pid'
$pid | Set-Content -Path $pidFile -Encoding ASCII

function Write-Entry([string]$message) {
  $line = '[{0}] {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -Path $logPath -Value $line -Encoding UTF8
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public class WinWatch {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  public static List<string> Visible() {
    var list = new List<string>();
    EnumWindows((h, p) => {
      if (IsWindowVisible(h)) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        int len = GetWindowTextLength(h);
        var sb = new StringBuilder(len + 1);
        GetWindowText(h, sb, sb.Capacity);
        if (sb.Length > 0) list.Add(pid + "|" + sb.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@

Write-Entry "watch started (pid $pid)"

$previousWindows = @{}
$previousProcs = @()

while ($true) {
  $procs = @(Get-Process ChatGPT -ErrorAction SilentlyContinue)
  $procIds = @($procs | ForEach-Object { [int]$_.Id })

  $newProcs = @($procIds | Where-Object { $previousProcs -notcontains $_ })
  $goneProcs = @($previousProcs | Where-Object { $procIds -notcontains $_ })
  if ($newProcs.Count -gt 0) {
    $started = @($procs | Where-Object { $newProcs -contains $_.Id } | ForEach-Object { $_.StartTime.ToString('HH:mm:ss') })
    Write-Entry ("processes appeared: " + ($newProcs -join ',') + " (started " + ($started -join ',') + ") total=" + $procs.Count)
  }
  if ($goneProcs.Count -gt 0) {
    Write-Entry ("processes gone: " + ($goneProcs -join ',') + " total=" + $procs.Count)
  }
  $previousProcs = $procIds

  # visible windows owned by Codex processes
  $current = @{}
  foreach ($entry in [WinWatch]::Visible()) {
    $parts = $entry -split '\|', 2
    $ownerPid = [int]$parts[0]
    if ($procIds -contains $ownerPid) {
      $current[$entry] = $true
    }
  }
  foreach ($key in $current.Keys) {
    if (-not $previousWindows.ContainsKey($key)) {
      Write-Entry ("window appeared: " + $key)
    }
  }
  foreach ($key in $previousWindows.Keys) {
    if (-not $current.ContainsKey($key)) {
      Write-Entry ("window gone: " + $key)
    }
  }
  $previousWindows = $current

  Start-Sleep -Milliseconds 1500
}
