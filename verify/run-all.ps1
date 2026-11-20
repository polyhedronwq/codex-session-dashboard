# 回归套件
#
#   powershell -ExecutionPolicy Bypass -File verify\run-all.ps1
#   ... -Snapshot      额外保存截图与数值快照
#   ... -SkipBar       跳过底栏检查
#
# 设计原则：每个检查都要能"真的失败"——用严格解析器、拒绝陈旧产物、验证消费者契约，
# 而不是只验证我们自己的假设。

param(
  [switch]$SkipBar,
  [switch]$Snapshot,
  [switch]$KeepHarness,
  [switch]$Full
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONIOENCODING = 'utf-8'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$verify = Join-Path $root 'verify'
$probe = Join-Path $root 'probe'

# ---- 路径 ----
$srcDir = Join-Path $root 'src'
$barDir = Join-Path $srcDir 'bar'
$sharedDir = Join-Path $srcDir 'shared'
$pluginDir = Join-Path $srcDir 'plugin\plugins\session-dashboard'
$distDir = Join-Path $root 'dist'
$installed = Join-Path $env:USERPROFILE '.codex-bar'
$liveMarket = Join-Path $installed 'plugin-market'
$configPath = Join-Path $env:USERPROFILE '.codex\config.toml'

$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) {
  foreach ($c in @("$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
                   "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
                   "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe")) {
    if (Test-Path $c) { $py = $c; break }
  }
}
if (-not $py) { throw '找不到 python' }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw '找不到 node' }

$script:total = 0
$script:failed = 0
$failures = New-Object System.Collections.Generic.List[string]

function Section($name) {
  Write-Host ''
  Write-Host "== $name" -ForegroundColor Cyan
}

function Check($name, [scriptblock]$body) {
  $script:total++
  try {
    $ok = & $body
    if ($ok) {
      Write-Host "  PASS  $name"
    } else {
      $script:failed++
      $failures.Add($name)
      Write-Host "  FAIL  $name" -ForegroundColor Red
    }
  } catch {
    $script:failed++
    $msg = $_.Exception.Message.Split([Environment]::NewLine)[0]
    $failures.Add("$name ($msg)")
    Write-Host "  FAIL  $name  -> $msg" -ForegroundColor Red
  }
}

function Hashes($dir, $algo = 'MD5') {
  $map = @{}
  if (-not (Test-Path $dir)) { return $map }
  Get-ChildItem $dir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($dir.Length + 1).Replace('\', '/')
    $map[$rel] = (Get-FileHash $_.FullName -Algorithm $algo).Hash
  }
  return $map
}

# ============================================================ A. 语法
Section 'A. 语法'

Check 'node --check: injected.js' {
  & $node --check (Join-Path $barDir 'injected.js') 2>&1 | Out-Null
  $LASTEXITCODE -eq 0
}
Check 'node --check: injector.js' {
  & $node --check (Join-Path $barDir 'injector.js') 2>&1 | Out-Null
  $LASTEXITCODE -eq 0
}
Check 'python 编译: server.py' {
  & $py -c "import py_compile,sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)" `
    (Join-Path $sharedDir 'server.py') (Join-Path $env:TEMP 'v-server.pyc') 2>&1 | Out-Null
  $LASTEXITCODE -eq 0
}
Check 'python 编译: bar_metrics.py' {
  & $py -c "import py_compile,sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)" `
    (Join-Path $barDir 'bar_metrics.py') (Join-Path $env:TEMP 'v-metrics.pyc') 2>&1 | Out-Null
  $LASTEXITCODE -eq 0
}
Check 'panel.html 内联脚本语法' {
  $tmp = Join-Path $env:TEMP 'v-panel.js'
  & $py -c "import pathlib,re,sys; h=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'); m=re.search(r'<script>(.*?)</script>', h, re.S); pathlib.Path(sys.argv[2]).write_text(m.group(1), encoding='utf-8')" `
    (Join-Path $sharedDir 'panel.html') $tmp
  if ($LASTEXITCODE -ne 0) { return $false }
  & $node --check $tmp 2>&1 | Out-Null
  $LASTEXITCODE -eq 0
}
Check '内联 CSS 花括号配平' {
  # node --check 只看 JS 语法，字符串里的 CSS 写坏了它发现不了（曾经因此把页内图标撑成巨型）
  $text = Get-Content (Join-Path $barDir 'injected.js') -Raw -Encoding UTF8
  $start = $text.IndexOf('const CSS = `')
  $end = $text.IndexOf('`;', $start)
  if ($start -lt 0 -or $end -lt 0) { return $false }
  $css = $text.Substring($start, $end - $start)
  $open = ($css.ToCharArray() | Where-Object { $_ -eq '{' }).Count
  $close = ($css.ToCharArray() | Where-Object { $_ -eq '}' }).Count
  if ($open -ne $close) { Write-Host "        -> { = $open, } = $close"; return $false }
  $true
}

