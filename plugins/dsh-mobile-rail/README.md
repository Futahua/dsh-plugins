# dsh-mobile-rail

Gives a phone its edges back: two invisible bands, two real panels.

## The problem

A phone has two rails it never asked for.

**The left one** is the sidebar. On a narrow viewport the layout collapses it to a
permanent 56px rail — it never goes away, because `computeColumns` maps a zero
sidebar width to 56px rather than 0
(`dsh-client-ui-layout/lib/client.js:37`):

```js
const s = sidebar === 0 ? 56 : clampWidth(sidebar, 264, 420);
```

The frame then writes that as an **inline style** (`gridTemplateColumns`), so no
class name or CSS variable can override it. On a ~419px phone that strip costs ~13%
of the usable width, permanently. And when the drawer *is* opened, the product keeps
laying the conversation out in whatever is left of the row: measured 139px beside the
280px drawer, which renders the header, the tab strip, the messages and the composer
as an unreadable sandwich.

**The right one** is the live browser pane from `@try-works/dsh-browser-agent`. It is
built as a desktop side panel: a 520px column that reserves its width by setting
`body.margin-right`. On a 419px phone that leaves the GUI **0px** wide — the app
looks hung, nothing responds, and taps fall through to the pane. Its collapsed state
is a 34px full-height strip that reserves its width the same way. The packaged
default is also `collapsed = false`, on every load, on every device, and the choice
is not persisted — so a phone opens a full-screen pane every time.

## What this does

Both edges get the same treatment, and both are driven entirely from this plugin.

| # | Behaviour | Hook |
| --- | --- | --- |
| 1 | Hide the sidebar rail | `[data-sidebar-collapsed] > :first-of-type` under `max-width: 768px` |
| 2 | Left-edge tap opens the **real** sidebar drawer | capture `pointerdown`, `clientX <= 24` |
| 3 | Tap beside the open drawer closes it | `clientX >` the sidebar column's right edge |
| 4 | Blank the squeezed remainder | `:not([data-sidebar-collapsed]) > :nth-child(2) > *` |
| 5 | Hide the pane's 34px collapsed rail | `[data-dsh-browser-pane="collapsed"]{display:none}` |
| 6 | Stop the pane reserving layout space | `body{margin-right:0!important}` |
| 7 | Keep the pane on the screen | `max-width:calc(100vw - 18px)!important` |
| 8 | Right-edge tap opens the pane, sliding in from the right | capture `pointerdown`, `clientX >= innerWidth - 24` |
| 9 | Tap beside the open pane closes it | `clientX <` the panel's left edge |
| 10 | Settle the pane's packaged expanded default once, without a flash | `html[data-dsh-pane-boot]` + the pane's own toggle |

Both bands behave like buttons: the band **highlights** while a finger is on it (even
a thumb brushing past), the **click flashes** it, and only a **tap** opens anything —
a press that travels, a scroll that clips the edge, or a brush never does.

**Why the product's own controls are clicked.** They are the only things that know
how to open their panel. Measured identities:

- sidebar: `[data-slot="sidebar"] button[aria-label="Open sidebar"]`, relabelled
  `Collapse sidebar` when open (a different button, not a relabel);
- pane: `aria-label="Expand browser pane"` / `"Collapse browser pane"`, and it
  publishes `data-dsh-browser-pane="collapsed" | "expanded"`.

Both are hidden exactly when this plugin needs them — the sidebar toggle is
`visibility:hidden` behind the hidden rail, and the pane's rail is `display:none` on
a phone — and `HTMLButtonElement.click()` does not hit-test, so both still work.

