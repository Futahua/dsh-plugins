# DSH plugins

Three plugins for the [DeepSeek Harness](https://github.com/deepseek-ai) Web GUI,
developed and verified against a live installation.

| Plugin | What it does |
| --- | --- |
| [`dsh-opencode-go-usage`](plugins/dsh-opencode-go-usage/) | Shows OpenCode Go subscription usage: a progress ring in the composer, and a nested-window panel on click |
| [`dsh-opencode-go-session`](plugins/dsh-opencode-go-session/) | Supplies the per-conversation `x-opencode-session` header OpenCode Go requires, and registers a model its catalog lacks |
| [`dsh-mobile-rail`](plugins/dsh-mobile-rail/) | Gives a touch device its screen back: both the sidebar rail and the browser-agent pane become invisible edge bands (highlight, flash, real panel sliding in, standing down while you type), and on iPadOS/iOS the shell is pinned above the on-screen keyboard |

The operational scripts — bringing the harness up at boot, restarting it to load
a plugin's host half, opening an authenticated GUI, and the Tailscale auth bridge
they depend on — live separately in [`harness/`](harness/).

## Where this runs

These plugins are installed into a DSH profile on the machine **`sloptop`**, at:

```
D:\Letters\MatTroiSeConMoc\.dsh\profiles\web\plugins\
```

That path is the profile's `plugins/` directory, wired in through
`profiles/web/package.json`. The exact location is machine-specific; on another
install it is `$DSH_HOME/profiles/web/plugins/`. Every script here reads the host
from environment variables so it can be pointed elsewhere:

| Variable | Meaning | Default in this repo |
| --- | --- | --- |
| `DSH_HOME` | the Harness home directory | `D:\Letters\MatTroiSeConMoc\.dsh` |
| `DSH_AUTHORITY` | the host:port serving the Web GUI | `sloptop.taild88607.ts.net:3080` |
| `DSH_PLUGIN_DIR` | where these plugin directories are installed | `$DSH_HOME/profiles/web/plugins` |
| `CDP_PORT` | local port forwarded to the phone's Chrome DevTools socket | `9444` |
| `DSH_URL` | the GUI URL **as the phone reaches it** (phone scripts) | `http://$DSH_AUTHORITY/` |

## Installing

A DSH plugin is a package the profile's Cordis loader mounts. Three steps per
plugin:

1. **Place the directory** in `$DSH_PLUGIN_DIR`.
2. **Link it** so bare-specifier resolution works — a junction on Windows, a
   symlink elsewhere:

   ```powershell
   New-Item -ItemType Junction `
     -Path "$DSH_HOME\profiles\web\node_modules\dsh-opencode-go-usage" `
     -Target "$DSH_HOME\profiles\web\plugins\dsh-opencode-go-usage"
   ```

3. **List it** in `$DSH_HOME/profiles/web/package.json`, as both a bundle and a
   `link:` dependency:

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": [
           "dsh-opencode-go-session",
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-opencode-go-usage",
           "dsh-mobile-rail"
         ],
         "patchReload": "live"
       }
     },
     "dependencies": {
       "dsh-opencode-go-usage": "link:D:/path/to/plugins/dsh-opencode-go-usage"
     }
   }
   ```

Bundle order matters for `dsh-opencode-go-session`: it must activate **before**
`@deepseek-ai/dsh-llm-pi-ai`, which resolves its provider catalog eagerly. The
other two have no ordering constraint.

Then restart `dsh web` and reload the browser (see *Reloading* below).

## Reloading

DSH has two reload paths, and which one applies depends on what changed:

| Change | Applies |
| --- | --- |
| `cordis.patch.yml` (row config, adding or removing rows) | **live** — `patchReload: "live"` watches it |
| `lib/client.js` | **live** — `dsh-client-hmr` polls it and swaps the bundle in the browser |
| `index.js` (host plugin code) | **restart `dsh web`** — module HMR is disabled in `dsh-base` |

A **newly added** client plugin is not injected into an already-running page, so
its first load also needs a browser reload.

## Verifying

Each plugin ships its own checks. They are the reason these plugins work — every
one of them caught a real bug during development.

```powershell
# host half: cached fetch, credential resolution, /api route
node plugins\dsh-opencode-go-usage\verify.mjs

# client half: bundle envelope, seat wiring, panel placement maths
node plugins\dsh-opencode-go-usage\verify-client.mjs

# mobile rail: envelope, CSS, the toggle finder, and the gesture logic (no browser needed)
node plugins\dsh-mobile-rail\verify-client.mjs

# mobile rail end to end, on a real phone over ADB (real touches, real geometry)
adb forward tcp:9444 localabstract:chrome_devtools_remote
node plugins\dsh-mobile-rail\verify-phone.mjs

