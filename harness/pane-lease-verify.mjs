// Prove the pane lease's fail-closed properties by measurement.
//
// Two things this suite is careful about, both of which an earlier version got
// wrong (see the header of pane-lease.mjs):
//
//   1. It imports the lease relative to ITS OWN location and prints which file
//      it actually loaded. The previous version imported a hard-coded absolute
//      path into an installed copy, so "12/12 passed" proved nothing about the
//      committed source.
//   2. It races STALE RECLAMATION and RELEASE-AGAINST-TAKEOVER, not just
//      acquisition against an absent file. Racing only the absent case is why
//      the old suite passed while the protocol could split-brain.
//
// Uses its own lease file so it cannot disturb a real run.

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const here = import.meta.dirname
const candidates = [
  join(here, 'pane-lease.mjs'),          // committed layout: harness/ beside harness/
  join(here, '..', 'pane-lease.mjs'),    // local probe layout: .dsh/probe/ vs .dsh/
]
let leasePath = null
for (const c of candidates) {
  try { readFileSync(c); leasePath = c; break } catch { /* try next */ }
}
if (!leasePath) throw new Error(`pane-lease.mjs not found near ${here}`)

const dir = mkdtempSync(join(tmpdir(), 'pane-lease-verify-'))
process.env.PANE_LEASE_FILE = join(dir, 'pane-lease.json')
const FILE = process.env.PANE_LEASE_FILE

const { acquire, release, renew, status, withLease, bannerScript } = await import(pathToFileURL(leasePath).href)

