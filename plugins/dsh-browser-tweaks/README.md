# dsh-browser-tweaks

Behaviour changes to the shipped browser pane
(`@try-works/dsh-browser-agent`) and the composer model pill, without
touching those packages:

1. **Plugin/stealth mode uses the shortcut-created Chrome profile**, so fresh
   logins land where the desktop shortcut's Chrome already lives.
2. **The "My Chrome" mode button is hidden** from the pane's mode toggle.
   Headless + Plugin remain, both clickable, both still switching modes.
3. **The composer model pill carries a provider badge**: the active provider
   plus usage left — or "free" for unmetered providers.

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
# --remote-debugging-port=9222 --user-data-dir="D:\Letters\MatTroiSeConMoc\.dsh\browser-profile"
```

Current value: `D:\Letters\MatTroiSeConMoc\.dsh\browser-profile` (moved out of
`D:\Programs\evTEMP\` on 2026-09-17; the old directory is deleted). If the
shortcut is ever recreated with a different `--user-data-dir`, edit that one
line (and the matching constant in `verify-client.mjs`).

**The badge — appended DOM, read provider.** The pill is the shipped
`conversation.input.model` seat: its text is React-owned, so the badge is a
`<span>` appended beside the pill content inside the pill element, and the
pill's own text is never rewritten. The provider is never assumed:

- a `provider/model` fallback label names it directly;
- the open model menu names it exactly (checked option's provider section),
  and a clicked option teaches it at once — cached per model name;
- model names unique to one provider (installed pi-ai catalogs, the session
  bundle's gap model, settings.yaml) resolve without the menu;
- names shared by several providers ("Muse Spark 1.3 Contributor" is both
  meta and opencode-go) show the safe fallback "free" until the menu has been
  opened once.

Only opencode-go is metered: the badge reuses the sibling
`dsh-opencode-go-usage` plugin's `/api/opencode-go-usage.status` reading
(what is left of the 5-hour window, polled every 60s while an opencode-go
model is active). meta and openai-codex have no usage API, so those read
"free". If the sibling plugin is absent the fetch fails and the badge shows
the provider name alone. A MutationObserver repaints on every DOM change, so
the badge follows model switches and survives re-renders; unload removes it.

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
restores everything, and that the bundle touches no filesystem or mode API.

## Licence

MIT.
