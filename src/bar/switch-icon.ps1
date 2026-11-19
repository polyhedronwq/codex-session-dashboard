param([string]$Variant = 'white')

$ErrorActionPreference = 'Stop'
$bar = Join-Path $env:USERPROFILE '.codex-bar'
$ico = Join-Path $bar ('chatgpt-{0}.ico' -f $(if ($Variant -eq 'black') { 'black' } else { 'white' }))
if (-not (Test-Path $ico)) { throw "icon not found: $ico" }

$ws = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path $bar 'ChatGPT 仪表盘.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'ChatGPT 仪表盘.lnk'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\ChatGPT 仪表盘.lnk')
)
foreach ($t in $targets) {
  if (-not (Test-Path $t)) { continue }
  $sc = $ws.CreateShortcut($t)
  $sc.IconLocation = "$ico,0"
  $sc.Save()
  Write-Host "updated: $t"
}

& "$env:WINDIR\System32\ie4uinit.exe" -show 2>$null
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DshIconRefresh {
  [DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);
  public static void Go() { SHChangeNotify(0x08000000, 0x1000, IntPtr.Zero, IntPtr.Zero); }
}
'@
[DshIconRefresh]::Go()
Write-Host "done ($Variant). If Explorer still shows the old icon, press F5 on the desktop."