Check 'verify 下的 JS 语法' {
  $bad = @()
  Get-ChildItem $verify -Filter '*.js' | ForEach-Object {
    & $node --check $_.FullName 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { $bad += $_.Name }
  }
  if ($bad.Count -gt 0) { Write-Host ('        -> ' + ($bad -join ', ')); return $false }
  $true
}
Check '所有 .ps1 语法正确且含中文者带 BOM' {
  $bad = @()
  $files = @(Get-ChildItem $barDir -Filter '*.ps1' -ErrorAction SilentlyContinue) +
           @(Get-ChildItem $verify -Filter '*.ps1' -ErrorAction SilentlyContinue) +
           @(Get-ChildItem (Join-Path $root 'tools') -Filter '*.ps1' -ErrorAction SilentlyContinue) +
           @(Get-Item (Join-Path $root 'build.ps1') -ErrorAction SilentlyContinue)
  foreach ($f in $files) {
    if (-not $f) { continue }
    $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $body = if ($hasBom) { $bytes[3..($bytes.Length - 1)] } else { $bytes }
    $nonAscii = @($body | Where-Object { $_ -gt 0x7F }).Count -gt 0
    $errs = $null
    [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errs) | Out-Null
    if ($errs.Count -gt 0) { $bad += "$($f.Name): 语法" }
    elseif ($nonAscii -and -not $hasBom) { $bad += "$($f.Name): 含中文但缺 BOM" }
  }
  if ($bad.Count -gt 0) { Write-Host ('        -> ' + ($bad -join ', ')); return $false }
  $true
}
Check '源码树无编译残留' {
  $junk = @(Get-ChildItem $srcDir -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq '__pycache__' -or $_.Extension -eq '.pyc' })
  if ($junk.Count -gt 0) { Write-Host ('        -> ' + (($junk | ForEach-Object Name) -join ', ')); return $false }
  $true
}

# ============================================================ B. 构建一致性
Section 'B. 源码 → 产物 → 运行位置'

Check 'dist 存在' { Test-Path (Join-Path $distDir 'manifest.json') }

Check 'dist/bar 与 src 一致' {
  $expected = @{}
  Get-ChildItem $barDir -File | ForEach-Object { $expected[$_.Name] = (Get-FileHash $_.FullName -Algorithm MD5).Hash }
  Get-ChildItem $sharedDir -File | ForEach-Object { $expected[$_.Name] = (Get-FileHash $_.FullName -Algorithm MD5).Hash }
  $actual = Hashes (Join-Path $distDir 'bar')
  if ($expected.Count -ne $actual.Count) { Write-Host "        -> 数量 $($expected.Count) vs $($actual.Count)"; return $false }
  $diff = $expected.Keys | Where-Object { $actual[$_] -ne $expected[$_] }
  if ($diff) { Write-Host ('        -> 不一致: ' + ($diff -join ', ')); return $false }
  $true
}

