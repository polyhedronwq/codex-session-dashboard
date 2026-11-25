# Codex 底栏 + 会话仪表盘 —— 一键安装 / 升级
#
#   install.cmd                     交互式
#   install.ps1 -CheckOnly          只检查，不改任何东西
#   install.ps1 -Yes                跳过确认
#   install.ps1 -Yes -TestHome <目录>  测试用：全部产物装进隔离目录，
#                                    不停止任何服务/进程、不碰调试端口、不碰真实配置与快捷方式、
#                                    不要求已安装 Codex 桌面版（CI 里跑发布包自检用）
#
# 安装根目录：%USERPROFILE%\.codex-bar
#   ├─ *.js / *.vbs / *.py …  底栏
#   └─ plugin-market\          面板插件（Codex 的市场源指向这里）
#
# 包内结构（与本脚本同级）：
#   bar\  plugin-market\  manifest.json  render-paths.ps1

param(
  [switch]$CheckOnly,
  [switch]$Yes,
  [string]$TestHome
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkgBar = Join-Path $here 'bar'
$pkgMarket = Join-Path $here 'plugin-market'
$pkgManifest = Join-Path $here 'manifest.json'
$render = Join-Path $here 'render-paths.ps1'

# -TestHome 是安装器的测试入口：把所有会被写入的位置都改到隔离目录，
# 并使用与"Codex 未运行"相同的等待分支，从而能在临时 HOME 里跑完整装载流程。
$testMode = [bool]$TestHome
if ($testMode) {
  $barDir = Join-Path $TestHome '.codex-bar'
  $marketDir = Join-Path $barDir 'plugin-market'
  $configPath = Join-Path $TestHome '.codex\config.toml'
  $startMenu = Join-Path $TestHome 'StartMenu'
  $desktop = Join-Path $TestHome 'Desktop'
} else {
  $barDir = Join-Path $env:USERPROFILE '.codex-bar'
  $marketDir = Join-Path $barDir 'plugin-market'
  $configPath = Join-Path $env:USERPROFILE '.codex\config.toml'
  $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $desktop = [Environment]::GetFolderPath('Desktop')
}

function Say($t) { Write-Host "  $t" }
function Step($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Bad($t) { Write-Host "  [缺失] $t" -ForegroundColor Yellow }
function Info($t) { Write-Host "  [信息] $t" }

function Find-Node {
  $voltaRoot = "$env:LOCALAPPDATA\Volta\tools\image\node"
  if (Test-Path $voltaRoot) {
    $candidate = Get-ChildItem $voltaRoot -Directory -ErrorAction SilentlyContinue |
      Sort-Object { try { [version]($_.Name -replace '[^0-9.]', '') } catch { [version]'0.0' } } -Descending |
      Select-Object -First 1
    if ($candidate) {
      $real = Join-Path $candidate.FullName 'node.exe'
      if (Test-Path $real) { return $real }
    }
  }
  $plain = "$env:ProgramFiles\nodejs\node.exe"
  if (Test-Path $plain) { return $plain }
  $found = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($found -and $found -notmatch '\\Volta\\node\.exe$') { return $found }
  return $null
}

function Find-Python {
  $cmd = (Get-Command python -ErrorAction SilentlyContinue).Source
  if ($cmd) { return $cmd }
  foreach ($v in @('Python313', 'Python312', 'Python311', 'Python310')) {
    $candidate = Join-Path $env:LOCALAPPDATA "Programs\Python\$v\python.exe"
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

function Ask-Install($what) {
  if ($Yes) { return $true }
  $answer = Read-Host "  要我现在帮你装 $what 吗？[Y/n]"
  return ($answer -eq '' -or $answer -eq 'Y' -or $answer -eq 'y')
}

function Try-Winget($id, $label) {
  $winget = (Get-Command winget -ErrorAction SilentlyContinue).Source
  if (-not $winget) { Bad "$label 需要手动安装（本机没有 winget）"; return }
  Say "正在安装 $label ..."
  & $winget install --id $id --silent --accept-package-agreements --accept-source-agreements | Out-Null
}

# ---------------------------------------------------------------- 包完整性
Step '1/4 校验安装包'

$manifest = $null
if (Test-Path $pkgManifest) {
  $manifest = Get-Content $pkgManifest -Raw -Encoding UTF8 | ConvertFrom-Json
  Say "版本 $($manifest.version) / 构建 $($manifest.build)"
} else {
  Bad '缺少 manifest.json（安装包不完整）'
  exit 1
}

$integrityErrors = @()
$expected = @($manifest.files.PSObject.Properties)
foreach ($entry in $expected) {
  $path = Join-Path $here ($entry.Name -replace '/', '\')
  if (-not (Test-Path $path)) { $integrityErrors += "缺少 $($entry.Name)"; continue }
  $actual = (Get-FileHash $path -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $entry.Value) { $integrityErrors += "哈希不符 $($entry.Name)" }
}
if ($integrityErrors.Count -gt 0) {
  Write-Host ('  包已损坏: ' + ($integrityErrors[0..([Math]::Min(3, $integrityErrors.Count - 1))] -join '; ')) -ForegroundColor Red
  exit 1
}
Ok "$($expected.Count) 个文件哈希校验通过"

# ---------------------------------------------------------------- 环境
Step '2/4 检查运行环境'

$node = Find-Node
$python = Find-Python
$app = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue
$missing = @()

if ($node) { Ok "node      $node" } else { Bad 'node'; $missing += 'node' }
if ($python) { Ok "python    $python" } else { Bad 'python'; $missing += 'python' }
if ($app) {
  Ok ("Codex     " + $app.Version)
  if ($app.Version -ne '26.1120.5083.0') { Info '开发时验证的版本是 26.1120.5083.0，版本不同时注入可能失效' }
} else { Bad 'Codex 桌面版未安装'; $missing += 'codex' }

$installedVersion = $null
$oldManifest = Join-Path $barDir '.install-manifest.json'
if (Test-Path $oldManifest) {
  try { $installedVersion = (Get-Content $oldManifest -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }
}
$isUpgrade = [bool]$installedVersion
if ($isUpgrade) {
  Info "检测到已安装 $installedVersion，本次为升级（整包覆盖，配置与历史不受影响）"
}

if ($CheckOnly) {
  Write-Host ''
  if ($missing.Count -eq 0) { Write-Host '检查完成：依赖齐全，可以安装。' -ForegroundColor Green }
  else { Write-Host ('检查完成：缺少 ' + ($missing -join ', ')) -ForegroundColor Yellow }
  Write-Host '本次为只读检查，未做任何修改。'
  exit 0
}

if ($testMode -and ($missing -contains 'codex')) {
  Info '测试模式：未安装 Codex 桌面版，跳过该检查'
  $missing = @($missing | Where-Object { $_ -ne 'codex' })
}

if ($missing -contains 'codex') {
  Write-Host '没有检测到 Codex 桌面版，无法安装。' -ForegroundColor Red
  exit 1
}

if ($missing.Count -gt 0) {
  if ($testMode) {
    Write-Host ('测试模式缺少依赖: ' + ($missing -join ', ') + '（不做交互安装）') -ForegroundColor Red
    exit 1
  }
  if ($missing -contains 'node' -and (Ask-Install 'Node.js')) { Try-Winget 'OpenJS.NodeJS.LTS' 'Node.js'; $node = Find-Node }
  if ($missing -contains 'python' -and (Ask-Install 'Python 3')) { Try-Winget 'Python.Python.3.12' 'Python 3'; $python = Find-Python }
  if (-not $node -or -not $python) {
    Write-Host '仍有依赖未就绪，请手动安装后重试：' -ForegroundColor Red
    Write-Host '  Node.js   https://nodejs.org/   或 winget install OpenJS.NodeJS.LTS'
    Write-Host '  Python 3  https://www.python.org/downloads/   或 winget install Python.Python.3.12'
    exit 1
  }
}

# ---------------------------------------------------------------- 安装
Step '3/4 安装文件'

if (-not $Yes) {
  Write-Host "  将覆盖: $barDir"
  Write-Host "          $marketDir"
  Write-Host "  将修改: $configPath（marketplace + 插件注册）"
  if (-not $isUpgrade) {
    $answer = Read-Host '  输入 Y 继续，其它键取消'
    if ($answer -ne 'Y' -and $answer -ne 'y') { Write-Host '已取消，未做任何修改。'; exit 0 }
  }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $barDir ".backup-$stamp"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
if (Test-Path $configPath) { Copy-Item $configPath (Join-Path $backupDir 'config.toml') -Force }

# 清单里的键是相对路径（bar/xxx.js），清理比较用的是底栏目录下的文件名，
# 所以这里必须以"包内 bar 目录的实际文件名"为准，否则会把刚复制的文件全当旧文件删掉。
$pkgFiles = @{}
Get-ChildItem $pkgBar -File | ForEach-Object { $pkgFiles[$_.Name] = $true }

New-Item -ItemType Directory -Path $barDir -Force | Out-Null
Get-ChildItem $pkgBar -File | ForEach-Object { Copy-Item $_.FullName (Join-Path $barDir $_.Name) -Force }
Say ('底栏 ' + (Get-ChildItem $pkgBar -File).Count + ' 个文件')

if (Test-Path $marketDir) { Remove-Item $marketDir -Recurse -Force }
Copy-Item $pkgMarket $marketDir -Recurse -Force
Say ('插件 ' + (Get-ChildItem $marketDir -Recurse -File).Count + ' 个文件')

$keepRuntime = @('.install-manifest.json', 'bar.log', 'quota-cache.json', 'health.json')
Get-ChildItem $barDir -File | Where-Object {
  $_.Name -notin $keepRuntime -and
  $_.Name -notmatch '^\.backup-' -and
  -not $pkgFiles.ContainsKey($_.Name)
} | ForEach-Object {
  Remove-Item $_.FullName -Force
  Say "清理旧文件 $($_.Name)"
}

& powershell -NoProfile -ExecutionPolicy Bypass -File $render -BarDir $barDir -PluginDir (Join-Path $marketDir 'plugins\session-dashboard') -Node $node -Python $python | Out-Null
Say '路径模板已按本机渲染'

# ---------------------------------------------------------------- 注册
Step '4/4 注册并启动'

# Codex 从未运行过时 ~/.codex 可能不存在；安装仍然要能写配置（测试模式同样受益）
$configDir = Split-Path -Parent $configPath
if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }

$config = @(if (Test-Path $configPath) { Get-Content $configPath -Encoding UTF8 } else { @() })
function Remove-Section([string[]]$lines, [string]$header) {
  $out = New-Object System.Collections.Generic.List[string]
  $skipping = $false
  foreach ($line in $lines) {
    if ($line -match '^\s*\[') {
      $skipping = ($line -eq $header)
      if ($skipping) { continue }
    }
    if (-not $skipping) { $out.Add($line) }
  }
  return $out.ToArray()
}
$config = Remove-Section $config '[marketplaces.codex-dashboard-local]'
$config = Remove-Section $config '[plugins."session-dashboard@codex-dashboard-local"]'
$config = @($config) + @(
  '',
  '[marketplaces.codex-dashboard-local]',
  'source_type = "local"',
  ('source = ' + "'" + ($marketDir -replace '\\', '\\') + "'"),
  '',
  '[plugins."session-dashboard@codex-dashboard-local"]',
  'enabled = true'
)
# 必须无 BOM：Codex 用严格的 TOML 解析，BOM 会让整个配置解析失败
[System.IO.File]::WriteAllLines($configPath, [string[]]$config, (New-Object System.Text.UTF8Encoding($false)))
Say 'Codex 配置已写入（未改动 notify）'

$shell = New-Object -ComObject WScript.Shell
$icon = Join-Path $barDir 'chatgpt-white.ico'
$launch = Join-Path $barDir 'launch.vbs'
$shortcuts = @()
$shortcutWarnings = @()
foreach ($dir in @($desktop, $startMenu)) {
  try {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $link = Join-Path $dir 'ChatGPT 仪表盘.lnk'
    $sc = $shell.CreateShortcut($link)
    $sc.TargetPath = "$env:WINDIR\System32\wscript.exe"
    $sc.Arguments = '//nologo "' + $launch + '"'
    $sc.WorkingDirectory = $barDir
    $sc.IconLocation = "$icon,0"
    $sc.Description = 'ChatGPT / Codex，带会话仪表盘底栏'
    $sc.Save()
    $shortcuts += $link
  } catch {
    # 快捷方式只是便利入口：失败不能中断安装（英文系统上中文 .lnk 可能失败）
    $shortcutWarnings += "${dir}: $($_.Exception.Message)"
  }
}
if ($shortcutWarnings.Count -gt 0) {
  foreach ($w in $shortcutWarnings) { Write-Host ('  [警告] 快捷方式创建失败（可用 start-bar.cmd 手动启动）: ' + $w) -ForegroundColor Yellow }
} else {
  Say '快捷方式: 桌面 + 开始菜单'
}

[ordered]@{
  installedAt  = (Get-Date).ToString('o')
  version      = $manifest.version
  build        = $manifest.build
  barDir       = $barDir
  marketDir    = $marketDir
  configBackup = if (Test-Path (Join-Path $backupDir 'config.toml')) { Join-Path $backupDir 'config.toml' } else { $null }
  backupDir    = $backupDir
  shortcuts    = $shortcuts
} | ConvertTo-Json -Depth 5 | ForEach-Object {
  [System.IO.File]::WriteAllText((Join-Path $barDir '.install-manifest.json'), $_, (New-Object System.Text.UTF8Encoding($false)))
}

$stale = @()
if (-not $testMode) {
  $stale = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -match 'session-dashboard.*server\.py' })
  foreach ($p in $stale) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($stale.Count -gt 0) { Say ("停止 $($stale.Count) 个旧面板服务进程（下次打开仪表盘自动重启）") }
} else {
  Say '测试模式：跳过停止旧面板服务/注入器（不碰正在运行的实例）'
}

$startedAt = Get-Date
if (-not $testMode) {
  # 先写暂停标记：否则守护进程会在 2 秒内把注入器重新拉起，和正在替换的文件打架
  New-Item -ItemType File -Path (Join-Path $barDir '.supervisor-pause') -Force | Out-Null
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'supervisor\.js|injector\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item (Join-Path $barDir '.supervisor-pause') -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath $node -ArgumentList (Join-Path $barDir 'supervisor.js') -WindowStyle Hidden | Out-Null
}

# 等注入器就绪：轮询 health.json，而不是固定睡 8 秒（实测恢复 0.7 秒，慢机器上 8 秒又可能不够）
$healthFile = Join-Path $barDir 'health.json'
$codexUp = $false
if (-not $testMode) {
  foreach ($cdpProbe in @('http://127.0.0.1:9223', 'http://[::1]:9223')) {
    try {
      $null = Invoke-RestMethod "$cdpProbe/json/version" -TimeoutSec 2
      $codexUp = $true
      break
    } catch { }
  }
}

if ($codexUp) {
  $ready = $false
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    if (Test-Path $healthFile) {
      # 必须比本次启动新，避免read到上一次运行留下的旧文件
      if ((Get-Item $healthFile).LastWriteTime -ge $startedAt) {
        try {
          $h = Get-Content $healthFile -Raw -Encoding UTF8 | ConvertFrom-Json
          if ($h.state -in @('ok', 'empty')) { $ready = $true; break }
        } catch { }
      }
    }
  }
  if (-not $ready) { Info '注入器 20 秒内未就绪，继续（底栏可能稍后才出现）' }
} else {
  Info 'Codex 未运行，跳过等待（下次用快捷方式启动即可）'
}

# 重载渲染进程：安装过程停掉了旧的面板服务，不重载的话已打开的面板会停在"未能显示"
$reload = Join-Path $here 'reload-page.js'
if (-not $testMode -and (Test-Path $reload) -and $node) {
  & $node $reload 2>&1 | Out-Null
  Start-Sleep -Seconds 2
}


if (-not $testMode) {
  $inj = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'injector\.js' })
  $sup = @(Get-NetTCPConnection -LocalPort 9225 -State Listen -ErrorAction SilentlyContinue).Count
  if ($inj.Count -eq 1 -and $sup -ge 1) { Ok '注入器与守护进程已启动' } else { Bad ('注入器进程数 ' + $inj.Count + '，守护监听端口 ' + $sup) }
  try {
    $null = Invoke-RestMethod 'http://localhost:9223/json/version' -TimeoutSec 3
    Ok '调试端口 9223 可用'
  } catch {
    Info '调试端口 9223 未打开：请用桌面「ChatGPT 仪表盘」启动 Codex（若已在运行，先完全退出）'
  }
} else {
  Info ('测试模式：安装产物在 ' + $TestHome + '，未做任何进程/端口检查')
}

Write-Host ''
Write-Host "安装完成: $($manifest.version) ($($manifest.build))" -ForegroundColor Green
Write-Host '回滚：双击 uninstall.cmd'
