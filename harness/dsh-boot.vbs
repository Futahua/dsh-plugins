' Bring the DSH stack up at logon: the Web GUI first, then the Tailscale bridge.
'
' Placed in the user's Startup folder, which needs no administrator rights
' (a scheduled task would). Runs boot-dsh.ps1 fully hidden (0 = hidden window),
' so nothing flashes on screen at sign-in.
'
' boot-dsh.ps1 is idempotent: if the GUI is already serving it starts nothing,
' so this is safe even if the harness was launched by hand first.
Option Explicit
Dim shell, script
Set shell = CreateObject("WScript.Shell")
script = "D:\Letters\MatTroiSeConMoc\.dsh\boot-dsh.ps1"
shell.Run "pwsh.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & script & """ -Quiet", 0, False
