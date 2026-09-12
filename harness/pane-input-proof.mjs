// Slice 8 — measured coordinate proof for the DSH browser pane.
//
// Claims to test, by measurement rather than by reading code:
//
//   1. The pane's SSE stream attaches CDP and starts a screencast.
//   2. `POST /browser-pane/input` reaches the page at the coordinate given,
//      in viewport CSS pixels, unmodified.
//
// Why a subscriber is required first: the pane's input handler reads a `cdp`
// handle that only exists while a stream client is attached (`pane.ts`
// ~line 352, "the screencast follows its subscribers"). Posting input with
// nobody watching is rejected with 400 "browser not ready".
//
// It clicks the centre of two opposite quadrants of .dsh/probe/coord-test.html
// and leaves the recorded hits in `window.__hits` for a separate read-back.
//
//   usage: node pane-input-proof.mjs [baseUrl]

const BASE = process.argv[2] ?? process.env.DSH_BASE ?? 'http://127.0.0.1:3080'

// The automation boundary is where ownership is enforceable, so this run takes
// the lease before driving and gives it back after. If somebody else holds the
// page, `withLease` refuses and the clicks below never happen — that is the
// fail-closed property, and it is the whole point: an automated run must not
// fight a human who is using the pane.
import { withLease } from '../pane-lease.mjs'

const OWNER = process.env.PANE_OWNER ?? `pane-input-proof:${process.pid}`

/** Points chosen from the probe page's 2x2 grid on a 1920x1080 viewport. */
const CLICKS = [
  { label: 'top-left quadrant centre', x: 480, y: 270, expect: 'tl' },
  { label: 'bottom-right quadrant centre', x: 1440, y: 810, expect: 'br' },
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function postInput(event) {
  const res = await fetch(`${BASE}/browser-pane/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  })
  const text = await res.text()
  return { status: res.status, text }
}

async function main() {
  // --- 1. Subscribe, and watch the state/frame events -------------------------
  const controller = new AbortController()
  const stream = await fetch(`${BASE}/browser-pane/stream`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  })
  console.log(`stream: HTTP ${stream.status}  ${stream.headers.get('content-type')}`)
  if (!stream.ok) throw new Error(`stream refused: HTTP ${stream.status}`)

  let frames = 0
  let state = null
  let buffer = ''
  const decoder = new TextDecoder()

  const pump = (async () => {
    const reader = stream.body.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let cut
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const name = /^event: (.+)$/mu.exec(chunk)?.[1] ?? 'message'
        const data = /^data: (.+)$/mu.exec(chunk)?.[1]
        if (data === undefined) continue
        if (name === 'frame') { frames += 1; continue }
        if (name === 'state') state = JSON.parse(data)
      }
    }
  })().catch(() => {})

  // The screencast attaches asynchronously; wait for it to report active.
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (state?.active === true || frames > 0) break
    await sleep(150)
  }
  console.log(`screencast state: ${JSON.stringify(state)}`)
  console.log(`frames received : ${frames}`)
  if (state?.active !== true && frames === 0) {
    throw new Error(`screencast never became active: ${JSON.stringify(state)}`)
  }

  // --- 2. Click, and check the route accepted each event ----------------------
  // Held under the lease so a concurrent run cannot interleave clicks with ours.
  await withLease({ owner: OWNER, ttlMs: 120_000 }, async (lease) => {
    console.log(`lease acquired by "${lease.owner}", expires ${new Date(lease.expiresAt).toISOString()}`)
    for (const click of CLICKS) {
      console.log(`\nclicking ${click.label} at (${click.x},${click.y}), expecting "${click.expect}"`)
      const seq = [
        { type: 'mouse-move', x: click.x, y: click.y, button: 'none' },
        { type: 'mouse-down', x: click.x, y: click.y, button: 'left' },
        { type: 'mouse-up', x: click.x, y: click.y, button: 'left' },
      ]
      for (const event of seq) {
        const { status, text } = await postInput(event)
        console.log(`  ${event.type.padEnd(11)} -> HTTP ${status} ${text}`)
        await sleep(80)
      }
      await sleep(200)
    }
  })
  console.log('lease released')

  console.log(`\nframes after input: ${frames}`)
  controller.abort()
  await pump
  console.log('\nstream closed. Read back window.__hits to confirm what was hit.')
}

await main()
