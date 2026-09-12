// Inspect the live DSH page on the phone via Chrome DevTools Protocol.
// Answers the one question that decides the fix: what state is the frame in?
//
// Superseded for the gesture work by `phone.mjs` + `verify-phone.mjs`; kept
// because it is the quickest way to see which of our rules the CSSOM applied.
const PORT = Number(process.argv[2] ?? 9444)
const MATCH = 'sloptop.taild88607.ts.net:3080'

const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const tab = tabs.find((t) => t.type === 'page' && (t.url ?? '').includes(MATCH))
if (!tab) { console.error('DSH tab not found'); process.exit(1) }
console.log(`tab: ${tab.title}`)
console.log(`url: ${tab.url}\n`)

const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const msgId = ++id
    pending.set(msgId, resolve)
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})

await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable')

/** Evaluate an expression in the page and return its value. */
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails) return { error: res.result.exceptionDetails.text }
  return res.result?.result?.value
}

const report = await evaluate(`(() => {
  const out = {};
  out.innerWidth = window.innerWidth;
  out.devicePixelRatio = window.devicePixelRatio;
  out.mediaMatches = window.matchMedia('(max-width: 768px)').matches;

  // The frame is the grid element carrying inline gridTemplateColumns.
  const frames = [...document.querySelectorAll('div')].filter(d => d.style && d.style.gridTemplateColumns);
  out.frameCount = frames.length;
  out.frames = frames.slice(0, 3).map(f => ({
    inline: f.style.gridTemplateColumns,
    computed: getComputedStyle(f).gridTemplateColumns,
    dataset: { ...f.dataset },
    childCount: f.children.length,
    className: String(f.className).slice(0, 60),
  }));

  // Did our stylesheet land, and what does the browser think of it?
  const style = document.querySelector('style[data-plugin="dsh-mobile-rail"]');
  out.railStylePresent = style !== null;
  if (style) {
    out.railStyleRules = style.sheet ? style.sheet.cssRules.length : 'no sheet';
    try {
      out.railStyleMedia = style.sheet ? [...style.sheet.cssRules].map(r => r.conditionText || r.cssText.slice(0, 60)) : [];
    } catch (e) { out.railStyleMedia = 'blocked: ' + e.message; }
  }

  // Is our rule actually winning for the frame?
  if (frames[0]) {
    out.matchesCollapsed = frames[0].matches('[data-sidebar-collapsed]');
    out.centreColumnMatchesBlankRule = frames[0].matches(':not([data-sidebar-collapsed])');
  }
  return out;
})()`)

console.log('--- page state ---')
console.log(JSON.stringify(report, null, 2))

// Ask the CSSOM directly which of our rules applied to the frame.
const applied = await evaluate(`(() => {
  const frame = [...document.querySelectorAll('div')].find(d => d.style && d.style.gridTemplateColumns);
  if (!frame) return 'no frame';
  const out = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules } catch { continue }
    for (const rule of rules) {
      if (rule.media) {
        out.push({ media: rule.conditionText, matches: matchMedia(rule.conditionText).matches, inner: [...rule.cssRules].map(r => r.selectorText).filter(Boolean) });
      }
    }
  }
  return out.filter(r => (r.inner || []).some(s => s && s.includes('sidebar-collapsed')));
})()`)
console.log('\n--- stylesheets containing our selector ---')
console.log(JSON.stringify(applied, null, 2))

ws.close()
