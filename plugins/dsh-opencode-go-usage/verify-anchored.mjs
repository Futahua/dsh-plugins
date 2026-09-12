// Verify the three-row usage-anchored chart on the live phone.
//
// The property that matters is that all three rows share one scale, so the
// anchor lines up vertically. That is geometric, so it is measured, not eyeballed.
// The GUI tab is identified by a URL substring. In the published repo this comes
// from config.mjs; the live install has no such file, so it falls back here.
let HOST_MATCH = process.env.DSH_HOST_MATCH ?? 'sloptop';
try {
	({ HOST_MATCH } = await import('../../config.mjs'));
} catch {
	/* running from a live profile: use the default above */
}

const PORT = Number(process.argv[2] ?? 9333)
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const tab = tabs.find((t) => t.type === 'page' && (t.url ?? '').includes(HOST_MATCH))
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

// Force closed first so the click opens rather than toggles.
await evaluate(`(() => { const p = document.querySelector('.dsh-go-usage-panel'); if (p) document.querySelector('.dsh-go-usage-button').click(); return true })()`)
await new Promise((r) => setTimeout(r, 250))

const report = await evaluate(`(async () => {
  const btn = document.querySelector('.dsh-go-usage-button');
  if (!btn) return 'no pill';
  btn.click();
  await new Promise(r => setTimeout(r, 400));

  const rows = [...document.querySelectorAll('.dsh-go-usage-row')];
  if (rows.length === 0) return { rows: 0, panel: Boolean(document.querySelector('.dsh-go-usage-panel')) };

  const data = rows.map(row => {
    const track = row.querySelector('.dsh-go-usage-track');
    const seg = row.querySelector('.dsh-go-usage-seg');
    const fill = row.querySelector('.dsh-go-usage-segfill');
    const anchor = row.querySelector('.dsh-go-usage-anchor');
    const tr = track.getBoundingClientRect();
    return {
      window: row.getAttribute('data-window'),
      label: row.querySelector('.dsh-go-usage-label')?.textContent,
      figure: row.querySelector('.dsh-go-usage-figs')?.textContent,
      trackLeft: Math.round(tr.left),
      trackWidth: Math.round(tr.width),
      segLeftPct: +((seg.getBoundingClientRect().left - tr.left) / tr.width * 100).toFixed(1),
      segWidthPct: +((seg.getBoundingClientRect().width / tr.width) * 100).toFixed(1),
      fillPctOfSeg: +(fill.getBoundingClientRect().width / seg.getBoundingClientRect().width * 100).toFixed(1),
      segColour: getComputedStyle(fill).backgroundColor,
      clippedLeft: seg.hasAttribute('data-clipped-left'),
      clippedRight: seg.hasAttribute('data-clipped-right'),
      anchorViewportX: anchor ? Math.round(anchor.getBoundingClientRect().left) : null,
      anchorPctOfTrack: anchor ? +((anchor.getBoundingClientRect().left - tr.left) / tr.width * 100).toFixed(1) : null,
    };
  });

  const arc = btn.querySelector('.dsh-go-usage-arc');
  return {
    rows: data.length,
    data,
    arcColour: arc ? getComputedStyle(arc).stroke : null,
    panelHeight: Math.round(document.querySelector('.dsh-go-usage-panel').getBoundingClientRect().height),
  };
})()`)

console.log(JSON.stringify(report, null, 2))

if (report && Array.isArray(report.data)) {
  console.log('\n--- alignment across rows ---')
  const xs = report.data.map((r) => r.anchorViewportX)
  const spread = Math.max(...xs) - Math.min(...xs)
  console.log(`  anchor x per row : ${xs.join(', ')}`)
  console.log(`  spread           : ${spread}px  ${spread <= 1 ? '(aligned)' : '(MISALIGNED)'}`)
  const widths = report.data.map((r) => r.trackWidth)
  console.log(`  track widths     : ${widths.join(', ')}  ${new Set(widths).size === 1 ? '(shared scale)' : '(DIFFERENT)'}`)
  console.log('\n--- every used portion ends at the anchor? ---')
  for (const r of report.data) {
    const usedEnd = r.segLeftPct + (r.fillPctOfSeg / 100) * r.segWidthPct
    console.log(`  ${String(r.label).padEnd(8)} used ends at ${usedEnd.toFixed(1)}%   anchor at ${r.anchorPctOfTrack}%`)
  }
}

await evaluate(`(() => { const b = document.querySelector('.dsh-go-usage-button'); if (b) b.click(); return true })()`)
ws.close()
