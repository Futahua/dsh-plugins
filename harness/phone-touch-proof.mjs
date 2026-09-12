// Slice 13 — does a real touch on the phone reach the shared page, at the right
// coordinate?
//
// The pane's page surface binds MOUSE handlers only, so touch has to arrive via
// the browser's compatibility mouse events. This measures whether it does.
//
// The approach avoids arithmetic by hand: it reads the rendered screencast
// image's rect off the phone, aims at a FRACTION of that image, and derives the
// expected page coordinate from the same fraction. If the pane's transform is
// right, a touch at fraction (fx, fy) must land at (fx * pageWidth, fy *
// pageHeight) in the shared page.
//
//   node phone-touch-proof.mjs [fx] [fy]        # defaults 0.6 0.4
//
// Read `window.__hits` on the shared page afterwards to see what it hit.

import { readFileSync } from 'node:fs'

const CDP = process.env.PHONE_CDP ?? 'http://127.0.0.1:9444'
const fx = Number(process.argv[2] ?? 0.6)
const fy = Number(process.argv[3] ?? 0.4)

const targets = await (await fetch(`${CDP}/json/list`)).json()
const pages = targets.filter((t) => t.type === 'page' && t.url.includes('3080'))
if (pages.length === 0) throw new Error('no DSH GUI tab on the phone')
const target = pages[0]
console.log(`phone tab: ${target.id}`)

const ws = new WebSocket(target.webSocketDebuggerUrl)
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

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed')
  return r.result?.result?.value
}

// --- geometry, measured on the phone ----------------------------------------
const geom = JSON.parse(await evaluate(`(() => {
  const img = [...document.querySelectorAll('img')].find(e => String(e.src).startsWith('data:image'))
  if (!img) return JSON.stringify({ found: false })
  const r = img.getBoundingClientRect()
  return JSON.stringify({
    found: true, x: r.x, y: r.y, w: r.width, h: r.height,
    vw: innerWidth, vh: innerHeight,
    // The on-screen portion matters: the pane can overflow the viewport.
    visibleFromX: Math.max(0, r.x), visibleToX: Math.min(innerWidth, r.x + r.width),
  })
})()`))

if (!geom.found) throw new Error('no screencast image on the phone — is the pane expanded?')
console.log(`image rect : x=${geom.x.toFixed(1)} y=${geom.y.toFixed(1)} ${geom.w.toFixed(0)}x${geom.h.toFixed(0)}`)
console.log(`viewport   : ${geom.vw}x${geom.vh}`)
console.log(`image on screen from x=${geom.visibleFromX.toFixed(0)} to x=${geom.visibleToX.toFixed(0)}`)

// --- aim at a fraction of the image -----------------------------------------
const touchX = Math.round(geom.x + fx * geom.w)
const touchY = Math.round(geom.y + fy * geom.h)

if (touchX < 0 || touchX > geom.vw || touchY < 0 || touchY > geom.vh) {
  throw new Error(`aim point (${touchX},${touchY}) falls outside the phone viewport — pick another fraction`)
}

console.log(`\ntouch at   : (${touchX},${touchY})  = fraction (${fx}, ${fy}) of the image`)
console.log(`expect page: (${Math.round(fx * 1920)}, ${Math.round(fy * 1080)})   [assumes a 1920x1080 page]`)

// --- dispatch ----------------------------------------------------------------
// A touch with no touch handlers on the target should still yield compatibility
// mouse events, which is the only path the pane listens on.
await send('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [{ x: touchX, y: touchY, radiusX: 8, radiusY: 8, force: 1 }],
})
await new Promise((r) => setTimeout(r, 90))
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
await new Promise((r) => setTimeout(r, 400))

console.log('\ntouch dispatched. Now read window.__hits on the shared page.')
ws.close()
