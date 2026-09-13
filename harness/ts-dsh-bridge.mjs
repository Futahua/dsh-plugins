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
// SECURITY MODEL — read this before changing the admission rules.
//
// The bridge admits a request in one of two ways:
//
//   1. The browser presents a session cookie that is itself valid (signed by
//      DSH's secret, unexpired, bound to a served authority). The bridge
//      re-signs it for the loopback authority, keeping the presented
//      issuedAt/expiresAt, so re-signing cannot extend a session.
//   2. OR the request is a top-level document navigation, in which case the
//      bridge MINTS a session and serves the GUI in one hop.
//
// An earlier version of this comment claimed the bridge "is not an
// authentication bypass" and "never mints a session for an unauthenticated
// caller". Case 2 makes both of those false. The honest description is:
//
//   Tailscale network authorization IS the credential for DSH, and the bridge
//   converts that authorization into a DSH session.
//
// Three consequences worth keeping in view:
//
//   - Every tailnet identity that can reach the Serve endpoint has full GUI
//     access. If the ACL there is effectively allow-all, then "member of my
//     tailnet" means "authorized DSH operator" — which should be an intentional
//     decision, not a side effect of joining.
//   - The nominal 30-day DSH session lifetime carries no authentication
//     significance: when it lapses, the next qualifying navigation mints
//     another.
//   - The tailnet ACL is therefore the only access control here that means
//     anything.
//
// Because case 2 hands a session to a caller who presented nothing, the
// definition of "top-level document navigation" is load-bearing. It is enforced
// from fetch metadata rather than from path shape — see isDocumentRequest.
//
// Binds 127.0.0.1 only, and rejects any Host it does not serve: binding to
// loopback is not the same as "reachable only through Tailscale Serve", since
// local processes and a local browser can reach it too.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
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

// There is deliberately NO login key, password or bootstrap token here.
//
// The bridge signs in any top-level document navigation that arrives without a
// session (the `cookie === undefined` branch below), because a browser landing
// on the GUI is overwhelmingly a bookmark rather than an attack. Everything
// that can reach these authorities is already on the tailnet, and tailnet
// membership is the real access boundary.
//
// A key on top of that was a second door into a room with no walls: it never
// denied anybody who could reach the port, it was only something to carry
// around, paste into chat, and leak. Removing it changes no security property
// that was actually being enforced — it removes the illusion of one.
//
// Do not reintroduce one. If access ever needs to be restricted, restrict the
// tailnet (ACLs, device approval), which is the layer that actually gates.
const MANIFEST_PATH = '/manifest.webmanifest'
// Loopback health probe used by startup.ps1 to wait until DSH is actually
// serving before the bridge starts forwarding to it.
const PROBE_QUERY = '__dsh_probe'
const MAX_AGE_MILLISECONDS = 30 * 1440 * 60 * 1000
// Backdate issuedAt to tolerate verifier-clock skew. Applied before the window
// is computed, so it shortens a session rather than extending it.
const CLOCK_SKEW_MILLISECONDS = 60 * 1000

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
  res.end(method === 'HEAD' ? undefined : 'dsh web authentication required; open the GUI URL to sign in.\n')
}

/** Authorities this bridge serves from loopback: its own listener. */
const LOOPBACK_AUTHORITIES = new Set([
  `127.0.0.1:${LISTEN_PORT}`,
  `localhost:${LISTEN_PORT}`,
  `[::1]:${LISTEN_PORT}`
])

/**
 * Whether we serve this Host at all.
 *
 * Binding to loopback is NOT the same as "only reachable through Tailscale
 * Serve": local processes and a local browser can reach the port too, which is
 * exactly the situation Host allowlisting exists for. An unknown Host must die
 * BEFORE any session is minted or proxied — not be quietly mapped onto a
 * served authority, which is what the previous `authorityFor` fallback did.
 */
function isKnownAuthority(host) {
  if (host === undefined || host === '') return false
  return PUBLIC_AUTHORITIES.includes(host) || LOOPBACK_AUTHORITIES.has(host)
}

/** Presentation authority: the name the browser used. Callers must have
 *  already established the Host is one we serve (see isKnownAuthority). */
function authorityFor(host) {
  return PUBLIC_AUTHORITIES.includes(host ?? '') ? host : PUBLIC_AUTHORITIES[0]
}

/**
 * Whether this is a TOP-LEVEL DOCUMENT NAVIGATION — which is the only thing
 * allowed to be handed a freshly minted session.
 *
 * The previous version decided this from method and path shape alone, which
 * never actually tested "navigation": any extensionless GET — an `<img src>`, an
 * `<iframe>`, a speculative or resource request — was classified as a login
 * navigation. That is worse than mislabelling, because the bridge mints the
 * session and proxies THAT SAME REQUEST upstream authenticated, so a caller
 * never has to accept or retain the Set-Cookie to get an authenticated fetch.
 * That is a CSRF-shaped primitive reachable from any content running in a
 * browser that can resolve the private hostname.
 *
 * Browsers send Fetch Metadata on every request, and it answers precisely the
 * question being asked, so it is authoritative when present:
 *
 *   Sec-Fetch-Dest: document   — the destination is a document, not an image,
 *                                iframe, script or empty (fetch/XHR)
 *   Sec-Fetch-Mode: navigate   — it is a navigation, not a cors/no-cors fetch
 *
 * When a client sends no Fetch Metadata at all, only the bare GUI entry points
 * qualify. An arbitrary extensionless path does not: that was the hole.
 */
