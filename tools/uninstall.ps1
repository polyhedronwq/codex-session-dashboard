# 一键回滚：撤销 install.ps1 所做的一切，并在结束时自检有无残留。
#
#   uninstall.cmd
#   uninstall.ps1 -KeepFiles      只停进程、留文件
#   uninstall.ps1 -RestorePrevious  还原安装前的底栏文件

param(
  [switch]$KeepFiles,
  [switch]$RestorePrevious
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$barDir = Join-Path $env:USERPROFILE '.codex-bar'
$manifestPath = Join-Path $barDir '.install-manifest.json'
$configPath = Join-Path $env:USERPROFILE '.codex\config.toml'

function Say($t) { Write-Host "  $t" }
function Step($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }

if (-not (Test-Path $manifestPath)) {
  Write-Host '找不到安装记录（.install-manifest.json），无法确认该撤销什么。' -ForegroundColor Yellow
  Write-Host "可手动删除：$barDir；桌面/开始菜单的「ChatGPT 仪表盘」快捷方式"
  exit 1
}

$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

Step '1/5 停止进程'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'injector\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Say "注入器 $($_.ProcessId)" }
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'session-dashboard.*server\.py|bar_metrics\.py' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Say "面板服务 $($_.ProcessId)" }

Step '2/5 删除快捷方式'
foreach ($link in @($manifest.shortcuts)) {
  if ($link -and (Test-Path $link)) { Remove-Item $link -Force -ErrorAction SilentlyContinue; Say $link }
}

Step '3/5 还原 Codex 配置'
$restored = $false
if ($manifest.configBackup -and (Test-Path $manifest.configBackup)) {
  Copy-Item $manifest.configBackup $configPath -Force
  Say "已用备份还原: $($manifest.configBackup)"
  $restored = $true
}
# 备份里可能已包含我们写入的段落（重复安装时），所以再剥一次
if (Test-Path $configPath) {
  $lines = Get-Content $configPath -Encoding UTF8
  $out = New-Object System.Collections.Generic.List[string]
  $skipping = $false
  foreach ($line in $lines) {
    if ($line -match '^\s*\[') {
      $skipping = ($line -eq '[marketplaces.codex-dashboard-local]') -or
                  ($line -eq '[plugins."session-dashboard@codex-dashboard-local"]')
      if ($skipping) { continue }
    }
    if (-not $skipping) { $out.Add($line) }
  }
  [System.IO.File]::WriteAllLines($configPath, [string[]]$out.ToArray(), (New-Object System.Text.UTF8Encoding($false)))
  Say '已移除安装时写入的配置段'
}

Step '4/5 删除文件'
if ($KeepFiles) {
  Say '按参数保留文件（-KeepFiles）'
} else {
  $restoreFiles = @()
  if ($RestorePrevious -and $manifest.backupDir) {
    $candidate = Join-Path $manifest.backupDir 'codex-bar-old'
    if (Test-Path $candidate) { $restoreFiles = @(Get-ChildItem $candidate -File -ErrorAction SilentlyContinue) }
  }
  if ($manifest.marketDir -and (Test-Path $manifest.marketDir)) {
    Remove-Item $manifest.marketDir -Recurse -Force -ErrorAction SilentlyContinue
    Say "删除插件 $($manifest.marketDir)"
  }
  Get-ChildItem $barDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch '^\.install-manifest' } |
    ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
  # 备份目录：新版是 .backup-<ts>，旧版是 backup-<ts>，两种都要清
  Get-ChildItem $barDir -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\.?backup-' -or $_.Name -eq '__pycache__' } |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  Get-ChildItem $barDir -Recurse -Force -Include '__pycache__', '*.pyc' -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($f in $restoreFiles) { Copy-Item $f.FullName (Join-Path $barDir $f.Name) -Force }
  if ($restoreFiles.Count -gt 0) { Say "已还原安装前的 $($restoreFiles.Count) 个文件" }
  Remove-Item $manifestPath -Force -ErrorAction SilentlyContinue
  # 清完文件后把空目录也删掉：自检说"无残留"，用户看到还在就更困惑
  if (Test-Path $barDir) {
    $left = @(Get-ChildItem $barDir -Force -ErrorAction SilentlyContinue)
    if ($left.Count -eq 0) {
      Remove-Item $barDir -Force -ErrorAction SilentlyContinue
      Say "底栏目录已删除: $barDir"
    } else {
      Say "底栏目录已清理（保留 $($left.Count) 项运行记录）: $barDir"
    }
  }
}

Step '5/5 残留自检'
$residue = @()

if (-not $KeepFiles) {
  if (Test-Path $barDir) {
    $left = @(Get-ChildItem $barDir -Recurse -Force -ErrorAction SilentlyContinue)
    if ($left.Count -gt 0) { $residue += "底栏目录仍有 $($left.Count) 项" }
  }
  $linkDirs = @([Environment]::GetFolderPath('Desktop'),
                (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))
  foreach ($dir in $linkDirs) {
    $link = Join-Path $dir 'ChatGPT 仪表盘.lnk'
    if (Test-Path $link) { $residue += "快捷方式残留 $link" }
  }
  if (Test-Path $configPath) {
    $cfg = Get-Content $configPath -Raw -Encoding UTF8
    if ($cfg -match 'codex-dashboard-local') { $residue += 'config.toml 仍有插件段落' }
  }
}

$alive = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'injector\.js' })
if ($alive.Count -gt 0) { $residue += "注入器仍在运行 ($($alive.Count))" }

if ($residue.Count -eq 0) {
  Write-Host ''
  Write-Host '回滚完成，无残留。' -ForegroundColor Green
  Write-Host 'Codex 应用本身没有被修改；重启一次 Codex 即可完全回到原状。'
  exit 0
} else {
  Write-Host ''
  Write-Host '回滚完成，但检测到残留：' -ForegroundColor Yellow
  foreach ($r in $residue) { Write-Host "  - $r" -ForegroundColor Yellow }
  exit 1
}
