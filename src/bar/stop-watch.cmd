@echo off
rem Stop the Codex window watcher (reads the pid written by watch-windows.ps1).
set "PIDFILE=%USERPROFILE%\.codex-bar\watch.pid"
if not exist "%PIDFILE%" (
  echo no pid file -- watcher not running
  exit /b 1
)
set /p WPID=<"%PIDFILE%"
taskkill /PID %WPID% /F >nul 2>&1
echo watcher %WPID% stopped
