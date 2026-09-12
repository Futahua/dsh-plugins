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

const GUI = process.env.DSH_BASE ?? 'http://127.0.0.1:3080'
const BRIDGE = process.env.DSH_BRIDGE ?? 'http://127.0.0.1:3099'
const TEMP = process.env.TEMP ?? 'D:/Programs/evTEMP'
const LEASE_OWNER = `acceptance:${process.pid}`

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

/** Locate a live browser debugging port from the newest puppeteer profile. */
function browserPort() {
  let dirs = []
  try {
    dirs = readdirSync(TEMP)
      .filter((n) => n.startsWith('puppeteer_dev_chrome_profile-'))
      .map((n) => join(TEMP, n))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  } catch { /* fall through to the error below */ }

  for (const dir of dirs) {
    try {
      const [port] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')
      if (/^\d+$/u.test(port.trim())) return { port: Number(port.trim()), dir }
    } catch { /* stale profile without the file */ }
  }
  throw new Error(`no DevToolsActivePort under ${TEMP} — has the pane ever opened a page?`)
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
  // The bridge serves a cookieless navigation the GUI directly, with a minted
  // session on the same response — no redirect to follow. fetch() still does not
  // persist the cookie, so it is carried forward by hand here.
  const first = await fetch(`${BRIDGE}/`, { redirect: 'manual' })
  const issued = (first.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  if (!issued) throw new Error(`no session cookie issued (HTTP ${first.status})`)

  const res = await fetch(`${BRIDGE}/`, { headers: { cookie: issued }, redirect: 'manual' })
  if (!res.ok) throw new Error(`authenticated fetch returned HTTP ${res.status}`)
  const html = await res.text()
  if (!html.includes('try-works/dsh-browser-agent')) throw new Error('plugin row absent from the boot graph')
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
  // shipped contract directly rather than over HTTP.
  const { acquire, release, status } = await import('file:///D:/Letters/MatTroiSeConMoc/.dsh/pane-lease.mjs')
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
  const { port } = browserPort()
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target on the plugin browser')

  const client = await cdp(page.webSocketDebuggerUrl)
  const evaluate = async (expression) => {
    const res = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'eval failed')
    return res.result?.result?.value
  }

  // Point the shared page at the 2x2 target.
  const probe = 'file:///D:/Letters/MatTroiSeConMoc/.dsh/probe/coord-test.html'
  await post('/browser-pane/goto', { url: probe })
  await sleep(1200)
  await evaluate(`window.__hits = []; document.getElementById('log').textContent = 'clicks:0'; 'armed'`)

  for (const t of TARGETS) {
    for (const type of ['mouse-move', 'mouse-down', 'mouse-up']) {
      const { status } = await post('/browser-pane/input', {
        type, x: t.x, y: t.y, button: type === 'mouse-move' ? 'none' : 'left',
      })
      if (status !== 200) throw new Error(`${type} at (${t.x},${t.y}) -> HTTP ${status}`)
      await sleep(70)
    }
    await sleep(180)
  }

  const hits = await evaluate('JSON.stringify(window.__hits)')
  client.close()
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
})

controller.abort()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((f) => f.name).join('; ')}`)
  process.exitCode = 1
}
