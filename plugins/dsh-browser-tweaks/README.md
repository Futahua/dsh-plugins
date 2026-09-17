# dsh-browser-tweaks

Two small behaviour changes to the shipped browser pane
(`@try-works/dsh-browser-agent`), without touching that package:

1. **Plugin/stealth mode uses the shortcut-created Chrome profile**, so fresh
   logins land where the desktop shortcut's Chrome already lives.
2. **The "My Chrome" mode button is hidden** from the pane's mode toggle.
   Headless + Plugin remain, both clickable, both still switching modes.

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

**The profile directory is a documented constant.** A page cannot resolve a
Windows `.lnk`, so the shortcut is read once, by hand, and stored as
`DSH_CHROME_PROFILE_DIR` in `cordis.patch.yml`:

```powershell
$sh = New-Object -ComObject WScript.Shell
$sh.CreateShortcut('C:\Users\Public\Desktop\Chrome (DSH Browser).lnk').Arguments
# --remote-debugging-port=9222 --user-data-dir="D:\Programs\evTEMP\dsh-chrome-profile"
```

Current value: `D:\Programs\evTEMP\dsh-chrome-profile`. If the shortcut is
ever recreated with a different `--user-data-dir`, edit that one line (and
the matching constant in `verify-client.mjs`).

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
       userDataDir: 'D:\Programs\evTEMP\dsh-chrome-profile'
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
restores everything, and that the bundle touches no filesystem or mode API.

## Licence

MIT.
