// Confirm the grey full-width ruler is gone from every row's track.
const PORT = Number(process.argv[2] ?? 9333)
const MATCH = process.env.DSH_HOST_MATCH ?? 'sloptop'

const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const tab = tabs.find((t) => t.type === 'page' && (t.url ?? '').includes(MATCH))
if (!tab) { console.error('GUI tab not found'); process.exit(1) }

const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((resolve) => {
  const msgId = ++id; pending.set(msgId, resolve)
  ws.send(JSON.stringify({ id: msgId, method, params }))
})
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable')

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails) return { error: res.result.exceptionDetails.text }
  return res.result?.result?.value
}

// Ensure it ends closed, then open it.
await evaluate(`(() => { if (document.querySelector('.dsh-go-usage-panel')) document.querySelector('.dsh-go-usage-button').click(); return true })()`)
await new Promise((r) => setTimeout(r, 250))

const report = await evaluate(`(async () => {
  document.querySelector('.dsh-go-usage-button').click();
  await new Promise(r => setTimeout(r, 400));
  const rows = [...document.querySelectorAll('.dsh-go-usage-row')];
  return rows.map(row => {
    const track = row.querySelector('.dsh-go-usage-track');
    const seg = row.querySelector('.dsh-go-usage-seg');
    const fill = row.querySelector('.dsh-go-usage-segfill');
    const tw = track.getBoundingClientRect().width;
    return {
      window: row.getAttribute('data-window'),
      trackBackground: getComputedStyle(track).backgroundColor,
      trackWidthPx: Math.round(tw),
      segWidthPctOfTrack: +((seg.getBoundingClientRect().width / tw) * 100).toFixed(1),
      segBackground: getComputedStyle(seg).backgroundColor,
      fillPx: Math.round(fill.getBoundingClientRect().width),
    };
  });
})()`)

console.log(JSON.stringify(report, null, 2))
if (Array.isArray(report)) {
  const transparent = report.every((r) => /rgba\(0, 0, 0, 0\)|transparent/u.test(r.trackBackground))
  console.log(`\ntrack ruler removed in every row: ${transparent}`)
  for (const r of report) {
    console.log(`  ${String(r.window).padEnd(8)} segment spans ${String(r.segWidthPctOfTrack).padStart(5)}% of track, remainder fill ${r.segBackground}`)
  }
}

await evaluate(`(() => { document.querySelector('.dsh-go-usage-button').click(); return true })()`)
ws.close()