Check 'dist/plugin-market 与 src 一致（构建注入的文件除外）' {
  # 构建会注入版本号(plugin.json)与本机路径(.mcp.json)，这两个不比对内容
  $injected = @('plugin.json', '.mcp.json')
  $expected = @{}
  # 整个 src/plugin 根目录都要比（包含 .agents 下的市场清单）
  Get-ChildItem (Join-Path $srcDir 'plugin') -Recurse -File | ForEach-Object {
    if ($_.Name -in $injected) { return }
    $rel = $_.FullName.Substring((Join-Path $srcDir 'plugin').Length + 1).Replace('\', '/')
    $expected[$rel] = (Get-FileHash $_.FullName -Algorithm MD5).Hash
  }
  Get-ChildItem $sharedDir -File | ForEach-Object {
    $expected["plugins/session-dashboard/$($_.Name)"] = (Get-FileHash $_.FullName -Algorithm MD5).Hash
  }

  $actual = @{}
  Get-ChildItem (Join-Path $distDir 'plugin-market') -Recurse -File | ForEach-Object {
    if ($_.Name -in $injected) { return }
    $rel = $_.FullName.Substring((Join-Path $distDir 'plugin-market').Length + 1).Replace('\', '/')
    $actual[$rel] = (Get-FileHash $_.FullName -Algorithm MD5).Hash
  }

  $missing = @($expected.Keys | Where-Object { -not $actual.ContainsKey($_) })
  $extra = @($actual.Keys | Where-Object { -not $expected.ContainsKey($_) })
  $changed = @($expected.Keys | Where-Object { $actual.ContainsKey($_) -and $actual[$_] -ne $expected[$_] })
  if ($missing) { Write-Host ('        -> 缺少: ' + ($missing -join ', ')) }
  if ($extra) { Write-Host ('        -> 多出: ' + ($extra -join ', ')) }
  if ($changed) { Write-Host ('        -> 内容不同: ' + ($changed -join ', ')) }
  (-not $missing) -and (-not $extra) -and (-not $changed)
}

Check 'dist/manifest.json 哈希正确（SHA256）' {
  $m = Get-Content (Join-Path $distDir 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $actual = Hashes $distDir 'SHA256'
  $actual.Remove('manifest.json')
  $files = @($m.files.PSObject.Properties)
  if ($files.Count -ne $actual.Count) { return $false }
  ($files | Where-Object { $actual[$_.Name].ToLower() -ne $_.Value } | Measure-Object).Count -eq 0
}

Check '安装目录与 dist/bar 一致（安装器重写的 3 个文件除外）' {
  $rewritten = @('launch.vbs', 'injector-only.vbs', 'injector.js')
  $expected = Hashes (Join-Path $distDir 'bar')
  $actual = Hashes $installed
  $keys = $expected.Keys | Where-Object { $_ -notin $rewritten }
  $missing = $keys | Where-Object { -not $actual.ContainsKey($_) }
  $changed = $keys | Where-Object { $actual[$_] -ne $expected[$_] }
  if ($missing) { Write-Host ('        -> 缺失: ' + ($missing -join ', ')) }
  if ($changed) { Write-Host ('        -> 内容不同: ' + ($changed -join ', ')) }
  (-not $missing) -and (-not $changed)
}

Check 'Codex 使用中的市场目录与 dist 一致（.mcp.json 除外）' {
  $expected = Hashes (Join-Path $distDir 'plugin-market')
  $drop = @($expected.Keys | Where-Object { $_ -like '*/.mcp.json' })
  foreach ($k in $drop) { $expected.Remove($k) }
  $actual = Hashes $liveMarket
  $actual.Remove('plugins/session-dashboard/.mcp.json')
  if ($expected.Count -ne $actual.Count) { return $false }
  ($expected.Keys | Where-Object { $actual[$_] -ne $expected[$_] } | Measure-Object).Count -eq 0
}

Check 'config.toml 市场源指向安装目录' {
  if (-not (Test-Path $configPath)) { return $false }
  $text = Get-Content $configPath -Raw -Encoding UTF8
  $text.Contains(($liveMarket -replace '\\', '\\'))
}

Check '运行中的 .mcp.json 指向自己那份 server.py' {
  $mcp = Join-Path $liveMarket 'plugins\session-dashboard\.mcp.json'
  $server = Join-Path $liveMarket 'plugins\session-dashboard\server.py'
  if (-not (Test-Path $mcp)) { return $false }
  $j = Get-Content $mcp -Raw -Encoding UTF8 | ConvertFrom-Json
  $conf = $j.mcpServers.'session-dashboard'
  ($conf.args[0] -eq $server) -and (Test-Path $conf.command)
}

Check '除 .ps1 外文本资源不得带 BOM' {
  # .ps1 需要 BOM 才能正确读中文；其它文件带 BOM 会被消费者当作内容（HTML/JSON 都可能翻车）
  $bad = @()
  foreach ($base in @($srcDir, (Join-Path $root 'tools'))) {
    Get-ChildItem $base -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Extension -in @('.html', '.js', '.py', '.json', '.cmd', '.vbs', '.md') } |
      ForEach-Object {
        $b = [System.IO.File]::ReadAllBytes($_.FullName)
        if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { $bad += $_.Name }
      }
  }
  if ($bad) { Write-Host ('        -> ' + (($bad | Select-Object -Unique) -join ', ')); return $false }
  $true
}

Check '所有 JSON 无 BOM' {
  $bad = @()
  foreach ($base in @($distDir, $installed)) {
    Get-ChildItem $base -Recurse -Filter '*.json' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '__pycache__' } | ForEach-Object {
        $b = [System.IO.File]::ReadAllBytes($_.FullName)
        if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { $bad += $_.Name }
      }
  }
  if ($bad) { Write-Host ('        -> ' + (($bad | Select-Object -Unique) -join ', ')); return $false }
  $true
}

Check 'config.toml 无 BOM（Codex 用严格 TOML 解析）' {
  if (-not (Test-Path $configPath)) { return $true }
  $b = [System.IO.File]::ReadAllBytes($configPath)
  -not ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
}

# ============================================================ C. 服务端
Section 'C. 服务端'

$newestThread = (& $py (Join-Path $verify 'thread-id.py')).Trim()

Check '取到有内容的会话 id' { $newestThread -match '^[0-9a-f-]{36}$' }

Check 'payload_for 返回成功' {
  if (-not $newestThread) { return $false }
  $out = & $py (Join-Path $verify 'payload-check.py') (Join-Path $sharedDir 'server.py') $newestThread ok
  ($out -join '').Trim() -eq 'ok'
}

Check 'quota 只暴露 api 字段' {
  $out = & $py (Join-Path $verify 'payload-check.py') (Join-Path $sharedDir 'server.py') $newestThread quota
  ($out -join '').Trim() -eq '["api"]'
}

Check '不存在的会话返回 not_found 且不抛异常' {
  $out = & $py (Join-Path $verify 'payload-check.py') (Join-Path $sharedDir 'server.py') '00000000-0000-0000-0000-000000000000' ok
  ($out -join '').Trim() -eq 'bad'
}

# ============================================================ D. 消费者契约
Check '服务端协议分支（ping/模板/未知方法/非法 JSON）' {
  & $py (Join-Path $verify 'server-branches.py') $installed
  $LASTEXITCODE -eq 0
}

Section 'D. 消费者契约（按 Codex 的读取方式校验）'

Check '安装目录: JSON/清单/MCP 握手' {
  $out = (& $py (Join-Path $verify 'contract-check.py') $installed 2>&1) -join "`n"
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    $fails = ($out -split "`n" | Where-Object { $_ -match 'FAIL' }) -join ' | '
    Write-Host ("        -> " + $fails)
  }
  $code -eq 0
}

