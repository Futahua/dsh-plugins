// Adversarial checks on the bridge's admission rules, after the hardening.
//
// Two things a review flagged, both tested here:
//
//   - isDocumentRequest decided "navigation" from method + path shape, so ANY
//     extensionless GET was handed a minted session AND proxied upstream
//     authenticated on that same request. A CSRF-shaped primitive.
//   - an unknown Host was silently mapped onto a served authority, not refused.
//
// Uses RAW SOCKETS rather than fetch, deliberately: `Host` and every `Sec-*`
// header are on the Fetch spec's forbidden-header list, so undici strips them
// and the bridge never sees what the test thinks it sent. A first version of
// this file used fetch and every case came back 401 for that reason alone —
// which looked exactly like a product failure and was not one.

import { connect } from 'node:net'

const PORT = Number(process.env.BRIDGE_PORT ?? 3099)
const HOSTHDR = process.env.BRIDGE_HOST ?? `127.0.0.1:${PORT}`

/** One raw request; returns { status, minted, location }. */
function raw({ path = '/', host = HOSTHDR, fetchDest, fetchMode, method = 'GET' }) {
  return new Promise((resolve) => {
    const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}`, 'Connection: close']
    if (fetchDest) lines.push(`Sec-Fetch-Dest: ${fetchDest}`)
    if (fetchMode) lines.push(`Sec-Fetch-Mode: ${fetchMode}`)
    const socket = connect(PORT, '127.0.0.1', () => {
      socket.write(lines.join('\r\n') + '\r\n\r\n')
    })
    let data = ''
    const done = () => {
      socket.destroy()
      const status = Number(/^HTTP\/1\.\d (\d{3})/u.exec(data)?.[1] ?? 0)
      resolve({
        status,
        minted: /^set-cookie: *dsh-auth-/imu.test(data),
        location: /^location: *(.+)$/imu.exec(data)?.[1]?.trim(),
      })
    }
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1')
      if (data.includes('\r\n\r\n') && (status_(data) !== 200 || data.length > 4096)) done()
      else if (status_(data) !== 200) done()
    })
    socket.on('end', done)
    socket.on('error', () => { socket.destroy(); resolve({ status: 0, minted: false }) })
    setTimeout(done, 4000)
  })
}
const status_ = (d) => Number(/^HTTP\/1\.\d (\d{3})/u.exec(d)?.[1] ?? 0)

let failures = 0
const rows = []
async function probe(label, opts, want) {
  const r = await raw(opts)
  const ok = r.status === want.status && (want.minted === undefined || r.minted === want.minted)
  if (!ok) failures++
  rows.push({ label, ...r, ok })
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(50)} HTTP ${r.status} minted=${r.minted}` +
      (ok ? '' : `   (wanted ${want.status}${want.minted === undefined ? '' : ` minted=${want.minted}`})`),
  )
}

console.log('Admission rules\n')

console.log('real navigations (must be admitted):')
await probe('navigation to /', { fetchDest: 'document', fetchMode: 'navigate' }, { status: 200, minted: true })
await probe('navigation to /index.html', { path: '/index.html', fetchDest: 'document', fetchMode: 'navigate' }, { status: 200, minted: true })

console.log('\nthe CSRF shape (must NOT be minted):')
await probe('image GET to extensionless path', { path: '/some/deep/path', fetchDest: 'image', fetchMode: 'no-cors' }, { status: 401, minted: false })
await probe('iframe GET to extensionless path', { path: '/embedded', fetchDest: 'iframe', fetchMode: 'navigate' }, { status: 401, minted: false })
await probe('fetch/XHR to extensionless path', { path: '/data-endpoint', fetchDest: 'empty', fetchMode: 'cors' }, { status: 401, minted: false })

console.log('\nno fetch metadata (fallback: exact entry points only):')
await probe('no metadata, exact entry point', {}, { status: 200, minted: true })
await probe('no metadata, extensionless path', { path: '/anything-else' }, { status: 401, minted: false })

console.log('\nHost allowlist (must be refused before minting):')
await probe('unknown Host', { host: 'evil.example.com' }, { status: 403, minted: false })
await probe('unknown Host on a real path', { host: 'evil.example.com', fetchDest: 'document', fetchMode: 'navigate' }, { status: 403, minted: false })
await probe('served tailnet authority', { host: 'sloptop.taild88607.ts.net:3080', fetchDest: 'document', fetchMode: 'navigate' }, { status: 200, minted: true })

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
