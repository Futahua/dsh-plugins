#requires -Version 7.0
<#
.SYNOPSIS
  Restart the DSH Web GUI in place, then re-assert the Tailscale Serve path.

.DESCRIPTION
  Host-side plugin code (a plugin's index.js) is not watched: dsh-base disables
  module HMR, so a newly installed or edited host half loads only at boot.
  Editing cordis.patch.yml alone is not enough — the row may be reconciled, but
  there is no module to load until the process restarts.

  This has to be driven from outside a turn. dsh web is the process that hosts
  the agent session: an agent that killed it would destroy its own turn before
  it could report the result, and if the relaunch then failed you would be left
  with no GUI and — on a phone or iPad — no terminal to fix it from. So the
  restart is a script you run, not something the agent does to itself.

  The order below is deliberate:

    1. Resolve the launcher FIRST and abort on failure. A resolution problem
       must never leave the GUI stopped with no way back up.
    2. Stop only the loopback listener. tailscaled also listens on this port on
       the tailnet address; killing that would take Tailscale Serve down with it.
    3. Refuse to kill anything that is not node.exe.
    4. Wait for the port to actually free before relaunching, so the new server
       cannot race the old socket.
    5. Relaunch through start-harness.ps1, which pins DSH_HOME and resolves dsh
       in three tiers, forwarding --no-open so no browser tab is spawned.
    6. Re-run startup.ps1 to re-assert the Serve mapping and reprint the login
       URL, then probe /browser-pane/stream: it 404s when the browser-agent host
       half is not loaded and answers otherwise, so the status code is a real
       loaded/not-loaded signal rather than a guess.

  Everything is appended to .dsh\restart-harness.log.

.PARAMETER Port
  The dsh web loopback listen port. Default 3080.

.PARAMETER StartupTimeoutSec
  How long to wait for the relaunched server to answer. Default 300.

.PARAMETER SkipStartup
  Do not run startup.ps1 afterwards (leaves the Serve mapping untouched).

.EXAMPLE
  pwsh -File .\restart-harness.ps1

.EXAMPLE
  pwsh -File .\restart-harness.ps1 -SkipStartup
#>
[CmdletBinding()]
param(
    [string]$DshHome          = 'D:\Letters\MatTroiSeConMoc\.dsh',
    [string]$WorkingDirectory = 'D:\Letters\MatTroiSeConMoc',
    [int]$Port                = 3080,
    [int]$BridgePort          = 3099,
    [int]$StartupTimeoutSec   = 300,
    [switch]$SkipStartup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$launcher = Join-Path $WorkingDirectory 'start-harness.ps1'
$startup  = Join-Path $DshHome 'startup.ps1'
$log      = Join-Path $DshHome 'restart-harness.log'
$pwshExe  = Join-Path $PSHOME 'pwsh.exe'
if (-not (Test-Path -LiteralPath $pwshExe)) { $pwshExe = 'pwsh' }

function Say([string]$Message) {
    $line = '{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message
    Write-Host $line
    Add-Content -LiteralPath $log -Value $line
}

# The loopback listener only. tailscaled binds the tailnet address AND an IPv6
# address on this same port, so an unfiltered lookup can hand back Tailscale.
function Get-LoopbackListener([int]$p) {
    $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    foreach ($c in @($conns)) {
        if ($c.LocalAddress -eq '127.0.0.1' -or $c.LocalAddress -eq '::1') { return $c }
    }
    return $null
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

# Read only the status line off a raw socket. The route table matches on
# pathname alone, so a GET against a POST route still proves the route exists —
# which is all this needs. A normal HTTP client is unusable for the SSE route
# because the response body never ends; here the headers (and therefore the
# status) arrive immediately and the body is simply never read.
function Get-RouteStatus([string]$TargetHost, [int]$TargetPort, [string]$Path, [int]$TimeoutMs = 5000) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $client.Connect($TargetHost, $TargetPort)
        $stream = $client.GetStream()
        $stream.ReadTimeout = $TimeoutMs
        # Host must match the loopback authority or DSH's browser-trust fence
        # answers 403 for reasons that have nothing to do with the route.
        $request = "GET $Path HTTP/1.1`r`nHost: ${TargetHost}:${TargetPort}`r`nAccept: text/event-stream`r`nConnection: close`r`n`r`n"
        $bytes = [System.Text.Encoding]::ASCII.GetBytes($request)
        $stream.Write($bytes, 0, $bytes.Length)
        $buf = New-Object byte[] 256
        $n = $stream.Read($buf, 0, 256)
        if ($n -le 0) { return $null }
        $head = [System.Text.Encoding]::ASCII.GetString($buf, 0, $n)
        if ($head -match '^HTTP/\d\.\d\s+(\d{3})') { return [int]$Matches[1] }
        return $null
    } catch {
        return $null
    } finally {
        $client.Close()
    }
}

Say '================ restart-harness ================'

# --- 1. Resolve the launcher before stopping anything -------------------------
if (-not (Test-Path -LiteralPath $launcher)) { throw "launcher not found: $launcher" }
Say 'step 1/6  resolving the launcher'
$check = & $pwshExe -NoLogo -NoProfile -File $launcher -Check 2>&1
$checkExit = $LASTEXITCODE
foreach ($line in @($check)) { Say ("          {0}" -f $line) }
if ($checkExit -ne 0) { throw "start-harness.ps1 -Check failed (exit $checkExit); nothing was stopped" }

# --- 2/3. Identify and verify the target process ------------------------------
Say ("step 2/6  locating the loopback listener on 127.0.0.1:{0}" -f $Port)
# Baseline before anything is stopped. 404 means the route is absent, so the
# post-restart reading is a real before/after signal and not a bare status code
# that could mean anything.
$paneBefore = Get-RouteStatus '127.0.0.1' $Port '/browser-pane/stream'
Say ("          baseline /browser-pane/stream -> {0}" -f $(if ($null -eq $paneBefore) { 'no answer' } else { "HTTP $paneBefore" }))
$listener = Get-LoopbackListener $Port
$targetPid = $null
if ($null -eq $listener) {
    Say '          nothing listening; nothing to stop'
} else {
    $targetPid = $listener.OwningProcess
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction SilentlyContinue
    if ($null -eq $proc) { throw "could not read PID $targetPid" }
    if ($proc.Name -ne 'node.exe') {
        throw ("127.0.0.1:{0} is owned by {1} (PID {2}), not node.exe - refusing to kill it" -f $Port, $proc.Name, $targetPid)
    }
    Say ("          stopping PID {0} ({1})" -f $targetPid, $proc.Name)
    Stop-Process -Id $targetPid -Force
}

# --- 4. Wait for the port to free ---------------------------------------------
if ($null -ne $targetPid) {
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if ($null -eq (Get-LoopbackListener $Port)) { break }
        Start-Sleep -Milliseconds 400
    }
    if ($null -ne (Get-LoopbackListener $Port)) { throw "port $Port is still held after 30s; not relaunching" }
    Say 'step 3/6  port released'
}

