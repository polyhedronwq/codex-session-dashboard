# One-shot diagnostic snapshot for the Codex status bar.
#
# Answers three questions at once, which no single log can:
#   1. what the page/bar thinks is going on   (diagnose-bar.js, via CDP)
#   2. what the database says                 (diagnose-data.py)
#   3. what happened recently                 (bar.log / windows.log tails)
#
# Usage: diagnose.cmd        -> writes %USERPROFILE%\.codex-bar\diagnose.txt
#        diagnose.ps1 -Show  -> also prints it

param(
  [switch]$Show,
  [string]$Out = (Join-Path $env:USERPROFILE '.codex-bar\diagnose.txt')
)

$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$lines = New-Object System.Collections.Generic.List[string]

# Windows PowerShell decodes native-command output with the console codepage by default,
# which mangles the Chinese thread titles coming back from node/python. Force UTF-8 both
# ways before the first external call.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$env:PYTHONIOENCODING = 'utf-8'

function Add-Line([string]$text) { $lines.Add($text) }
function Add-Section([string]$title) {
  Add-Line ''
  Add-Line ('=' * 66)
  Add-Line $title
  Add-Line ('=' * 66)
}

Add-Line ('diagnose  ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))

# ---------------------------------------------------------------- environment
Add-Section '1. 进程 / 版本'
$app = Get-AppxPackage -Name OpenAI.Codex
Add-Line ('Codex 版本      : ' + ($(if ($app) { $app.Version } else { '未安装 / 读不到' })))
$chat = @(Get-Process ChatGPT -ErrorAction SilentlyContinue)
Add-Line ('ChatGPT 进程数  : ' + $chat.Count)
Add-Line ('可见窗口数      : ' + (@($chat | Where-Object { $_.MainWindowTitle }).Count))
$inj = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'injector\.js' })
Add-Line ('注入器进程数    : ' + $inj.Count + $(if ($inj.Count -ne 1) { '   <-- 期望 1' } else { '' }))
try {
  $cdp = Invoke-RestMethod 'http://127.0.0.1:9223/json/version' -TimeoutSec 3
  Add-Line ('调试端口 9223   : 可用 (' + $cdp.Browser + ')')
} catch {
  Add-Line '调试端口 9223   : 不可用  <-- 底栏一定没有数据'
}

# ---------------------------------------------------------------- page facts
Add-Section '2. 页面状态（底栏 / 会话解析 / 用量 chip）'
$barJson = & node (Join-Path $here 'diagnose-bar.js') 2>&1
$bar = $null
try { $bar = ($barJson | Select-Object -Last 1) | ConvertFrom-Json } catch { }

if (-not $bar -or -not $bar.ok) {
  Add-Line ('取页面状态失败: ' + ($(if ($bar) { $bar.reason } else { ($barJson -join ' ') })))
} else {
  $p = $bar.page
  Add-Line ('注入版本        : ' + $p.build)
  Add-Line ('底栏可见        : ' + $(if ($p.barOpacity -eq '1') { '是' } else { '否 (opacity=' + $p.barOpacity + ')' }))
  Add-Line ('底栏文字        : ' + $p.barText)
  Add-Line ''
  Add-Line '会话解析:'
  Add-Line ('  屏幕上的会话  : ' + $(if ($p.onScreen) { $p.onScreen.id + '  (' + $p.onScreen.nodes + ' 个节点)' } else { '（无消息节点）' }))
  Add-Line ('  侧栏选中      : ' + $p.sidebarSelectedRaw + $(if ($p.sidebarIsPlaceholder) { '   <-- 占位 id！' } else { '' }))
  Add-Line ('  localStorage  : ' + $p.storedThread)
  Add-Line ('  侧栏占位 id 数: ' + $p.placeholdersInSidebar)
  if ($p.laidOutConversations -and $p.laidOutConversations.PSObject.Properties.Count -gt 1) {
    Add-Line '  同时布局的会话（多于 1，靠节点数取最大）:'
    foreach ($prop in $p.laidOutConversations.PSObject.Properties) {
      Add-Line ('    ' + $prop.Name + '  ' + $prop.Value + ' 个')
    }
  }
  Add-Line ''
  Add-Line ('回合映射        : ' + $p.turnMapSize + ' 轮')
  Add-Line ('用量 chip       : ' + $p.chipCount + ' 个，其中不属于当前回合的 ' + $p.chipsUnknown + ' 个' +
    $(if ($p.chipsUnknown -gt 0) { '   <-- chip 串台' } else { '' }))
  if ($p.chipCount -gt 0) {
    foreach ($c in $p.chips | Select-Object -First 8) {
      Add-Line ('    ' + $c.text.PadRight(18) + ' turn=' + $c.turn + '  会话=' + $c.conversation +
        $(if ($c.known) { '' } else { '  (不在当前映射)' }))
    }
  }
  $resolvedId = $p.onScreen.id
}

