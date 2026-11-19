@echo off
rem Fallback entry point. The desktop / Start-menu shortcut calls launch.vbs directly.
start "" wscript.exe //nologo "%~dp0launch.vbs"
