@echo off
chcp 65001 >nul
title Codex 底栏卸载
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
echo.
pause
