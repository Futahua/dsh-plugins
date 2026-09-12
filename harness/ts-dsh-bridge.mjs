// Loopback-only bridge that lets Tailscale Serve reach the DSH Web GUI.
//
// Why this exists: dsh web binds 127.0.0.1 and enforces a Host fence
// (trustedHosts = [] when bound to loopback). Tailscale's plain-HTTP `serve`
// preserves the client's Host header (the tailnet name), which the fence
// rejects with 403, and this tailnet cannot provision TLS certs for HTTPS
// Serve. This bridge rewrites Host/Origin to the loopback authority the fence
// accepts, and re-signs the browser's tailnet-scoped dsh session cookie for the
// loopback authority using DSH's persistent browser-session secret.
//
// SECURITY: the bridge is not an authentication bypass. It admits a request
// only when the browser presents a session cookie that is itself valid (signed
// by DSH's secret, unexpired, bound to this exact authority). Otherwise it
// returns the same minimal 401 DSH emits, and it never mints a session for an
// unauthenticated caller. The re-signed upstream cookie keeps the presented
// cookie's own issuedAt/expiresAt, so the bridge cannot extend a session.
//
// Binds 127.0.0.1 only: reachable exclusively through Tailscale Serve.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { join } from 'node:path'

const LISTEN_PORT = Number(process.env.BRIDGE_PORT ?? 3099)
const UPSTREAM_PORT = Number(process.env.BRIDGE_UPSTREAM ?? 3080)
// The authority dsh web trusts: the exact loopback bind it was launched on.
const UPSTREAM_AUTHORITY = `127.0.0.1:${UPSTREAM_PORT}`
// Non-loopback authorities this bridge serves a browser on.
const PUBLIC_AUTHORITIES = (process.env.BRIDGE_AUTHORITIES ??
  'sloptop.taild88607.ts.net:3080,sloptop:3080').split(',').map((s) => s.trim()).filter(Boolean)

// The browser-session signing secret, read from the local credential store at
// startup. Deliberately NOT defaulted to a literal: this file ships in a public
// repo, and a hardcoded copy of this particular value is a session-forgery key
// for the Harness it belongs to — it signs the client-connection/browser-session
// cookie that authorises the whole GUI. Fail closed rather than guess.
function readSessionSecret() {
  if (process.env.BRIDGE_SECRET) return process.env.BRIDGE_SECRET.trim()
  // This script sits beside .credentials.yaml in the Harness home; DSH_HOME
  // overrides for an install laid out elsewhere.
  const home = process.env.DSH_HOME ?? import.meta.dirname ?? process.cwd()
  const file = join(home, '.credentials.yaml')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Error(
      `cannot read ${file}: set DSH_HOME to the Harness home, or pass BRIDGE_SECRET. ` +
        'The bridge needs the client-connection/browser-session secret to verify cookies.',
    )
  }
  // The record is a 32-byte base64url value stored under client-connection.
  const match = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{43})/u.exec(text)
  if (!match) throw new Error(`${file} has no client-connection/browser-session secret`)
  return match[1]
}

const SECRET_B64URL = readSessionSecret()
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_VERSION = 'v1'
const TOKEN_QUERY = 'token'

// One-tap login: /__dsh_login?key=<token> sets the session cookie and bounces
// to the GUI. Needed on phones, where DevTools cannot set a cookie by hand, and
// where typing a 300-character cookie into a URL bar is impractical.
// The key persists across restarts so a home-screen bookmark keeps working.
const BRIDGE_DIR = import.meta.dirname ?? process.cwd()
const KEY_FILE = process.env.BRIDGE_KEY_FILE ?? join(BRIDGE_DIR, 'ts-bridge-key')
const LOGIN_PATH = '/__dsh_login'
const MANIFEST_PATH = '/manifest.webmanifest'
// Loopback health probe used by startup.ps1 to wait until DSH is actually
// serving before the bridge starts forwarding to it.
const PROBE_QUERY = '__dsh_probe'
const MAX_AGE_MILLISECONDS = 30 * 1440 * 60 * 1000
// Backdate issuedAt to tolerate verifier-clock skew. Applied before the window
// is computed, so it shortens a session rather than extending it.
const CLOCK_SKEW_MILLISECONDS = 60 * 1000

