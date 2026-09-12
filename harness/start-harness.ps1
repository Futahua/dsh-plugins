#requires -Version 7.0
<#
.SYNOPSIS
  Launch DeepSeek Harness against the relocated home directory.

.DESCRIPTION
  Companion to relocate-dsh-home.ps1 / sync-dsh-home.ps1. It pins DSH_HOME for
  the launched process instead of relying on the persisted User-scope variable,
  because a Windows process inherits the environment its parent had at start:
  Explorer picks up a newly persisted variable only when it restarts, so a
  shortcut created today would otherwise launch the harness against the old
  home until the next sign-out.

  Setting the variable here also keeps the launcher correct no matter who
  starts it — a fresh shell, the desktop shortcut, or a scheduled task.

  The harness launcher is resolved in three tiers, because `dsh` is not
  reliably on PATH:

    1. `dsh` on PATH — true when launched from a shell the harness itself
       spawned, since the npx run injects its own `.bin` directory. That
       directory lives in neither the User nor the Machine PATH, so an
       Explorer-launched shortcut cannot see it.
    2. The cached npx install of `@deepseek-ai/dsh`, run directly with node.
       Offline, instant, and pinned to the version already on disk — the one
       this home's profile, sessions, and plugins were set up against.
    3. `npx --yes @deepseek-ai/dsh@latest`, a last resort that needs the
       registry and may install a different version than the one in use.

  Tier 2 exists because tier 3 alone would silently re-resolve `@latest` on
  every launch: a new upstream release would then start against a home whose
  profile format and plugins were validated against the previous one, and the
  shortcut would fail outright with no network.

.PARAMETER DshHome
  Harness home to use for this process. Default: D:\Letters\MatTroiSeConMoc\.dsh

.PARAMETER WorkingDirectory
  Directory to launch from. This is the agent's workspace root — the profile's
  sandbox policy takes `workspaceRoot` from the process working directory, and
  the session directory key is derived from it. Default: D:\Letters\MatTroiSeConMoc

.PARAMETER Profile
  Profile to boot. Default: web (the GUI profile).

.PARAMETER Check
  Resolve and print everything, then exit without launching. Useful to verify
  the launcher after an environment change; run it under a sanitized PATH to
  confirm what a shortcut would see.

.PARAMETER Passthrough
  Any remaining arguments are forwarded to the harness.

.EXAMPLE
  pwsh -File .\start-harness.ps1 -Check

.EXAMPLE
  pwsh -File .\start-harness.ps1
#>
[CmdletBinding()]
param(
    [string]$DshHome          = 'D:\Letters\MatTroiSeConMoc\.dsh',
    [string]$WorkingDirectory = 'D:\Letters\MatTroiSeConMoc',
    [string]$Profile          = 'web',
    [switch]$Check,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Passthrough
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
  Tier 1: `dsh` on PATH. The npx shim ships an extensionless POSIX script
  beside dsh.cmd, and `Get-Command dsh` can return that one, which PowerShell
  cannot execute — so prefer the Windows entry points in order and fall back to
  the .cmd sibling of an extensionless match.
#>
function Resolve-DshOnPath {
    foreach ($name in @('dsh.cmd', 'dsh.exe', 'dsh.ps1', 'dsh')) {
        $found = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $found) { continue }
        $source = $found.Source
        if ([string]::IsNullOrWhiteSpace($source)) { continue }
        if ([string]::IsNullOrEmpty([IO.Path]::GetExtension($source))) {
            $sibling = "$source.cmd"
            if (Test-Path -LiteralPath $sibling) { return $sibling }
            continue
        }
        return $source
    }
    return $null
}

<#
  Tier 2: the cached npx install, run directly. npx keeps each resolved package
  under <cache>\_npx\<hash>\node_modules, which is exactly what its own shim
  executes; running the bin with node skips the registry entirely. The newest
  cached version wins, with the most recently written cache entry breaking
  ties.
