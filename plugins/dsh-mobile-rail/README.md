# dsh-mobile-rail

Gives a touch device its screen back: two invisible bands, two real panels, and a
shell that stays above the keyboard.

## The problem

A touch device has two rails it never asked for, and a keyboard that lands on top of
the composer.

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

**The third** is the keyboard, and it is an iPad and iPhone problem. The shell sizes
itself with percentages — `html, body, #root { height: 100% }` — and a percentage
resolves against the **layout** viewport. Android and desktop resize that viewport
when the keyboard appears, so the composer rises on its own and there is nothing to
fix. iPadOS and iOS resize only the **visual** viewport
(`window.visualViewport.height`) and leave the layout viewport at full height, so the
composer sits at the bottom of a box that still reaches under the keyboard. Safari
sometimes pans the visual viewport to reveal the focused field and sometimes does not,
which is the "it pushes everything up, except when it decides not to" behaviour.

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
| 11 | Stand down entirely under the keyboard | a text field is focused *and* the viewport is keyboard-sized |
| 12 | Pin the shell above the on-screen keyboard | `html[data-dsh-keyboard] #root` + `--dsh-keyboard-height` |
| 13 | Follow Safari's own panning | `--dsh-keyboard-top` from `visualViewport.offsetTop` |
| 14 | A real control in a band wins over the band | `closest("button, a[href], input, [role=button], …")` at press time |
| 15 | Put every composer control on one row | `[data-slot="conversation.composer.bar"] div:has(> div > button[aria-label="Commands"])` |

**The composer's controls, on one row.** Measured at 419px before this was written: the
commands (`+`) button, the attachment button, the access-mode chip, the usage ring, the
model chip and the send button came to more than the 377px row and wrapped onto two
lines. The `+` duplicates what typing `/` already does and is the widest thing in the
left group, so it is hidden; the rest are held on one line with `flex-wrap:nowrap`, and
the model chip is the one thing allowed to shrink (`flex-shrink:1!important` on the group
the app marks `flex: 0 0 auto`, plus `min-width:0` down the chain), truncating with an
ellipsis rather than pushing the send button off the edge. Measured after: six controls
on one line, worst overlap 0px, smallest gap 8px, rightmost edge 385px of 409px.

The row is named by `:has()` because its class names are hashed per build and its
position in the tree is not stable. `:has()` is Chrome 105+ and Safari 15.4+, and on
anything older the rule is simply dropped: the row wraps onto two lines exactly as it
does without this plugin, which is the pre-existing behaviour rather than a new failure.

**A band claims empty space only.** The right sidebar's toggle lives in the top-right
corner and the composer's own buttons line the bottom of both edges, all of them inside
a band — so a press whose target (or whose target's ancestor) is a control is left to
the app. It is still tracked, so a finger wandering from there into a band lights the
band up, but a press that *starts* on a control can never open a panel. Deferring to the
app costs one `closest` call and needs no list of labels to keep up to date, which is
what makes it survive a rename.

Dismissing an open panel by tapping beside it is deliberately unchanged: that tap is
aimed at the panel, which floats over whatever sits beneath it.

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

## While you are typing, both bands stand down

The natural way to leave the keyboard on a phone is to tap the empty band beside the
composer. That tap lands **on this plugin's bands**, and the bands call
`stopPropagation` — so before this existed, the tap never reached the app, the field
never blurred, the keyboard stayed up and a panel opened instead.

So while a text field has focus, both bands are completely inert: no highlight, no
activation, and nothing claimed — not even `stopPropagation` — so the tap goes to the
app and does what it was meant to do. The `armed` flag is not set either, which means
the *release* of that same tap cannot open anything even though focus has gone by then.

Detection is a read of `document.activeElement` on each gesture (no focus listeners,
which can be missed), and it is deliberately narrow:

- `INPUT` with a text-like `type`. A focused checkbox or button is not typing;
- `TEXTAREA`;
- `isContentEditable === true` — the composer is a **Lexical contenteditable div**,
  not a textarea: `<div contentEditable role="textbox" aria-multiline
  data-composer-input>`, from `ComposerContentEditable` in
  `@deepseek-ai/dsh-client-ui-conversation`;
- anything inside `[data-composer-input][contenteditable="true"]` or
  `[role="textbox"][contenteditable="true"]`.

A bare `[role="textbox"]` is **not** enough: a session-less composer renders the same
DOM inert, and an inert field holding focus must not disable the bands.

## The keyboard, on iPad and iPhone

While a text field holds focus and the visual viewport is shorter than the layout
viewport by more than a keyboard's worth, the shell is pinned to the visual viewport:

```css
html[data-dsh-keyboard] #root {
  position: fixed;
  top: var(--dsh-keyboard-top, 0px);
  height: var(--dsh-keyboard-height, 100%);
}
```

`#root` is the app's own container (`<div id="root">` in the served page, and
`document.getElementById("root")` in the bundle), and it is the element whose
`height: 100%` chain decides where the composer sits. Pinned, the shell ends exactly
where the keyboard begins: the conversation takes the remaining space and the composer
sits on top of the keyboard — every time, rather than when the browser feels like it.
`--dsh-keyboard-top` compensates for Safari's own panning, which moves what is visible
without moving the layout viewport.

