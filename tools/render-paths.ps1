# 把 {{node}} / {{python}} / {{server}} 占位符渲染成目标机器上的真实路径。
#
# 构建（镜像到开发机）和安装（部署到用户机器）共用这一份逻辑，
# 避免两处各写一套正则——历史上正是因为两套逻辑不一致，出现过
# "兜底语句被一起替换" 和 "反斜杠被重复转义" 两个问题。

param(
  [AllowEmptyString()][string]$BarDir,        # 底栏目录（含 launch.vbs / injector-only.vbs / injector.js）
  [AllowEmptyString()][string]$PluginDir,     # 插件的 session-dashboard 目录（含 .mcp.json）
  [string]$Node,
  [string]$Python
)

$ErrorActionPreference = 'Stop'

function Find-Node {
  # Volta 的 C:\Program Files\Volta\node.exe 是 shim，会经 "cmd /C node ..." 再起一次，
  # 表现为黑窗口，所以优先解析真实二进制。
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

if (-not $Node) { $Node = Find-Node }
if (-not $Python) { $Python = Find-Python }
if (-not $Node) { throw '找不到 node.exe' }
if (-not $Python) { throw '找不到 python.exe' }

# --- 底栏：VBS 用单反斜杠；JS 字符串用双反斜杠 ---
if ($BarDir -and (Test-Path $BarDir)) {
  foreach ($name in @('launch.vbs', 'injector-only.vbs')) {
    $path = Join-Path $BarDir $name
    if (-not (Test-Path $path)) { continue }
    $text = Get-Content $path -Raw -Encoding UTF8
    if ($text -notmatch '\{\{node\}\}') { continue }
    # 只替换第一处赋值，保留 "If Not fso.FileExists(...) Then nodeExe = ""node.exe""" 这类兜底
    $text = $text.Replace('{{node}}', $Node)
    Set-Content $path -Value $text -Encoding ASCII
  }

  $inj = Join-Path $BarDir 'injector.js'
  if ((Test-Path $inj)) {
    $text = Get-Content $inj -Raw -Encoding UTF8
    if ($text -match '\{\{python\}\}') {
      # .Replace 是字面量替换：每个反斜杠换成两个，JS 里才会还原成单反斜杠
      $text = $text.Replace('{{python}}', $Python.Replace('\', '\\'))
      [System.IO.File]::WriteAllText($inj, $text, (New-Object System.Text.UTF8Encoding($false)))
    }
  }
}

# --- 插件：JSON 里用双反斜杠 ---
if ($PluginDir -and (Test-Path $PluginDir)) {
  $mcp = Join-Path $PluginDir '.mcp.json'
  if (Test-Path $mcp) {
    $text = Get-Content $mcp -Raw -Encoding UTF8
    if ($text -match '\{\{python\}\}|\{\{server\}\}') {
      $server = Join-Path $PluginDir 'server.py'
      $text = $text.Replace('{{python}}', $Python.Replace('\', '\\'))
      $text = $text.Replace('{{server}}', $server.Replace('\', '\\'))
      [System.IO.File]::WriteAllText($mcp, $text, (New-Object System.Text.UTF8Encoding($false)))
    }
  }
}

Write-Host "  node   : $Node"
Write-Host "  python : $Python"