#>
function Resolve-CachedDsh {
    $roots = [System.Collections.Generic.List[string]]::new()
    if ($env:npm_config_cache) { $roots.Add((Join-Path $env:npm_config_cache '_npx')) }
    if ($env:LOCALAPPDATA) { $roots.Add((Join-Path $env:LOCALAPPDATA 'npm-cache\_npx')) }

    $node = Get-Command 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) { $node = Get-Command 'node' -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if (-not $node) { return $null }

    $candidates = [System.Collections.Generic.List[object]]::new()
    foreach ($root in ($roots | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($dir in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
            $manifest = Join-Path $dir.FullName 'node_modules\@deepseek-ai\dsh\package.json'
            if (-not (Test-Path -LiteralPath $manifest)) { continue }
            try { $json = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json } catch { continue }

            # `bin` is an object here, but tolerate the single-string spelling.
            $binProp = $json.PSObject.Properties['bin']
            $binRel = $null
            if ($binProp -and $binProp.Value) {
                if ($binProp.Value -is [string]) { $binRel = $binProp.Value }
                else {
                    $dshProp = $binProp.Value.PSObject.Properties['dsh']
                    if ($dshProp) { $binRel = $dshProp.Value }
                }
            }
            if (-not $binRel) { continue }

            $bin = Join-Path (Split-Path -Parent $manifest) $binRel
            if (-not (Test-Path -LiteralPath $bin)) { continue }

            $versionProp = $json.PSObject.Properties['version']
            $numeric = [version]'0.0.0'
            if ($versionProp -and $versionProp.Value) {
                try { $numeric = [version]([string]$versionProp.Value -replace '-.*$', '') } catch { }
            }
            $candidates.Add([pscustomobject]@{
                Version = [string]$versionProp.Value
                Numeric = $numeric
                Bin     = $bin
                Node    = $node.Source
                Cache   = $dir.FullName
                Written = $dir.LastWriteTimeUtc
            })
        }
    }
    if ($candidates.Count -eq 0) { return $null }
    return $candidates | Sort-Object -Property Numeric, Written -Descending | Select-Object -First 1
}

if (-not (Test-Path -LiteralPath $DshHome)) {
    throw "Harness home not found: $DshHome  (run relocate-dsh-home.ps1, or pass -DshHome)"
}
if (-not (Test-Path -LiteralPath $WorkingDirectory)) {
    throw "Working directory not found: $WorkingDirectory  (pass -WorkingDirectory)"
}

# --- resolve the launcher, tier by tier --------------------------------------
$launcherName = $null
$launcherArgs = @()
$launcherNote = $null

$onPath = Resolve-DshOnPath
if ($onPath) {
    $launcherName = $onPath
    $launcherNote = 'dsh on PATH'
} else {
    $cached = Resolve-CachedDsh
    if ($cached) {
        $launcherName = $cached.Node
        $launcherArgs = @($cached.Bin)
        $launcherNote = ('cached npx install {0}' -f $cached.Version)
    } else {
        $npx = Get-Command 'npx.cmd' -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $npx) {
            throw "Cannot find 'dsh' on PATH, no cached '@deepseek-ai/dsh' under the npm cache, and no 'npx.cmd' to fall back on. Install Node.js/npm, then retry."
        }
        $launcherName = $npx.Source
        $launcherArgs = @('--yes', '@deepseek-ai/dsh@latest')
        $launcherNote = 'npx @latest (needs the registry; may install a different version)'
    }
}

$env:DSH_HOME = $DshHome

# The persisted value is what a future Explorer-started process will inherit;
# if it disagrees, say so rather than silently overriding it forever.
$persisted = [Environment]::GetEnvironmentVariable('DSH_HOME', 'User')
$settingsPath = Join-Path $DshHome 'settings.yaml'
$credentialsPath = Join-Path $DshHome '.credentials.yaml'

if ($Check) {
    Write-Host 'DeepSeek Harness launcher check'
    Write-Host ('  DSH_HOME (this process) : {0}' -f $env:DSH_HOME)
    Write-Host ('  DSH_HOME (persisted)    : {0}' -f $(if ($persisted) { $persisted } else { '<unset>' }))
    Write-Host ('  launcher                : {0}' -f $launcherNote)
    Write-Host ('  resolved command        : {0} {1}' -f $launcherName, ($launcherArgs -join ' '))
    Write-Host ('  profile                 : {0}' -f $Profile)
    Write-Host ('  working directory       : {0}' -f $WorkingDirectory)
    Write-Host ('  settings.yaml           : {0}' -f $(if (Test-Path -LiteralPath $settingsPath) { 'present' } else { 'MISSING' }))
    Write-Host ('  .credentials.yaml       : {0}' -f $(if (Test-Path -LiteralPath $credentialsPath) { 'present' } else { 'absent' }))
    # Mirror the invocation below exactly; joining a lone format string is how
    # the previous version printed "bin.jsweb" with no separator.
    $parts = @($launcherName) + $launcherArgs + @($Profile)
    if ($Passthrough) { $parts += $Passthrough }
    $fullCommand = ($parts | ForEach-Object { if ($_ -match '\s') { '"{0}"' -f $_ } else { $_ } }) -join ' '
    Write-Host ('  full command            : {0}' -f $fullCommand)
    if ($launcherNote -like 'npx @latest*') {
        Write-Warning 'falling back to npx @latest: this needs the registry and may start a version other than the one in use'
    }
    if ($persisted -and $persisted -ne $DshHome) {
        Write-Warning ('persisted DSH_HOME differs from the pinned one; this launch uses {0}' -f $DshHome)
    }
    exit 0
}

if ($persisted -and $persisted -ne $DshHome) {
    Write-Warning ('persisted DSH_HOME is "{0}" but this launcher pins "{1}"' -f $persisted, $DshHome)
}
if ($launcherNote -like 'npx @latest*') {
    Write-Warning 'no cached harness found; npx will resolve @latest from the registry'
}
if (-not (Test-Path -LiteralPath $settingsPath)) {
    Write-Warning ('no settings.yaml in {0}; the harness will start with defaults' -f $DshHome)
}

$Host.UI.RawUI.WindowTitle = 'DeepSeek Harness'
Set-Location -LiteralPath $WorkingDirectory

Write-Host ('DeepSeek Harness  |  profile {0}  |  DSH_HOME {1}' -f $Profile, $env:DSH_HOME)
Write-Host ('launcher          |  {0}' -f $launcherNote)
Write-Host ''

& $launcherName @launcherArgs $Profile @Passthrough
exit $LASTEXITCODE
