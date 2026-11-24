Option Explicit
Dim sh, fso, dir, codexExe, nodeExe, barDir, pauseFile
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
codexExe = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Microsoft\WindowsApps\chatgpt-desktop.exe")

' Use the real node.exe directly: the Volta shim re-execs via "cmd /C node ...",
' which would pop a console window.
nodeExe = "{{node}}"
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"

' 正常启动时清掉"暂停守护"标记：上次 stop-bar / 测试留下的标记不能阻止这次拉起。
pauseFile = dir & "\.supervisor-pause"
On Error Resume Next
If fso.FileExists(pauseFile) Then fso.DeleteFile pauseFile, True
On Error GoTo 0

' Codex is a GUI app: show it normally.
sh.Run """" & codexExe & """ --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223", 1, False
WScript.Sleep 1200
' 守护进程必须在后台（0）：它拉起 injector.js，并在它意外退出时自动重启。
sh.Run """" & nodeExe & """ """ & dir & "\supervisor.js""", 0, False
