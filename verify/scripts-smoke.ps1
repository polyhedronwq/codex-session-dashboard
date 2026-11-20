# 用户脚本冒烟：这些是用户会直接双击的东西，之前零测试。
#
#   powershell -ExecutionPolicy Bypass -File verify\scripts-smoke.ps1
#   ... -Full      额外跑破坏性检查（停/起注入器、连装两次、卸载残留）
#
# 默认只做可安全回滚的检查，不会打断正在使用的底栏。

param([switch]$Full)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$installed = Join-Path $env:USERPROFILE '.codex-bar'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcut = Join-Path $desktop 'ChatGPT 仪表盘.lnk'

$script:total = 0
$script:failed = 0

function Test-Item($name, [scriptblock]$body) {
  $script:total++
  try {
    $ok = & $body
    if ($ok) { Write-Host "  PASS  $name" }
    else { $script:failed++; Write-Host "  FAIL  $name" -ForegroundColor Red }
  } catch {
    $script:failed++
    $msg = $_.Exception.Message.Split([Environment]::NewLine)[0]
    Write-Host "  FAIL  $name  -> $msg" -ForegroundColor Red
  }
}

# 前置：必须处于已安装状态，否则下面测的是"不存在的功能"
if (-not (Test-Path (Join-Path $installed 'injected.js'))) {
  Write-Host '  FAIL  未安装（先运行 install.ps1），无法检查用户脚本' -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------- 诊断脚本
Test-Item 'diagnose.ps1 能生成报告' {
  $out = Join-Path $env:TEMP 'dsh-diagnose-test.txt'
  Remove-Item $out -Force -ErrorAction SilentlyContinue
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installed 'diagnose.ps1') -Out $out 2>&1 | Out-Null
  if (-not (Test-Path $out)) { return $false }
  $text = Get-Content $out -Raw -Encoding UTF8
  $size = (Get-Item $out).Length
  Remove-Item $out -Force -ErrorAction SilentlyContinue
  ($size -gt 500) -and ($text -match 'health|injector|9223')
}

# ---------------------------------------------------------------- 图标切换（往返）
Test-Item 'switch-icon.ps1 黑白往返' {
  if (-not (Test-Path $shortcut)) { return $false }
  $ws = New-Object -ComObject WScript.Shell
  $before = $ws.CreateShortcut($shortcut).IconLocation
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installed 'switch-icon.ps1') -Variant black 2>&1 | Out-Null
  $black = $ws.CreateShortcut($shortcut).IconLocation
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installed 'switch-icon.ps1') -Variant white 2>&1 | Out-Null
  $after = $ws.CreateShortcut($shortcut).IconLocation
  $okBlack = $black -match 'chatgpt-black\.ico'
  $okBack = $after -match 'chatgpt-white\.ico'
  if (-not ($okBlack -and $okBack)) {
    Write-Host "        -> before=$before black=$black after=$after"
    return $false
  }
  $before -eq $after
}

# ---------------------------------------------------------------- 窗口监视器
Test-Item 'watch-windows.ps1 起得来、stop-watch.cmd 停得掉' {
  $pidFile = Join-Path $installed 'watch.pid'
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  $proc = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $installed 'watch-windows.ps1') `
    -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 3
  if (-not (Test-Path $pidFile)) { $proc | Stop-Process -Force -ErrorAction SilentlyContinue; return $false }
  $watcherPid = [int]((Get-Content $pidFile -Raw).Trim())
  $alive = $null -ne (Get-Process -Id $watcherPid -ErrorAction SilentlyContinue)
  & "$env:WINDIR\System32\cmd.exe" /c (Join-Path $installed 'stop-watch.cmd') 2>&1 | Out-Null
  Start-Sleep -Seconds 2
  $stillAlive = $null -ne (Get-Process -Id $watcherPid -ErrorAction SilentlyContinue)
  $proc | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  if (-not $alive) { Write-Host "        -> pid 文件写了但进程不在" }
  $alive -and -not $stillAlive
}

# ---------------------------------------------------------------- 构建 -NoMirror
Test-Item 'build.ps1 -NoMirror 只出 dist，不改安装目录' {
  # 不能用修改时间判断：Copy-Item 会保留源文件的 LastWriteTime，
  # 所以在安装目录里放一个内容标记，被镜像覆盖就会消失。
  $target = Join-Path $installed 'injected.js'
  if (-not (Test-Path $target)) { return $false }
  # 必须按字节备份/还原：用 Set-Content 会把 BOM 写进去，污染安装目录
  $backupBytes = [System.IO.File]::ReadAllBytes($target)
  $marker = '/* dsh-nomirror-marker */'
  try {
    $text = [System.IO.File]::ReadAllText($target, [System.Text.Encoding]::UTF8)
    [System.IO.File]::WriteAllText($target, $text + "`n" + $marker, (New-Object System.Text.UTF8Encoding($false)))
    Start-Sleep -Milliseconds 300
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'build.ps1') -NoMirror 2>&1 | Out-Null
    $after = [System.IO.File]::ReadAllText($target, [System.Text.Encoding]::UTF8)
    $distBuilt = Test-Path (Join-Path $root 'dist\manifest.json')
    if (-not ($after -like "*$marker*")) {
      Write-Host '        -> 安装目录被 -NoMirror 覆盖了'
    }
    $distBuilt -and ($after -like "*$marker*")
  } finally {
    [System.IO.File]::WriteAllBytes($target, $backupBytes)
  }
}