# ---------------------------------------------------------------- data facts
Add-Section '3. 数据库 / 解析器'
$py = $null
foreach ($candidate in @('python', 'py')) {
  $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
  if ($cmd) { $py = $cmd.Source; break }
}
if (-not $py) {
  foreach ($cand in @("$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
                      "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
                      "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
                      "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe")) {
    if (Test-Path $cand) { $py = $cand; break }
  }
}

$dataJson = & $py (Join-Path $here 'diagnose-data.py') $resolvedId 2>&1
$data = $null
try { $data = ($dataJson | Select-Object -Last 1) | ConvertFrom-Json } catch { }

if (-not $data -or -not $data.ok) {
  Add-Line ('取数据库状态失败: ' + ($dataJson -join ' '))
} else {
  $t = $data.resolvedThread
  Add-Line '底栏解析到的会话:'
  if (-not $t) {
    Add-Line '  （没解析到，底栏因此是空的）'
  } elseif (-not $t.found) {
    Add-Line ('  ' + $t.id + '   <-- 数据库里没有这一行')
  } else {
    Add-Line ('  ' + $t.id)
    Add-Line ('  模型 ' + $t.model + ' / 强度 ' + $t.effort + ' / ' + $t.tokens_used + ' tok / 更新于 ' + $t.updated_at)
    Add-Line ('  记录文件: ' + $(if ($t.rollout_exists) { '存在 ' + [math]::Round($t.rollout_size / 1KB) + ' KB' } else { '不存在  <-- rollout_missing' }))
    Add-Line ('  标题: ' + $t.name)
  }
  Add-Line ''
  Add-Line '解析器行为:'
  Add-Line ('  只给占位 id     -> ' + $(if ($data.resolver.placeholderOnly) { $data.resolver.placeholderOnly } else { '拒绝（None）' }))
  Add-Line ('  占位 id + 参数  -> ' + $(if ($data.resolver.placeholderWithArgs) { $data.resolver.placeholderWithArgs } else { '拒绝（None）' }))
  if ($data.payload) {
    Add-Line ('  面板取数        : ok=' + $data.payload.ok + ' reason=' + $data.payload.reason +
      ' 轮=' + $data.payload.turns + ' 步=' + $data.payload.steps)
  }
  Add-Line ''
  Add-Line '今天的回合触发来源:'
  foreach ($prop in $data.triggers.counts.PSObject.Properties) {
    Add-Line ('  ' + $prop.Name.PadRight(34) + $prop.Value)
  }
  foreach ($n in $data.triggers.nonComposer) {
    Add-Line ('    ' + $n.time + '  ' + $n.trigger)
  }
  Add-Line ''
  Add-Line '最新的几条会话（对照是否“存在但换了 id”）:'
  foreach ($n in $data.newestThreads) {
    Add-Line ('  ' + $n.created + '  ' + $n.id.Substring(0, 13) + '  ' + $n.model.PadRight(14) + ' ' + $n.name)
  }
}

# ---------------------------------------------------------------- logs
Add-Section '4. 日志尾部'
$barLog = Join-Path $env:USERPROFILE '.codex-bar\bar.log'
if (Test-Path $barLog) {
  Add-Line '--- bar.log（最后 25 行）---'
  Get-Content $barLog -Encoding UTF8 | Select-Object -Last 25 | ForEach-Object { Add-Line $_ }
} else {
  Add-Line 'bar.log 不存在'
}

$winLog = Join-Path $env:USERPROFILE '.codex-bar\windows.log'
if (Test-Path $winLog) {
  Add-Line ''
  Add-Line '--- windows.log（最后 12 行）---'
  Get-Content $winLog -Encoding UTF8 | Select-Object -Last 12 | ForEach-Object { Add-Line $_ }
} else {
  Add-Line ''
  Add-Line 'windows.log 不存在（窗口监视器没跑过）'
}

# ---------------------------------------------------------------- write it out
$lines -join [Environment]::NewLine | Set-Content -Path $Out -Encoding UTF8
Write-Host ('报告已写入: ' + $Out)
if ($Show) { Get-Content $Out -Encoding UTF8 | Write-Host }
