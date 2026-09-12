#requires -Version 7.0
<#
.SYNOPSIS
  Create (or refresh) the desktop shortcuts for the DSH setup.

.DESCRIPTION
  Idempotent: re-running overwrites the shortcuts in place, so this is the way to
  repair them after a path change.

  Four shortcuts, each a different job, because conflating them is what made the
  original setup confusing:

  | Shortcut | Runs | Job |
  | --- | --- | --- |
  | DeepSeek Harness | open-dsh.ps1 | the everyday one: ensure it is up, then open an authenticated GUI |
  | DSH Restart | restart-harness.ps1 | reload after a plugin change, then verify both halves |
  | DSH Console | start-harness.ps1 | foreground run, visible log - for debugging |
  | DSH Phone Link | open-dsh.ps1 -Copy | put the tailnet login URL on the clipboard for a new device |

  The launcher shortcuts start pwsh minimised rather than hidden: a flash of
  console is worth it, because a hidden window that fails leaves you with no
  indication that anything happened at all.

.PARAMETER DshHome
  Harness home. Default D:\Letters\MatTroiSeConMoc\.dsh

.PARAMETER WorkingDirectory
  The harness workspace root. Default D:\Letters\MatTroiSeConMoc

.PARAMETER StartMenu
  Also create the shortcuts in the Start Menu, so they are searchable.

.EXAMPLE
  pwsh -File install-shortcuts.ps1

.EXAMPLE
  pwsh -File install-shortcuts.ps1 -StartMenu
#>
[CmdletBinding()]
param(
    [string]$DshHome          = 'D:\Letters\MatTroiSeConMoc\.dsh',
    [string]$WorkingDirectory = 'D:\Letters\MatTroiSeConMoc',
    [switch]$StartMenu
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$pwshExe = Join-Path $PSHOME 'pwsh.exe'
if (-not (Test-Path -LiteralPath $pwshExe)) { throw "pwsh not found at $pwshExe" }

$open    = Join-Path $DshHome 'open-dsh.ps1'
$restart = Join-Path $WorkingDirectory 'restart-harness.ps1'
$console = Join-Path $WorkingDirectory 'start-harness.ps1'

foreach ($p in @($open, $restart, $console)) {
    if (-not (Test-Path -LiteralPath $p)) { throw "required script missing: $p" }
}

# Minimised (7), not hidden: a failed launch should leave a taskbar button
# rather than vanishing without trace.
$minimised = 7
$normal    = 1

# KeepOpen adds -NoExit so the console survives to be read. Only the two
# shortcuts that print something worth reading get it; the other two finish and
# should take their window with them.
$definitions = @(
    @{ Name = 'DeepSeek Harness'; Script = $open;    Arguments = '';      Window = $minimised; KeepOpen = $false; Description = 'Open the DSH Web GUI (starts it if needed)' }
    @{ Name = 'DSH Restart';      Script = $restart; Arguments = '';      Window = $normal;    KeepOpen = $true;  Description = 'Restart DSH and verify the plugin halves' }
    @{ Name = 'DSH Console';      Script = $console; Arguments = '';      Window = $normal;    KeepOpen = $true;  Description = 'Run DSH in the foreground with a visible log' }
    @{ Name = 'DSH Phone Link';   Script = $open;    Arguments = '-Copy'; Window = $minimised; KeepOpen = $false; Description = 'Copy the tailnet login URL for a phone or tablet' }
)

$targets = @([Environment]::GetFolderPath('Desktop'))
if ($StartMenu) {
    $targets += (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
}

$shell = New-Object -ComObject WScript.Shell
$created = 0

foreach ($dir in $targets) {
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    foreach ($d in $definitions) {
        $path = Join-Path $dir ($d.Name + '.lnk')
        $lnk = $shell.CreateShortcut($path)
        $lnk.TargetPath       = $pwshExe
        $noExit               = if ($d.KeepOpen) { '-NoExit ' } else { '' }
        $extra                = if ($d.Arguments) { ' ' + $d.Arguments } else { '' }
        $lnk.Arguments        = ('-NoLogo {0}-ExecutionPolicy Bypass -File "{1}"{2}' -f $noExit, $d.Script, $extra)
        $lnk.WorkingDirectory = $WorkingDirectory
        $lnk.WindowStyle      = $d.Window
        $lnk.Description      = $d.Description
        $lnk.IconLocation     = "$pwshExe,0"
        $lnk.Save()
        Write-Host ('  {0}  ->  {1}' -f $path, (Split-Path -Leaf $d.Script))
        $created++
    }
}

Write-Host ''
Write-Host ("{0} shortcut(s) written." -f $created)
Write-Host 'The logon entry is separate: dsh-boot.vbs in the Startup folder boots the stack at sign-in.'
