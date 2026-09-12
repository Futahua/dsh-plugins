// Fail-closed per-tab ownership lease for the shared browser page.
//
// THE PROBLEM
//
// The pane and an automation script drive ONE page. Nothing arbitrates between
// them: an automated run clicking through a flow will fight a human who is
// using the pane at the same time, and both will see a page that is behaving
// inexplicably.
//
// WHAT THIS CAN AND CANNOT ENFORCE
//
// Measured, not assumed: the pane's own input route reads a CDP handle that
// only exists while an SSE client is streaming (`pane.ts`, "the screencast
// follows its subscribers"), and the package exposes no hook to make that route
// refuse input. So this cannot stop a human clicking. What it CAN do — and what
// the actual damage comes from — is stop an AUTOMATION from driving while
// somebody else holds the page. That boundary is ours, so it is enforceable
// there, and it fails closed.
//
// The contract: an automation must hold the lease to drive, and must release it
// when done. `withLease` does both, and refuses to run the body if it cannot
// acquire. A crashed run cannot wedge the system: leases expire.
//
// State lives in one JSON file, taken atomically. Corrupt or unreadable state is
// treated as HELD, never as free — failing open is the one bug that would make
// this worthless.
//
//   node pane-lease.mjs status
//   node pane-lease.mjs acquire --owner=my-run --ttl=60000 --tab=3
//   node pane-lease.mjs release --owner=my-run
//   node pane-lease.mjs takeover --owner=my-run      # steal an EXPIRED lease
//
// As a library:
//   import { withLease } from './pane-lease.mjs'
//   await withLease({ owner: 'my-run' }, async (lease) => { ... })

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? 'D:/Letters/MatTroiSeConMoc/.dsh'
const LEASE_FILE = process.env.PANE_LEASE_FILE ?? join(DSH_HOME, 'pane-lease.json')

/** Default hold time. Short enough that a crash frees the page quickly. */
export const DEFAULT_TTL_MS = 120_000

/**
 * Read the lease.
 * @returns {{held: boolean, owner?: string, expiresAt?: number, tab?: number, reason?: string}}
 */
export function status() {
  let raw
  try {
    raw = readFileSync(LEASE_FILE, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { held: false, reason: 'no lease file' }
    // Unreadable for any other reason: refuse to call it free.
    return { held: true, owner: '<unreadable>', reason: `cannot read: ${error.code}` }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Corrupt state fails CLOSED. A half-written file must never read as free.
    return { held: true, owner: '<corrupt>', reason: 'lease file is not valid JSON' }
  }
  if (typeof parsed?.owner !== 'string' || typeof parsed?.expiresAt !== 'number') {
    return { held: true, owner: '<malformed>', reason: 'lease file lacks owner/expiresAt' }
  }
  if (Date.now() >= parsed.expiresAt) {
    return { held: false, owner: parsed.owner, expiresAt: parsed.expiresAt, reason: 'expired' }
  }
  return { held: true, owner: parsed.owner, expiresAt: parsed.expiresAt, tab: parsed.tab }
}

function writeExclusive(payload) {
  // 'wx' is atomic create-if-absent: two racing acquirers cannot both win.
  const fd = openSync(LEASE_FILE, 'wx')
  try {
    writeSync(fd, JSON.stringify(payload))
  } finally {
    closeSync(fd)
  }
}

/**
 * Acquire the lease. Fails closed: returns `{ok: false}` rather than granting
 * when the page is held, or when the existing state cannot be trusted.
 *
 * @param {{owner: string, ttlMs?: number, tab?: number}} options
 */
export function acquire({ owner, ttlMs = DEFAULT_TTL_MS, tab }) {
  if (!owner) throw new Error('acquire requires an owner')
  const expiresAt = Date.now() + ttlMs
  const payload = { owner, expiresAt, tab, pid: process.pid, acquiredAt: Date.now() }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeExclusive(payload)
      return { ok: true, owner, expiresAt }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const current = status()
      if (!current.held) {
        // Expired or absent: clear it and retry once. A genuine race here just
        // means another acquirer wins the retry, which is correct.
        try { unlinkSync(LEASE_FILE) } catch { /* someone else cleared it */ }
        continue
      }
      return {
        ok: false,
        heldBy: current.owner,
        expiresAt: current.expiresAt,
        reason: current.reason ?? 'held by another owner',
      }
    }
  }
  return { ok: false, heldBy: '<race>', reason: 'lost the acquire race twice' }
}

