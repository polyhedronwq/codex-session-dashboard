Option Explicit
Dim sh, fso, dir, nodeExe
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = "{{node}}"
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"
sh.Run """" & nodeExe & """ """ & dir & "\injector.js""", 0, False
