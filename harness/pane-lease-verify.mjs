// Prove the pane lease's fail-closed properties by measurement.
//
// The important one is #7: corrupt or unreadable state must read as HELD. A
// lease that fails open is worse than no lease, because it looks like
// protection while granting exactly the access it exists to deny.
//
// Uses its own lease file so it cannot disturb a real run.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'pane-lease-verify-'))
process.env.PANE_LEASE_FILE = join(dir, 'pane-lease.json')

const { acquire, release, status, withLease, bannerScript } = await import(
  'file:///D:/Letters/MatTroiSeConMoc/.dsh/pane-lease.mjs'
)
const FILE = process.env.PANE_LEASE_FILE

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('1. no lease file reads as free')
check('status.held', status().held, false)

console.log('\n2. first acquire wins')
const a = acquire({ owner: 'run-a', ttlMs: 60_000 })
check('acquire(ok)', a.ok, true)

console.log('\n3. FAIL-CLOSED: a second owner is refused, not queued')
const b = acquire({ owner: 'run-b', ttlMs: 60_000 })
check('acquire(ok)', b.ok, false)
check('heldBy', b.heldBy, 'run-a')

console.log('\n4. status names the holder')
check('held', status().held, true)
check('owner', status().owner, 'run-a')

console.log('\n5. a non-holder cannot release')
check('release(ok)', release({ owner: 'run-b' }).ok, false)
check('still held', status().held, true)

console.log('\n6. the holder can release')
check('release(ok)', release({ owner: 'run-a' }).ok, true)
check('status.held', status().held, false)

console.log('\n7. FAIL-CLOSED: corrupt state denies rather than grants')
writeFileSync(FILE, '{ this is not json')
check('status.held', status().held, true)
check('acquire(ok)', acquire({ owner: 'run-c' }).ok, false)

console.log('\n8. FAIL-CLOSED: malformed-but-valid JSON also denies')
writeFileSync(FILE, JSON.stringify({ hello: 'world' }))
check('status.held', status().held, true)
check('acquire(ok)', acquire({ owner: 'run-c' }).ok, false)

console.log('\n9. an expired lease frees the page (a crash cannot wedge it)')
writeFileSync(FILE, JSON.stringify({ owner: 'run-dead', expiresAt: Date.now() - 1000 }))
check('status.held', status().held, false)
check('reason', status().reason, 'expired')
check('acquire(ok)', acquire({ owner: 'run-d', ttlMs: 60_000 }).ok, true)
release({ owner: 'run-d' })

console.log('\n10. withLease runs the body, then frees; a blocked body never runs')
let ran = 0
await withLease({ owner: 'run-e', ttlMs: 60_000 }, async () => { ran += 1 })
check('body ran once', ran, 1)
check('released after', status().held, false)

acquire({ owner: 'run-f', ttlMs: 60_000 })
let blockedRan = 0
let threw = null
try {
  await withLease({ owner: 'run-g', ttlMs: 60_000 }, async () => { blockedRan += 1 })
} catch (error) { threw = error.message }
check('blocked body never ran', blockedRan, 0)
check('withLease threw', typeof threw === 'string' && threw.includes('held by "run-f"'), true)
release({ owner: 'run-f' })

console.log('\n11. a concurrent burst yields exactly one winner')
for (const f of [FILE]) { try { rmSync(f) } catch {} }
const results = await Promise.all(
  Array.from({ length: 8 }, (_, i) =>
    Promise.resolve().then(() => acquire({ owner: `race-${i}`, ttlMs: 60_000 })),
  ),
)
const winners = results.filter((r) => r.ok)
check('exactly one winner', winners.length, 1)

console.log('\n12. banner script is well-formed and names the owner')
const script = bannerScript('run-a', 60_000)
check('mentions owner', script.includes('Automation \\"run-a\\"'), true)

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