function isDocumentRequest(req, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (url.pathname === MANIFEST_PATH) return false
  if (url.pathname.startsWith('/api')) return false
  if (url.pathname.startsWith('/plugins/')) return false
  if (url.pathname.startsWith('/assets/')) return false
  if (/\.(?:js|mjs|css|map|json|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|wasm)$/iu.test(url.pathname)) return false

  const dest = req.headers['sec-fetch-dest']
  const mode = req.headers['sec-fetch-mode']
  if (dest !== undefined || mode !== undefined) {
    // Present: trust it, and require both halves to say "navigation".
    return dest === 'document' && (mode === undefined || mode === 'navigate')
  }

  // Absent: fall back to the exact entry points only, never a wildcard path.
  return url.pathname === '/' || url.pathname === '/index.html'
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://bridge.invalid')

  // Host allowlist, enforced BEFORE anything is minted or proxied. Without this
  // an arbitrary Host header reaching the loopback listener — a local process, a
  // DNS-rebinding style request from a browser — was silently mapped onto a
  // served authority and admitted. Fail closed, and say which host was refused.
  if (!isKnownAuthority(req.headers.host)) {
    log('rejected unknown Host', req.headers.host ?? '<absent>')
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('host not served by this bridge\n')
    return
  }

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

  const cookie = upstreamCookie(req.headers.cookie)
  // A token-bearing root URL is DSH's own launch handshake; let it through so
  // DSH stays the single authority that mints sessions. The web-app manifest is
  // public too: a 401 there makes iOS treat "Add to Home Screen" as broken.
  const hasToken = url.searchParams.has(TOKEN_QUERY)
  const publicPath = url.pathname === MANIFEST_PATH

  // A browser landing on the GUI with no session is far more likely to be a
  // bookmarked or typed address than an attack, so serve it the GUI with a
  // freshly minted session rather than showing DSH's 401. Sub-resources still
  // get a hard 401: a fetch or image following a redirect to "/" would receive
  // HTML under a resource content type.
  const mint = cookie === undefined && !hasToken && !publicPath && isDocumentRequest(req, url)
  if (cookie === undefined && !hasToken && !publicPath && !mint) {
    log('denied', req.method, req.url)
    writeUnauthorized(res, req.method)
    return
  }

  // Signing in happens IN ONE HOP, by proxying with a minted cookie rather than
  // redirecting to a login URL. Redirecting looks equivalent and is not: a
  // client that cannot retain cookies follows the 303 back to "/", arrives
  // cookieless again, and is sent round forever — measured with `curl -L`,
  // which gave up after 50 redirects. Proxying in place hands such a client a
  // real page, and browsers just save a round trip.
  //
  // A Referer-based guard against that loop was tried first and cannot work:
  // this response sets `referrer-policy: no-referrer`, so the follow-up arrives
  // with no Referer to detect. Do not reintroduce one.
  let effective = cookie
  let setCookie
  if (mint) {
    // Anchor expiresAt to the backdated issuedAt so the window stays exactly
    // MAX_AGE_MILLISECONDS: DSH rejects a cookie whose span exceeds the limit.
    const issuedAt = Date.now() - CLOCK_SKEW_MILLISECONDS
    const expiresAt = issuedAt + MAX_AGE_MILLISECONDS
    // TWO signings, because the two hops present different authorities: the
    // browser stores a cookie bound to the name in its address bar, while DSH
    // must receive one bound to the loopback authority it was launched on.
    // Signing once and using it for both is a 401 — DSH checks the binding.
    // SameSite=Lax (not Strict) so the cookie still rides a top-level
    // navigation that started in another app. No Secure: this is plain HTTP.
    const maxAge = Math.floor(MAX_AGE_MILLISECONDS / 1000)
    setCookie = `${signFor(authorityFor(req.headers.host), issuedAt, expiresAt)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`
    effective = signFor(UPSTREAM_AUTHORITY, issuedAt, expiresAt)
    log('auto-login for', req.headers.host)
  }

  const headers = upstreamHeaders(req.headers, effective)
  if (effective === undefined) delete headers.cookie
  const upstream = httpRequest({
    host: '127.0.0.1',
    port: UPSTREAM_PORT,
    method: req.method,
    path: req.url,
    headers
  }, (upRes) => {
    const out = { ...upRes.headers }
    if (setCookie !== undefined) out['set-cookie'] = setCookie
    res.writeHead(upRes.statusCode ?? 502, out)
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
  log('auth: top-level navigations are signed in; sub-resources are verified per request')
  log('access boundary: tailnet membership - no key, password or login URL')
  log(`open the gui at: http://${PUBLIC_AUTHORITIES[0]}/`)
})
