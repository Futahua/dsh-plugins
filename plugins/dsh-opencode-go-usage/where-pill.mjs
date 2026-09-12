// Where is the pill, and how far does the panel actually stick out?
import { HOST_MATCH } from '../../config.mjs'
const PORT = Number(process.argv[2] ?? 9333)
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const tab = tabs.find((t) => t.type === 'page' && (t.url ?? '').includes(HOST_MATCH))

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

console.log(JSON.stringify(await evaluate(`(async () => {
  const btn = document.querySelector('.dsh-go-usage-button');
  if (!btn) return 'no pill';
  if (!document.querySelector('.dsh-go-usage-panel')) { btn.click(); await new Promise(r => setTimeout(r, 250)); }
  const panel = document.querySelector('.dsh-go-usage-panel');
  const wrap = document.querySelector('.dsh-go-usage');
  const pb = panel.getBoundingClientRect();
  const wb = wrap.getBoundingClientRect();
  const bb = btn.getBoundingClientRect();

  // Is the new CSS actually loaded?
  const tag = document.querySelector('style[data-plugin="dsh-opencode-go-usage"]');
  const css = tag ? tag.textContent : '';

  return {
    viewport: window.innerWidth,
    pillRect: { left: Math.round(bb.left), right: Math.round(bb.right), w: Math.round(bb.width) },
    wrapRect: { left: Math.round(wb.left), right: Math.round(wb.right), w: Math.round(wb.width) },
    panelRect: { left: Math.round(pb.left), right: Math.round(pb.right), w: Math.round(pb.width) },
    overflowLeftPx: Math.max(0, Math.round(-pb.left)),
    cssHasRightMinus8: css.includes('right:-8px'),
    cssPanelRule: (css.match(/\\.dsh-go-usage-panel\\{[^}]*\\}/) || ['(absent)'])[0],
    panelOffsetParent: panel.offsetParent ? panel.offsetParent.className.toString().slice(0, 40) : null,
  };
})()`), null, 2))

ws.close()