# both plugins are actually served by a running instance
node plugins\dsh-mobile-rail\check-live.mjs
```

`check-live.mjs` and the other live scripts need a running GUI; point them with
`DSH_AUTHORITY`. `verify-client.mjs` needs nothing — it stubs the DOM and module
table and evaluates the real bundle. `verify-phone.mjs` needs the ADB forward
above and opens a tab of its own, so it never disturbs what you have open.

## Notes from building these

Findings that cost real debugging time, recorded so they need not be rediscovered:

- **OpenCode Go usage is readable, but undocumented.**
  `GET https://opencode.ai/zen/go/v1/usage` returns the three rolling windows.
  It is not in the [Go docs](https://opencode.ai/docs/go/), which point only at
  the web console. Inference responses carry **no** rate-limit headers, so
  polling that endpoint is the only option. See
  [`dsh-opencode-go-usage/README.md`](plugins/dsh-opencode-go-usage/README.md).

- **The three Go windows do not nest in time.** The limits nest (5-hour is 20% of
  the monthly allowance, weekly is 50%), but the weekly window resets on a fixed
  weekday boundary and the monthly cycle follows the subscription date, so a week
  can begin before the month does. Measured on a live account: the week started
  four days *before* the monthly window. Drawing it nested would be a lie.

- **`grid-template-columns` on the layout frame resists stylesheet overrides.**
  The browser's own matched-styles API confirmed the rule winning the cascade,
  and the track still computed to its old value; a freshly injected identical
  sheet had no effect either. Sizing the column instead works. See
  [`dsh-mobile-rail/README.md`](plugins/dsh-mobile-rail/README.md).

- **The product's own toggle is the only thing that opens the sidebar.** Measured
  identity: `[data-slot="sidebar"] button[aria-label="Open sidebar"]`, relabelled
  to `Collapse sidebar` when open. While the rail is hidden by CSS that button is
  `visibility:hidden`, so no finger can hit-test it — but `click()` skips
  hit-testing and the React handler still runs. An earlier attempt faked the
  reveal in CSS and left the sidebar unreachable.

- **`click()` dispatches its event at (0,0).** The guard that swallowed the
  compatibility click after a handled tap therefore also swallowed the toggle's
  own activation for a tap in the top-left corner. Both the stub-DOM check and the
  phone check now tap that corner specifically.

- **A fullscreen right-panel document tab hides the entire layout.** It renders
  into the frame's `overlayLayer`, above both the sidebar and the centre column.
  Two byte-identical screenshots looked like a frozen CDP surface; they were
  simply what the tab showed. Open a tab of your own rather than driving the one
  the user has open.

- **`/json/new` is refused on Android Chrome** (`500 Could not create new page`),
  while `Target.createTarget` on the browser socket works. Phone coordinates are
  CSS pixels — 419x747 here, not the 720x1380 of a screenshot.

- **A panel that reserves its width can erase the GUI.** The browser pane takes its
  space out of the page with `body.margin-right`. On a 419px phone an expanded 520px
  pane therefore left the GUI **0px** wide: the app looked hung, nothing responded,
  and taps fell through to the pane. A stylesheet rule with `!important` beats the
  inline value, so the fix needs no patch to the package — which matters, because an
  earlier revision *did* patch it inside `node_modules`, and `npm install` would have
  silently undone every one of those fixes.

- **iPadOS and iOS never resize the layout viewport for the keyboard.** They shrink the
  *visual* viewport (`window.visualViewport.height`) and leave the layout viewport at
  full height, so an app whose shell is `html, body, #root { height: 100% }` ends up
  with its composer under the keyboard — and Safari's own attempt to reveal the focused
  field is a heuristic that sometimes runs and sometimes does not. `dsh-mobile-rail`
  pins `#root` to the visual viewport while a text field has focus, which is inert on
  Android and desktop because their layout viewport already shrinks. Guarded by a
  focus test, a 120px shrink threshold, and a zoom check (`visualViewport.scale`) —
  otherwise a pinch zoom would look exactly like a keyboard.

- **A newly added bundle does not load without a `dsh web` restart.** Adding a package
  to a profile's `dsh.profile.bundles` was measured not to change the served page's
  boot graph, while `lib/client.js` edits in an already-mounted bundle hot-reload
  immediately. That is why the keyboard fix lives inside `dsh-mobile-rail` rather than
  in a plugin of its own: the separate package was built, registered, and confirmed
  absent from the served graph, then folded in and removed.

- **A tap an edge band claims never reaches the app.** Both bands call
  `stopPropagation`, which is what keeps a tap from activating something underneath —
  and also what stopped the tap that leaves the keyboard from blurring the composer.
  `dsh-mobile-rail` therefore goes completely inert while a text field has focus,
  claiming nothing at all. The composer is a Lexical **contenteditable div**
  (`data-composer-input`, `role="textbox"`), not a textarea, so detection reads
  `isContentEditable` — and deliberately not a bare `role="textbox"`, because a
  session-less composer renders the same DOM inert.

- **Background tabs never run `requestAnimationFrame`.** A freshly created Android
  Chrome tab is a background tab until you look at it, and a plugin that coalesced its
  work through rAF did nothing there at all — measured `marked: 0, pane: "expanded"`
  after a reload, with no error anywhere. `setTimeout` plus a bounded retry settles it;
  the plugin's checks now forbid rAF returning.

- **A 130ms flash cannot be verified over ADB.** Reading the attribute after the tap is
  a race that produced false failures, because a CDP round trip to the phone can
  outlast the flash. The check records it with a `MutationObserver` inside the page
  instead.

- **A phone with Android's animation scales at `0.0` reports
  `prefers-reduced-motion: reduce`.** That is a Developer-options speed setting,
  and honouring it meant an explicitly requested animation could never be seen, so
  `dsh-mobile-rail` animates anyway and says so in the stylesheet. Check with
  `adb shell settings get global animator_duration_scale`. The phone test asserts
  the slide *on a device that reports `reduce`*, which is the case that used to be
  invisible.

- **`tailscale serve` plus the Host fence.** Plain-HTTP Serve preserves the
  client's `Host` header, which DSH's `/api` fence rejects with 403 for a non-loopback
  authority. `--trusted-host` fixes the fence; note the authority must match what
  Serve presents *exactly*. See
  [`dsh-mobile-rail/TRUSTED-HOST-FINDING.md`](plugins/dsh-mobile-rail/TRUSTED-HOST-FINDING.md).

- **There is no slot inside the context-meter popover.** DSH's only UI
  contribution mechanism is the slot registry; the popover's children are a
  hardcoded array. The nearest supported seat is `conversation.input.right`,
  which is where the ring lives.

## Licence

MIT. See [LICENSE](LICENSE).
