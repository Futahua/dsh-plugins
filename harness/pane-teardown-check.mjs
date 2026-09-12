// Slice 16 — teardown check: did the browser leak?
//
// The plugin closes its Chrome from a `ctx.effect` disposer. That disposer only
// runs when the plugin unloads (a `dsh web` restart, or an unload through the
// profile patch), and it cannot be exercised in place: re-enabling a plugin
// needs a module load, and `dsh-base` disables module HMR, so a failed re-enable
// would leave the pane down until a restart.
//
// So the cheap way to close that slice is to look for leaks rather than force an
// unload. Run this after a restart. A healthy result is: every live headless
// Chrome started AFTER the current dsh web, is parented to a live process, and
// there is at most one browser for one server.
//
//   node pane-teardown-check.mjs
//
// Exits non-zero if a leak is found, so it can gate a change.

import { execFileSync } from 'node:child_process'

const POWERSHELL = 'pwsh.exe'

function ps(script) {
  return execFileSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  )
}

function json(script) {
  const out = ps(script).trim()
  return out === '' ? [] : JSON.parse(out)
}

// --- the server ---------------------------------------------------------------
const servers = json(`
  $c = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue |
       Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -First 1
  if (-not $c) { '[]' } else {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
    ConvertTo-Json -Compress @(@{ pid = $p.ProcessId; started = $p.CreationDate.ToString('o'); name = $p.Name })
  }
`)

if (servers.length === 0) {
  console.log('no dsh web listening on 127.0.0.1:3080 — start it first, or the comparison is meaningless')
  process.exitCode = 2
} else {
  const server = servers[0]
  const serverStart = new Date(server.started)
  console.log(`dsh web : pid ${server.pid} (${server.name}), started ${serverStart.toISOString()}`)

  // --- browsers ---------------------------------------------------------------
  const browsers = json(`
    $all = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
           Where-Object { $_.CommandLine -match '--headless' }
    $rows = foreach ($b in $all) {
      $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($b.ParentProcessId)" -ErrorAction SilentlyContinue
      $prof = if ($b.CommandLine -match '--user-data-dir=([^\\s"]+)') { Split-Path $Matches[1] -Leaf } else { '' }
      @{ pid = $b.ProcessId; ppid = $b.ParentProcessId; started = $b.CreationDate.ToString('o');
         parentAlive = [bool]$parent; parentName = if ($parent) { $parent.Name } else { '' }; profile = $prof }
    }
    ConvertTo-Json -Compress @($rows)
  `)

  console.log(`headless chrome processes: ${browsers.length}`)

  const problems = []
  let roots = 0
  for (const b of browsers) {
    const started = new Date(b.started)
    const isRoot = b.parentName === 'node.exe'
    if (isRoot) roots += 1
    const notes = []
    if (!b.parentAlive) notes.push('ORPHAN (parent process is gone)')
    if (started < serverStart) notes.push('predates the current dsh web')
    if (isRoot && b.profile === '') notes.push('root process with no recognisable profile')
    console.log(
      `  pid ${b.pid}  started ${started.toISOString().slice(11, 19)}  ` +
        `parent=${b.parentAlive ? b.parentName : 'DEAD'}  profile=${b.profile || '-'}` +
        (notes.length ? `   <-- ${notes.join('; ')}` : ''),
    )
    if (notes.length) problems.push(`pid ${b.pid}: ${notes.join('; ')}`)
  }

  if (roots > 1) problems.push(`${roots} browser roots alive — expected one per server`)

  // --- profile directories ----------------------------------------------------
  const profiles = json(`
    $d = Get-ChildItem $env:TEMP -Directory -Filter 'puppeteer_dev_chrome_profile-*' -ErrorAction SilentlyContinue
    ConvertTo-Json -Compress @($d | ForEach-Object { @{ name = $_.Name; mtime = $_.LastWriteTime.ToString('o') } })
  `)
  console.log(`\nprofile directories on disk: ${profiles.length} (leftovers are temp litter, not processes)`)

  console.log('')
  if (problems.length === 0) {
    console.log('PASS  no leaked browser: every live instance is parented and postdates the server')
  } else {
    console.log('FAIL  possible teardown leak:')
    for (const p of problems) console.log(`  - ${p}`)
    process.exitCode = 1
  }
}