Test-Item '快捷方式内容正确（wscript + launch.vbs + 图标）' {
  if (-not (Test-Path $shortcut)) { return $false }
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($shortcut)
  $targetOk = $sc.TargetPath -match 'wscript\.exe$'
  $argsOk = $sc.Arguments -match 'launch\.vbs'
  $iconOk = (Test-Path ($sc.IconLocation -replace ',\d+$', ''))
  if (-not ($targetOk -and $argsOk -and $iconOk)) {
    Write-Host "        -> target=$($sc.TargetPath) args=$($sc.Arguments) icon=$($sc.IconLocation)"
  }
  $targetOk -and $argsOk -and $iconOk
}

# ---------------------------------------------------------------- 破坏性检查
if ($Full) {
  Test-Item 'stop-bar.ps1 停止注入器，随后能重新拉起' {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installed 'stop-bar.ps1') 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    $stopped = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -match 'injector\.js' }).Count -eq 0
    Start-Process -FilePath "$env:WINDIR\System32\wscript.exe" `
      -ArgumentList '//nologo', (Join-Path $installed 'injector-only.vbs') -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 8
    $restarted = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -match 'injector\.js' }).Count -eq 1
    $stopped -and $restarted
  }

  Test-Item '连装两次不重复注册' {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'share\install.ps1') -Yes 2>&1 | Out-Null
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'share\install.ps1') -Yes 2>&1 | Out-Null
    $config = Join-Path $env:USERPROFILE '.codex\config.toml'
    $text = Get-Content $config -Raw -Encoding UTF8
    $markets = ([regex]::Matches($text, '\[marketplaces\.codex-dashboard-local\]')).Count
    $plugins = ([regex]::Matches($text, '\[plugins\."session-dashboard@codex-dashboard-local"\]')).Count
    if (-not ($markets -eq 1 -and $plugins -eq 1)) {
      Write-Host "        -> 市场段 $markets 次、插件段 $plugins 次"
    }
    $markets -eq 1 -and $plugins -eq 1
  }

  Test-Item '卸载后无残留，重装后恢复' {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'share\uninstall.ps1') 2>&1 | Out-Null
    $uninstallOk = $LASTEXITCODE -eq 0
    $residue = (Test-Path $installed) -or (Test-Path $shortcut)
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'share\install.ps1') -Yes 2>&1 | Out-Null
    Start-Sleep -Seconds 6
    $restored = Test-Path (Join-Path $installed 'injected.js')
    if (-not ($uninstallOk -and -not $residue -and $restored)) {
      Write-Host "        -> 卸载退出=$LASTEXITCODE 残留=$residue 重装=$restored"
    }
    $uninstallOk -and (-not $residue) -and $restored
  }
}

Write-Host ''
if ($script:failed -eq 0) {
  Write-Host "用户脚本: $($script:total) 项全过" -ForegroundColor Green
} else {
  Write-Host "用户脚本: $($script:failed)/$($script:total) 失败" -ForegroundColor Red
}
exit $script:failed
