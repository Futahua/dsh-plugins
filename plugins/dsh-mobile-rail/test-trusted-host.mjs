// Probe the Host fence on a dsh web started with --trusted-host <tailnet>.
// 401 = fence passed (auth required); 403 = fence rejected. 403 is what forced
// the bridge to exist, so 401 here means Serve could connect directly.
import { connect } from 'node:net'

const PORT = Number(process.argv[2] ?? 3094)
import { TRUSTED_HOST as AUTHORITY } from '../../config.mjs'

function raw({ hostHeader, path = '/api/rpc' }) {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port: PORT })
    let data = ''
    const done = (v) => { sock.destroy(); resolve(v) }
    sock.setTimeout(8000, () => done('TIMEOUT'))
    sock.on('error', (e) => done('ERR ' + e.message))
    sock.on('connect', () => {
      sock.write([`GET ${path} HTTP/1.1`, `Host: ${hostHeader}`, 'Connection: close', '', ''].join('\r\n'))
    })
    sock.on('data', (c) => { data += c.toString('utf8') })
    sock.on('end', () => {
      const status = String(data.split('\r\n')[0]).replace('HTTP/1.1 ', '')
      const body = data.split('\r\n\r\n').slice(1).join('').trim().slice(0, 30)
      done(`${status}  ${body}`)
    })
  })
}

console.log(`fence probe on 127.0.0.1:${PORT}`)
const loopback = await raw({ hostHeader: `127.0.0.1:${PORT}` })
const tailnet = await raw({ hostHeader: AUTHORITY })
const control = await raw({ hostHeader: 'evil.example.com' })

console.log(`  loopback Host        -> ${loopback}`)
console.log(`  tailnet Host         -> ${tailnet}   <- decisive`)
console.log(`  untrusted Host       -> ${control}`)
console.log('')
const tailnetOk = tailnet.includes('401')
const controlOk = control.includes('403')
console.log(`  control still rejected : ${controlOk ? 'yes (fence still active)' : 'NO - unexpected'}`)
if (tailnetOk) {
  console.log('  VERDICT: --trusted-host WORKS.')
  console.log('           Serve could proxy directly to dsh web; the bridge would no')
  console.log('           longer be needed for the Host fence.')
} else {
  console.log('  VERDICT: tailnet Host still refused; the bridge remains necessary.')
}