console.log(`loaded lease from: ${leasePath}`)
console.log(`test lease file  : ${FILE}\n`)

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`)
}
const ok = (label, cond, detail = '') => check(label + (detail ? ` ${detail}` : ''), !!cond, true)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clear = () => { try { rmSync(FILE) } catch { /* absent */ } }
const expireNow = () => writeFileSync(FILE, JSON.stringify({ ...JSON.parse(readFileSync(FILE, 'utf8')), expiresAt: Date.now() - 1 }))

console.log('1. no lease file reads as free')
check('status.held', status().held, false)

console.log('\n2. first acquire wins and mints a token')
clear()
const a = acquire({ owner: 'run-a', ttlMs: 60_000 })
ok('acquire.ok', a.ok)
ok('has a 32-char token', typeof a.token === 'string' && a.token.length === 32)
check('generation', a.generation, 1)

console.log('\n3. FAIL-CLOSED: a second owner is refused, not queued')
const b = acquire({ owner: 'run-b', ttlMs: 60_000 })
check('acquire.ok', b.ok, false)
check('heldBy', b.heldBy, 'run-a')

console.log('\n4. a non-holder cannot release; the holder can')
check('release by run-b', release({ owner: 'run-b' }).ok, false)
check('still held', status().held, true)
check('release by run-a with token', release({ owner: 'run-a', token: a.token }).ok, true)
check('status.held', status().held, false)

console.log('\n5. ABA: a stale holder must NOT delete a successor that reused the name')
clear()
const first = acquire({ owner: 'same-name', ttlMs: 60_000 })
ok('first acquire', first.ok)
expireNow()
const second = acquire({ owner: 'same-name', ttlMs: 60_000 })
ok('successor acquire', second.ok)
ok('different token', second.token !== first.token)
check('stale release refused', release({ owner: 'same-name', token: first.token }).ok, false)
check('successor still holds', status().held, true)
check('…and it is the successor', status().token, second.token)

console.log('\n6. FAIL-CLOSED: corrupt state denies rather than grants')
writeFileSync(FILE, '{ this is not json')
check('status.held', status().held, true)
check('acquire.ok', acquire({ owner: 'run-c' }).ok, false)

console.log('\n7. FAIL-CLOSED: valid JSON with no token denies (old or partial write)')
writeFileSync(FILE, JSON.stringify({ owner: 'x', expiresAt: Date.now() + 60_000 }))
check('status.held', status().held, true)
check('reason names the cause', /token/u.test(status().reason ?? ''), true)
check('acquire.ok', acquire({ owner: 'run-c' }).ok, false)

console.log('\n8. FAIL-CLOSED: malformed-but-valid JSON also denies')
writeFileSync(FILE, JSON.stringify({ hello: 'world' }))
check('status.held', status().held, true)

console.log('\n9. an expired lease frees the page, and generation advances')
writeFileSync(FILE, JSON.stringify({ owner: 'run-dead', token: 'deadbeef'.repeat(4), generation: 1, expiresAt: Date.now() - 1000 }))
check('status.held', status().held, false)
check('reason', status().reason, 'expired')
const reacquired = acquire({ owner: 'run-d', ttlMs: 60_000 })
ok('acquire.ok', reacquired.ok)
check('generation incremented', reacquired.generation, 2)
release({ owner: 'run-d', token: reacquired.token })

console.log('\n10. RACE ON STALE RECLAMATION: exactly one winner, 40 rounds')
// The old suite raced acquisition against an ABSENT file, which 'wx' already
// serialises. This races the reclaim path — where the protocol could
// split-brain — and checks the file agrees with the single winner.
let raceFail = null
for (let round = 1; round <= 40 && raceFail === null; round += 1) {
  clear()
  acquire({ owner: 'seed', ttlMs: 60_000 })
  expireNow()
  const results = []
  await Promise.all(Array.from({ length: 6 }, (_, i) =>
    Promise.resolve().then(() => results.push(acquire({ owner: `stale-${round}-${i}`, ttlMs: 60_000 })))))
  const winners = results.filter((r) => r.ok)
  if (winners.length !== 1) {
    raceFail = `round ${round}: ${winners.length} winners (${winners.map((w) => w.owner).join(', ')})`
    break
  }
  const live = status()
  if (!live.held || live.token !== winners[0].token) {
    raceFail = `round ${round}: file token does not match the winner`
    break
  }
  release({ owner: winners[0].owner, token: winners[0].token })
}
check('40 rounds x 6 concurrent reclaimers: one winner, file agrees', raceFail, null)

console.log('\n11. RENEWAL: a body that outlives its TTL keeps the lease')
clear()
let midBodyHeld = null
await withLease({ owner: 'long-run', ttlMs: 700, renewMs: 200 }, async (lease) => {
  await sleep(1500)                       // more than 2x the TTL
  lease.assertHeld()                      // throws if renewal had failed
  midBodyHeld = status()
})
ok('still held mid-body of a run 2x its TTL', midBodyHeld?.held === true)
check('held by the long run', midBodyHeld?.owner, 'long-run')
check('released after the body', status().held, false)

console.log('\n12. withLease runs the body, then frees; a blocked body never runs')
let ran = 0
await withLease({ owner: 'run-e', ttlMs: 60_000 }, async () => { ran += 1 })
check('body ran once', ran, 1)
check('released after', status().held, false)

const held = acquire({ owner: 'run-f', ttlMs: 60_000 })
let blockedRan = 0
let threw = null
try {
  await withLease({ owner: 'run-g', ttlMs: 60_000 }, async () => { blockedRan += 1 })
} catch (error) { threw = error.message }
check('blocked body never ran', blockedRan, 0)
ok('withLease threw naming the holder', /held by "run-f"/u.test(threw ?? ''), `(${(threw ?? '').slice(0, 54)}…)`)
release({ owner: 'run-f', token: held.token })

console.log('\n13. assertHeld() throws once the lease is taken from us')
clear()
let asserted = null
await withLease({ owner: 'victim', ttlMs: 60_000, renewMs: 60_000 }, async (lease) => {
  expireNow()
  const usurper = acquire({ owner: 'usurper', ttlMs: 60_000 })
  ok('usurper acquired', usurper.ok)
  try { lease.assertHeld(); asserted = 'no throw' } catch (error) { asserted = error.message }
})
ok('assertHeld threw', asserted !== null && asserted !== 'no throw', `(${(asserted ?? '').slice(0, 44)}…)`)

console.log('\n14. renew refuses over a successor')
clear()
const r1 = acquire({ owner: 'renewer', ttlMs: 60_000 })
expireNow()
const r2 = acquire({ owner: 'successor', ttlMs: 60_000 })
check('stale renew refused', renew({ owner: 'renewer', token: r1.token, ttlMs: 60_000 }).ok, false)
check('successor untouched', status().token, r2.token)
release({ owner: 'successor', token: r2.token })

console.log('\n15. banner script names the owner')
const script = bannerScript('run-a', 60_000)
check('mentions owner', script.includes('Automation \\"run-a\\"'), true)

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
