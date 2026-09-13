// Minimal raw HTTP request, for tests that need to send headers `fetch()` will
// not let them send.
//
// `Host` and every `Sec-*` header are on the Fetch spec's forbidden-header list.
// undici silently drops them, so a test written with `fetch()` cannot simulate a
// browser navigation at all — and worse, undici supplies its OWN Fetch Metadata
// (`Sec-Fetch-Dest: empty`, `Sec-Fetch-Mode: cors`), which the bridge correctly
// reads as "this is a fetch, not a navigation".
//
// The first version of the bridge admission test used fetch and every case came
// back 401, which looked exactly like a product failure and was purely the
// harness lying about what it sent.

import { connect } from 'node:net'

/**
 * @param {{port?: number, host?: string, path?: string, method?: string,
 *          headers?: Record<string,string>, body?: string,
 *          navigation?: boolean, timeoutMs?: number}} [options]
 * @returns {Promise<{status: number, headers: Record<string,string>, setCookie: string[], text: string, raw: string}>}
 */
export function rawRequest({
  port = Number(process.env.BRIDGE_PORT ?? 3099),
  host = `127.0.0.1:${port}`,
  path = '/',
  method = 'GET',
  headers = {},
  body,
  navigation = false,
  timeoutMs = 8000,
} = {}) {
  return new Promise((resolve) => {
    const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}`, 'Connection: close']
    if (navigation) {
      // What a real browser sends for a top-level navigation.
      lines.push('Sec-Fetch-Dest: document', 'Sec-Fetch-Mode: navigate', 'Sec-Fetch-Site: none')
      lines.push('Upgrade-Insecure-Requests: 1', 'Accept: text/html,application/xhtml+xml')
    }
    if (body !== undefined) lines.push(`Content-Length: ${Buffer.byteLength(body)}`)
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`)

    const socket = connect(port, '127.0.0.1', () => {
      socket.write(lines.join('\r\n') + '\r\n\r\n' + (body ?? ''))
    })

    let raw = ''
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      socket.destroy()
      const [head = '', ...rest] = raw.split('\r\n\r\n')
      const parsed = {}
      for (const line of head.split('\r\n').slice(1)) {
        const idx = line.indexOf(':')
        if (idx > 0) parsed[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
      }
      resolve({
        status: Number(/^HTTP\/1\.\d (\d{3})/u.exec(head)?.[1] ?? 0),
        headers: parsed,
        setCookie: (raw.match(/^set-cookie:.*$/gimu) ?? []).map((l) => l.slice(l.indexOf(':') + 1).trim()),
        text: rest.join('\r\n\r\n'),
        raw,
      })
    }

    socket.on('data', (chunk) => { raw += chunk.toString('latin1') })
    socket.on('end', finish)
    socket.on('close', finish)
    socket.on('error', finish)
    setTimeout(finish, timeoutMs)
  })
}

/** Which authorities this bridge serves from loopback. */
export const loopbackAuthority = (port = Number(process.env.BRIDGE_PORT ?? 3099)) => `127.0.0.1:${port}`
