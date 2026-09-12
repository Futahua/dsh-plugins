// Verify the hover glance: three swatches with numbers, and that a mouse pointer
// triggers it while a touch tap does not.
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

// Close anything open first.
await evaluate(`(() => { if (document.querySelector('.dsh-go-usage-panel')) document.querySelector('.dsh-go-usage-button').click(); return true })()`)
await new Promise((r) => setTimeout(r, 250))

console.log('--- is the new bundle loaded? ---')
console.log(JSON.stringify(await evaluate(`(() => {
  const tag = document.querySelector('style[data-plugin="dsh-opencode-go-usage"]');
  const css = tag ? tag.textContent : '';
  return {
    styleTags: document.querySelectorAll('style[data-plugin="dsh-opencode-go-usage"]').length,
    hasQuickCss: css.includes('dsh-go-usage-quick'),
    hasSwatchCss: css.includes('dsh-go-usage-swatch'),
    hasRowsCss: css.includes('dsh-go-usage-rows'),
  };
})()`), null, 2))

console.log('\n--- mouse hover (via pointerover, which React maps to onPointerEnter) ---')
console.log(JSON.stringify(await evaluate(`(async () => {
  const btn = document.querySelector('.dsh-go-usage-button');
  if (!btn) return 'no pill';
  btn.dispatchEvent(new PointerEvent('pointerover', {
    bubbles: true, pointerType: 'mouse', relatedTarget: document.body,
  }));
  await new Promise(r => setTimeout(r, 300));
  const quick = document.querySelector('.dsh-go-usage-quick');
  if (!quick) return { quick: false };
  const rows = [...quick.querySelectorAll('.dsh-go-usage-quickrow')].map(r => ({
    text: r.textContent,
    swatch: getComputedStyle(r.querySelector('.dsh-go-usage-swatch')).backgroundColor,
  }));
  const r = quick.getBoundingClientRect();
  return {
    quick: true,
    rows: rows.length,
    data: rows,
    hasChart: Boolean(document.querySelector('.dsh-go-usage-rows')),
    sizePx: Math.round(r.width) + 'x' + Math.round(r.height),
    onScreen: r.left >= 0 && r.right <= window.innerWidth,
  };
})()`), null, 2))

console.log('\n--- leaving hides it ---')
console.log(JSON.stringify(await evaluate(`(async () => {
  const btn = document.querySelector('.dsh-go-usage-button');
  btn.dispatchEvent(new PointerEvent('pointerout', {
    bubbles: true, pointerType: 'mouse', relatedTarget: document.body,
  }));
  await new Promise(r => setTimeout(r, 300));
  return { quickGone: !document.querySelector('.dsh-go-usage-quick') };
})()`)))

console.log('\n--- a touch tap must NOT show the glance ---')
console.log(JSON.stringify(await evaluate(`(async () => {
  const btn = document.querySelector('.dsh-go-usage-button');
  btn.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, pointerType: 'touch' }));
  await new Promise(r => setTimeout(r, 200));
  return { quickShown: Boolean(document.querySelector('.dsh-go-usage-quick')) };
})()`)))

ws.close()
