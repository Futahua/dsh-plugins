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
// HOW MUTUAL EXCLUSION ACTUALLY WORKS HERE
//
// An earlier version got this wrong in three ways, all found by review and
// fixed below. The lessons are load-bearing, so they are recorded rather than
// just applied:
//
//   1. It reclaimed an expired lease with `unlink()` then retried `wx`. Those
//      two steps are not atomic together: two processes could both read stale,
//      one could unlink the OTHER's freshly acquired lease, and both would end
//      up believing they owned the page. Now reclamation installs a whole new
//      file with an atomic rename, and then RE-READS to confirm its own token
//      survived. Losing that check means losing the race, and losing the race
//      is reported rather than assumed away.
//   2. It authorized release by owner NAME. A run that expired and was replaced
//      by a later run reusing the same name could delete the successor's lease.
//      Every acquisition now carries a unique random `token`; release and renew
//      are authorized by token, so a stale holder cannot touch a successor.
//   3. `withLease` acquired once and ran the body to completion, so a body that
//      outlived its TTL kept driving while a successor also drove. It now
//      renews on a heartbeat, and exposes `assertHeld()` for bodies that want
//      to check before each mutating step.
//
// Residual, stated plainly: this is cooperative locking over a file, not an OS
// mutex. `assertHeld()` is a check, not a fence — a body that ignores both it
// and the abort signal can still issue one more request after losing the lease.
// Real fencing would have to live inside the thing being driven, and the pane
// is third-party. Do not describe this as more than it is.
//
// State lives in one JSON file. Corrupt or unreadable state is treated as HELD,
// never as free — failing open is the one bug that would make this worthless.
// Consequence, also stated plainly: a crash that leaves a corrupt file wedges
// the page until someone clears it. `status()` reports that case with
// `owner: '<corrupt>'` so it is diagnosable rather than mysterious.
//
//   node pane-lease.mjs status
//   node pane-lease.mjs acquire --owner=my-run --ttl=60000 --tab=3
//   node pane-lease.mjs release --owner=my-run --token=<token>
//   node pane-lease.mjs takeover --owner=my-run      # steal an EXPIRED lease
//
// As a library:
//   import { withLease } from './pane-lease.mjs'
//   await withLease({ owner: 'my-run' }, async (lease) => {
//     lease.assertHeld()                            // before each mutating step
//     ...
//   })

import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? 'D:/Letters/MatTroiSeConMoc/.dsh'
const LEASE_FILE = process.env.PANE_LEASE_FILE ?? join(DSH_HOME, 'pane-lease.json')

/** Default hold time. Short enough that a crash frees the page quickly. */
export const DEFAULT_TTL_MS = 120_000

const mintToken = () => randomBytes(16).toString('hex')

/**
 * Read raw lease state, distinguishing "absent" from "untrustworthy".
 *
 * The distinction is the whole safety property: absent means free, and
 * anything we cannot fully trust means HELD.
 *
 * @returns {{kind: 'absent'|'held'|'expired'|'untrusted', value?: object, reason?: string}}
 */
function readState() {
  let raw
  try {
    raw = readFileSync(LEASE_FILE, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'absent', reason: 'no lease file' }
    return { kind: 'untrusted', reason: `cannot read: ${error.code}` }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A half-written file must never read as free.
    return { kind: 'untrusted', reason: 'lease file is not valid JSON' }
  }
  if (typeof parsed?.owner !== 'string' || typeof parsed?.expiresAt !== 'number') {
    return { kind: 'untrusted', reason: 'lease file lacks owner/expiresAt' }
  }
  if (typeof parsed.token !== 'string') {
    // Written by an older version, or truncated: refuse rather than guess.
    return { kind: 'untrusted', reason: 'lease file has no token (old or partial write)' }
  }
  if (Date.now() >= parsed.expiresAt) {
    return { kind: 'expired', value: parsed, reason: 'expired' }
  }
  return { kind: 'held', value: parsed }
}