The geometry is refreshed on every `resize` and `scroll` of the visual viewport rather
than on a timer, because iOS fires those events *throughout* the keyboard's animation:
following them moves the shell with the keyboard instead of snapping it into place
afterwards.

Three conditions guard it, so it cannot fire when it should not — and because of them
the plugin is completely inert on desktop, on Android, and on an iPad with a hardware
keyboard attached:

| Condition | Why |
| --- | --- |
| a text field has focus | the same viewport measurement shrinks for other reasons |
| the shrink is ≥ 120px (`MIN_KEYBOARD_PX`) | a software keyboard is a few hundred px; Safari's collapsible toolbars are tens |
| `visualViewport.scale <= 1.01` | a pinch zoom shrinks the visual viewport exactly like a keyboard, and pinning the shell mid-zoom would be wrong |

The composer check is shared with the edge bands above: one `isTyping()` predicate, so
"is the user typing" has one definition in this plugin.

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
- The typing stand-down relies on focus staying on the editable element. If a future
  composer keeps focus on a wrapper that is neither editable nor inside
  `[data-composer-input]`, the bands would stay live while typing.
- The keyboard fix relies on the shell staying `#root` with a percentage height. If a
  future build gives `#root` — or the frame inside it — a `vh`/`dvh` height, that
  element would keep the layout-viewport height and ignore the pin. (Checked in the
  current build: the only `vh`/`dvh` rules are `max-height` caps on dialogs and
  popovers, which is harmless.)
- The keyboard fix is the one behaviour in this plugin that could not be verified on
  real hardware: it needs an iPad or iPhone, and the phone this project was built
  against is Android. It is covered by checks that drive a simulated
  `visualViewport` — pin, exact geometry, pan compensation, release, zoom, toolbar
  threshold, no focus, and the already-resized case — but the first real-device
  confirmation is the user reloading the iPad.
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
| `verify-phone.mjs` | End-to-end check on a real phone: real touches, real geometry, both edges, and the keyboard stand-down |
| `phone.mjs` | The ADB + CDP harness `verify-phone.mjs` drives the phone with |
| `connect-phone.mjs` | Makes the phone reachable wirelessly, re-asserts the forward, and confirms DevTools answers |
| `check-live.mjs` | Asks the running GUI whether it serves this bundle |
| `check-scratch.mjs` | Same, against a scratch instance, using a cookie jar |
| `ADB-INSPECTION.md` | How the phone is driven, and the traps that cost time |

## Verifying

```
node .dsh\profiles\web\plugins\dsh-mobile-rail\verify-client.mjs
node .dsh\profiles\web\plugins\dsh-mobile-rail\check-live.mjs
node .dsh\profiles\web\plugins\dsh-mobile-rail\connect-phone.mjs
node .dsh\profiles\web\plugins\dsh-mobile-rail\verify-phone.mjs
```

`verify-client.mjs` needs no browser and no server. `verify-phone.mjs` drives the
real phone and needs the phone reachable first — `connect-phone.mjs` does that over
Wi-Fi (see `ADB-INSPECTION.md` for the one-time pairing): it opens a tab of its own,
dispatches real touch events, and asserts geometry for both edges and for the
keyboard — the rail hidden at 419px wide, the drawer and the pane caught mid-slide,
the pane never wider than the screen and never reserving space, everything restored
when a tap lands beside it, a focused composer with no keyboard leaving the bands
working, a focused composer *under* a keyboard standing them down (and the tap
dismissing the field rather than being swallowed), the composer's controls held on one
row with nothing overlapping and nothing past the composer's own edge, the 1280px layout
untouched, and the corner-tap regression below.

`lib/client.js` hot-reloads in the browser; no server restart. The live bundle
publishes `window.__dshMobileRail.version`, so "is the new build running?" is a
measurement rather than an assumption — a screenshot once predated an HMR swap and
made a working fix look broken.

`window.__dshMobileRail.gates` answers the other half of that question: **why** a band
ignored a tap. A band stands down for several unrelated reasons and every one of them
looks identical from the outside, so this reads them together:

```js
window.__dshMobileRail.gates
// {typing:true, keyboardUp:false, covering:false, baseline:747, innerHeight:747,
//  visualHeight:747, narrow:true, sidebarCollapsed:true, paneCollapsed:true}
```

`covering` is the one that decides a band's fate (`typing && keyboardUp`). Run that on
the phone before believing any theory about a tap that did nothing.

`verify-phone.mjs` also records a gesture timeline in the page while it runs
(`window.__trace`: every `pointerdown`/`pointerup`/`click` with a timestamp, plus the
drawer's state polled every 50ms) and prints it when anything fails. A CDP tap settles
before the app re-renders, so reading state straight afterwards races it; the trace is
what tells a state change nobody asked for from one the tap caused. A frame the app
replaced shows up in it as `REPLACED`.

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
