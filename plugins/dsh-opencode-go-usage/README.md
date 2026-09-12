# dsh-opencode-go-usage

Shows how much of your **OpenCode Go** subscription allowance is spent — the
5-hour, weekly, and monthly windows — inside the DSH Web GUI.

## Status

| Half | State |
| --- | --- |
| Host plugin (fetch + cache + `/api` route) | **built and verified** (`verify.mjs` ALL PASS) |
| Client plugin (the pill) | **built and verified** (`verify-client.mjs` ALL PASS) |
| Loaded in the running `dsh web` | **not yet** — needs one restart + F5 |

## What you see

A **progress ring** in the composer row, immediately to the left of the
context-occupancy meter. The ring reports the 5-hour window — the shortest limit,
so the one most likely to bite first — and wears that window's colour (pink). It
escalates to amber at 70% and red at 90%. Clicking it opens a small panel:

```
OpenCode Go allowance
Monthly   24% · 29d   [━━━━━━━━│━━━━━━━━━━━━━━━━━━━]
Weekly    48% · 35h   [━━━━━━━━│━━━━━━━━━━━━━━━━━━━]
5-hour    11% · 3h    [        ┃██│━━━━━━━━━━━━━━━━]
                              ↑ shared anchor
```

Three rows on **one shared quota scale**, where the track in every row is the
monthly allowance, so a bar's width is its allowance as a fraction of that
($30 = 50%, $12 = 20%). The solid part of each bar is allowance consumed and the
lighter part is what remains.

Each window is **positioned by its own usage**, not by its allowance:

```
windowWidth = allowance / monthlyAllowance
usedWidth   = windowWidth × usage%
windowLeft  = anchor − usedWidth
```

Every used portion **ends at the same anchor**, which is what makes the three rows
comparable — the boundary lines up vertically across them. Because position is a
function of usage, the bars slide horizontally as usage changes: burn a window
faster and it grows leftward.

This is a **quota scale, not a timeline**. It makes no claim that the current week
sits inside the current month — the windows are deliberately not nested in time
(measured on a live account, the weekly window began four days *before* the
monthly billing period, because the weekly resets on a fixed weekday boundary
while the monthly cycle follows the subscription date).

**Truncation.** A window whose reading would reach past either end of the track is
clipped rather than rescaled, so the scale always means exactly one monthly
allowance and never silently re-bases. A clipped edge is squared off so it reads
as "continues" rather than "ends". Both directions are reachable: a heavy child
against a light month clips on the **left** (used > anchor), and a light child
against a heavy month clips on the **right** (remaining > 100 − anchor).

It renders nothing until the first successful reading, so it never occupies the
composer row with a placeholder it cannot fill. If the reading goes stale it
keeps showing the last value and says why underneath; if it fails outright the
panel explains instead of silently disappearing.

## How the UI attaches

The context meter's popover is **not extensible** — its children are a hardcoded
array (`dsh-client-ui-conversation/lib/client.js` 15494-15533), `ContextMeter` is
not an export, and DSH has no patch-an-existing-component API. The supported seat
b that renders immediately beside it is `conversation.input.right` (kind `list`,
scope `session`, zero shipped occupants), which is what this plugin registers
into:

```js
ctx.slots.inject("conversation.input.right", () =>
  ctx.slots.register({ name: "conversation.input.right", id: "opencode-go-usage", order: 100 }, GoUsagePill));
```

So the meter and the Go pill sit side by side, each with its own popover. Putting
Go rows *inside* the context popover would require DOM injection against a
hashed CSS class — it would break silently on any DSH rebuild, which is worse
than not having it.


## Where the number comes from

`GET https://opencode.ai/zen/go/v1/usage` with `Authorization: Bearer <key>`:

```json
{"usage":{
  "rolling":{"status":"ok","percent":27,"resetsAt":"2026-09-12T11:50:42Z"},
  "weekly": {"status":"ok","percent":41,"resetsAt":"2026-09-14T00:00:00Z"},
  "monthly":{"status":"ok","percent":20,"resetsAt":"2026-10-11T15:43:05Z"}}}
```

Caveats worth knowing:

- **The endpoint is undocumented.** <https://opencode.ai/docs/go/> only points at
  the web console; users are still filing requests for API access
  ([#38824](https://github.com/anomalyco/opencode/issues/38824),
  [#43983](https://github.com/anomalyco/opencode/issues/43983)). Treat the shape
  as observed, not guaranteed — the plugin reports every failure instead of
  throwing, so a change here degrades to a visible message.
- **Inference responses carry no rate-limit headers**, so polling `/usage` is the
  only way to read quota. Verified: a real completion returns only
  Cloudflare/Date/Content-Type headers.
- The credential is resolved through `ctx.credentials` with the same
  `apiKeyEnv: OPENCODE_GO_API_KEY` reference the `opencode-go` provider profile
  uses, so the plugin follows the route's own credential and stores no copy.
- `OPENCODE_GO_API_KEY` is this profile's reference name, not an OpenCode
  convention (OpenCode's own CLI uses `OPENCODE_API_KEY`).

## Configuration

`cordis.patch.yml` in this directory:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | turn the service off entirely |
| `baseUrl` | `https://opencode.ai/zen/go/v1` | gateway root; `/usage` is appended |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | credential reference to resolve |
| `cacheMs` | `30000` | minimum age before a reading is refreshed |
| `refreshMs` | `60000` | background poll period; `0` disables polling |
| `timeoutMs` | `10000` | per-request timeout |

## Surfaces

- **Host service:** `ctx.opencodeGoUsage.status()` →
  `{ ok, stale, windows[], fetchedAt, error, plan }`. Never throws.
- **HTTP:** `GET /api/opencode-go-usage.status` returns that same object as JSON
  with `cache-control: no-store`. Lives under `/api`, so it inherits
  Connection's Host fence and browser-session cookie — check it with a
  signed-in session, e.g. from the GUI console:

  ```js
  await (await fetch('/api/opencode-go-usage.status')).json()
  ```

- **Per-request diagnostic (`verify.mjs`):** exercises the pure helpers, a
  deliberately bad key, and the live reading.

## Verifying

```
node .dsh\profiles\web\plugins\dsh-opencode-go-usage\verify.mjs          # host: helpers + live gateway
node .dsh\profiles\web\plugins\dsh-opencode-go-usage\verify-client.mjs   # client: bundle envelope + seat wiring
```

`verify-client.mjs` stubs `window.__ModuleLoader__`, `require`, and a minimal DOM,
then evaluates `lib/client.js` exactly as the browser would. It catches syntax
errors, a wrong envelope, missing exports, and a mis-wired slot registration —
not rendering, which still needs a browser.

## Loading it

Both halves are new, so the running `dsh web` has never loaded them. Host
`index.js` edits are **not** watched (`dsh-base` disables module HMR), so
activation requires one restart:

```
cd D:\Letters\MatTroiSeConMoc
dsh web --resume session-cedb656f-621c-4671-9e0f-02e556746177
```

Then **press F5 in the browser**: a newly added client-plugin row is not injected
into an already-running page (only *rewrites* of an already-loaded client bundle
hot-reload, via `dsh-client-hmr`).

After that, editing only `cordis.patch.yml` (row config, adding/removing rows)
applies live via the profile's `patchReload: "live"`, and editing `lib/client.js`
also hot-reloads live. Editing `index.js` needs another restart.
