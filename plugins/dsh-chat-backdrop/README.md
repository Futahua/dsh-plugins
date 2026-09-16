# dsh-chat-backdrop

An optional photo behind the chat, with its switch in the side panel.

## What it does

- **On**: the picture covers the page on its own viewport layer, centered —
  narrowing to portrait crops the side edges around a fixed middle. Exactly as
  supplied: no dimming, no filter. The side panel and dialogs keep their solid
  backgrounds; the composer keeps its pill.
- **Switch**: a Backdrop row above Settings, On/Off. On by default; remembers
  the choice. Icon-only when the panel is collapsed to its rail.
- **New photo**: hold the row (or right-click it) to pick a replacement.
  Past ~1.5MB it is re-encoded on the way in (longest edge 1920, JPEG),
  because the page silently drops oversized style values — a big pick stored
  and synced fine but never painted. Bad picks are ignored, never applied.
- **Sync**: the choice and the photo live in one host document
  (`$DSH_HOME/chat-backdrop.json`) behind `GET`/`PUT
  /api/chat-backdrop.state`, polled quietly, so phone and desktop follow each
  other within seconds.

## Installing

1. Place the directory in `$DSH_HOME/profiles/web/plugins/`.
2. Link it: `node install-link.mjs` (re-run after any `pnpm install`).
3. Append to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: chat-backdrop
      name: dsh-chat-backdrop
      config:
        enabled: true
```

4. **Restart the host** (`restart-harness.ps1`): the client half loads on page
   reload, but the host service in `index.js` only loads at boot. Then reload
   every browser tab.
5. Confirm `window.__dshChatBackdrop.version` matches the source `VERSION`.

## Files

- `lib/client.js` — the whole GUI half (the picture travels embedded; run
  `node embed.mjs` after replacing `assets/backdrop.png`).
- `index.js` — the host service (shared state + routes).
- `test-host.mjs` — 10 checks against the service with a fake context.