Check 'dist: 模板态可交付' {
  $out = (& $py (Join-Path $verify 'contract-check.py') $distDir 2>&1) -join "`n"
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    $fails = ($out -split "`n" | Where-Object { $_ -match 'FAIL' }) -join ' | '
    Write-Host ("        -> " + $fails)
  }
  $code -eq 0
}

# ============================================================ E. 面板渲染
Check 'tools/call 无参数也能定位会话' {
  # Codex 打开面板时不保证带线程上下文；这里必须能兜底，否则面板显示"未能显示"
  $out = (& $py (Join-Path $verify 'tool-call-check.py') $installed 2>&1) -join "`n"
  $code = $LASTEXITCODE
  if ($code -ne 0) { Write-Host ('        -> ' + $out) }
  $code -eq 0
}

Check '资源不声明 ui.csp（会触发宿主 CSP 拦掉内联脚本）' {
  $srv = Join-Path $installed 'plugin-market\plugins\session-dashboard\server.py'
  if (-not (Test-Path $srv)) { return $false }
  $text = Get-Content $srv -Raw -Encoding UTF8
  -not ($text -match "'ui':\s*\{\s*'csp'")
}

Section 'E. 面板渲染与数值对账'

$harnessOk = $false
$expectedJson = Join-Path $env:TEMP 'verify-expected.json'
if ($newestThread) {
  # 先删旧产物：否则生成失败时会拿上一次的文件假装通过
  Get-ChildItem $probe -Filter 'panel-harness*.html' -ErrorAction SilentlyContinue | Remove-Item -Force
  $startedAt = Get-Date

  & $py (Join-Path $probe 'build_harness.py') --thread=$newestThread | Out-Null
  & $py (Join-Path $probe 'build_harness.py') stats --thread=$newestThread | Out-Null
  & $py (Join-Path $probe 'build_harness.py') trace --thread=$newestThread | Out-Null
  & $py (Join-Path $probe 'build_harness.py') agents --thread=$newestThread | Out-Null
  & $py (Join-Path $verify 'payload-check.py') (Join-Path $sharedDir 'server.py') $newestThread dump $expectedJson | Out-Null

  $built = @(Get-ChildItem $probe -Filter 'panel-harness*.html' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $startedAt })
  $harnessOk = $built.Count -eq 4
  if (-not $harnessOk) { Write-Host "        -> 只生成了 $($built.Count)/4 个 harness" }
}

