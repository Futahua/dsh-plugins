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
| [`startup.ps1`](startup.ps1) | Starts the auth bridge if it is not listening, re-asserts the Tailscale Serve mapping, rotates the bridge log, prints the one-tap login URL. |
| [`open-dsh.ps1`](open-dsh.ps1) | Ensures the stack is up, then opens an **already-authenticated** URL. `-Copy` puts the tailnet login URL on the clipboard instead. |
| [`restart-harness.ps1`](restart-harness.ps1) | Stops the GUI and starts it again, then verifies. Resolves the launcher *before* stopping anything, and refuses to kill a listener that is not `node.exe`. |
| [`start-harness.ps1`](start-harness.ps1) | The launcher. Pins `DSH_HOME` for the process and resolves `dsh` in three tiers (PATH → cached npx install → `npx @latest`). |
| [`install-shortcuts.ps1`](install-shortcuts.ps1) | Creates or refreshes the four desktop shortcuts. |
| [`ts-dsh-bridge.mjs`](ts-dsh-bridge.mjs) | The loopback auth bridge. See below. |
| [`ts-make-access.mjs`](ts-make-access.mjs) | Mints and verifies a session cookie for a given authority. Diagnostic. |
| [`ts-acceptance.mjs`](ts-acceptance.mjs) | Checks the auth boundary through the tailnet: API requests are gated, document navigations auto-sign-in. |

## Why a bridge exists at all

DSH's Web server enforces a Host fence: it rejects any authority that is not the
loopback bind it was launched on. `tailscale serve` necessarily presents the
tailnet hostname, so the request arrives with a Host header DSH refuses.

The bridge listens on loopback, verifies the browser's session cookie itself,
and re-signs it for the loopback authority DSH expects, preserving the original
`issuedAt`/`expiresAt` so re-signing never extends a session. It never mints a
session for an anonymous caller.

It also serves the one-tap login link:

```
http://<authority>/__dsh_login?key=<key>
```

which sets the session cookie server-side and redirects — no JavaScript, which
is what makes it usable from a phone or tablet where a long cookie cannot be
typed into a URL bar. The key persists in `ts-bridge-key` across restarts so a
home-screen bookmark keeps working.

## Shortcuts

`install-shortcuts.ps1` writes four:

| Shortcut | Runs | Job |
| --- | --- | --- |
| DeepSeek Harness | `open-dsh.ps1` | the everyday one — ensure up, open authenticated |
| DSH Restart | `restart-harness.ps1` | reload after a plugin change, then verify |
| DSH Console | `start-harness.ps1` | foreground run with a visible log, for debugging |
| DSH Phone Link | `open-dsh.ps1 -Copy` | tailnet login URL to the clipboard, for adding a device |

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
| `BRIDGE_KEY_FILE` | where the one-tap login key lives | `<harness home>/ts-bridge-key` |

## Security notes

Worth stating plainly, because this folder is public and the design is
deliberately readable:

- **No secret is committed, and none is hardcoded.** `ts-dsh-bridge.mjs` reads
  the session-signing secret from `.credentials.yaml` at startup and **fails
  closed** if it cannot. It previously carried a literal fallback — a copy of a
  live session-forgery key sitting in a file destined for a public repo. It was
  never committed, and it has been removed. Do not reintroduce a default.
- **The login key is a bearer credential.** Anyone who has that URL has full
  control of the GUI. It is stored in `ts-bridge-key` (mode 0600) and is
  deliberately not in this repo. Rotate it by deleting the file and restarting
  the bridge.
- **The bridge binds loopback only** (`127.0.0.1`), so it is reachable only
  through `tailscale serve`. It is not an internet-facing proxy.
- The tailnet hostname appears in these scripts as an overridable default. It is
  a MagicDNS name, not a secret, and it is already recorded in the top-level
  README — but it is the one piece of identifying information here, so change
  the defaults if you would rather it were not.

## Requirements

Windows with PowerShell 7, Node.js, Tailscale, and Google Chrome. The bridge and
the launcher are the only pieces with real dependencies; `install-shortcuts.ps1`
and `open-dsh.ps1` are thin wrappers you can ignore if you drive the launcher
directly.
