// Evaluate a JS expression inside the phone's Chrome, over the adb CDP forward.
//
//   node phone-eval.mjs "<expression>"
//   node phone-eval.mjs --tab=1 "<expression>"
//
// Defaults to the first tab whose URL is the DSH GUI. Chrome on Android exposes
// every tab, so picking by URL matters: this claims exactly one and reports the
// id it used, rather than acting on "whatever was in front".

const CDP = process.env.PHONE_CDP ?? 'http://127.0.0.1:9444'
const args = process.argv.slice(2)
const tabFlag = args.find((a) => a.startsWith('--tab='))
const expression = args.filter((a) => !a.startsWith('--tab=')).join(' ')

if (!expression) {
  console.error('usage: node phone-eval.mjs [--tab=N] "<expression>"')
  process.exit(2)
}

const targets = await (await fetch(`${CDP}/json/list`)).json()
const pages = targets.filter((t) => t.type === 'page' && t.url.includes('3080'))
if (pages.length === 0) throw new Error('no DSH GUI tab on the phone')

const index = tabFlag ? Number(tabFlag.split('=')[1]) : 0
const target = pages[index]
if (!target) throw new Error(`no GUI tab at index ${index} (found ${pages.length})`)

console.error(`[phone tab ${index}/${pages.length - 1}] id=${target.id}`)
console.error(`[url] ${target.url}`)

const ws = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  const resolve = pending.get(msg.id)
  if (resolve) { pending.delete(msg.id); resolve(msg) }
})

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

const result = await send('Runtime.evaluate', {
  expression,
  returnByValue: true,
  awaitPromise: true,
})

if (result.result?.exceptionDetails) {
  console.error('EXCEPTION:', JSON.stringify(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails))
  process.exitCode = 1
} else {
  const value = result.result?.result?.value
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

ws.close()
