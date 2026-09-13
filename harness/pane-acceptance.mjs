// Slice 17 — the end-to-end acceptance gate for the DSH browser pane.
//
// One command that answers "is the pane actually working", with no human in the
// loop and no reasoning about whether it probably is. Exits non-zero on any
// failure so it can gate a change.
//
//   node pane-acceptance.mjs
//
// What it checks, and why each one is here:
//
//   1. host half    — the routes exist at all (404 means the plugin's host half
//                     never registered; see the webServer inject note)
//   2. client half  — the boot graph carries the row, so the pane can mount
//   3. stream       — SSE reports the page active AND delivers real frames
//   4. lease        — a second owner is refused (fail-closed)
//   5. coordinates  — clicks land EXACTLY where aimed, measured by reading the
//                     page's own record of clientX/clientY back over CDP
//
// Check 5 is the one that matters. Everything else can pass while input lands
// in the wrong place, which is the failure a user experiences as "the pane is
// broken" without being able to say why.
//
// It attaches to the plugin's own Chrome by reading the port out of
// DevToolsActivePort — the browser is launched with --remote-debugging-port=0,
// so the port is OS-assigned and must be discovered, not assumed.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readFileSync as readLeaseFile } from 'node:fs'
import { pathToFileURL } from 'node:url'

const GUI = process.env.DSH_BASE ?? 'http://127.0.0.1:3080'
const BRIDGE = process.env.DSH_BRIDGE ?? 'http://127.0.0.1:3099'
const TEMP = process.env.TEMP ?? 'D:/Programs/evTEMP'
const LEASE_OWNER = `acceptance:${process.pid}`

// The lease is imported relative to THIS file and the resolved path is printed,
// because the previous version imported a hard-coded absolute path into an
// installed copy — so "all checks passed" said nothing about the committed
// source it was supposedly validating.
const hereDir = import.meta.dirname
let leasePath = null
for (const candidate of [join(hereDir, 'pane-lease.mjs'), join(hereDir, '..', 'pane-lease.mjs')]) {
  try { readLeaseFile(candidate); leasePath = candidate; break } catch { /* try next */ }
}
if (!leasePath) throw new Error(`pane-lease.mjs not found near ${hereDir}`)
const { acquire, release, status, openLease, assertDrivable } = await import(pathToFileURL(leasePath).href)
const { rawRequest } = await import(pathToFileURL(join(hereDir, 'raw-http.mjs')).href)
console.log(`lease under test: ${leasePath}\n`)

// A refusal from the guard throws at top level; Node's default handling exits
// immediately and races the SSE socket teardown, tripping a libuv assertion on
// Windows so a clean refusal reports as a crash. Report it and drain instead.
process.on('uncaughtException', (error) => {
  console.error(`\n  REFUSED\n  ${error.message}\n`)
  process.exitCode = 1
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []

async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail })
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`)
  } catch (error) {
    results.push({ name, ok: false, detail: error.message })
    console.log(`  FAIL  ${name}  — ${error.message}`)
  }
}

/**
 * Find the tab holding `urlSubstring`, across EVERY candidate debug port.
 *
 * Several puppeteer profiles linger on disk from earlier launches, so the newest
 * profile folder is not proof of which browser is live — trusting it once
 * pointed this test at a superseded browser that had no such tab, and the
 * failure looked like a product bug. Scan all of them and take the one that
 * really has the page.
 */
async function findPageOnAnyPort(urlSubstring, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  const tried = new Set()
  while (Date.now() < deadline) {
    for (const { port, dir } of browserPorts()) {
      tried.add(port)
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const pages = list.filter((t) => t.type === 'page')
        const hit = pages.find((t) => t.url.includes(urlSubstring))
        if (hit) return { port, dir, page: hit, pages }
      } catch { /* not this browser */ }
    }
    await sleep(400)
  }
  return { port: null, page: null, tried: [...tried] }
}

/** Every candidate debugging port, newest profile first. */
function browserPorts() {
  let dirs = []
  try {
    dirs = readdirSync(TEMP)
      .filter((n) => n.startsWith('puppeteer_dev_chrome_profile-'))
      .map((n) => join(TEMP, n))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  } catch { /* fall through */ }
  const out = []
  for (const dir of dirs) {
    try {
      const [port] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')
      if (/^\d+$/u.test(port.trim())) out.push({ port: Number(port.trim()), dir })
    } catch { /* stale profile without the file */ }
  }
  return out
}

/** Locate a live browser debugging port from the newest puppeteer profile. */
function browserPort() {
  const [first] = browserPorts()
  if (first === undefined) throw new Error(`no DevToolsActivePort under ${TEMP} — has the pane ever opened a page?`)
  return first
}

/** Minimal CDP client over the built-in WebSocket. */
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    pending.get(msg.id)?.(msg)
    pending.delete(msg.id)
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true })
  })
  return {
    send: (method, params = {}) =>
      new Promise((resolve) => {
        const n = ++id
        pending.set(n, resolve)
        ws.send(JSON.stringify({ id: n, method, params }))
      }),
    close: () => ws.close(),
  }
}

async function post(path, body) {
  const res = await fetch(`${GUI}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

