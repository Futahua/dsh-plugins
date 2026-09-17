# DSH mobile Web UI — what plugins can and cannot change

Verified by reading the installed packages (paths relative to
`.dsh/profiles/node_modules/@deepseek-ai/`). Written for anyone deciding whether
a phone-UI tweak can be shipped as a plugin.

## There is no mobile layout

The phone experience is **the same component tree** as desktop, with two JS
breakpoints. No `matchMedia` for layout, no `isMobile`, no mobile components, no
drawer, no bottom navigation:

| Breakpoint | Where | Effect |
| --- | --- | --- |
| `1024` | `dsh-client-ui-layout/lib/client.js:13,233` | `narrow = viewport < 1024`; sidebar auto-collapses to a 56px rail, toggling expands it to 280px and squeezes the centre |
| `768` | `dsh-client-ui-sidebar-right/lib/client.js:916` | the right bar becomes a fixed full-screen overlay instead of a reserved track |

`viewport` comes from a `ResizeObserver` on the frame (`layout:214-232`), seeded
from `window.innerWidth` (`:344`). The shell adds only a `viewport` meta tag.

Width media queries exist in exactly a few places — chat 480, settings-models
560, settings-plugin-inventory 680, trajectory 760, user-questions 720,
workflow-run 560, plus `pointer:coarse` for attachments — and they only shrink or
hide *labels*. `layout`, `sidebar` and `sidebar-right` have none.

**Consequence: every slot renders on a phone.** The report enumerates 61 slot
entries in the catalog (`dsh-cordis-client-runner/lib/client.js:2201-4599`) and
none is viewport-dependent. Only the props handed to a seat change
(`sidebar{collapsed,width}`, `rightbar{width,viewportWidth,canShow}`).

## Seats that work well on a phone

Additive list seats, all confirmed phone-visible:

- `shell.overlay` — root-scoped, frame-wide floating layer, click-through until
  your node takes pointer events. Good for a floating button.
- `conversation.input.left` / `.right` / `.dock`, `conversation.composer.dock`
- `conversation.session.header.actions` / `.utilities`
- `conversation.view`, `conversation.input.overlay`
- `settings.general.item`, `settings.section`
- in the sidebar rail: `sidebar.panellist` (id/label/order, plus a matching `main`
  keyed panel via `ctx.layout.selectPanel(id)`) and `sidebar.footer.action`

Desktop-only on a phone: `sidebar.brand.name` — rendered only inside `wide &&`
(`sidebar:203,218`), so it is absent until the rail is expanded.

The right bar is **not** desktop-only, just collapsed: `canShow=false` and width 0
on a phone (`layout:299`), reachable through `conversation.session.header.corner`
(the expand button), then full-screen below 768px.

## Styling, ordering, shadowing

- **Order** applies to list slots only: registry sorts priority-then-order
  (`dsh-client-ui-slots/lib/index.js:122`), renderer sorts winners by `order`
  (`dsh-client-ui-renderer/lib/client.js:866`). Unused for single/keyed/chain.
- **There is no `replace` option.** `replaceRisk` in the catalog is prose. The
  real mechanism is **`priority`** (ascending, default 0, lowest renders): a
  second registration in an occupied cell at the *same* priority throws naming
  the occupant; a lower priority shadows it. Shadowing **deletes** the shipped
  occupant — there is no wrapping API.
- **CSS injection is a convention, not a registry.** Ship a `<style>` with
  `dataset.plugin` and `dataset.pluginCss` set to your package id
  (`layout:70-79`; helper in `dsh-client-ui-theme/lib/client.js:1078-1090`).
  `dsh-client-hmr` deletes `style[data-plugin="<id>"]` on reload
  (`dsh-client-hmr/lib/client.js:53-55,80`), so re-inject inside `apply`.
- **Stable CSS hooks exist** — this is the important one for a *durable* tweak:
  every outlet renders `<div data-slot="<key>" style="display:contents">`
  (`renderer:767-777`), and the frame carries `data-sidebar-collapsed`,
  `data-rightbar-collapsed/-fullscreen/-instant`, `data-shell-overlay`
  (`layout:281-303`). Target those instead of hashed class names.
- **Supported token restyle:** `ctx.theme.overrideTokens(source, tokens)` with
  `{light,dark}` values, stacked and disposable (`theme:1358-1370`).
- **Cannot** unregister or hide another plugin's entry: `entries()` /
  `entriesOfSlot()` / `snapshot()` are read-only
  (`dsh-client-runtime/lib/client.js:180-202`).

## Recipe, most robust first

1. **Additive list seat** that is phone-visible (see list above). Fully
   supported, survives updates.
2. **CSS injection** scoped with `@media (max-width: 768px)` plus `[data-slot=…]`
   or frame `data-*` selectors. Supported and platform-identical, but
   hashed-class churn is a real risk if you target class names rather than data
   attributes. (Prefer `max-width` over the newer range syntax for older
   mobile Safari.)
3. **Shadow to replace or hide:** `register({name, priority:-1}, MyComponent)`
   displaces the shipped occupant, or register `() => null` to hide it. Works,
   but it *removes* shipped UI rather than tuning it.
4. **Unsupported:** moving or anchoring an existing occupant, portalling into
   built-in DOM, unregistering another plugin's entry, or any mobile-specific
   seat (none exists). Raw `querySelector('[data-slot]')` mutation works but
   fights React and is unsupported.

## How this plugin uses it

`usage` registers into `conversation.input.right` — a list seat
that is empty in the shipped product, phone-visible, and validated by plugin
`verify-client.mjs`. On a narrow screen the composer row is tight, so the pill is
deliberately small (a dot plus `Go 27%`); its own CSS is scoped under
`.dsh-usage` so it can be narrowed further with a media query if needed.
