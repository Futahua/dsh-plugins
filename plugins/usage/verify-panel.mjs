// Verify the new ring + nested-bar panel on the live phone.
import { HOST_MATCH } from '../../config.mjs'
const PORT = Number(process.argv[2] ?? 9333)

const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const dshTabs = tabs.filter((t) => t.type === 'page' && (t.url ?? '').includes(HOST_MATCH))
console.log(`DSH tabs: ${dshTabs.length}\n`)

for (const tab of dshTabs) {
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

  console.log(`--- ${tab.id.slice(0, 8)} ---`)
  const report = await evaluate(`(async () => {
    const btn = document.querySelector('.dsh-usage-button');
    if (!btn) return { pill: false };

    // Open the panel and measure it.
    btn.click();
    await new Promise(r => setTimeout(r, 250));

    const ring = btn.querySelector('svg');
    const arc = btn.querySelector('.dsh-usage-arc');
    const panel = document.querySelector('.dsh-usage-panel');
    const rows = panel ? [...panel.querySelectorAll('.dsh-usage-row')] : [];

    return {
      pill: true,
      ring: ring ? { w: ring.getAttribute('width'), h: ring.getAttribute('height') } : null,
      arc: arc ? {
        dasharray: arc.getAttribute('stroke-dasharray'),
        circumference: 2 * Math.PI * 7,
      } : null,
      buttonTitle: btn.getAttribute('title'),
      buttonLevel: btn.getAttribute('data-level'),
      panelOpen: Boolean(panel),
      rowCount: rows.length,
      rows: rows.map(r => {
        const label = r.querySelector('.dsh-usage-head span')?.textContent;
        const pct = r.querySelector('.dsh-usage-head b')?.textContent;
        const reset = r.querySelector('.dsh-usage-reset')?.textContent?.trim();
        const bar = r.querySelector('.dsh-usage-bar');
        const fill = r.querySelector('.dsh-usage-fill');
        const panelW = panel.getBoundingClientRect().width;
        return {
          label, pct, reset,
          level: r.getAttribute('data-level'),
          barPx: bar ? Math.round(bar.getBoundingClientRect().width) : null,
          barPctOfPanel: bar ? Math.round((bar.getBoundingClientRect().width / panelW) * 100) : null,
          fillPx: fill ? Math.round(fill.getBoundingClientRect().width) : null,
        };
      }),
      caption: panel ? panel.querySelector('.dsh-usage-caption')?.textContent?.slice(0, 60) : null,
      panelWidthPx: panel ? Math.round(panel.getBoundingClientRect().width) : null,
      viewport: window.innerWidth,
      overflowsLeft: panel ? Math.round(panel.getBoundingClientRect().left) < 0 : null,
    };
  })()`)
  console.log(JSON.stringify(report, null, 2))

  // Close the panel again so both tabs are left clean.
  await evaluate(`(() => { const b = document.querySelector('.dsh-usage-button'); if (b) b.click(); return true })()`)
  ws.close()
  console.log('')
}
