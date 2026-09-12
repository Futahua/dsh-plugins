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
  then open an ALREADY-AUTHENTICATED URL.

  That last part matters. The GUI itself answers 401 without a session cookie,
  so opening the plain GUI URL can dump you on "authentication required" - the
  problem the one-tap login link was built to solve. This opens the bridge's
  login URL instead, which sets the session cookie and redirects to the GUI.

  Local by default: 127.0.0.1 on the bridge, no Tailscale round trip.

.PARAMETER Tailnet
  Open the tailnet login URL instead of the loopback one. Useful for checking
  what a phone sees, from this machine.

.PARAMETER Copy
  Do not open a browser; copy the tailnet login URL to the clipboard so it can
  be sent to a phone or tablet. This is the one to use when setting up a new
  device.

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
$keyFile = Join-Path $DshHome 'ts-bridge-key'
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

# --- 2. Build the authenticated URL ------------------------------------------
$key = ''
if (Test-Path -LiteralPath $keyFile) { $key = (Get-Content -LiteralPath $keyFile -Raw).Trim() }

if ($key -eq '') {
    # No key means the bridge has never run. Fall back to the plain GUI URL
    # rather than opening a login URL that cannot work.
    $url = "http://127.0.0.1:{0}/" -f $Port
    Say ("no login key at {0}; opening the plain GUI URL (it may ask for auth)" -f $keyFile)
} elseif ($Tailnet -or $Copy) {
    $url = "http://{0}/__dsh_login?key={1}" -f $Authority, $key
} else {
    $url = "http://127.0.0.1:{0}/__dsh_login?key={1}" -f $BridgePort, $key
}

# --- 3. Open it, or copy it ---------------------------------------------------
if ($Copy) {
    Set-Clipboard -Value $url
    Say 'tailnet login URL copied to the clipboard - send it to the device you want to add.'
    Say 'it stays valid across restarts, so it can be saved as a home-screen bookmark.'
} else {
    Say ("opening {0}" -f ($url -replace 'key=.*$', 'key=<redacted>'))
    Start-Process $url
}
