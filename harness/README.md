# Harness scripts

Operational scripts for a DSH installation: bringing it up at boot, restarting
it after a plugin change, reaching it from a phone, and the shortcuts that tie
those together.

These are not plugins — the plugins live in [`../plugins`](../plugins). This
folder is the other half: the machinery that keeps the Web GUI running and
reachable. They are here because they were developed against the same live
install and are useless undocumented.

## The problem they solve

Three separate things, which are easy to conflate:

| Need | What it means | Script |
| --- | --- | --- |
| **Across boots** | log in and the GUI is already reachable from your phone | `boot-dsh.ps1` via `dsh-boot.vbs` |
| **Reload** | a newly installed plugin's host half only loads at boot, so it needs a restart | `restart-harness.ps1` |
| **Opening** | click something and land in an authenticated GUI, not a 401 | `open-dsh.ps1` |

The original setup only handled the middle one. `startup.ps1` *waited* for
`dsh web` to be serving and then started the bridge — but nothing ever started
`dsh web`. After a reboot the bridge would come up, wait its full five minutes
for a server that was never launched, and the GUI stayed dark until someone ran
the launcher by hand. `boot-dsh.ps1` is the missing first half.

## Files

| File | Role |
| --- | --- |
| [`boot-dsh.ps1`](boot-dsh.ps1) | Logon entry point. Ensures `dsh web` is serving (starting it detached if not), then hands off to `startup.ps1`. Idempotent: starts nothing if the GUI already answers. |
| [`dsh-boot.vbs`](dsh-boot.vbs) | The Startup-folder shim that runs `boot-dsh.ps1` fully hidden. A `.vbs` because the Startup folder needs no administrator rights, where a scheduled task would. |
| [`startup.ps1`](startup.ps1) | Starts the auth bridge if it is not listening, re-asserts the Tailscale Serve mapping, rotates the bridge log, prints the URL to open. |
| [`open-dsh.ps1`](open-dsh.ps1) | Ensures the stack is up, then opens the GUI. `-Copy` puts the tailnet URL on the clipboard instead. |
| [`restart-harness.ps1`](restart-harness.ps1) | Stops the GUI and starts it again, then verifies. Resolves the launcher *before* stopping anything, and refuses to kill a listener that is not `node.exe`. |
| [`start-harness.ps1`](start-harness.ps1) | The launcher. Pins `DSH_HOME` for the process and resolves `dsh` in three tiers (PATH → cached npx install → `npx @latest`). |
| [`install-shortcuts.ps1`](install-shortcuts.ps1) | Creates or refreshes the four desktop shortcuts. |
| [`ts-dsh-bridge.mjs`](ts-dsh-bridge.mjs) | The loopback auth bridge. See below. |
| [`ts-make-access.mjs`](ts-make-access.mjs) | Mints and verifies a session cookie for a given authority. Diagnostic. |
| [`ts-acceptance.mjs`](ts-acceptance.mjs) | Checks the auth boundary through the tailnet: API requests are gated, document navigations auto-sign-in. |
| [`pane-acceptance.mjs`](pane-acceptance.mjs) | The end-to-end gate: one command, five checks, non-zero exit on failure. |
| [`pane-lease.mjs`](pane-lease.mjs) | Fail-closed per-tab ownership lease for the shared browser page. CLI + library. |
| [`pane-lease-verify.mjs`](pane-lease-verify.mjs) | Twelve checks on the lease, including that corrupt state denies rather than grants. |
| [`pane-input-proof.mjs`](pane-input-proof.mjs) | Measures the pane's coordinate transform: dispatches clicks, then you read back what was hit. |
| [`coord-test.html`](coord-test.html) | The 2×2 target page those clicks are aimed at. |
| [`pane-input-tests.mjs`](pane-input-tests.mjs) | Measures drag, wheel and keyboard against `input-test.html`. |
| [`input-test.html`](input-test.html) | Scroll / drag / type target page for the above. |
| [`phone-eval.mjs`](phone-eval.mjs) | Evaluate JS in a chosen tab of the phone's Chrome over the adb CDP forward. |
| [`phone-touch-proof.mjs`](phone-touch-proof.mjs) | Aim a real touch at a *fraction* of the pane image, and derive the expected page coordinate from the same fraction. |

## Pane ownership, and what a lease can actually enforce

The browser pane and an automation script drive **one shared page**, and nothing
arbitrates between them. An automated run clicking through a flow will fight a
human using the pane, and both will see a page behaving inexplicably.

Two facts decide what can be done about it, both measured rather than assumed:

