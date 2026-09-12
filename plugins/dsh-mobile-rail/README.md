# dsh-mobile-rail

Stops the collapsed sidebar rail from eating a phone's left edge.

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

On a ~430px phone that strip costs ~13% of the usable width, permanently. Its own
source calls it "the 56px rail" (`dsh-client-ui-sidebar/lib/client.js:80`).

## The fix

The width is an inline style, so no class name or CSS variable can override it.
But the frame publishes `data-sidebar-collapsed` (`ui-layout:281`), set exactly
when the 56px rail is in effect. That is the hook:

| Selector | Effect |
| --- | --- |
| `[data-sidebar-collapsed]` under `max-width: 768px` | track goes to `0px` |
| `::before` on that frame | a 14px edge target to bring it back |
| `:hover` on that frame | rail returns in place, overlaying rather than reflowing |
| `[data-rail-revealed]` | same, driven by touch on devices without hover |

`!important` is load-bearing: the width arrives as an inline `style` attribute,
which otherwise outranks every stylesheet.

Nothing is shadowed, replaced, or removed — this only adds CSS gated on a
breakpoint and an attribute the product already publishes. Wide viewports and the
expanded sidebar are untouched.

## Behaviour

- **Phone (≤768px), rail collapsed:** the strip is gone. Swipe/hover from the
  left edge, or move the pointer there, and the rail slides in over the
  conversation; it hides again a few seconds after you let go.
- **Tablet / desktop:** unchanged. The breakpoint is deliberately *below* the
  1024px auto-collapse so tablets keep the normal rail.
- **Expanded sidebar:** unchanged — the rules only match the collapsed state.

Touch has no hover, so a `touchstart` within 24px of the left edge sets
`data-rail-revealed` for 4 seconds, which drives the same rule the hover path
uses. That listener is installed through `ctx.effect`, so it is removed when the
plugin unloads.

## Files

| File | Role |
| --- | --- |
| `lib/client.js` | The whole behaviour: CSS injection + touch reveal |
| `index.js` | Empty host stub — client-modules only discovers bundles through a loader row |
| `cordis.patch.yml` | The loader row |
| `verify-client.mjs` | Structural check: envelope, exports, and that the CSS targets the real hook |
| `check-scratch.mjs` | End-to-end check against a running instance |

## Verifying

```
node .dsh\profiles\web\plugins\dsh-mobile-rail\verify-client.mjs
node .dsh\profiles\web\plugins\dsh-mobile-rail\check-scratch.mjs <launch-token>
```

`check-scratch.mjs` also asserts the usage route answers, so it covers both
plugins. Point it at a scratch instance (`--port 3096`) rather than the live one.

Confirmed on a scratch instance running this profile: the served combo bundle
returns **HTTP 200, 11 MB**, and contains both this bundle (`data-rail-revealed`)
and the usage pill (`dsh-go-usage-button`).

## Tuning

The media query is the only knob. To hide the rail on tablets too, raise
`NARROW_MAX_PX` in `lib/client.js` to `1024`; to keep it on small laptops, lower
it. Editing `lib/client.js` hot-reloads in the browser — no server restart.

## Caveats

- Targets a **data attribute the product publishes**, not a hashed class name, so
  it should survive rebuilds; but it does rely on DSH continuing to write
  `data-sidebar-collapsed`, and on the sidebar being the first grid child.
- The 14px edge target sits over the conversation's left edge. If that proves
  intrusive with certain gestures, narrow it.
- A future DSH release that makes the rail hideable on its own would make this
  plugin unnecessary.
