# dsh-mobile-rail

Gives a phone its left edge back, and opens the real sidebar from it.

## The problem

On a narrow viewport the layout collapses the sidebar to a **permanent 56px
rail** — it never goes away, because `computeColumns` maps a zero sidebar width
to 56px rather than 0 (`dsh-client-ui-layout/lib/client.js:37`):

```js
const s = sidebar === 0 ? 56 : clampWidth(sidebar, 264, 420);
```

The frame then writes that as an **inline style**:

```js
style: { gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.rightbar}px` }
```

On a ~419px phone that strip costs ~13% of the usable width, permanently.

Expanding the sidebar has the opposite problem: the product keeps laying the
conversation out in what is left of the row. Measured at 419px, the drawer is
280px and the remainder is **139px**, in which the header, the tab strip, the
messages, the file cards and the composer all render as an unreadable sandwich of
squeezed controls.

## What this does

Four behaviours, all measured on a Galaxy Note 10+ over ADB + CDP rather than
inferred:

| # | Behaviour | Hook |
| --- | --- | --- |
| 1 | Hide the rail | `[data-sidebar-collapsed] > :first-of-type` under `max-width: 768px` |
| 2 | Left-edge tap opens the **real** sidebar | capture `pointerdown`, `clientX <= 24` |
| 3 | Tap beside the open drawer closes it | capture `pointerdown`, `clientX > sidebar right edge` |
| 4 | Blank the squeezed remainder | `:not([data-sidebar-collapsed]) > :nth-child(2) > *` |
| 5 | Glow the band, slide the drawer both ways, fade the cover | `@keyframes dsh-mobile-rail-slide-in` / `-slide-out`, `.dsh-mobile-rail-glow[data-lit]`, `transition:opacity` |

**Why the width cannot simply be overridden.** It arrives as an inline `style`
attribute, which outranks every stylesheet. A matching `!important` rule was
confirmed by the browser's own matched-styles API to be winning the cascade, and
the track *still* computed to 56px; a freshly injected identical sheet had no
effect either. Collapsing the sidebar **column** works, which is what rule 1
does. `width:0;overflow:hidden` is used rather than `display:none`, because
removing a grid child outright also collapsed the centre column.

**Why the product's own toggle is clicked.** The toggle is the only thing that
knows how to open the sidebar. Its measured identity is
`[data-slot="sidebar"] button[aria-label="Open sidebar"]`, and once open the label
becomes `Collapse sidebar` — the button is swapped, not relabelled in place.
While the rail is hidden that button computes `visibility:hidden`, so no finger
can hit-test it; `HTMLButtonElement.click()` skips hit-testing entirely and the
product's React handler runs normally. An earlier attempt faked the reveal in CSS
instead, which left the sidebar unreachable.

**Why the blank needs no colour.** The centre column paints no background of its
own (`rgba(0,0,0,0)`), so hiding its content reveals the frame's background — the
app's own base colour (`rgb(21,21,23)`, against the sidebar's `rgb(27,27,28)`).
That is correct in light and dark without hard-coding anything, and the
stylesheet contains no `background` declaration or hex colour at all.

## Behaviour

- **Phone (≤768px), rail collapsed:** no strip. Tap the left edge (24px band) and
  the real sidebar opens; tap anywhere beside it and it closes. Nothing is left
  covering the conversation, so scrolling and typing are unaffected.
- **Phone, sidebar open:** the drawer plus a flat blank remainder.
- **Tablet / desktop:** untouched. The breakpoint is deliberately *below* the
  1024px auto-collapse so tablets keep the normal rail. Verified at 1280px: the
  edge band is inert and nothing is blanked.
- **Scroll gestures that start inside the 24px band** also open the drawer: a tap
  cannot be told from a drag until the finger moves, and the open has to feel
  immediate. Same trade-off as an iOS edge swipe.

## The animation, and the one preference it ignores

A tap that rearranges the whole screen should have a beginning and an end, so the
band glows, the drawer slides both ways, and the cover fades with it:

- **The glow** is an injected `position:fixed` element on `body`, not on the frame
  — the frame is a grid, so a new child would become a grid item and could disturb
  the tracks this plugin is careful not to fight. It carries
  `pointer-events:none`, so it can never swallow a tap, and `z-index:15` puts it
  above the drawer column and the resize handle (11) but below the overlay layer
  (20) that holds dialogs. Measured on the phone: `elementsFromPoint(6,400)` while
  lit returns the glow first, then the sidebar column.
- **The slides** are a `transform` on the drawer column, not on the grid track: the
  track changes in a single commit, so there is nothing to transition. Neither
  direction uses `animation-fill-mode`, because a transform left behind would make
  the column a containing block for anything fixed-position inside it.
- **Sliding *out* needs the drawer held open.** The collapsed rules hide it in the
  same commit that `data-sidebar-collapsed` appears, so by the time anything can
  react there is nothing left to slide. The plugin watches that attribute and sets
  `data-rail-closing` for exactly `RAIL_MS`, which restores the drawer's width and
  visibility for one animation and lifts it to `z-index:16` — over the centre
  column, which is already back to full width underneath. The width comes from
  `--dsh-rail-w`, recorded while the drawer was **open**: measuring it at close
  time always yields 0, and a hard-coded 280px would snap on a resized drawer. The
  duration is shared with the stylesheet (`animation:… ${RAIL_MS}ms`) so the hold
  and the animation cannot drift apart.
- **The cover fades** by animating `opacity` on the centre column's children, with
  the declaration living on a rule that **always** matches. A transition written
  only on the state being left disappears along with that state, and the change
  snaps instead of fading — this was the difference between a fade and a flicker.
  `pointer-events:none` rides along while blanked, so the invisible conversation
  cannot be scrolled or clicked through the cover.
- The glow is `rgba(88,150,255,…)`. The app exposes **no** accent colour to borrow
  — checked: no blue custom properties anywhere, no coloured links — so this is a
  chosen blue that reads on the `#151517` base.

