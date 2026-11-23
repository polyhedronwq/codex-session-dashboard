# 性能阈值检查（不是基线采集）：解析耗时 / 指标往返 / 空闲 CPU / 进程内存。
#
#   powershell -ExecutionPolicy Bypass -File verify\perf-check.ps1
#
# 阈值取 docs/PERF.md 基线的 5-10 倍，留给慢机器和偶发活动；只拦"数量级退化"，
# 不追求精确数字（精确基线用 verify\perf-baseline.ps1 采集后人工比较）。

param(
  [double]$MaxParseMs = 50,
  [double]$MaxRttMs = 200,
  [double]$MaxCpuPct = 10,
  [int]$MaxMemMb = 300,
  [int]$SampleSeconds = 5
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$verify = Join-Path $root 'verify'
$installed = Join-Path $env:USERPROFILE '.codex-bar'
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { throw '找不到 python' }
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONIOENCODING = 'utf-8'

$script:total = 0
$script:failed = 0
function Check($name, $value, $limit, $unit) {
  $script:total++
  $ok = ($null -ne $value) -and ([double]$value -le [double]$limit)
  if ($ok) {
    Write-Host ("  PASS  {0}：{1} {2}（上限 {3} {2}）" -f $name, $value, $unit, $limit)
  } else {
    $script:failed++
    Write-Host ("  FAIL  {0}：{1} {2}（上限 {3} {2}）" -f $name, $value, $unit, $limit) -ForegroundColor Red
  }
}

$thread = (& $py (Join-Path $verify 'thread-id.py')).Trim()

# ---- 1. 解析耗时（缓存命中后的中位数）----
$parseMs = & $py -c @'
import importlib.util, sys, time
spec = importlib.util.spec_from_file_location('srv', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
tid = sys.argv[2]
m.payload_for(tid)                      # 预热：第一次含额度/文件读取
samples = []
for _ in range(5):
    t0 = time.perf_counter()
    m.payload_for(tid)
    samples.append((time.perf_counter() - t0) * 1000)
samples.sort()
print(f'{samples[len(samples) // 2]:.1f}')
'@ (Join-Path $installed 'server.py') $thread
Check '解析耗时（缓存命中，中位数）' $parseMs $MaxParseMs 'ms'

# ---- 2. 底栏指标往返（线程常驻进程，中位数）----
$rttMs = & $py -c @'
import json, subprocess, sys, time
proc = subprocess.Popen([sys.executable, sys.argv[1]], stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, text=True, encoding='utf-8')
proc.stdin.write(json.dumps({'id': 0, 'thread': sys.argv[2]}) + '\n'); proc.stdin.flush()
proc.stdout.readline()                  # 预热
samples = []
for i in range(5):
    t0 = time.perf_counter()
    proc.stdin.write(json.dumps({'id': i + 1, 'thread': sys.argv[2]}) + '\n'); proc.stdin.flush()
    proc.stdout.readline()
    samples.append((time.perf_counter() - t0) * 1000)
proc.kill()
samples.sort()
print(f'{samples[len(samples) // 2]:.1f}')
'@ (Join-Path $installed 'bar_metrics.py') $thread
Check '底栏指标往返（中位数）' $rttMs $MaxRttMs 'ms'

# ---- 3. 注入器空闲 CPU（单核百分比）----
$inj = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'injector\.js' })
if ($inj.Count -eq 1) {
  $procId = $inj[0].ProcessId
  $cpu0 = (Get-Process -Id $procId).CPU
  Start-Sleep -Seconds $SampleSeconds
  $cpu1 = (Get-Process -Id $procId).CPU
  $cpuPct = [math]::Round(($cpu1 - $cpu0) / $SampleSeconds * 100, 2)
  Check '注入器空闲 CPU（单核）' $cpuPct $MaxCpuPct '%'
} else {
  $script:total++
  $script:failed++
  Write-Host "  FAIL  注入器进程数 $($inj.Count)（应为 1），无法测 CPU" -ForegroundColor Red
}

# ---- 4. 底栏相关进程内存合计 ----
$sumMb = 0
foreach ($p in (Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in 'node.exe', 'python.exe' -and
    ($_.CommandLine -match 'injector\.js|bar_metrics\.py|session-dashboard.*server\.py') })) {
  $sumMb += [math]::Round((Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue).WorkingSet64 / 1MB)
}
Check '底栏进程内存合计' $sumMb $MaxMemMb 'MB'

Write-Host ''
if ($script:failed -eq 0) {
  Write-Host "  性能阈值: 全部通过（$script:total 项）" -ForegroundColor Green
} else {
  Write-Host "  性能阈值: $script:failed/$script:total 项超阈值" -ForegroundColor Red
}
exit $script:failed
