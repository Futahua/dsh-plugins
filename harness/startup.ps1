# Keep the DSH GUI reachable on Tailscale.
#
# Invoked at logon by dsh-tailscale-bridge.vbs in the user's Startup folder
# (see TAILSCALE-SERVE.md for why this is not a scheduled task), and safe to run
# by hand at any time. Idempotent: it waits for DSH to be serving, starts the
# bridge if it is not already up, and re-asserts the Serve mapping if it drifted.
#
#   usage: pwsh -File startup.ps1 [-Quiet]
param(
    [switch]$Quiet
)
$ErrorActionPreference = 'Stop'

$dshHome    = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridge     = Join-Path $dshHome 'ts-dsh-bridge.mjs'
$log        = Join-Path $dshHome 'ts-bridge.log'
$errLog     = Join-Path $dshHome 'ts-bridge.err.log'
$tailscale  = 'C:\Program Files\Tailscale\tailscale.exe'
$upstream   = 3080        # dsh web
$bridgePort = 3099
$servePort  = 3080        # tailnet-facing

function Say($msg) { if (-not $Quiet) { Write-Host $msg } }

function Test-Listening([int]$Port) {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $c -and @($c).Count -gt 0
}

# --- 1. Wait for dsh web to be serving (it may still be starting at boot) -----
$deadline = (Get-Date).AddMinutes(5)
while ((Get-Date) -lt $deadline) {
    if (Test-Listening $upstream) {
        try {
            $r = Invoke-WebRequest "http://127.0.0.1:$upstream/" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            Say "dsh web is serving (HTTP $($r.StatusCode))"
            break
        } catch {
            # A 401 here still proves DSH is answering.
            if ($_.Exception.Response) { Say "dsh web is serving (HTTP $([int]$_.Exception.Response.StatusCode))"; break }
        }
    }
    Start-Sleep -Seconds 3
}
if (-not (Test-Listening $upstream)) {
    Say "dsh web is not listening on $upstream; starting bridge anyway (it will forward once DSH is up)"
}

# --- 2. Start the bridge if it is not already running -------------------------
if (Test-Listening $bridgePort) {
    Say "bridge already listening on 127.0.0.1:$bridgePort"
} else {
    Start-Process -FilePath 'node' -ArgumentList $bridge -WindowStyle Hidden `
        -RedirectStandardOutput $log -RedirectStandardError $errLog
    $ok = $false
    foreach ($i in 1..15) {
        Start-Sleep -Seconds 1
        if (Test-Listening $bridgePort) { $ok = $true; break }
    }
    if (-not $ok) { throw "bridge did not start; see $errLog" }
    Say "bridge started on 127.0.0.1:$bridgePort"
}

# --- 2b. Keep the bridge log bounded ------------------------------------------
# Start-Process truncates these on each start, so growth is normally slow; this
# caps the pathological case of a long-lived bridge logging many denials.
foreach ($f in @($log, $errLog)) {
    if ((Test-Path $f) -and (Get-Item $f).Length -gt 1MB) {
        Move-Item $f "$f.1" -Force
        Say "rotated $(Split-Path -Leaf $f)"
    }
}

# --- 3. Re-assert the Tailscale Serve mapping ---------------------------------
if (Test-Path $tailscale) {
    try {
        $status = & $tailscale serve status 2>&1 | Out-String
        if ($status -match "127\.0\.0\.1:$bridgePort") {
            Say "serve mapping already points at the bridge"
        } else {
            & $tailscale serve --bg --http=$servePort $bridgePort | Out-Null
            Say "serve mapping re-applied"
        }
    } catch {
        Say "could not verify serve mapping: $($_.Exception.Message)"
    }
} else {
    Say "Tailscale CLI not found at $tailscale"
}

Say "ready: http://sloptop.taild88607.ts.net:$servePort/"

# --- 4. Say where the GUI is --------------------------------------------------
# No login link to print any more: the bridge signs in any device that reaches
# it, so tailnet membership is the only credential. See ts-dsh-bridge.mjs.
Say "open:   any device on the tailnet -> http://sloptop.taild88607.ts.net:$servePort/"