**Why the blank needs no colour.** The centre column paints no background of its own
(`rgba(0,0,0,0)`), so hiding its content reveals the frame's background — the app's
own base colour (`rgb(21,21,23)`, against the sidebar's `rgb(27,27,28)`). That is
correct in light and dark without hard-coding anything.

## Why this is a plugin and not a patch

An earlier revision fixed the browser pane by editing the package inside
`node_modules`. Every one of those patches would have been erased by the next
`npm install`. Each is now expressed here instead:

| Was a `node_modules` patch | Is now |
| --- | --- |
| clamp the pane width | `max-width:calc(100vw - 18px)!important` |
| start the pane collapsed on a phone | the boot flag plus one click on the pane's own toggle |
| `body{margin-right:0}` on a phone | the same rule, injected by this plugin |
| a floating rail button for the phone | the rail is hidden; the edge band replaces it |

The package is back to its shipped state (`lib/client.js` matches the pristine copy
at `lib/client.js.orig`), and nothing outside this directory is modified.

## Behaviour

- **Phone (≤768px), everything closed:** no strip on either side. Tap the left edge
  for the sidebar, the right edge for the browser pane; tap anywhere beside the open
  panel to close it. Nothing covers the conversation, so scrolling and typing are
  unaffected.
- **Phone, sidebar open:** the drawer plus a flat blank remainder.
- **Phone, pane open:** the pane, at most `100vw - 18px` wide, with the GUI still at
  full width behind it.
- **Tablet / desktop:** untouched. The breakpoint is deliberately below the 1024px
  auto-collapse so tablets keep their normal rails. Verified at 1280px: both bands
  are inert.
- **Scroll gestures that start inside a band** do not open anything: the release has
  to be within 12px of the press to count as a tap.

## Failure modes

Stated plainly, because an earlier revision failed silently and looked like it had
worked:

- If DSH renames either control, the matching pattern misses, that band does nothing,
  and the miss is reported **once** to the console rather than swallowed. The rails
  stay hidden either way; nothing else changes.
- The selectors rely on DSH continuing to publish `data-sidebar-collapsed`, on the
  sidebar staying the frame's first grid child and the centre column the second, and
  on the browser-agent package continuing to publish `data-dsh-browser-pane`. The
  checks assert the centre column is still `centerCol`.
- **Background tabs do not run `requestAnimationFrame`.** The first version of this
  plugin coalesced its work through rAF, so it did nothing at all in a freshly
  created Android Chrome tab (which is a background tab until you look at it):
  measured `marked: 0, pane: "expanded"` after a reload. It now coalesces with
  `setTimeout` and retries for six seconds, and a check forbids rAF returning.
- If the pane mounts later than six seconds after load it is shown at its packaged
  default rather than being settled. It is still clamped and still reserves nothing;
  it just is not auto-collapsed.
- A DSH release that hides its own rails would make rules 1, 2, 5 and 8 unnecessary.

## Files

| File | Role |
| --- | --- |
| `lib/client.js` | The whole behaviour: injected CSS + both edge bands |
| `index.js` | Empty host stub — client-modules only discovers bundles through a loader row |
| `cordis.patch.yml` | The loader row |
| `verify-client.mjs` | Self-check: envelope, CSS, both toggle finders, and the gesture logic against a stub DOM |
| `verify-phone.mjs` | End-to-end check on a real phone: real touches, real geometry, both edges |
| `phone.mjs` | The ADB + CDP harness `verify-phone.mjs` drives the phone with |
| `check-live.mjs` | Asks the running GUI whether it serves this bundle |
| `check-scratch.mjs` | Same, against a scratch instance, using a cookie jar |
| `ADB-INSPECTION.md` | How the phone is driven, and the traps that cost time |

## Verifying

```
node .dsh\profiles\web\plugins\dsh-mobile-rail\verify-client.mjs
node .dsh\profiles\web\plugins\dsh-mobile-rail\check-live.mjs
node .dsh\profiles\web\plugins\dsh-mobile-rail\verify-phone.mjs
```

`verify-client.mjs` needs no browser and no server. `verify-phone.mjs` drives the
real phone and needs `adb forward tcp:9444 localabstract:chrome_devtools_remote`
first (see `ADB-INSPECTION.md`): it opens a tab of its own, dispatches real touch
events, and asserts geometry for both edges — the rail hidden at 419px wide, the
drawer and the pane caught mid-slide, the pane never wider than the screen and never
reserving space, everything restored when a tap lands beside it, the 1280px layout
untouched, and the corner-tap regression below.

`lib/client.js` hot-reloads in the browser; no server restart. The live bundle
publishes `window.__dshMobileRail.version`, so "is the new build running?" is a
measurement rather than an assumption — a screenshot once predated an HMR swap and
made a working fix look broken.

## Tuning

`NARROW_MAX_PX` (768) decides where the phone behaviour applies: raise it to 1024 to
apply it on tablets too. `EDGE_PX` (24, about 6mm at the phone's 3.6 device-pixel
ratio) is the width of each band.

## History worth keeping

- `click()` dispatches its MouseEvent at `(0,0)`. The guard that swallows the
  compatibility click after a handled tap therefore also swallowed the toggle's own
  activation for a tap in the top-left corner, so the drawer refused to open from the
  spot a thumb reaches most easily. Both suites cover that corner specifically.
- A `transition` declared only on the state being left disappears with that state, and
  the change snaps. A slide-**out** and a fading cover were tried on the left drawer
  and removed again on request; what remains is the slide **in**, which is what was
  asked for.
- The flashes are recorded from inside the page during verification rather than read
  after the fact: a flash lasts 130ms by design and a CDP round trip over ADB can
  outlast it, which produced false failures.