# --- 5. Relaunch --------------------------------------------------------------
Say 'step 4/6  relaunching dsh web'
# -NoExit keeps the window open if dsh web exits immediately, so a startup
# failure stays readable instead of vanishing with the console.
# Not $args: that is a PowerShell automatic variable and assigning to it inside
# a parameterised script is asking for trouble.
$launchArgs = @('-NoLogo', '-NoExit', '-File', $launcher, '--no-open')
Start-Process -FilePath $pwshExe -ArgumentList $launchArgs -WorkingDirectory $WorkingDirectory
Say ("          launched: pwsh {0}" -f ($launchArgs -join ' '))

Say ("step 5/6  waiting for http://127.0.0.1:{0}/ to answer" -f $Port)
$deadline = (Get-Date).AddSeconds($StartupTimeoutSec)
$serving  = $null
while ((Get-Date) -lt $deadline) {
    $serving = Get-HttpStatus ("http://127.0.0.1:{0}/" -f $Port)
    if ($null -ne $serving) { break }
    Start-Sleep -Seconds 2
}
if ($null -eq $serving) { throw "dsh web did not answer within ${StartupTimeoutSec}s; check the launcher window" }
Say ("          serving (HTTP {0}; 401 is expected - the GUI is auth-gated)" -f $serving)

# --- 6. Re-assert Serve + verify the browser-agent route ----------------------
if (-not $SkipStartup) {
    if (Test-Path -LiteralPath $startup) {
        Say 'step 6/6  re-asserting the Tailscale Serve path'
        $su = & $pwshExe -NoLogo -NoProfile -File $startup 2>&1
        foreach ($line in @($su)) { Say ("          {0}" -f $line) }
    } else {
        Say ("step 6/6  startup.ps1 not found at {0}; skipping" -f $startup)
    }
}

$pane = Get-RouteStatus '127.0.0.1' $Port '/browser-pane/stream'
if ($null -eq $pane) {
    Say 'verify    /browser-pane/stream did not answer - plugin state unknown'
} elseif ($pane -eq 404) {
    Say ("verify    /browser-pane/stream still HTTP 404 (was {0}): the browser-agent host half did NOT load" -f $(if ($null -eq $paneBefore) { 'no answer' } else { "HTTP $paneBefore" }))
} else {
    Say ("verify    /browser-pane/stream -> HTTP {0} (was {1}): browser-agent host half IS loaded" -f $pane, $(if ($null -eq $paneBefore) { 'no answer' } else { "HTTP $paneBefore" }))
}

# The client half is a genuinely separate signal. The host half can register its
# routes while the pane still never appears, because whether the pane mounts is
# decided by the boot graph injected into index.html. Fetching index.html
# directly on the loopback port answers 401, so this goes through the auth
# bridge, which signs document navigations. Best effort: a missing bridge
# reports "not checked" rather than a false negative.
$clientRow = $null
try {
    $idx = Invoke-WebRequest ("http://127.0.0.1:{0}/" -f $BridgePort) -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    $clientRow = [bool]($idx.Content -match 'try-works')
} catch {
    $clientRow = $null
}
if ($null -eq $clientRow) {
    Say ("verify    client half NOT CHECKED (no answer from the bridge on {0})" -f $BridgePort)
} elseif ($clientRow) {
    Say 'verify    index.html boot graph carries the browser-agent row: client half is registered'
} else {
    Say 'verify    index.html boot graph does NOT mention the plugin: the pane will not mount'
}

Say 'done. Reload the GUI tab: index.html carries no cache validators, and the'
Say '      pane bundle is a revisioned URL the browser has never fetched, so a'
Say '      plain reload is enough. Ctrl+F5 is harmless if in doubt.'
Say ("log: {0}" -f $log)
