# dsh-code-colors

House style for the DSH Web GUI: colors carry meaning — yellow=created,
pink=changed, blue=read/code, sage=thinking, lavender=closing reply, red=failed.

## What it does

- **Inline code** renders blue; fenced blocks untouched.
- **Edit/write rows** split the `+N -M` statistic: `+N` yellow, `-M` blue.
  Created files show `+N` alone and read yellow end to end (pen included);
  edited files read pink.
- **Files-changed panel** gains per-file `+N -M` counts summed from the turn's
  own tool rows, wraps instead of clipping, and loses its file-type glyph and
  its "Files changed" label.
- **Reasoning** renders sage italic with no label or icon, in chat and in the
  trajectory pane. **Read** rows get a blue eye, no label. **Edit/grep** rows
  lose their words but keep their glyphs. Injected context renders blue.
- **Contrast**: row content brighter than titles; chrome white dimmed (user
  messages, composer input, and the side pane exempt).
- **Turn tails**: no like/dislike or usage buttons; the clock shows the elapsed
  time and opens the usage dialog; the closing message renders lavender.
- **Finished turns fold** behind a "worked for Xs" strip; injected-context rows
  fold with the work. Holding a row folds it (touch-safe: no stray selection).
- **Any failed tool row** reads red and loses its status dot, icon kept
  (a failed process row regains its terminal glyph as a clone).
- **Fenced-code Copy** is an icon button with a tick on copy.

Everything anchors on `data-*` attributes the product publishes, never on
CSS-module hashes. See `lib/client.js` header for the per-version history
(current: v24).

## Installing

1. Place the directory in `$DSH_HOME/profiles/web/plugins/`.
2. Link it: `node install-link.mjs` (re-run after any `pnpm install`).
3. Append to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: code-colors
      name: dsh-code-colors
      config:
        enabled: true
```

Reload the page. Plugins load at boot; confirm
`window.__dshCodeColors.version` matches the source `VERSION`.

## Verifying

`verify-live.mjs` checks the live GUI over CDP (needs the shared Chrome on
its DevTools port). It takes minutes — background it. `page.mjs` runs one
expression (`node page.mjs --file q.js`), `shot.mjs` screenshots an element,
`check-mobile.mjs` covers 390px.