1. **The pane's input route needs a live stream subscriber.** It reads a CDP
   handle that only exists while an SSE client is attached (`pane.ts`, "the
   screencast follows its subscribers"). Posting input with nobody watching is
   rejected with `400 browser not ready`.
2. **There is no hook to make that route refuse input.** The package registers
   its routes directly on the web server and exposes no interception point.

So a lease **cannot** stop a human clicking, and any design claiming otherwise
would be theatre. What it *can* do — and where the real damage comes from — is
stop an **automation** driving while somebody else holds the page. That boundary
is ours, so it is enforceable there, and it fails closed:

```js
import { withLease } from './pane-lease.mjs'

await withLease({ owner: 'my-run' }, async () => {
  // Never runs if the page is already held.
})
```

`pane-lease.mjs` keeps state in one JSON file taken atomically, so two racing
acquirers cannot both win. Leases expire, so a crashed run cannot wedge the
page. Unreadable, malformed or corrupt state reads as **held**, never free —
failing open is the one bug that would make the whole thing worthless.

The visible half lives in the page, not the GUI: `bannerScript(owner)` returns a
JS expression any driver can evaluate, so the human watching the pane sees who
has taken the page and until when. The banner is `pointer-events:none` — a
takeover notice that swallowed clicks would be worse than none.

Verified: 12/12 checks pass, and an A/B on the same automation with the same
coordinates gave **0 clicks** while the lease was held and **2 clicks** at the
expected coordinates once it was free.

## Why a bridge exists at all

DSH's Web server enforces a Host fence: it rejects any authority that is not the
loopback bind it was launched on. `tailscale serve` necessarily presents the
tailnet hostname, so the request arrives with a Host header DSH refuses.

The bridge listens on loopback, verifies the browser's session cookie itself,
and re-signs it for the loopback authority DSH expects, preserving the original
`issuedAt`/`expiresAt` so re-signing never extends a session.

**There is no key, password or login URL.** A top-level navigation that arrives
without a session is served the GUI in one hop, with a freshly minted cookie on
the same response; API and asset requests are still verified per request, and
answer 401 without a valid cookie.

Signing in deliberately does **not** redirect. It proxies in place, because a
client that cannot retain cookies would otherwise follow the redirect back to
`/`, arrive cookieless again, and loop forever — measured with `curl -L`, which
gave up after 50 redirects. Proxying in place hands such a client a real page and
saves browsers a round trip. The cookie is signed **twice** per request, once
bound to the authority in the browser's address bar and once bound to the
loopback authority DSH was launched on; reusing a single signing for both hops
produces a 401, because DSH checks the binding.

Since the bridge is reachable only from loopback, and loopback is reachable only
through `tailscale serve`, **tailnet membership is the access boundary**. That
was already true before the key was removed — which is exactly why the key never
denied anybody. It was a second door into a room with no walls: something to
carry around, paste into chat, and leak, guarding nothing that was not already
guarded by the tailnet. Removing it changed no security property that was
actually being enforced.

If access ever needs to be narrowed, narrow it in Tailscale (ACLs, device
approval, node sharing). That is the layer that gates.

## Shortcuts

`install-shortcuts.ps1` writes four:

| Shortcut | Runs | Job |
| --- | --- | --- |
| DeepSeek Harness | `open-dsh.ps1` | the everyday one — ensure up, then open |
| DSH Restart | `restart-harness.ps1` | reload after a plugin change, then verify |
| DSH Console | `start-harness.ps1` | foreground run with a visible log, for debugging |
| DSH Phone Link | `open-dsh.ps1 -Copy` | tailnet URL to the clipboard, for adding a device |

```powershell
pwsh -File install-shortcuts.ps1            # desktop
pwsh -File install-shortcuts.ps1 -StartMenu # and the Start Menu
```

## Configuration

Every script takes `-DshHome` and `-WorkingDirectory`; the defaults point at the
install this was developed on. Honoured environment variables:

| Variable | Meaning | Default |
| --- | --- | --- |
| `DSH_HOME` | Harness home (holds `.credentials.yaml`, profiles, sessions) | `D:\Letters\MatTroiSeConMoc\.dsh` |
| `DSH_AUTHORITY` | the tailnet authority the GUI is reached on | `sloptop.taild88607.ts.net:3080` |
| `BRIDGE_PORT` / `BRIDGE_UPSTREAM` | bridge listen port / GUI port | `3099` / `3080` |
| `BRIDGE_AUTHORITIES` | comma-separated non-loopback authorities served | `sloptop.taild88607.ts.net:3080,sloptop:3080` |
| `BRIDGE_SECRET` | override the signing secret (otherwise read from the credential store) | unset |

## Security notes

Worth stating plainly, because this folder is public and the design is
deliberately readable:

- **No secret is committed, and none is hardcoded.** `ts-dsh-bridge.mjs` reads
  the session-signing secret from `.credentials.yaml` at startup and **fails
  closed** if it cannot. It previously carried a literal fallback — a copy of a
  live session-forgery key sitting in a file destined for a public repo. It was
  never committed, and it has been removed. Do not reintroduce a default.
- **There is no password to leak.** The previous one-tap login key is gone by
  design; see the bridge section above. Nothing about adding a device involves a
  credential — install Tailscale, join the tailnet, open the URL.
- **The bridge binds loopback only** (`127.0.0.1`), so it is reachable only
  through `tailscale serve`. It is not an internet-facing proxy.
- **Adding a device is a Tailscale action, not a DSH one.** If a device should
  not have access, remove it from the tailnet; nothing in this folder can or
  should gate it.
- The tailnet hostname appears in these scripts as an overridable default. It is
  a MagicDNS name, not a secret, and it is already recorded in the top-level
  README — but it is the one piece of identifying information here, so change
  the defaults if you would rather it were not.

## Requirements

Windows with PowerShell 7, Node.js, Tailscale, and Google Chrome. The bridge and
the launcher are the only pieces with real dependencies; `install-shortcuts.ps1`
and `open-dsh.ps1` are thin wrappers you can ignore if you drive the launcher
directly.
