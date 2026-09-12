# Inspecting the live phone over ADB

The Galaxy Note 10+ is reachable over ADB, which is how the phone layout was
measured instead of guessed. This is how to repeat that.

## Setup

ADB lives at `D:\Programs\AndroidSDK\platform-tools\adb.exe` (not on PATH).

```powershell
$adb = "D:\Programs\AndroidSDK\platform-tools\adb.exe"
& $adb devices -l
# RF8M73S4NEM  device  product:d2sxx model:SM_N975F
```

Device metrics, which decide whether the mobile breakpoint applies:

```
& $adb shell wm size      # Physical 1440x3040, Override 720x1520
& $adb shell wm density   # Physical 420, Override 275
```

With that override Chrome reports:

| | |
| --- | --- |
| `window.innerWidth` | 419 |
| `window.innerHeight` | 747 |
| `devicePixelRatio` | 1.71875 |

so `matchMedia('(max-width: 768px)')` matches. **419x747 is the coordinate space
for everything below** — not 720x1380, which is device pixels.

## Connect, then attach to Chrome

Wireless first — the phone is usually across the room, and once it has been paired
with this computer ADB reconnects over mDNS by itself whenever both are on the same
Wi-Fi:

```powershell
node .dsh\profiles\web\plugins\dsh-mobile-rail\connect-phone.mjs
```

That script reports each step rather than assuming any of them: it waits for a
device, tries the mDNS-advertised endpoint if none appears, re-asserts the DevTools
forward (which dies with the transport), and confirms Chrome's DevTools answers on
`127.0.0.1:9444`. `--status` reports without changing anything.

First-time pairing cannot be automated — Android shows a six-digit code that only a
human can read:

```
1. Phone: Settings -> Developer options -> Wireless debugging -> ON
2. Phone: "Pair device with pairing code"  -> shows  <ip>:<pair-port>  and a code
3. Here:  adb pair <ip>:<pair-port> <code>      (once; then mDNS reconnects forever)
```

Notes that cost time:

- **The device serial changes with the transport.** Over USB it is `RF8M73S4NEM`; over
  wireless it is `adb-RF8M73S4NEM-JO3DeB._adb-tls-connect._tcp`. Anything using
  `adb -s RF8M73S4NEM ...` stops working the moment the cable comes out.
- **The forward does not survive the transport changing.** Unplugging the cable kills
  `adb forward tcp:9444`, and the next CDP call fails with `ECONNREFUSED` — which
  looks like the phone being offline. Re-assert the forward (the script does).
- **mDNS does not cross networks.** Not to another subnet, and not over Tailscale,
  even though the phone is on the tailnet. Same Wi-Fi or a cable.
- Port 9222 is usually taken by desktop Chrome and 9333 was left bound by an earlier
  session, so 9444 is the local port used here.

Then run the end-to-end check, which opens a tab of its own, dispatches real touches,
and asserts geometry:

```powershell
node .dsh\profiles\web\plugins\dsh-mobile-rail\verify-phone.mjs
```

`phone.mjs` is the harness it uses: attach, real taps
(`Input.dispatchTouchEvent`), screenshots, and `STATE_EXPR`, the one reading of
frame state every probe shares. `CDP_PORT`, `DSH_URL`, `DSH_HOST_MATCH` and
`DSH_SHOT_DIR` override its defaults, and every CDP call is bounded — a wedged
renderer surfaces as a timeout naming the page, instead of hanging the script.

Clean up when finished (the forward only; the wireless connection is worth keeping):

```powershell
& $adb forward --remove-all
```

## What the measurements established

At `innerWidth = 419`:

| State | Grid | Sidebar | Centre |
| --- | --- | --- | --- |
| Closed | `0px 418.909px 0px` | 0px | 419px, painted |
| Drawer open | `280px 138.909px 0px` | 280px | 139px, blanked |
| After a tap beside it | `0px 418.909px 0px` | 0px | 419px, painted |

Four facts that decided the implementation, none of them guessable from the
source:

1. The sidebar toggle is `[data-slot="sidebar"] button[aria-label="Open sidebar"]`,
   and the label becomes `Collapse sidebar` once open — the button is swapped, not
   relabelled in place.
2. While the rail is hidden that toggle computes `visibility:hidden`, so no finger
   can ever hit-test it. `HTMLButtonElement.click()` skips hit-testing and the
   product's React handler still runs. This is the only thing that opens the real
   sidebar.
3. The product does **not** close the sidebar on an outside tap: a real touch at
   (300,700) with the drawer open left it open. Hence the plugin's own rule.
4. The centre column paints no background (`rgba(0,0,0,0)`), so hiding its content
   reveals the frame's own colour (`rgb(21,21,23)` against the sidebar's
   `rgb(27,27,28)`). Blanking needs no colour of its own.

## Traps worth remembering

1. **`/json/new` is refused on Android Chrome** (`500 Could not create new page`).
   `Target.createTarget` on the **browser** socket works. `newTab()` uses that.
2. **Coordinates are CSS pixels.** Sampling `elementFromPoint(600,300)` on a
   419x747 viewport returns `null`, because 600 is off-screen. Device pixels and
   CSS pixels differ here by 1.71875.
3. **The sidebar slot is `display:contents`.** `[data-slot="sidebar"]` measures
   0x0 in every state, open or closed. The width lives on the frame's first grid
   child; measuring the slot reports 0 and looks exactly like a broken plugin.
4. **Grepping the served bundle for `768px` fails.** The source is
   `` `@media (max-width: ${NARROW_MAX_PX}px){` `` — a template literal resolved at
   runtime, so the bundle stores the expression, not the result. Search for the
   rule text, or read the live CSSOM.
5. **A forced inline override corrupts later readings.** Setting
   `grid-template-columns` with `!important` from the console changes the computed
   value for the rest of that page's life. Reload before re-measuring.
6. **A fullscreen right-panel document tab covers the whole layout.** It renders
   into the frame's `overlayLayer`, on top of both the sidebar and the centre
   column, so the state under test is invisible and unreachable. Two
   byte-identical screenshots looked like a frozen CDP surface; they were simply
   what the tab displayed. Open a tab of your own (`newTab()`) instead of driving
   whatever the user has open.

## Screenshots

Two independent paths, and they agreed:

```powershell
# 1. through CDP, in the tab being driven (what verify-phone.mjs writes)
# 2. the phone's actual display, as ground truth
& $adb shell screencap -p /sdcard/dsh-screen.png
& $adb pull /sdcard/dsh-screen.png shots\phone-screen.png
```

Pull rather than piping `exec-out screencap` through a redirect: PowerShell's `>`
corrupts binary output.

Note that a background tab does not repaint, so `attach()` calls
`Page.bringToFront` before capturing.
