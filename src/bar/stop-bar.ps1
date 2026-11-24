# 停掉底栏：先写"暂停守护"标记，再停守护进程与注入器。
# 否则 supervisor.js 会在 2 秒内把注入器重新拉起，stop-bar.cmd 看起来没生效。
$barDir = Join-Path $env:USERPROFILE '.codex-bar'
New-Item -ItemType File -Path (Join-Path $barDir '.supervisor-pause') -Force | Out-Null
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'supervisor\.js|injector\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host 'injector stopped (Codex itself keeps running)'