/** Public view of the lease. */
export function status() {
  const state = readState()
  if (state.kind === 'absent') return { held: false, reason: state.reason }
  if (state.kind === 'untrusted') {
    return { held: true, owner: '<untrusted>', reason: state.reason }
  }
  const { owner, expiresAt, tab, token, generation } = state.value
  if (state.kind === 'expired') return { held: false, owner, expiresAt, reason: 'expired' }
  return { held: true, owner, expiresAt, tab, token, generation }
}

/**
 * Install a lease file, replacing whatever is there.
 *
 * `writeFileSync` to a unique temp path then `renameSync` over the target: on
 * Windows rename is an atomic replace, so a reader sees either the whole old
 * file or the whole new one, never a truncated one — and never an absent one,
 * which is the window the old unlink-then-create version left open.
 */
function install(payload) {
  const tmp = `${LEASE_FILE}.${process.pid}.${mintToken()}.tmp`
  writeFileSync(tmp, JSON.stringify(payload))
  try {
    renameSync(tmp, LEASE_FILE)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* best effort */ }
    throw error
  }
}

/** Create a lease that does not exist yet. Atomic: only one racer can win. */
function createExclusive(payload) {
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
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be a positive number')

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = readState()

    if (state.kind === 'held') {
      return { ok: false, heldBy: state.value.owner, expiresAt: state.value.expiresAt, reason: 'held by another owner' }
    }
    if (state.kind === 'untrusted') {
      // Fail closed, and say why: this is the "wedged" case, and it must be
      // visible rather than silently grantable.
      return { ok: false, heldBy: '<untrusted>', reason: `refusing: ${state.reason}` }
    }

    const token = mintToken()
    const generation = (state.value?.generation ?? 0) + 1
    const payload = {
      owner, token, generation,
      expiresAt: Date.now() + ttlMs,
      acquiredAt: Date.now(),
      pid: process.pid,
      ...(tab === undefined ? {} : { tab }),
    }

    if (state.kind === 'absent') {
      try {
        createExclusive(payload)
        return { ok: true, owner, token, generation, expiresAt: payload.expiresAt }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        continue // someone created it between our read and our create: re-evaluate
      }
    }

    // Expired: replace it wholesale, then confirm our token is the one that
    // survived. If it is not, another acquirer won and we must NOT proceed.
    install(payload)
    const after = readState()
    if (after.kind === 'held' && after.value.token === token) {
      return { ok: true, owner, token, generation, expiresAt: payload.expiresAt }
    }
    // Lost the race. Loop and re-evaluate from scratch rather than assume.
  }
  return { ok: false, heldBy: '<race>', reason: 'lost the acquire race repeatedly' }
}

/**
 * Extend a lease we still hold. Authorized by token, so a stale holder cannot
 * renew over a successor that has since taken the page.
 *
 * Deliberately refuses to renew a lease that is already at or past expiry:
 * at that point the page is legitimately someone else's, and rewriting the file
 * would be exactly the split-brain this design exists to prevent.
 */
export function renew({ owner, token, ttlMs = DEFAULT_TTL_MS }) {
  const state = readState()
  if (state.kind !== 'held') return { ok: false, reason: state.reason ?? 'lease is not held' }
  if (state.value.token !== token) {
    return { ok: false, reason: `lease is held by "${state.value.owner}"`, heldBy: state.value.owner }
  }
  const payload = { ...state.value, owner: state.value.owner ?? owner, expiresAt: Date.now() + ttlMs }
  install(payload)
  const after = readState()
  if (after.kind === 'held' && after.value.token === token) {
    return { ok: true, expiresAt: payload.expiresAt }
  }
  return { ok: false, reason: 'renewal was replaced by another acquirer' }
}

