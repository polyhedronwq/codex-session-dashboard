@echo off
chcp 65001 >nul
title Codex 底栏安装
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
