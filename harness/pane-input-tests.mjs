// Slices 9 and 10 — do drag, wheel and keyboard input actually reach the page?
//
// The package CLAIMS these work. This measures them instead: each event is
// dispatched through the same `POST /browser-pane/input` route a human's
// gesture uses, and the page records what it received, so the answer is a
// number rather than an inference.
//
//   node pane-input-tests.mjs
//
// Note the stream: input is rejected with 400 while no SSE client is attached
// (the pane reads a CDP handle that only exists while streaming), so this holds
// one open for the duration.

const GUI = process.env.DSH_BASE ?? 'http://127.0.0.1:3080'
const TEMP = process.env.TEMP ?? 'D:/Programs/evTEMP'
const PROBE = 'file:///D:/Letters/MatTroiSeConMoc/.dsh/probe/input-test.html'

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []

async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true })
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`  FAIL  ${name}  — ${error.message}`)
  }
}

function browserPort() {
  const dirs = readdirSync(TEMP)
    .filter((n) => n.startsWith('puppeteer_dev_chrome_profile-'))
    .map((n) => join(TEMP, n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  for (const dir of dirs) {
    try {
      const [port] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')
      if (/^\d+$/u.test(port.trim())) return Number(port.trim())
    } catch { /* stale profile */ }
  }
  throw new Error('no live browser port found')
}

async function attach() {
  const port = browserPort()
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    pending.get(m.id)?.(m)
    pending.delete(m.id)
  })
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('cdp connect failed')), { once: true })
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id
      pending.set(n, resolve)
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  return {
    evaluate: async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
      return r.result?.result?.value
    },
    close: () => ws.close(),
  }
}

async function post(event) {
  const res = await fetch(`${GUI}/browser-pane/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  })
  if (!res.ok) throw new Error(`${event.type} -> HTTP ${res.status}`)
  await sleep(45)
}

async function goto(url) {
  await fetch(`${GUI}/browser-pane/goto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  await sleep(1400)
}

console.log('DSH pane input — drag, wheel, keyboard\n')

// Hold a stream open: no subscriber means 400 on every input post.
const controller = new AbortController()
const stream = await fetch(`${GUI}/browser-pane/stream`, {
  signal: controller.signal,
  headers: { accept: 'text/event-stream' },
})
stream.body?.cancel?.().catch(() => {})
if (!stream.ok) throw new Error(`stream refused: HTTP ${stream.status}`)
console.log(`  stream attached (HTTP ${stream.status})\n`)

const client = await attach()
await goto(PROBE)
await client.evaluate('window.__resetInput()')

// --- Slice 9a: drag ----------------------------------------------------------
await check('drag: mousedown/move/up carries the element and reports release', async () => {
  await client.evaluate('window.__resetInput()')
  const from = { x: 300, y: 250 }   // inside the 220x110 box at (200,200)
  const to = { x: 520, y: 430 }
  await post({ type: 'mouse-move', x: from.x, y: from.y, button: 'none' })
  await post({ type: 'mouse-down', x: from.x, y: from.y, button: 'left' })
  // Several intermediate moves, as a real drag produces.
  for (let i = 1; i <= 4; i += 1) {
    await post({
      type: 'mouse-move',
      x: Math.round(from.x + ((to.x - from.x) * i) / 4),
      y: Math.round(from.y + ((to.y - from.y) * i) / 4),
      button: 'left',
    })
  }
  await post({ type: 'mouse-up', x: to.x, y: to.y, button: 'left' })
  await sleep(250)

  const state = JSON.parse(await client.evaluate('JSON.stringify(window.__readInput())'))
  if (state.drop === null) throw new Error('no mouseup recorded — the drag never reached the page')
  if (state.drop.x !== to.x || state.drop.y !== to.y) {
    throw new Error(`released at (${state.drop.x},${state.drop.y}), dispatched (${to.x},${to.y})`)
  }
  if (state.boxPos.left === '200px' && state.boxPos.top === '200px') {
    throw new Error('element did not move — mousemove did not reach the page')
  }
  return `released exactly at (${state.drop.x},${state.drop.y}), box moved to ${state.boxPos.left},${state.boxPos.top}`
})

// --- Slice 9b: wheel ---------------------------------------------------------
await check('wheel: scrolling reaches the page', async () => {
  await client.evaluate('window.__resetInput()')
  for (let i = 0; i < 5; i += 1) {
    await post({ type: 'wheel', x: 600, y: 500, deltaX: 0, deltaY: 120, deltaMode: 0 })
  }
  await sleep(400)
  const state = JSON.parse(await client.evaluate('JSON.stringify(window.__readInput())'))
  if (state.scrollY <= 0) throw new Error(`scrollY stayed ${state.scrollY} — wheel had no effect`)
  return `scrollY ${state.scrollY} after 5x120 deltaY (saw ${state.scrolls.join(', ')})`
})

// --- Slice 10: keyboard ------------------------------------------------------
const CHAR = (ch) => {
  if (ch === ' ') return { key: ' ', code: 'Space' }
  if (/[a-z]/iu.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}` }
  if (/[0-9]/u.test(ch)) return { key: ch, code: `Digit${ch}` }
  return { key: ch, code: '' }
}

await check('keyboard: keydown reaches the page and text lands in a field', async () => {
  await client.evaluate('window.__resetInput()')
  await client.evaluate(`document.getElementById('field').focus(); 'focused'`)

  const text = 'Hi 42'
  for (const ch of text) {
    const { key, code } = CHAR(ch)
    await post({ type: 'key-down', key, code, text: ch })
    await post({ type: 'key-up', key, code })
  }
  await sleep(350)

  const state = JSON.parse(await client.evaluate('JSON.stringify(window.__readInput())'))
  if (state.keys.length === 0) throw new Error('no keydown observed by the page')
  if (state.field !== text) {
    throw new Error(`field holds ${JSON.stringify(state.field)}, expected ${JSON.stringify(text)}`)
  }
  return `typed ${JSON.stringify(state.field)}; ${state.keys.length} keydowns seen (last: ${state.keys.at(-1).key})`
})

await check('keyboard: modifiers and special keys are delivered, not just text', async () => {
  await client.evaluate('window.__resetInput()')
  await client.evaluate(`document.getElementById('field').focus(); 'focused'`)
  // Enter (no text), then Shift+A: the page should see both by key and code.
  await post({ type: 'key-down', key: 'Enter', code: 'Enter', text: '\r' })
  await post({ type: 'key-up', key: 'Enter', code: 'Enter' })
  await post({ type: 'key-down', key: 'A', code: 'KeyA', text: 'A', modifiers: 8 })
  await post({ type: 'key-up', key: 'A', code: 'KeyA', modifiers: 8 })
  await sleep(300)
  const state = JSON.parse(await client.evaluate('JSON.stringify(window.__readInput())'))
  const seen = state.keys.map((k) => `${k.key}/${k.code}`)
  if (!seen.includes('Enter/Enter')) throw new Error(`Enter not seen (saw ${seen.join(', ')})`)
  if (!seen.some((k) => k.startsWith('A/'))) throw new Error(`Shift+A not seen (saw ${seen.join(', ')})`)
  return `saw ${seen.join(', ')}`
})

client.close()
controller.abort()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((f) => f.name).join('; ')}`)
  process.exitCode = 1
}