Check '四个页签的 harness 均本次新生成' { $harnessOk }

if ($harnessOk) {
  Check '4 页签 × 深浅色渲染 + 数值对账' {
    & $node (Join-Path $verify 'panel-render.js') $probe $expectedJson
    $LASTEXITCODE -eq 0
  }
}

# ============================================================ F. 底栏
  Check '面板行为（控件/内容/交互）' {
    & $node (Join-Path $verify 'panel-behaviour.js') $probe
    $LASTEXITCODE -eq 0
  }

Section 'F. 底栏三态'

$cdpUp = $false
# 显式双栈：localhost 在不同环境会先解析到 ::1 或 127.0.0.1，可能命不中
foreach ($cdpProbe in @('http://127.0.0.1:9223', 'http://[::1]:9223')) {
  try {
    $null = Invoke-RestMethod "$cdpProbe/json/version" -TimeoutSec 2
    $cdpUp = $true
    break
  } catch { }
}

if ($SkipBar) {
  Write-Host '  SKIP  按参数跳过（-SkipBar）'
} elseif (-not $cdpUp) {
  Write-Host '  SKIP  调试端口 9223 未打开（Codex 未用「ChatGPT 仪表盘」启动）'
  Write-Host '        完整回归：完全退出 Codex，用桌面快捷方式启动后重跑'
} else {
  Check 'health.json 字段完整' {
    $h = Join-Path $installed 'health.json'
    if (-not (Test-Path $h)) { return $false }
    $j = Get-Content $h -Raw -Encoding UTF8 | ConvertFrom-Json
    $names = $j.PSObject.Properties.Name
    ($names -contains 'state') -and ($names -contains 'lastOkAt') -and
    ($names -contains 'missingAnchors') -and ($names -contains 'build')
  }

  Check 'health.json 不是每秒重写' {
    # 稳态下状态不变就只允许 60 秒一次心跳；这里 5 秒内最多变 1 次
    $h = Join-Path $installed 'health.json'
    $changes = 0
    $last = (Get-Item $h).LastWriteTime
    for ($i = 0; $i -lt 5; $i++) {
      Start-Sleep -Seconds 1
      $now = (Get-Item $h).LastWriteTime
      if ($now -ne $last) { $changes++; $last = $now }
    }
    if ($changes -gt 1) { Write-Host "        -> 5 秒内写了 $changes 次"; return $false }
    $true
  }

  Check '底栏存在 / 三态 / 灰点' {
    & $node (Join-Path $verify 'bar-states.js')
    $LASTEXITCODE -eq 0
  }

  Check '重启注入器后能在 20 秒内恢复' {
    # 曾经因为"窗口在后台时布局尺寸为 0"被误判成空会话，底栏消失 3 分钟
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -match 'injector\.js' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    Start-Process -FilePath "$env:WINDIR\System32\wscript.exe" `
      -ArgumentList '//nologo', (Join-Path $installed 'injector-only.vbs') -WindowStyle Hidden | Out-Null
    $h = Join-Path $installed 'health.json'
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 500
      if (Test-Path $h) {
        $j = Get-Content $h -Raw -Encoding UTF8 | ConvertFrom-Json
        # ok 和 empty 都说明注入器已经连上并做出了判断；
        # 用户就停在新对话时 empty 是正确结果（"新对话不得显示旧会话"由另一条检查负责）。
        if ($j.state -in @('ok', 'empty')) { return $true }
      }
    }
    $false
  }
}

# ============================================================ G. 单测
Check '会话判定：新对话不得显示旧会话' {
  # 这条对应的真实事故：兜底规则让新对话界面显示了别的会话的数据。
  # 判定逻辑已抽成纯函数（src/bar/thread-resolver.js），这里跑它的单测。
  & $node (Join-Path $verify 'test-resolver.js')
  $LASTEXITCODE -eq 0
}

  Check '注入器单实例锁（第二个实例应退出）' {
    $before = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -match 'injector\.js' }).Count
    Start-Process -FilePath "$env:WINDIR\System32\wscript.exe" `
      -ArgumentList '//nologo', (Join-Path $installed 'injector-only.vbs') -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 4
    $after = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -match 'injector\.js' }).Count
    $log = Get-Content (Join-Path $installed 'bar.log') -Tail 25 -Encoding UTF8
    $said = ($log -join "`n") -match 'another injector is already running'
    if (-not ($before -eq 1 -and $after -eq 1 -and $said)) {
      Write-Host "        -> before=$before after=$after 日志提示=$said"
      return $false
    }
    $true
  }

