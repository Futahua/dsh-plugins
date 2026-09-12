// Verify the scratch instance on the real profile serves both plugin bundles
// and that the usage route answers, using a cookie jar the way a browser would.
const BASE = 'http://127.0.0.1:3096'
const TOKEN = process.argv[2]
if (!TOKEN) { console.error('usage: node check.mjs <token>'); process.exit(2) }

const jar = new Map()
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')

async function get(path, { follow = true } = {}) {
  let url = BASE + path
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: jar.size ? { Cookie: cookieHeader() } : {},
    })
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';')[0]
      const at = pair.indexOf('=')
      if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
    }
    if (follow && res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url).href
      continue
    }
    return { status: res.status, body: await res.text() }
  }
  return { status: 0, body: '' }
}

// 1. Authenticate with the launch token.
const boot = await get(`/?token=${TOKEN}`)
console.log(`bootstrap            : HTTP ${boot.status}, cookies=${jar.size}`)

// 2. Pull the real bundle URLs out of the served page.
const page = await get('/')
console.log(`index                : HTTP ${page.status}, ${page.body.length} bytes`)

const refs = [...page.body.matchAll(/src="([^"]+dsh-(?:mobile-rail|opencode-go-usage)\/client\.js[^"]*)"/g)]
  .map((m) => m[1].replaceAll('&amp;', '&'))
console.log(`bundle refs found    : ${refs.length}`)

for (const ref of refs) {
  const url = new URL(ref, BASE)
  const res = await fetch(url, { headers: { Cookie: cookieHeader() } })
  const text = await res.text()
  const name = ref.includes('mobile-rail') ? 'dsh-mobile-rail' : 'dsh-opencode-go-usage'
  const ok = res.status === 200 && text.includes('__ModuleLoader__')
  console.log(`${name.padEnd(21)}: HTTP ${res.status}, ${text.length} bytes, bundle=${text.includes('__ModuleLoader__')}  ${ok ? 'OK' : 'BAD'}`)
}

// 3. The host route (session-authenticated).
const status = await get('/api/opencode-go-usage.status')
let parsed
try { parsed = JSON.parse(status.body) } catch { /* leave undefined */ }
console.log(`usage route          : HTTP ${status.status}`)
if (parsed) {
  const windows = (parsed.windows ?? []).map((w) => `${w.label} ${w.percent}%`).join(' | ')
  console.log(`  ok=${parsed.ok} stale=${parsed.stale} ${windows}${parsed.error ? ` error=${parsed.error}` : ''}`)
} else {
  console.log(`  body: ${status.body.slice(0, 80)}`)
}
