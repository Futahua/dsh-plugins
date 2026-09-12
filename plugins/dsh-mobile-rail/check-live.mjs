// Does the LIVE server serve the plugins?
//
// Mints a browser-session cookie the same way the bridge does, using the
// signing secret from the local credential store — never a hardcoded copy. That
// secret is per-install and must not be committed.
//
//   DSH_AUTHORITY   host:port of the GUI   (or pass it as argv[2])
//   DSH_HOME        Harness home holding .credentials.yaml
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AUTHORITY as CONFIG_AUTHORITY, DSH_HOME } from '../../config.mjs'

const AUTHORITY = process.argv[2] ?? CONFIG_AUTHORITY

/** Read the browser-session signing secret from the local credential store. */
function readSecret() {
  const file = join(DSH_HOME, '.credentials.yaml')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Error(
      `cannot read ${file}. Set DSH_HOME to the Harness home, or point this script at an install that has one.`,
    )
  }
  // The record is a 32-byte base64url value stored under client-connection.
  const match = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{43})/u.exec(text)
  if (!match) throw new Error(`${file} has no client-connection/browser-session secret`)
  return match[1]
}

const key = Buffer.from(readSecret().replaceAll('-', '+').replaceAll('_', '/'), 'base64')
const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

/** A cookie valid for one authority, backdated to tolerate clock skew. */
function cookieFor(authority) {
  const issuedAt = Date.now() - 60_000
  const expiresAt = issuedAt + 30 * 864e5
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
  const sig = b64url(createHmac('sha256', key).update(body).digest())
  return `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}=v1.${body}.${sig}`
}

const headers = { Cookie: cookieFor(AUTHORITY) }
const res = await fetch(`http://${AUTHORITY}/`, { headers })
const body = await res.text()
console.log(`live index: HTTP ${res.status}, ${body.length} bytes`)

for (const id of ['dsh-mobile-rail', 'dsh-opencode-go-usage']) {
  console.log(`  ${id.padEnd(22)} in boot graph: ${body.includes(id)}`)
}

const usage = await fetch(`http://${AUTHORITY}/api/opencode-go-usage.status`, { headers })
console.log(`  usage route           : HTTP ${usage.status}`)