Check '底栏跟随面板动画（偏差 < 2px）' {
  & $node (Join-Path $verify 'bar-follow.js')
  $LASTEXITCODE -eq 0
}

Check '运行中的判定结果与 health.json 一致' {
  # 现场一致性：页面里实际判定出来的会话，必须和注入器记录的一样
  & $node (Join-Path $verify 'resolver-live.js') $installed $node
  $LASTEXITCODE -eq 0
}

Section 'G. 解析层单元测试'

Check 'verify/test_server.py' {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = (& $py (Join-Path $verify 'test_server.py') 2>&1) -join "`n"
  } finally {
    $ErrorActionPreference = $prev
  }
  $passed = ($out -match 'Ran \d+ tests') -and ($out -notmatch 'FAILED')
  if (-not $passed) { Write-Host ('        -> ' + (($out -split "`n" | Select-Object -Last 4) -join ' | ')) }
  $passed
}

# ============================================================ H. 安装器
Check 'README 参数与代码一致' {
  & $py (Join-Path $verify 'test-docs.py')
  $LASTEXITCODE -eq 0
}

Section 'H. 安装器'

$installer = Join-Path $root 'share\install.ps1'
$uninstaller = Join-Path $root 'share\uninstall.ps1'

Check 'install.ps1 -CheckOnly 通过' {
  if (-not (Test-Path $installer)) { return $false }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $installer -CheckOnly 2>&1 | Out-Null
  $LASTEXITCODE -eq 0
}
Check 'uninstall.ps1 语法正确' {
  if (-not (Test-Path $uninstaller)) { return $false }
  $errs = $null
  [System.Management.Automation.Language.Parser]::ParseFile($uninstaller, [ref]$null, [ref]$errs) | Out-Null
  $errs.Count -eq 0
}

