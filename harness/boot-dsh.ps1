#requires -Version 7.0
<#
.SYNOPSIS
  Bring the whole DSH setup up at logon: the Web GUI, then the Tailscale bridge.

.DESCRIPTION
  This is the logon entry point (run by dsh-tailscale-bridge.vbs in the user's
  Startup folder). It exists because startup.ps1 alone was not enough: startup.ps1
  waits for `dsh web` to be serving and then starts the bridge, but nothing ever
  started `dsh web`. After a reboot the bridge would come up, wait its full five
  minutes for a server that was never launched, and the GUI would stay dark until
  someone ran start-harness.ps1 by hand.

  So the order is: make sure the server is up first, then hand off to
  startup.ps1 for the bridge and the Serve mapping.

  Idempotent and safe to run at any time. If the GUI is already serving, nothing
  is started and it goes straight to the bridge step.

  `dsh web` is launched detached with its output redirected to log files rather
  than into a hidden console. A console nobody reads is a slow trap: once its
  output buffer fills, the writing process blocks. Redirecting also means the
  server keeps running after this script exits, and its log survives for
  debugging.

.PARAMETER Port
  The dsh web loopback listen port. Default 3080.

.PARAMETER SkipServer
  Do not attempt to start the GUI; only run the bridge step. Useful when the
  server is deliberately being run in the foreground elsewhere.

.PARAMETER Quiet
  Suppress console output (used by the logon entry).

.EXAMPLE
  pwsh -File boot-dsh.ps1

.EXAMPLE
  pwsh -File boot-dsh.ps1 -Quiet
#>
[CmdletBinding()]
param(
    [string]$DshHome          = 'D:\Letters\MatTroiSeConMoc\.dsh',
    [string]$WorkingDirectory = 'D:\Letters\MatTroiSeConMoc',
    [int]$Port                = 3080,
    [int]$StartupTimeoutSec   = 300,
    [switch]$SkipServer,
    [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$launcher = Join-Path $WorkingDirectory 'start-harness.ps1'
$startup  = Join-Path $DshHome 'startup.ps1'
$log      = Join-Path $DshHome 'boot-dsh.log'
$outLog   = Join-Path $DshHome 'dsh-web.log'
$errLog   = Join-Path $DshHome 'dsh-web.err.log'
$pwshExe  = Join-Path $PSHOME 'pwsh.exe'
if (-not (Test-Path -LiteralPath $pwshExe)) { $pwshExe = 'pwsh' }

function Say([string]$Message) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    if (-not $Quiet) { Write-Host $line }
    Add-Content -LiteralPath $log -Value $line
}

# The loopback listener only: tailscaled also binds this port on the tailnet
# address, and that is not the process this script manages.
function Test-Loopback([int]$p) {
    $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    foreach ($c in @($conns)) {
        if ($c.LocalAddress -eq '127.0.0.1' -or $c.LocalAddress -eq '::1') { return $true }
    }
    return $false
}

# Returns the HTTP status code, or $null when nothing answered at all.
function Get-HttpStatus([string]$Url) {
    try {
        $r = Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        return [int]$r.StatusCode
    } catch {
        # StrictMode: a connection error has no Response property at all, so a
        # bare $_.Exception.Response throws instead of returning $null.
        $response = $_.Exception.PSObject.Properties['Response']
        if ($response -and $response.Value) { return [int]$response.Value.StatusCode }
        return $null
    }
}

Say '================ boot-dsh ================'

# --- 1. Make sure the GUI is up ----------------------------------------------
$alreadyUp = $false
if (Test-Loopback $Port) {
    $status = Get-HttpStatus ("http://127.0.0.1:{0}/" -f $Port)
    if ($null -ne $status) {
        # Any answer, including the expected 401, means the server is serving.
        Say ("gui already serving on 127.0.0.1:{0} (HTTP {1}) - leaving it alone" -f $Port, $status)
        $alreadyUp = $true
    } else {
        Say ("127.0.0.1:{0} is listening but not answering yet; will wait rather than start a second server" -f $Port)
        $alreadyUp = $true
    }
}

if ($alreadyUp) {
    # Nothing to start.
} elseif ($SkipServer) {
    Say 'server start skipped (-SkipServer)'
} elseif (-not (Test-Path -LiteralPath $launcher)) {
    Say ("launcher not found: {0} - cannot start the gui" -f $launcher)
} else {
    Say ("starting the gui via {0} (detached, logs redirected)" -f (Split-Path -Leaf $launcher))
    # -no-open: no browser tab at logon. Redirection, not a hidden console.
    $launchArgs = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcher, '--no-open')
    Start-Process -FilePath $pwshExe -ArgumentList $launchArgs `
        -WorkingDirectory $WorkingDirectory -WindowStyle Hidden `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog
}

# --- 2. Wait for it to answer -------------------------------------------------
$deadline = (Get-Date).AddSeconds($StartupTimeoutSec)
$serving  = $null
while ((Get-Date) -lt $deadline) {
    $serving = Get-HttpStatus ("http://127.0.0.1:{0}/" -f $Port)
    if ($null -ne $serving) { break }
    Start-Sleep -Seconds 2
}
if ($null -eq $serving) {
    Say ("gui did not answer within {0}s - see {1}" -f $StartupTimeoutSec, $errLog)
} else {
    Say ("gui serving (HTTP {0}; 401 is expected - the GUI is auth-gated)" -f $serving)
}

# --- 3. Bridge + Serve mapping, and the login link ----------------------------
if (Test-Path -LiteralPath $startup) {
    Say 'running startup.ps1 for the bridge and the Serve mapping'
    $su = & $pwshExe -NoLogo -NoProfile -File $startup -Quiet 2>&1
    foreach ($line in @($su)) { Say ("  {0}" -f $line) }
} else {
    Say ("startup.ps1 not found at {0}; skipping the bridge step" -f $startup)
}

Say 'boot complete'