function loadBootstrapKey() {
  if (process.env.BRIDGE_KEY) return process.env.BRIDGE_KEY.trim()
  try {
    if (existsSync(KEY_FILE)) {
      const existing = readFileSync(KEY_FILE, 'utf8').trim()
      if (/^[A-Za-z0-9_-]{20,}$/u.test(existing)) return existing
    }
  } catch { /* fall through and mint a new key */ }
  const minted = randomBytes(32).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  try { writeFileSync(KEY_FILE, minted + '\n', { mode: 0o600 }) } catch { /* non-fatal */ }
  return minted
}

const BOOTSTRAP_KEY = loadBootstrapKey()

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const decodeB64Url = (value) => {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
}
const secret = Buffer.from(SECRET_B64URL.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
const cookieName = (authority) => COOKIE_PREFIX + b64url(createHash('sha256').update(authority).digest())

/** Verify a presented cookie against DSH's cookie format for one authority. */
function verifyCookie(value, authority) {
  const parts = value.split('.')
  if (parts.length !== 3 || parts[0] !== COOKIE_VERSION) return undefined
  const [, body, encodedSignature] = parts
  const actual = decodeB64Url(encodedSignature)
  if (actual === undefined) return undefined
  const expected = createHmac('sha256', secret).update(body).digest()
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return undefined
  const raw = decodeB64Url(body)
  if (raw === undefined) return undefined
  let payload
  try { payload = JSON.parse(raw.toString('utf8')) } catch { return undefined }
  if (payload === null || typeof payload !== 'object') return undefined
  if (payload.version !== 1 || payload.authority !== authority) return undefined
  const { issuedAt, expiresAt } = payload
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return undefined
  const now = Date.now()
  if (!(issuedAt <= now && expiresAt > now && expiresAt > issuedAt)) return undefined
  if (expiresAt - issuedAt > MAX_AGE_MILLISECONDS) return undefined
  return { issuedAt, expiresAt }
}

/** Read one cookie value out of a Cookie header (generated names are cookie-safe). */
function readCookie(headerValue, name) {
  for (const segment of (headerValue ?? '').split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Re-sign a verified session for the upstream authority, preserving its window. */
function signFor(authority, issuedAt, expiresAt) {
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
  const sig = b64url(createHmac('sha256', secret).update(body).digest())
  return `${cookieName(authority)}=${COOKIE_VERSION}.${body}.${sig}`
}

/** Drop every bridge cookie the browser holds; they are not upstream-scoped. */
function readPresentedSession(cookieHeader) {
  const names = [UPSTREAM_AUTHORITY, ...PUBLIC_AUTHORITIES].map(cookieName)
  for (const name of names) {
    const value = readCookie(cookieHeader, name)
    if (value !== undefined) return { name, value }
  }
  return undefined
}

function stripBridgeCookies(cookieHeader) {
  const names = new Set([UPSTREAM_AUTHORITY, ...PUBLIC_AUTHORITIES].map(cookieName))
  const kept = []
  for (const segment of (cookieHeader ?? '').split(';')) {
    const name = segment.split('=')[0]?.trim()
    if (name === undefined || name === '' || names.has(name)) continue
    kept.push(segment.trim())
  }
  return kept
}

/**
 * Authorize one browser request and build the upstream Cookie header.
 * @returns the Cookie header to send upstream, or undefined when unauthorized.
 */
function upstreamCookie(cookieHeader) {
  const presented = readPresentedSession(cookieHeader)
  if (presented === undefined) return undefined
  for (const authority of [UPSTREAM_AUTHORITY, ...PUBLIC_AUTHORITIES]) {
    if (presented.name !== cookieName(authority)) continue
    const window = verifyCookie(presented.value, authority)
    if (window === undefined) return undefined
    return [...stripBridgeCookies(cookieHeader), signFor(UPSTREAM_AUTHORITY, window.issuedAt, window.expiresAt)].join('; ')
  }
  return undefined
}

/** Headers as the upstream must see them: loopback authority, same-origin. */
function upstreamHeaders(headers, cookie) {
  const out = { ...headers }
  out.host = UPSTREAM_AUTHORITY
  out.cookie = cookie
  if (headers.origin !== undefined) out.origin = `http://${UPSTREAM_AUTHORITY}`
  if (headers.referer !== undefined) {
    try {
      const ref = new URL(headers.referer)
      out.referer = `http://${UPSTREAM_AUTHORITY}${ref.pathname}${ref.search}`
    } catch { delete out.referer }
  }
  return out
}

/**
 * DSH is not answering. This is the normal state whenever `dsh web` is not
 * running on the PC, so say that plainly instead of leaking a raw Bad Gateway.
 */
function writeUpstreamDown(res, error) {
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH is not running</title>
<style>body{font:16px system-ui,sans-serif;margin:3rem auto;max-width:26rem;padding:0 1rem;line-height:1.5}
code{background:#0001;padding:.15em .35em;border-radius:.25em}</style>
<h2>DSH is not running on the PC</h2>
<p>The Tailscale bridge is up, but nothing is listening on the <code>dsh web</code>
port, so there is no session to connect to.</p>
<p>Start it on the PC with <code>dsh web</code>, then reload this page.</p>
<p style="opacity:.6">upstream: ${UPSTREAM_AUTHORITY} &middot; ${error}</p>`
  res.writeHead(503, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    'retry-after': '5',
    'content-length': Buffer.byteLength(html)
  })
  res.end(html)
}

const log = (...parts) => console.log(new Date().toISOString(), ...parts)

/** The exact minimal rejection DSH emits for an unauthenticated request. */
function writeUnauthorized(res, method) {
  res.writeHead(401, {
    'cache-control': 'no-store, no-cache, must-revalidate',
    'content-type': 'text/plain; charset=utf-8'
  })
  res.end(method === 'HEAD' ? undefined : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
}

/**
 * One-tap login. The cookie is issued by the server as a Set-Cookie header and
 * the redirect is a plain Location hop, so no JavaScript is involved: Safari
 * (and iOS in general) is unreliable about document.cookie writes during a
 * page-load navigation, and Private Browsing silently drops them.
 *
 * Presentation is chosen from the Host header so the cookie is bound to exactly
 * the authority the browser used, which is the one the hop back to DSH presents.
 */
function writeBootstrap(res, authority, next = '/') {
  // Anchor expiresAt to the backdated issuedAt so the span stays exactly
  // MAX_AGE_MILLISECONDS: DSH rejects a cookie whose window exceeds the limit.
  const issuedAt = Date.now() - CLOCK_SKEW_MILLISECONDS
  const expiresAt = issuedAt + MAX_AGE_MILLISECONDS
  const cookie = signFor(authority, issuedAt, expiresAt)
  const maxAge = Math.floor(MAX_AGE_MILLISECONDS / 1000)
  const target = /^\/(?!\/)/u.test(next) ? next : '/'
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH login</title>
<style>body{font:16px system-ui,sans-serif;margin:3rem auto;max-width:24rem;padding:0 1rem;text-align:center}</style>
<p>Signed in. <a href="${target}">Open the DeepSeek Harness GUI</a></p>`
  res.writeHead(303, {
    location: target,
    // SameSite=Lax (not Strict) so the cookie still rides a top-level
    // navigation that started in another app. No Secure: this is plain HTTP.
    'set-cookie': `${cookie}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    'referrer-policy': 'no-referrer',
    'content-length': Buffer.byteLength(html)
  })
  res.end(html)
}

/** Presentation authority: the name the browser used when it is one we serve. */
function authorityFor(host) {
  return PUBLIC_AUTHORITIES.includes(host ?? '') ? host : PUBLIC_AUTHORITIES[0]
}

/**
 * Whether this is a top-level document navigation, which is safe to answer with
 * a login redirect. API and static-asset requests must never be redirected: a
 * fetch or image following a 303 to "/" would receive HTML under a resource
 * content type, and redirecting /api would loop.
 */
function isDocumentRequest(req, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (url.pathname === MANIFEST_PATH) return false
  if (url.pathname.startsWith('/api')) return false
  if (url.pathname.startsWith('/plugins/')) return false
  if (url.pathname.startsWith('/assets/')) return false
  if (/\.(?:js|mjs|css|map|json|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|wasm)$/iu.test(url.pathname)) return false
  return true
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://bridge.invalid')

  // Health probe: reports whether the DSH upstream answers at all. Loopback
  // callers only, and it reveals nothing beyond liveness.
  if (url.searchParams.has(PROBE_QUERY)) {
    const remote = req.socket.remoteAddress ?? ''
    if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end('forbidden\n')
      return
    }
    const probe = httpRequest({ host: '127.0.0.1', port: UPSTREAM_PORT, method: 'GET', path: '/' }, (up) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`upstream ${up.statusCode}\n`)
    })
    probe.on('error', (error) => {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end(`upstream unreachable: ${error.message}\n`)
    })
    probe.end()
    return
  }

  // Login bootstrap: authorized by its own unguessable key, never by a cookie.
  if (url.pathname === LOGIN_PATH) {
    const presented = Buffer.from(url.searchParams.get('key') ?? '', 'utf8')
    const expected = Buffer.from(BOOTSTRAP_KEY, 'utf8')
    if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) {
      log('denied bootstrap', req.socket.remoteAddress)
      writeUnauthorized(res, req.method)
      return
    }
    log('bootstrap login issued for', authorityFor(req.headers.host))
    writeBootstrap(res, authorityFor(req.headers.host))
    return
  }

  const cookie = upstreamCookie(req.headers.cookie)
  // A token-bearing root URL is DSH's own launch handshake; let it through so
  // DSH stays the single authority that mints sessions. The web-app manifest is
  // public too: a 401 there makes iOS treat "Add to Home Screen" as broken.
  const hasToken = url.searchParams.has(TOKEN_QUERY)
  if (cookie === undefined && !hasToken && url.pathname !== MANIFEST_PATH) {
    // A browser landing on the GUI with no session is far more likely to be a
    // bookmarked or typed address than an attack, so sign it in rather than
    // showing DSH's 401. Sub-resources still get a hard 401: only top-level
    // navigations are redirected, which also keeps this loop-free.
    if (isDocumentRequest(req, url)) {
      log('auto-login redirect for', req.headers.host)
      // Relay only a path DSH actually serves; anything else lands on "/" so the
      // user gets the GUI instead of a 404 from a stale deep bookmark.
      const next = url.pathname === '/index.html' ? '/index.html' : '/'
      writeBootstrap(res, authorityFor(req.headers.host), next)
      return
    }
    log('denied', req.method, req.url)
    writeUnauthorized(res, req.method)
    return
  }
  const headers = upstreamHeaders(req.headers, cookie)
  if (cookie === undefined) delete headers.cookie
  const upstream = httpRequest({
    host: '127.0.0.1',
    port: UPSTREAM_PORT,
    method: req.method,
    path: req.url,
    headers
  }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers)
    upRes.pipe(res)
  })
  upstream.on('error', (error) => {
    log('upstream error', error.message)
    if (!res.headersSent) writeUpstreamDown(res, error.message)
  })
  req.pipe(upstream)
})

// Upgrade passthrough (kept for completeness) with the same authorization.
server.on('upgrade', (req, socket) => {
  const cookie = upstreamCookie(req.headers.cookie)
  if (cookie === undefined) {
    log('denied upgrade', req.url)
    socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
    return
  }
  const headers = upstreamHeaders(req.headers, cookie)
  headers.connection = 'Upgrade'
  const lines = [`GET ${req.url} HTTP/1.1`]
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`)
  }
  const upstream = connect({ host: '127.0.0.1', port: UPSTREAM_PORT }, () => {
    upstream.write(lines.join('\r\n') + '\r\n\r\n')
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', (error) => { log('upgrade error', error.message); socket.destroy() })
  socket.on('error', () => upstream.destroy())
})

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  log(`bridge listening on http://127.0.0.1:${LISTEN_PORT} -> http://${UPSTREAM_AUTHORITY}`)
  log(`public authorities: ${PUBLIC_AUTHORITIES.join(', ')}`)
  log('auth: browser cookie verified per request; no session is minted for anonymous callers')
  log(`one-tap login: http://${PUBLIC_AUTHORITIES[0]}${LOGIN_PATH}?key=${BOOTSTRAP_KEY}`)
})