/**
 * Release the lease.
 *
 * Authorized by TOKEN when one is supplied (owner-name fallback exists only for
 * the CLI convenience path). The old version authorized by owner name alone,
 * which let a run that had expired and been replaced delete its successor's
 * lease whenever both used the same name.
 *
 * The check and the delete are made atomic by renaming the file aside first:
 * only one process can win that rename, and if the file turns out not to be
 * ours it is renamed straight back.
 */
export function release({ owner, token }) {
  const state = readState()
  if (state.kind === 'absent') return { ok: true, released: false, reason: 'no lease file' }
  if (state.kind === 'untrusted') {
    return { ok: false, released: false, reason: `refusing to touch untrusted state: ${state.reason}` }
  }

  const aside = `${LEASE_FILE}.${mintToken()}.releasing`
  try {
    renameSync(LEASE_FILE, aside)
  } catch {
    return { ok: false, released: false, reason: 'lease disappeared during release' }
  }

  let moved = null
  try {
    moved = JSON.parse(readFileSync(aside, 'utf8'))
  } catch { /* unreadable: handled as "not ours" below */ }

  const isOurs = token !== undefined ? moved?.token === token : moved?.owner === owner
  if (isOurs) {
    try { unlinkSync(aside) } catch { /* already gone */ }
    return { ok: true, released: true }
  }

  // Not ours — put it back untouched so the real holder keeps the page.
  try {
    renameSync(aside, LEASE_FILE)
  } catch {
    try { unlinkSync(aside) } catch { /* best effort */ }
  }
  return { ok: false, released: false, heldBy: moved?.owner, reason: 'not the holder (token mismatch)' }
}

/**
 * Open a lease as a live handle: acquired now, renewed on a heartbeat, and
 * checked with `assertHeld()`. `close()` releases it.
 *
 * This exists so a driver does not have to be shaped as a single callback to be
 * safe. A file of sequential steps can open one handle, assert inside its own
 * send helpers, and close in a finally — which is how the pane drivers use it.
 * `withLease` is the same thing for code that already fits a callback.
 */
export function openLease({ owner, ttlMs = DEFAULT_TTL_MS, tab, renewMs }) {
  const got = acquire({ owner, ttlMs, tab })
  if (!got.ok) {
    throw new Error(
      `pane lease refused: held by "${got.heldBy}"` +
        (got.expiresAt ? ` until ${new Date(got.expiresAt).toISOString()}` : '') +
        ` (${got.reason})`,
    )
  }

  let lost = null
  const interval = Math.max(250, renewMs ?? Math.floor(ttlMs / 3))
  const timer = setInterval(() => {
    const r = renew({ owner, token: got.token, ttlMs })
    if (!r.ok) lost = r.reason
  }, interval)
  timer.unref?.()

  let closed = false
  const finish = () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    release({ owner, token: got.token })
  }

  // Release on process exit as well as on close(). A driver written as a flat
  // sequence of top-level steps has no `finally` to run, so a throw anywhere
  // after acquisition used to strand the lease until its TTL — observed: a
  // failed run left the page held for the full five minutes and blocked the
  // acceptance gate that followed it. Cleanup belongs to the wrapper, not to the
  // caller's control flow.
  process.once('exit', finish)

  return {
    owner,
    token: got.token,
    generation: got.generation,
    expiresAt: got.expiresAt,
    get lost() { return lost },
    /** Throw unless this exact lease is still the live one. */
    assertHeld() {
      if (lost) throw new Error(`pane lease lost: ${lost}`)
      const now = status()
      if (!now.held) throw new Error(`pane lease lost: ${now.reason ?? 'no longer held'}`)
      if (now.token !== got.token) throw new Error(`pane lease lost to "${now.owner}"`)
      return true
    },
    close() {
      process.removeListener('exit', finish)
      finish()
    },
  }
}