Measured on the phone, mid-transition: the drawer caught at `translateX(-154px)`
opening and `-260px` closing, the cover at `0.26 → 0.58 → 0.90 → 1` on the way
back and `0.86 → 0.51 → 0.32 → 0.16 → 0` on the way in.

**It deliberately does not honour `prefers-reduced-motion`.** That is measured, not
overlooked: on the target phone Android's `animator_duration_scale`,
`transition_animation_scale` and `window_animation_scale` are all `0.0`, so Chrome
reports `reduce` — a speed preference set in Developer options, not a statement
about motion sensitivity — and honouring it meant the requested animation could
never be seen. `verify-phone.mjs` therefore asserts the slide *on a device that
reports `reduce`*, which is the case that used to be invisible. Restoring
`@media (prefers-reduced-motion: reduce){...}` with `animation:none` and
`transition:none` is all it takes to reverse the decision.

## Failure modes

Stated plainly, because an earlier revision failed silently and looked like it
had worked:

- If DSH renames the toggle, the finder matches `/^(open|collapse|close|expand|show|hide)\s+sidebar$/i`
  and misses. The rail still hides; only the edge tap stops working. A miss is
  reported once to the console rather than swallowed.
- The selectors rely on DSH continuing to publish `data-sidebar-collapsed`, on the
  sidebar staying the frame's first grid child, and on the centre column staying
  the second. `verify-client.mjs` and the phone probe both assert the centre
  column is still `centerCol`.
- A DSH release that hides the rail by itself would make rules 1–3 unnecessary.

## Files

| File | Role |
| --- | --- |
| `lib/client.js` | The whole behaviour: injected CSS + edge taps |
| `index.js` | Empty host stub — client-modules only discovers bundles through a loader row |
| `cordis.patch.yml` | The loader row |
| `verify-client.mjs` | Self-check: envelope, CSS, the toggle finder, and the gesture logic against a stub DOM |
| `verify-phone.mjs` | End-to-end check on a real phone: real touches, real geometry |
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
events, and asserts geometry — rail hidden at 419px wide, a 280px drawer after an
edge tap, the centre blanked while it is open, everything restored after a tap
beside it, the 1280px layout untouched, and the corner-tap regression below.

`lib/client.js` hot-reloads in the browser; no server restart. The live bundle
publishes `window.__dshMobileRail.version`, so "is the new build running?" is a
measurement rather than an assumption — a screenshot once predated an HMR swap
and made a working fix look broken.

## Tuning

`NARROW_MAX_PX` (768) decides where the phone behaviour applies: raise it to 1024
to hide the rail on tablets too. `EDGE_PX` (24, about 6mm at the phone's 3.6
device-pixel ratio) is the width of the tap band.

## History worth keeping

`click()` dispatches its MouseEvent at `(0,0)`. The guard that swallows the
compatibility click after a handled tap therefore also swallowed the toggle's own
activation for a tap in the top-left corner, so the drawer refused to open from
the spot a thumb reaches most easily. `verify-client.mjs` now runs that exact
case, and the phone probe taps `(8,8)` for real.