# ============================================================ I. 真实流程与截图
Section 'I. 真实流程与截图'

$shotsDir = Join-Path $verify 'shots'

if (-not $cdpUp) {
  Write-Host '  SKIP  调试端口未打开，跳过真实流程'
} else {
  Check '真实流程：打开面板无致命错误' {
    & $node (Join-Path $verify 'panel-live.js') $shotsDir
    $LASTEXITCODE -eq 0
  }

  Check '面板截图有内容（像素占比）' {
    $png = Join-Path $shotsDir 'panel-live.png'
    if (-not (Test-Path $png)) { return $false }
    & $py (Join-Path $verify 'panel-pixels.py') $png
    $LASTEXITCODE -eq 0
  }
}

Check '截图集已生成（供人工复核）' {
  # 面板截图依赖 harness；E 段（或上一次运行的清理）可能没有留着，这里兜底重建
  if (-not (Test-Path (Join-Path $probe 'panel-harness.html')) -and $newestThread) {
    & $py (Join-Path $probe 'build_harness.py') --thread=$newestThread | Out-Null
    & $py (Join-Path $probe 'build_harness.py') stats --thread=$newestThread | Out-Null
    & $py (Join-Path $probe 'build_harness.py') trace --thread=$newestThread | Out-Null
    & $py (Join-Path $probe 'build_harness.py') agents --thread=$newestThread | Out-Null
  }
  & $node (Join-Path $verify 'screens.js') $shotsDir $probe
  $LASTEXITCODE -eq 0
}
Write-Host "        截图目录: $shotsDir"

# ============================================================ J. 用户脚本
Section 'J. 用户脚本'

Check '用户脚本冒烟（诊断/图标/监视器/-NoMirror）' {
  $args = @()
  if ($Full) { $args += '-Full' }
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $verify 'scripts-smoke.ps1') @args
  $LASTEXITCODE -eq 0
}

# ============================================================ 快照
if ($Snapshot) {
  Section 'I. 基线快照'
  $dir = Join-Path $verify ("baseline\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  & $node (Join-Path $verify 'snapshot.js') $dir $probe
  if (Test-Path $expectedJson) { Copy-Item $expectedJson (Join-Path $dir 'payload.json') -Force }
  Check '快照已生成' { Test-Path (Join-Path $dir 'meta.json') }
}

if (-not $KeepHarness) {
  Get-ChildItem $probe -Filter 'panel-harness*.html' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}

# ============================================================ 汇总
Write-Host ''
Write-Host ('=' * 60)
if ($script:failed -eq 0) {
  Write-Host "全部通过：$($script:total) 项" -ForegroundColor Green
} else {
  Write-Host "$($script:failed)/$($script:total) 项失败：" -ForegroundColor Red
  foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
}
Write-Host ('=' * 60)
exit $script:failed