/**
 * Acquire, renew on a heartbeat, run, always release. The body is NOT run when
 * the lease cannot be taken — that is the fail-closed property.
 *
 * `lease.assertHeld()` throws if the lease has been lost, so a long body can
 * check before each mutating step instead of driving on a lease it no longer
 * owns.
 */
export async function withLease({ owner, ttlMs = DEFAULT_TTL_MS, tab, renewMs }, body) {
  const lease = openLease({ owner, ttlMs, tab, renewMs })
  try {
    return await body(lease)
  } finally {
    lease.close()
  }
}

/**
 * Refuse to drive unless the pane is on the browser this tooling owns.
 *
 * The pane runs in two modes. "own" (the default) is a throwaway headless
 * Chrome the plugin launched; "connect" attaches to a real, signed-in Chrome.
 * Every route that drives — goto, input, tab-open, tab-close — acts on whatever
 * tab is ACTIVE in whichever browser is currently attached.
 *
 * So a script written against the throwaway browser will, in connect mode,
 * navigate or close a human's real tab instead. That is not hypothetical: it
 * happened twice while this was being built, once navigating a live ChatGPT
 * conversation, and nothing in the tooling objected either time.
 *
 * Call this before driving. It reads the pane's own state, and throws rather
 * than touching a browser it does not own.
 *
 * @param {{allowConnect?: boolean, base?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{mode: string, url: string, active: boolean}>}
 */
export async function assertDrivable({
  allowConnect = process.env.PANE_ALLOW_CONNECT === '1',
  base = process.env.DSH_BASE ?? 'http://127.0.0.1:3080',
  timeoutMs = 10_000,
} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let reader = null
  let done = false
  try {
    const res = await fetch(`${base}/browser-pane/stream`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    })
    if (!res.ok) throw new Error(`pane stream refused: HTTP ${res.status}`)

    reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const { value, done: ended } = await reader.read()
      if (ended) break
      buffer += decoder.decode(value, { stream: true })
      const match = /event: state\s*\ndata: (.+)/u.exec(buffer)
      if (match) {
        // Mark done BEFORE any throw so the finally does not abort the socket.
        done = true
        const state = JSON.parse(match[1])
        if (state.mode !== 'own' && !allowConnect) {
          throw new Error(
            `refusing to drive: the pane is attached to a real browser, not the one this tooling owns ` +
              `(mode="${state.mode}", showing ${state.url}). Driving would act on whatever tab is active there. ` +
              `Switch the pane back to its own browser, or set PANE_ALLOW_CONNECT=1 to override deliberately.`,
          )
        }
        return state
      }
    }
    throw new Error('pane sent no state event — is the browser-agent plugin loaded?')
  } finally {
    clearTimeout(timer)
    // Close by cancelling the reader, and deliberately do NOT abort the fetch on
    // the path we completed. Aborting a fetch whose body still has a pending
    // read races socket teardown and trips a libuv assertion on Windows at
    // process exit (`!(handle->flags & UV_HANDLE_CLOSING)`), which corrupts the
    // exit code of the caller — a refused run would report a crash rather than a
    // clean refusal. `reader.cancel()` ends the stream without that race.
    if (reader) { try { await reader.cancel() } catch { /* already closed */ } }
    if (!done) controller.abort()
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
  const token = flag('token')
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
    case 'renew':
      out(renew({ owner, token, ttlMs }))
      break
    case 'release':
      out(release({ owner, token }))
      break
    case 'takeover': {
      // Explicit, auditable steal — only ever of an EXPIRED lease.
      const current = status()
      if (current.held) { out({ ok: false, heldBy: current.owner, reason: 'lease is live, refusing takeover' }); break }
      out(acquire({ owner, ttlMs, tab }))
      break
    }
    case 'banner':
      console.log(bannerScript(owner, ttlMs))
      break
    default:
      console.error('usage: pane-lease.mjs <status|acquire|renew|release|takeover|banner> [--owner=] [--token=] [--ttl=] [--tab=]')
      process.exitCode = 2
  }
}
