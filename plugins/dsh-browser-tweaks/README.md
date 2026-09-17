# dsh-browser-tweaks

Behaviour changes to the shipped browser pane
(`@try-works/dsh-browser-agent`), without touching that package:

1. **Plugin/stealth mode uses the shortcut-created Chrome profile**, so fresh
   logins land where the desktop shortcut's Chrome already lives.
2. **The "My Chrome" mode button is hidden** from the pane's mode toggle.
   Headless + Plugin remain, both clickable, both still switching modes.
3. **The pane stays attached to the shortcut Chrome** instead of launching
   its own Chrome onto the same profile directory (which would take the
   profile lock and leave the pane blank forever).

## How it works

**Stealth profile — config, not DOM.** `launchStealthBrowser()` in the shipped
`lib/index.js` reads `cfg.userDataDir` (`""` = the default
`~/.dsh/browser-stealth-profile`) and spawns Chrome with
`--user-data-dir=<that dir>`. `cordis.patch.yml` therefore carries an
id-targeted override setting `userDataDir` on the `dsh-browser-agent` row —
the supported path, needing no DOM patching.

**The button — DOM, not config.** The shipped `lib/client.js` renders its
three ModeButtons unconditionally; no config key governs the toggle's
visibility, so no config override can remove one. `lib/client.js` instead
hides exactly the `<button>` whose whole text is `My Chrome` inside
`[data-dsh-browser-pane]`, via a MutationObserver that re-sweeps on every DOM
change (survives collapse/expand and re-renders; no timers, no
`requestAnimationFrame`). Unload disconnects the observer and restores every
button it hid.

**The connect guard — client, no config route.** Every page load opens the
pane's `/browser-pane/stream`, whose `startScreencast()` launches a Chrome via
`sharedPage()` — and the shipped runtime boots in own mode (its constructor
only ever picks own or stealth; no config key selects connect). With our
`userDataDir` override that launch squats the shortcut profile's lock, so the
shortcut Chrome can never start. `lib/client.js` therefore POSTs
`/browser-pane/mode {mode:"connect"}` on install (bundle evaluation runs
before the pane's own EventSource connects) and keeps its own EventSource on
the pane stream, re-posting on any state whose mode is not connect — which
also covers a host restart with the page still open. Each post makes the
server close/kill any own browser first, then attach to the shortcut Chrome;
with that Chrome closed the server broadcasts its own "launch the shortcut"
error state instead of launching. Two honest limits: while the guard runs, a
manual Headless/Plugin click is pulled back to connect (an own launch on this
directory always collides, so there is nothing working to preserve); and if
the shortcut was started after the page loaded, reload the page so the stream
reconnect re-attaches.

**The profile directory is a documented constant.** A page cannot resolve a
Windows `.lnk`, so the shortcut is read once, by hand, and stored as
`DSH_CHROME_PROFILE_DIR` in `cordis.patch.yml`:

```powershell
$sh = New-Object -ComObject WScript.Shell
$sh.CreateShortcut('C:\Users\Public\Desktop\Chrome (DSH Browser).lnk').Arguments
# --remote-debugging-port=9222 --user-data-dir="D:\Letters\MatTroiSeConMoc\.dsh\browser-profile"
```

Current value: `D:\Letters\MatTroiSeConMoc\.dsh\browser-profile` (moved out of
`D:\Programs\evTEMP\` on 2026-09-17; the old directory is deleted). If the
shortcut is ever recreated with a different `--user-data-dir`, edit that one
line (and the matching constant in `verify-client.mjs`).

## Installing

Per the repo root README pattern, three steps — plus one merge the layer
order forces (read before skipping it):

1. **Place the directory** in `$DSH_PLUGIN_DIR`
   (`$DSH_HOME/profiles/web/plugins/dsh-browser-tweaks`).
2. **Link it** so bare-specifier resolution works:

   ```powershell
   New-Item -ItemType Junction `
     -Path "$DSH_HOME\profiles\web\node_modules\dsh-browser-tweaks" `
     -Target "$DSH_HOME\profiles\web\plugins\dsh-browser-tweaks"
   ```

3. **List it** in `$DSH_HOME/profiles/web/package.json`, as both a bundle
   and a `link:` dependency — **after** `@try-works/dsh-browser-agent`, so
   the `userDataDir` override applies to a row that already exists:

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": [
           "dsh-opencode-go-session",
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-opencode-go-usage",
           "dsh-mobile-rail",
           "@try-works/dsh-browser-agent",
           "dsh-browser-tweaks"
         ],
         "patchReload": "live"
       }
     },
     "dependencies": {
       "dsh-browser-tweaks": "link:D:/Letters/MatTroiSeConMoc/.dsh/profiles/web/plugins/dsh-browser-tweaks"
     }
   }
   ```

4. **Merge `userDataDir` into the profile layer.** Bundle layers apply before
   the profile's own `cordis.patch.yml`, and an override *replaces* the row's
   whole `config` object — so if that file already configures
   `dsh-browser-agent` (e.g. `connectUrl`), add the same `userDataDir` there,
   or the profile layer wins and stealth keeps the default profile:

   ```yaml
   - id: dsh-browser-agent
     inject:
       - webServer
     config:
       connectUrl: 'http://127.0.0.1:9222'
       userDataDir: 'D:\Letters\MatTroiSeConMoc\.dsh\browser-profile'
   ```

Then restart `dsh web` (host rows and new bundles are not hot-loaded) and
reload the browser once (a newly added client bundle is not injected into an
already-running page; later `lib/client.js` edits hot-reload live).

## Verifying

```powershell
node plugins\dsh-browser-tweaks\verify-client.mjs
```

Checks the bundle envelope, that the override carries the shortcut profile
(and not the default), that My Chrome hides while Headless + Plugin stay
visible and posting, that a re-rendered toggle is re-hidden, that unload
restores everything, that the guard posts exactly one attach-mode switch on
install and re-posts only on drift, and that the bundle touches no filesystem
and no route but the mode switch.

Live check after a restart (on the machine, not in this repo): with the
shortcut Chrome running, no pane-owned Chrome may hold our directory —

```powershell
Get-CimInstance Win32_Process -Filter "name='chrome.exe'" |
  Where-Object { $_.CommandLine -like '*--remote-debugging-port=0*' -and
    $_.CommandLine -like '*browser-profile*' }
```

— which must return nothing, while the pane shows the shortcut's page. With
the shortcut closed, the pane must show the server's "launch the shortcut"
error state instead of a blank.

## Licence

MIT.
