# 构建：src/ → dist/ → 运行位置
#
#   powershell -ExecutionPolicy Bypass -File build.ps1
#   powershell -ExecutionPolicy Bypass -File build.ps1 -NoMirror   # 只出 dist
#
# dist 里保留 {{node}} / {{python}} / {{server}} 模板（可移植），
# 真实路径在"镜像到本机"和"安装到用户机器"时才渲染——两处共用 tools\render-paths.ps1。

param(
  [switch]$NoMirror
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $root 'src'
$dist = Join-Path $root 'dist'
$shared = Join-Path $src 'shared'
$render = Join-Path $root 'tools\render-paths.ps1'
$installed = Join-Path $env:USERPROFILE '.codex-bar'
$liveMarket = Join-Path $root 'plugin-market'
$shareDir = Join-Path $root 'share'

function Say($t) { Write-Host "  $t" }

# ---- 构建号 ----
$injected = Join-Path $src 'bar\injected.js'
$build = if (Test-Path $injected) {
  (Select-String -Path $injected -Pattern "const BUILD = '([^']+)'" -AllMatches).Matches[0].Groups[1].Value
} else { 'unknown' }

# ---- 版本号（存在 VERSION 时读取）----
$versionFile = Join-Path $root 'VERSION'
$version = if (Test-Path $versionFile) { (Get-Content $versionFile -Raw).Trim() } else { '0.0.0' }

Write-Host ''
Write-Host "== 构建 $version ($build)" -ForegroundColor Cyan

# ---- 清理 ----
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $dist 'bar') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dist 'plugin-market') -Force | Out-Null

# ---- 底栏 ----
Copy-Item (Join-Path $src 'bar\*') (Join-Path $dist 'bar') -Recurse -Force
Copy-Item (Join-Path $shared '*') (Join-Path $dist 'bar') -Force

# ---- 插件 ----
Copy-Item (Join-Path $src 'plugin\*') (Join-Path $dist 'plugin-market') -Recurse -Force
Copy-Item (Join-Path $shared '*') (Join-Path $dist 'plugin-market\plugins\session-dashboard') -Force

# ---- 清掉编译残留 ----
Get-ChildItem $dist -Recurse -Force -Include '__pycache__', '*.pyc' -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Say ("底栏: " + (Get-ChildItem (Join-Path $dist 'bar') -File).Count + " 个文件")
Say ("插件: " + (Get-ChildItem (Join-Path $dist 'plugin-market') -Recurse -File).Count + " 个文件")

# 插件清单里的版本跟 VERSION 保持一致（必须在生成 manifest 之前）
$pluginJson = Join-Path $dist 'plugin-market\plugins\session-dashboard\.codex-plugin\plugin.json'
if ((Test-Path $pluginJson) -and $version -ne '0.0.0') {
  $j = Get-Content $pluginJson -Raw -Encoding UTF8 | ConvertFrom-Json
  $j.version = $version
  $json = $j | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($pluginJson, $json, (New-Object System.Text.UTF8Encoding($false)))
  Say ("plugin.json 版本 -> $version")
}

# ---- 清单 ----
$files = @{}
Get-ChildItem $dist -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($dist.Length + 1).Replace('\', '/')
  $files[$rel] = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
}
[ordered]@{
  version     = $version
  build       = $build
  generatedAt = (Get-Date).ToString('o')
  files       = $files
} | ConvertTo-Json -Depth 4 | ForEach-Object {
  # 必须无 BOM：下游 JSON 解析器可能不接受 BOM
  [System.IO.File]::WriteAllText((Join-Path $dist 'manifest.json'), $_, (New-Object System.Text.UTF8Encoding($false)))
}
Say ("清单: " + $files.Count + " 个文件（保留模板，可移植）")

# ---- 发布包 ----
if (Test-Path $shareDir) {
  Get-ChildItem $shareDir -Force | Where-Object { $_.Name -notmatch '^install\.|^uninstall\.|^使用说明' } |
    Remove-Item -Recurse -Force
}
New-Item -ItemType Directory -Path $shareDir -Force | Out-Null
Copy-Item (Join-Path $dist 'bar') $shareDir -Recurse -Force
Copy-Item (Join-Path $dist 'plugin-market') $shareDir -Recurse -Force
Copy-Item (Join-Path $dist 'manifest.json') $shareDir -Force
Copy-Item (Join-Path $root 'tools\install.ps1') $shareDir -Force
Copy-Item (Join-Path $root 'tools\reload-page.js') $shareDir -Force
Copy-Item (Join-Path $root 'tools\uninstall.ps1') $shareDir -Force
Copy-Item (Join-Path $root 'tools\render-paths.ps1') $shareDir -Force
Copy-Item (Join-Path $root 'tools\install.cmd') $shareDir -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $root 'tools\uninstall.cmd') $shareDir -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $root 'tools\使用说明.txt') $shareDir -Force -ErrorAction SilentlyContinue

Say '发布包: share/（dist + 安装器脚本）'

# ---- 镜像到运行位置 ----
if (-not $NoMirror) {
  Write-Host ''
  Write-Host '== 渲染路径并同步到运行位置' -ForegroundColor Cyan

  if (Test-Path $installed) {
    Get-ChildItem (Join-Path $dist 'bar') -File | ForEach-Object {
      Copy-Item $_.FullName (Join-Path $installed $_.Name) -Force
    }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $render `
      -BarDir $installed -PluginDir $installed | Out-Null
    Say "~/.codex-bar（已渲染 node/python）"
  }

  # 插件也装在 ~/.codex-bar 下，安装根只有一个
  $installedMarket = Join-Path $installed 'plugin-market'
  if (Test-Path $installed) {
    if (Test-Path $installedMarket) { Remove-Item $installedMarket -Recurse -Force }
    Copy-Item (Join-Path $dist 'plugin-market') $installed -Recurse -Force
    & powershell -NoProfile -ExecutionPolicy Bypass -File $render `
      -BarDir (Join-Path $installedMarket 'plugins\session-dashboard') `
      -PluginDir (Join-Path $installedMarket 'plugins\session-dashboard') | Out-Null
    Say "~/.codex-bar/plugin-market（已渲染 .mcp.json）"
  }
}

# ---- 发布包 zip ----
$pkgDir = Join-Path $root 'dist-package'
if (Test-Path $pkgDir) { Remove-Item $pkgDir -Recurse -Force }
New-Item -ItemType Directory -Path $pkgDir -Force | Out-Null
$zip = Join-Path $pkgDir ("codex-dashboard-{0}.zip" -f $version)
Compress-Archive -Path (Join-Path $shareDir '*') -DestinationPath $zip -Force
Write-Host ''
Write-Host ("发布包: " + $zip + " (" + [math]::Round((Get-Item $zip).Length / 1KB) + " KB)") -ForegroundColor Green

Write-Host ''
Write-Host "构建完成：$version ($build)" -ForegroundColor Green
