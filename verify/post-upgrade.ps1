# Codex 自动升级之后的自检（约 40 秒）。
#
#   powershell -ExecutionPolicy Bypass -File verify\post-upgrade.ps1
#
# 只跑最容易被 Codex 上游 DOM/入口变化打破的几项；完整回归用 verify\run-all.ps1。
# 这三类问题在 P12 之前都出过：仪表盘入口搬家、切换会话底栏消失、空对话误报故障。

param(
  [switch]$SkipLive
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONIOENCODING = 'utf-8'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$verify = Join-Path $root 'verify'
$installed = Join-Path $env:USERPROFILE '.codex-bar'
$healthFile = Join-Path $installed 'health.json'

$py = (Get-Command python -ErrorAction SilentlyContinue).Source
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $py) { throw '找不到 python' }
if (-not $node) { throw '找不到 node' }

$script:total = 0
$script:failed = 0
function Check($name, [scriptblock]$body) {
  $script:total++
  try {
    $ok = & $body
    if ($ok) {
      Write-Host "  PASS  $name"
    } else {
      $script:failed++
      Write-Host "  FAIL  $name" -ForegroundColor Red
    }
  } catch {
    $script:failed++
    $msg = $_.Exception.Message.Split([Environment]::NewLine)[0]
    Write-Host "  FAIL  $name  -> $msg" -ForegroundColor Red
  }
}

# ---- 0. 版本提示（不是失败项，但升级排查先看这里）----
Write-Host ''
Write-Host '== 版本' -ForegroundColor Cyan
try {
  $current = (Get-AppxPackage -Name OpenAI.Codex).Version
} catch { $current = '(读不到)' }
$installer = Join-Path $root 'tools\install.ps1'
$verified = if (Test-Path $installer) {
  (Select-String -Path $installer -Pattern "26\.\d+\.\d+\.\d+" -AllMatches).Matches[0].Value
} else { '(未知)' }
$build = if (Test-Path (Join-Path $installed 'injected.js')) {
  (Select-String -Path (Join-Path $installed 'injected.js') -Pattern "const BUILD = '([^']+)'" -AllMatches).Matches[0].Groups[1].Value
} else { '(未安装)' }
Write-Host "  Codex 当前版本 : $current"
Write-Host "  开发时验证版本 : $verified"
Write-Host "  底栏构建       : $build"
if ($current -ne $verified) {
  Write-Host '  [注意] Codex 版本与验证版本不同，底栏/面板可能因页面结构变化失效，请看下面的检查结果。' -ForegroundColor Yellow
}

# 调试端口决定后面两项能否跑
$cdpUp = $false
foreach ($probe in @('http://127.0.0.1:9223', 'http://[::1]:9223')) {
  try { $null = Invoke-RestMethod "$probe/json/version" -TimeoutSec 2; $cdpUp = $true; break } catch { }
}
Write-Host ''
if (-not $cdpUp) {
  Write-Host '  调试端口 9223 未打开：请完全退出 Codex，用桌面「ChatGPT 仪表盘」快捷方式启动。' -ForegroundColor Yellow
  if (-not $SkipLive) { Write-Host '  （依赖实时页面的检查会跳过）' -ForegroundColor Yellow }
}

Write-Host ''
Write-Host '== 检查' -ForegroundColor Cyan

Check 'health.json 合法，且底栏构建与安装目录一致' {
  if (-not (Test-Path $healthFile)) { Write-Host '        -> 没有 health.json（注入器没跑过）'; return $false }
  $h = Get-Content $healthFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $names = $h.PSObject.Properties.Name
  $okShape = ($names -contains 'state') -and ($names -contains 'missingAnchors') -and ($names -contains 'build')
  $okState = $h.state -in @('ok', 'empty', 'starting', 'no-anchor', 'error')
  $okBuild = $h.build -eq $build
  if (-not ($okShape -and $okState -and $okBuild)) {
    Write-Host "        -> state=$($h.state) build=$($h.build)（安装版 $build）"
  }
  $okShape -and $okState -and $okBuild
}

Check '注入器单实例在运行' {
  $n = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'injector\.js' }).Count
  if ($n -ne 1) { Write-Host "        -> 注入器进程数 $n（应为 1）"; return $false }
  $true
}

if ($SkipLive -or -not $cdpUp) {
  Write-Host '  SKIP  实时页面检查（-SkipLive 或调试端口未打开）'
} else {
  Check '仪表盘按钮：能打开/关闭，且入口找不到时给出可见提示' {
    & $node (Join-Path $verify 'dashboard-button.js')
    $LASTEXITCODE -eq 0
  }

  Check '切换会话后底栏仍在（缓存编辑器回归）' {
    & $py (Join-Path $verify 'bar-switch.py')
    $LASTEXITCODE -eq 0
  }
}

Write-Host ''
Write-Host ('=' * 56)
if ($script:failed -eq 0) {
  Write-Host "升级后自检通过：$($script:total) 项" -ForegroundColor Green
  Write-Host '如需完整验证，跑 verify\run-all.ps1'
} else {
  Write-Host "$($script:failed)/$($script:total) 项失败——Codex 可能改了页面结构，先看 bar.log 的 dashboard/health 行" -ForegroundColor Red
}
Write-Host ('=' * 56)
exit $script:failed
