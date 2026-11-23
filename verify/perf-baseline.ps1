# 性能基线：测一次，把数字写进 docs\PERF.md
#
#   powershell -ExecutionPolicy Bypass -File verify\perf-baseline.ps1
#   powershell -ExecutionPolicy Bypass -File verify\perf-baseline.ps1 -IdleSeconds 60

param(
  [int]$IdleSeconds = 30,
  [string]$OutFile
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$verify = Join-Path $root 'verify'
$installed = Join-Path $env:USERPROFILE '.codex-bar'
if (-not $OutFile) { $OutFile = Join-Path $root 'docs\PERF.md' }

$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { $py = "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe" }
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONIOENCODING = 'utf-8'

Write-Host '== 1/4 解析耗时（payload_for）'
$thread = (& $py (Join-Path $verify 'thread-id.py')).Trim()
$timing = & $py -c @'
import importlib.util, pathlib, sys, time
server = pathlib.Path(sys.argv[1]); tid = sys.argv[2]
spec = importlib.util.spec_from_file_location('srv', server)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
t0 = time.time(); m.payload_for(tid); cold = time.time() - t0
warm = []
for _ in range(5):
    t0 = time.time(); m.payload_for(tid); warm.append(time.time() - t0)
print(f'{cold:.4f} {sorted(warm)[len(warm)//2]:.4f}')
'@ (Join-Path $installed 'server.py') $thread
$cold, $warm = $timing -split '\s+'
Write-Host "  首次（含额度接口）: $cold s    缓存命中: $warm s"

Write-Host '== 2/4 底栏指标往返（bar_metrics）'
$metricsRtt = & $py -c @'
import json, subprocess, sys, time
proc = subprocess.Popen([sys.executable, sys.argv[1]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding='utf-8')
proc.stdin.write(json.dumps({'id': 1, 'thread': sys.argv[2]}) + '\n'); proc.stdin.flush()
proc.stdout.readline()          # 预热
samples = []
for i in range(5):
    t0 = time.time()
    proc.stdin.write(json.dumps({'id': i + 2, 'thread': sys.argv[2]}) + '\n'); proc.stdin.flush()
    proc.stdout.readline()
    samples.append(time.time() - t0)
proc.kill()
print(f'{sorted(samples)[len(samples)//2]:.4f}')
'@ (Join-Path $installed 'bar_metrics.py') $thread
Write-Host "  中位数: $metricsRtt s"

Write-Host "== 3/4 空闲 $IdleSeconds 秒的 CPU 占用"
$inj = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'injector\.js' })
if ($inj.Count -eq 0) { Write-Host '  注入器未运行，跳过' ; $cpuPct = 'n/a' }
else {
  $procId = $inj[0].ProcessId
  $cpu0 = (Get-Process -Id $procId).CPU
  Start-Sleep -Seconds $IdleSeconds
  $cpu1 = (Get-Process -Id $procId).CPU
  $cpuPct = [math]::Round(($cpu1 - $cpu0) / $IdleSeconds * 100, 2)
  Write-Host "  单核 ${cpuPct}%"
}

Write-Host '== 4/4 内存占用'
$rows = @()
$sumMb = 0
foreach ($p in (Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in 'node.exe', 'python.exe' -and ($_.CommandLine -match 'injector\.js|bar_metrics\.py|session-dashboard.*server\.py') })) {
  $mb = [math]::Round((Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue).WorkingSet64 / 1MB)
  $sumMb += $mb
  $kind = if ($p.CommandLine -match 'injector\.js') { '注入器 (node)' }
          elseif ($p.CommandLine -match 'bar_metrics') { '指标守护 (python)' }
          else { '面板服务 (python)' }
  $rows += "| $kind | $mb MB |"
  Write-Host "  $kind : $mb MB"
}
Write-Host "  合计: $sumMb MB"

$codexVersion = (Get-AppxPackage -Name OpenAI.Codex).Version
$build = if (Test-Path (Join-Path $installed 'injected.js')) {
  (Select-String -Path (Join-Path $installed 'injected.js') -Pattern "const BUILD = '([^']+)'" -AllMatches).Matches[0].Groups[1].Value
} else { 'unknown' }

New-Item -ItemType Directory -Path (Split-Path $OutFile -Parent) -Force | Out-Null
$md = @"
# 性能基线

> 由 ``verify\perf-baseline.ps1`` 生成。同一台机器上比较改前/改后时请重跑本脚本。

- 采集时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
- Codex 版本：$codexVersion
- 底栏构建：$build
- 样本会话：$($thread.Substring(0,8))…

## 解析耗时

| 场景 | 耗时 |
| --- | ---: |
| 首次 payload（含额度接口，未命中缓存） | $cold s |
| 缓存命中后 | $warm s |

## 底栏刷新

| 指标 | 值 |
| --- | ---: |
| bar_metrics 往返中位数 | $metricsRtt s |
| 空闲时 CPU（单核） | $cpuPct % |

轮询策略：有变化时 1 秒，静止 30 秒后降到 2 秒；数据文件有写入会立即唤醒。

## 内存

| 进程 | 工作集 |
| --- | ---: |
$($rows -join "`n")
| **合计** | **$sumMb MB** |

不含 Codex 自身。额度接口有跨进程磁盘缓存（有值 60 分钟 / 未归属 120 分钟），
所以稳态下网络请求约每小时一次。
"@
[System.IO.File]::WriteAllText($OutFile, $md, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ''
Write-Host "已写入 $OutFile" -ForegroundColor Green
