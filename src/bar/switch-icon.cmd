@echo off
chcp 65001 >nul
title 切换 Codex 图标
echo 1 = 白色图标（默认，适合深色任务栏）
echo 2 = 黑色图标（适合浅色任务栏）
echo.
set /p choice=请输入 1 或 2 后回车：
if "%choice%"=="2" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0switch-icon.ps1" -Variant black
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0switch-icon.ps1" -Variant white
)
echo.
pause