/**
 * Release the lease. Only the holder may release it, so a run that lost its
 * lease (expired, then taken over) cannot release the new holder's claim.
 */
export function release({ owner }) {
  const current = status()
  if (!current.held) {
    // Expired but present: clear the file so the next acquirer does not have to.
    try { unlinkSync(LEASE_FILE) } catch { /* already gone */ }
    return { ok: true, released: false, reason: 'no live lease' }
  }
  if (current.owner !== owner) {
    return { ok: false, released: false, heldBy: current.owner, reason: 'not the holder' }
  }
  try { unlinkSync(LEASE_FILE) } catch { /* already gone */ }
  return { ok: true, released: true }
}

/**
 * Acquire, run, always release. The body is NOT run when the lease cannot be
 * taken — that is the fail-closed property.
 */
export async function withLease({ owner, ttlMs = DEFAULT_TTL_MS, tab }, body) {
  const got = acquire({ owner, ttlMs, tab })
  if (!got.ok) {
    throw new Error(
      `pane lease refused: held by "${got.heldBy}" until ` +
        `${new Date(got.expiresAt ?? 0).toISOString()} (${got.reason})`,
    )
  }
  try {
    return await body({ owner, expiresAt: got.expiresAt })
  } finally {
    release({ owner })
  }
}

/**
 * The visible half of the handoff: a banner any driver can evaluate in the
 * shared page, so the human watching the pane can SEE that an automation has
 * taken the page — and that it will give it back.
 *
 * Returns a JS expression string; evaluate it in the page.
 */
export function bannerScript(owner, ttlMs = DEFAULT_TTL_MS) {
  const until = new Date(Date.now() + ttlMs).toISOString().slice(11, 19)
  const text = JSON.stringify(`Automation "${owner}" is driving this page until ${until} UTC`)
  return `(() => {
    const id = '__dsh-pane-lease-banner'
    document.getElementById(id)?.remove()
    const el = document.createElement('div')
    el.id = id
    el.textContent = ${text}
    el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;' +
      'background:#b45309;color:#fff;font:600 13px system-ui,sans-serif;' +
      'padding:6px 10px;text-align:center;pointer-events:none'
    document.documentElement.appendChild(el)
    return 'banner shown'
  })()`
}

/** Remove the banner. */
export function bannerClearScript() {
  return `(() => { document.getElementById('__dsh-pane-lease-banner')?.remove(); return 'banner cleared' })()`
}

// --- CLI ---------------------------------------------------------------------
if (import.meta.filename === process.argv[1]) {
  const [command, ...rest] = process.argv.slice(2)
  const flag = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
  const owner = flag('owner') ?? 'cli'
  const ttlMs = Number(flag('ttl') ?? DEFAULT_TTL_MS)
  const tab = flag('tab') === undefined ? undefined : Number(flag('tab'))

  const out = (value) => console.log(JSON.stringify(value, null, 2))
  switch (command) {
    case 'status':
      out(status())
      break
    case 'acquire':
      out(acquire({ owner, ttlMs, tab }))
      break
    case 'release':
      out(release({ owner }))
      break
    case 'takeover': {
      // Explicit, auditable steal — only ever of an EXPIRED lease.
      const current = status()
      if (current.held) { out({ ok: false, heldBy: current.owner, reason: 'lease is live, refusing takeover' }); break }
      try { unlinkSync(LEASE_FILE) } catch { /* absent */ }
      out(acquire({ owner, ttlMs, tab }))
      break
    }
    case 'banner':
      console.log(bannerScript(owner, ttlMs))
      break
    default:
      console.error('usage: pane-lease.mjs <status|acquire|release|takeover|banner> [--owner=] [--ttl=] [--tab=]')
      process.exitCode = 2
  }
}