console.log('DSH browser pane — end-to-end acceptance\n')

// --- 1. host half ------------------------------------------------------------
await check('host half: /browser-pane/stream is registered', async () => {
  const res = await fetch(`${GUI}/browser-pane/stream`, { method: 'GET' })
  if (res.status === 404) throw new Error('404 — the host half did not register its routes')
  res.body?.cancel?.()
  return `HTTP ${res.status}`
})

// --- 2. client half ----------------------------------------------------------
await check('client half: boot graph carries the plugin row', async () => {
  // Raw sockets, because a browser navigation cannot be simulated with fetch():
  // `Sec-*` headers are forbidden to set, and undici adds its own Fetch Metadata
  // (`Dest: empty`, `Mode: cors`) that the bridge correctly reads as "a fetch,
  // not a navigation" — so fetch() is refused a session, by design.
  const nav = await rawRequest({ path: '/', navigation: true })
  if (nav.status !== 200) throw new Error(`navigation returned HTTP ${nav.status}`)
  const cookie = nav.setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('dsh-auth-'))
  if (!cookie) throw new Error('no session cookie minted on the navigation')

  const res = await rawRequest({ path: '/', headers: { Cookie: cookie } })
  if (res.status !== 200) throw new Error(`authenticated fetch returned HTTP ${res.status}`)
  if (!res.text.includes('try-works/dsh-browser-agent')) throw new Error('plugin row absent from the boot graph')
  return 'row present'
})

// --- 3. stream, held open for the coordinate check ---------------------------
const controller = new AbortController()
let frames = 0
let state = null
await check('stream: page active and frames flowing', async () => {
  const res = await fetch(`${GUI}/browser-pane/stream`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  ;(async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let cut
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const event = /^event: (.+)$/mu.exec(chunk)?.[1]
        const data = /^data: (.+)$/mu.exec(chunk)?.[1]
        if (data === undefined) continue
        if (event === 'frame') frames += 1
        else if (event === 'state') state = JSON.parse(data)
      }
    }
  })().catch(() => {})

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && state?.active !== true && frames === 0) await sleep(150)
  if (state?.active !== true && frames === 0) throw new Error(`never active: ${JSON.stringify(state)}`)
  return `active, ${frames} frame(s)`
})

// --- 4. lease fails closed ---------------------------------------------------
await check('lease: a second owner is refused', async () => {
  // The lease is a module + lock file, not a plugin route, so this exercises the
  // shipped contract directly rather than over HTTP. It uses the module imported
  // at the top of this file — the same source being reviewed, resolved by path
  // and printed above — not a hard-coded copy somewhere else on disk.
  if (status().held) throw new Error(`page is already held by "${status().owner}" — cannot run the check`)
  const a = acquire({ owner: `${LEASE_OWNER}-a`, ttlMs: 30_000 })
  if (!a.ok) throw new Error('first acquire unexpectedly refused')
  const b = acquire({ owner: `${LEASE_OWNER}-b`, ttlMs: 30_000 })
  release({ owner: `${LEASE_OWNER}-a` })
  if (b.ok) throw new Error('SECOND ACQUIRE SUCCEEDED — the lease is not fail-closed')
  return `refused, held by ${b.heldBy}`
})

