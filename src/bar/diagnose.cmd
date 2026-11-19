@echo off
rem One-shot diagnostic snapshot: writes %USERPROFILE%\.codex-bar\diagnose.txt
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose.ps1" %*
if /i "%1"=="-Show" goto :eof
type "%USERPROFILE%\.codex-bar\diagnose.txt"
