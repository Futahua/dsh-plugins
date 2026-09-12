// Generate the browser session cookie for the DSH GUI over Tailscale and verify it.
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Read the signing secret from the local credential store — never a hardcoded
// copy. This value signs the browser-session cookie, so a literal in a script is
// a session-forgery key for the Harness it belongs to.
const SECRET = (() => {
  const home = process.env.DSH_HOME ?? 'D:/Letters/MatTroiSeConMoc/.dsh'
  const file = join(home, '.credentials.yaml')
  const match = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{43})/u.exec(readFileSync(file, 'utf8'))
  if (!match) throw new Error(`${file} has no client-connection/browser-session secret`)
  return match[1]
})()
const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const key = Buffer.from(SECRET.replaceAll('-', '+').replaceAll('_', '/'), 'base64')

// Backdate issuedAt so a cookie is valid at the verifier even if the two clocks
// differ by a fraction of a second. expiresAt stays absolute, so this only ever
// shortens the session window, never extends it.
const CLOCK_SKEW_MILLISECONDS = 60_000

function mint(authority) {
  const issuedAt = Date.now() - CLOCK_SKEW_MILLISECONDS
  const expiresAt = issuedAt + 30 * 864e5
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
  const sig = b64url(createHmac('sha256', key).update(body).digest())
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest())
  return { name, value: `v1.${body}.${sig}`, pair: `${name}=v1.${body}.${sig}`, expiresAt }
}

const AUTHORITIES = ['sloptop.taild88607.ts.net:3080', 'sloptop:3080']

for (const authority of AUTHORITIES) {
  const c = mint(authority)
  const res = await fetch(`http://${authority}/`, { headers: { Cookie: c.pair } })
  const html = await res.text()
  console.log(`authority   : ${authority}`)
  console.log(`  verified  : HTTP ${res.status}  boot=${html.includes('__DSH_BOOT__')}`)
  console.log(`  expires   : ${new Date(c.expiresAt).toISOString()}`)
  console.log(`  COOKIE    : ${c.pair}`)
  console.log('')
}
