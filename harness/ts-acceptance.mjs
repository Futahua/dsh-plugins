// Security boundary check through the tailnet.
//
// Two behaviours are intentional and must not blur:
//   - API/sub-resource requests are the auth boundary: invalid session => 401.
//   - Top-level document navigations auto sign-in, so a stale bookmark works.
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
function cookieFor(a) {
  // Backdate issuedAt to tolerate verifier-clock skew.
  const i = Date.now() - 60_000, e = i + 30 * 864e5
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: a, issuedAt: i, expiresAt: e }), 'utf8'))
  const sig = b64url(createHmac('sha256', key).update(body).digest())
  return 'dsh-auth-' + b64url(createHash('sha256').update(a).digest()) + '=v1.' + body + '.' + sig
}

const TS = 'sloptop.taild88607.ts.net:3080'
const BASE = `http://${TS}`
const BOGUS = 'dsh-auth-bogusname=v1.bogusbody.bogussig'
const WRONG = cookieFor('someone-else.example.com:3080')
const rpcBody = JSON.stringify({ type: 'client-request', rpcId: '0f8fad5b-d9cb-469f-a165-70867728950e', method: 'ping', payload: {} })

async function req(path, { cookie, method = 'GET', body } = {}) {
  const headers = {}
  if (cookie) headers.Cookie = cookie
  if (body) headers['content-type'] = 'application/json'
  const r = await fetch(`${BASE}${path}`, { method, headers, body, redirect: 'manual' })
  return { status: r.status, loc: r.headers.get('location'), text: (await r.text()).trim().slice(0, 44).replace(/\s+/g, ' ') }
}

let failures = 0
const check = (label, cond, detail) => {
  if (!cond) failures++
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label.padEnd(34)} ${detail}`)
}

console.log('API boundary (must reject unauthenticated):')
for (const [label, cookie] of [['no cookie', undefined], ['bogus cookie', BOGUS], ['wrong authority', WRONG], ['valid cookie', cookieFor(TS)]]) {
  const r = await req('/api/ping', { method: 'POST', body: rpcBody, cookie })
  const expect = label === 'valid cookie' ? 404 : 401
  check(`POST /api/ping  ${label}`, r.status === expect, `HTTP ${r.status} (expect ${expect})`)
}

console.log('')
console.log('Sub-resources (must reject, never redirect):')
for (const p of ['/assets/index.js', '/plugins/x/client.js']) {
  const r = await req(p)
  check(`GET ${p}`, r.status === 401 && !r.loc, `HTTP ${r.status} location=${r.loc ?? 'none'}`)
}

console.log('')
console.log('Documents (auto sign-in, by design):')
for (const [label, cookie] of [['no cookie', undefined], ['bogus cookie', BOGUS], ['valid cookie', cookieFor(TS)]]) {
  const r = await req('/', { cookie })
  const ok = label === 'valid cookie' ? r.status === 200 : (r.status === 303 && r.loc === '/')
  check(`GET /  ${label}`, ok, `HTTP ${r.status} location=${r.loc ?? 'none'}`)
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
// Exit naturally: process.exit() during socket teardown trips a libuv assertion
// on Windows (async.c) that corrupts the exit code.
process.exitCode = failures === 0 ? 0 : 1
