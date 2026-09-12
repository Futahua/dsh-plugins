#requires -Version 7.0
<#
.SYNOPSIS
  Open the DSH Web GUI, bringing it up first if it is not already running.

.DESCRIPTION
  The everyday entry point, and what the desktop shortcut runs. It is
  deliberately more than "open a URL": if the harness is not running, a bare
  bookmark would land on a connection error, which is exactly the confusing
  state this is meant to remove.

  So: ensure the stack is up (delegating to boot-dsh.ps1, which is idempotent),
  then open the GUI.

  No key or password is involved. The auth bridge signs in any top-level
  navigation that arrives without a session, so any device that can reach the
  bridge is in - and the only devices that can reach it are on the tailnet.
  Tailnet membership is the credential.

  Local by default: 127.0.0.1 on the bridge, no Tailscale round trip.

.PARAMETER Tailnet
  Open the tailnet URL instead of the loopback one. Useful for checking what a
  phone sees, from this machine.

.PARAMETER Copy
  Do not open a browser; copy the tailnet URL to the clipboard, for setting up a
  new device. Only Tailscale has to be installed there first.

.PARAMETER Authority
  Tailnet authority used by -Tailnet and -Copy. Default sloptop.taild88607.ts.net:3080.

.PARAMETER Quiet
  Suppress progress output.

.EXAMPLE
  pwsh -File open-dsh.ps1

.EXAMPLE
  pwsh -File open-dsh.ps1 -Copy
#>
[CmdletBinding()]
param(
    [string]$DshHome          = 'D:\Letters\MatTroiSeConMoc\.dsh',
    [string]$WorkingDirectory = 'D:\Letters\MatTroiSeConMoc',
    [int]$Port                = 3080,
    [int]$BridgePort          = 3099,
    [string]$Authority        = 'sloptop.taild88607.ts.net:3080',
    [switch]$Tailnet,
    [switch]$Copy,
    [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$boot    = Join-Path $DshHome 'boot-dsh.ps1'
$pwshExe = Join-Path $PSHOME 'pwsh.exe'
if (-not (Test-Path -LiteralPath $pwshExe)) { $pwshExe = 'pwsh' }

function Say([string]$Message) { if (-not $Quiet) { Write-Host $Message } }

# --- 1. Make sure the stack is up --------------------------------------------
if (Test-Path -LiteralPath $boot) {
    Say 'ensuring the harness is up...'
    & $pwshExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $boot -Quiet -DshHome $DshHome -WorkingDirectory $WorkingDirectory -Port $Port | Out-Null
} else {
    Say ("boot script not found at {0}; opening the URL anyway" -f $boot)
}

# --- 2. Build the URL ---------------------------------------------------------
# No key, no login path: the bridge signs in any top-level navigation, so simply
# opening the GUI is enough. Loopback by default to avoid a Tailscale round trip.
if ($Tailnet -or $Copy) {
    $url = "http://{0}/" -f $Authority
} else {
    $url = "http://127.0.0.1:{0}/" -f $BridgePort
}

# --- 3. Open it, or copy it ---------------------------------------------------
if ($Copy) {
    Set-Clipboard -Value $url
    Say 'tailnet URL copied - open it on any device that is on the tailnet.'
    Say 'no key or password is needed; it can be saved as a home-screen bookmark.'
} else {
    Say ("opening {0}" -f $url)
    Start-Process $url
}