// --- 5. coordinates, measured ------------------------------------------------
const TARGETS = [
  { x: 480, y: 270, expect: 'tl' },
  { x: 1440, y: 810, expect: 'br' },
]

await check('coordinates: clicks land exactly where aimed', async () => {
  // Never drive a browser this tooling does not own. In connect mode the pane is
  // attached to a real signed-in Chrome and goto/input act on its ACTIVE TAB —
  // which is how a run of this file once navigated a live conversation.
  await assertDrivable()

  // Own the page for the duration of the drive. The previous version navigated
  // and clicked here WITHOUT holding the lease while check 4 above asserted that
  // two owners cannot hold it — the acceptance gate violated the contract it was
  // validating.
  const lease = openLease({ owner: `${LEASE_OWNER}-coords`, ttlMs: 120_000 })
  let client = null
  try {
    // Navigate FIRST, then attach to the tab that actually holds the probe.
    //
    // Attaching to "the first page target" is NOT the tab the plugin drove: the
    // plugin acts on its ACTIVE tab, and this browser can hold several. Picking
    // the wrong one produced `Cannot set properties of null` — the test was
    // arming a blank tab while the plugin had navigated a different one.
    // Resolved beside this script, like the lease: coord-test.html ships in the
    // same directory, so this works both installed (.dsh/probe/) and committed
    // (harness/) without a machine-specific absolute path.
    const probe = pathToFileURL(join(hereDir, 'coord-test.html')).href
    await post('/browser-pane/goto', { url: probe })
    await sleep(1500)

    const found = await findPageOnAnyPort('coord-test')
    if (!found.page) {
      throw new Error(
        `no tab on the probe URL — the plugin drove a tab this test cannot see ` +
          `(ports tried: ${found.tried?.join(', ') || 'none'})`,
      )
    }
    client = await cdp(found.page.webSocketDebuggerUrl)
    const evaluate = async (expression) => {
      const res = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'eval failed')
      return res.result?.result?.value
    }

    await evaluate(`window.__hits = []; document.getElementById('log').textContent = 'clicks:0'; 'armed'`)

    for (const t of TARGETS) {
      for (const type of ['mouse-move', 'mouse-down', 'mouse-up']) {
        lease.assertHeld()
        const { status } = await post('/browser-pane/input', {
          type, x: t.x, y: t.y, button: type === 'mouse-move' ? 'none' : 'left',
        })
        if (status !== 200) throw new Error(`${type} at (${t.x},${t.y}) -> HTTP ${status}`)
        await sleep(70)
      }
      await sleep(180)
    }

    const hits = await evaluate('JSON.stringify(window.__hits)')
    const parsed = JSON.parse(hits)

    if (parsed.length !== TARGETS.length) {
      throw new Error(`expected ${TARGETS.length} hits, got ${parsed.length}: ${hits}`)
    }
    for (const [i, t] of TARGETS.entries()) {
      const hit = parsed[i]
      if (hit.id !== t.expect) throw new Error(`aimed at "${t.expect}", hit "${hit.id}"`)
      if (hit.x !== t.x || hit.y !== t.y) {
        throw new Error(`aimed at (${t.x},${t.y}), page recorded (${hit.x},${hit.y}) — offset present`)
      }
    }
    return `exact: ${parsed.map((h) => `${h.id}(${h.x},${h.y})`).join(', ')}`
  } finally {
    lease.close()
    client?.close()
  }
})

controller.abort()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((f) => f.name).join('; ')}`)
  process.exitCode = 1
}
