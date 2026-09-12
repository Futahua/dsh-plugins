# Inspecting the live phone over ADB

The Galaxy Note 10+ is reachable over ADB, which made it possible to read the
real DOM instead of guessing. This is how to repeat that.

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

With that override, Chrome reports `window.innerWidth = 419`, which is why the
768px media query matches.

## Attach to Chrome

Port 9222 is often already taken, so use a free one:

```powershell
& $adb forward --remove-all
& $adb forward tcp:9333 localabstract:chrome_devtools_remote
```

Then read the page. `inspect-phone.mjs` prints viewport, the layout frame's grid,
its `dataset`, and whether this plugin's stylesheet is live:

```powershell
node .dsh\profiles\web\plugins\dsh-mobile-rail\inspect-phone.mjs 9333
```

`measure-phone.mjs` reports the resting and revealed geometry, including a
synthetic `touchstart` to exercise the phone's reveal path (which has no hover):

```powershell
node .dsh\profiles\web\plugins\dsh-mobile-rail\measure-phone.mjs 9333
```

Clean up when finished:

```powershell
& $adb forward --remove-all
```

## What this found

The rail fix was **correct and working**; the report that the strip was still
visible came from a page state before the fix had loaded.

Live measurements on the phone (`innerWidth = 419`):

| State | Computed grid | Rail | Center |
| --- | --- | --- | --- |
| Resting | `0px 418.909px 0px` | **0px** | 419px (full width) |
| Touch near left edge | `56px 362.909px 0px` | 56px | 363px |
| Release | `0px 418.909px 0px` | 0px | 419px |

Also confirmed at rest: the frame carries `data-sidebar-collapsed`, matches
`[data-sidebar-collapsed]:not([data-rail-revealed])`, `matchMedia('(max-width: 768px)')`
is true, and exactly one stylesheet with that selector is registered.

## Two false alarms worth remembering

1. **Grepping the bundle for `768px` fails.** The source is
   `` `@media (max-width: ${NARROW_MAX_PX}px){` `` — a template literal resolved
   at runtime, so the delivered bundle stores the expression, not the result.
   Search for the rule text instead, or inspect the live CSSOM.
2. **A forced inline override corrupts a later reading.** Setting
   `grid-template-columns` with `!important` from the console changes the
   computed value for the *rest* of that page's life. A measurement taken
   afterwards reflects the override, not the plugin. Reload before re-measuring.

## Note on screenshots

`adb shell screencap -p /sdcard/x.png` then `adb pull` works, but the model
serving this session cannot accept images, so layout was verified numerically
via the CSSOM instead. That is more precise anyway: it reports exact pixel
widths rather than an eyeballed strip.
