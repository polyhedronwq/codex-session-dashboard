Option Explicit
Dim sh, fso, dir, codexExe, nodeExe
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
codexExe = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Microsoft\WindowsApps\chatgpt-desktop.exe")

' Use the real node.exe directly: the Volta shim re-execs via "cmd /C node ...",
' which would pop a console window.
nodeExe = "{{node}}"
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"

' Codex is a GUI app: show it normally.
sh.Run """" & codexExe & """ --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223", 1, False
WScript.Sleep 1200
' Injector must stay invisible (0).
sh.Run """" & nodeExe & """ """ & dir & "\injector.js""", 0, False
