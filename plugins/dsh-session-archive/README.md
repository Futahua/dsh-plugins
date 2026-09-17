# dsh-session-archive

Sidebar session pane replacement: every session row reveals a one-click
archive button on hover, beside the `...` menu. One click archives
immediately with **no confirmation dialog** — the same posture as the
shipped Archive menu item, which commits without a dialog because archiving
only hides the row through the registry-global archive set and never touches
the session log. The row disappears when the archive-set echo lands.

## What it replaces, and why a whole pane

There is **no slot for per-session-row actions** — verified against the
installed harness (`@deepseek-ai/dsh-client-ui-workspace`,
`@deepseek-ai/dsh-cordis-client-runner` slot catalog). The only seat is
`sidebar.workspaces` itself: `kind: "single"`, `scope: "root"`, declared by
the `sidebar` shell entry (`@deepseek-ai/dsh-client-ui-sidebar`), owner
props `{ wide, expandSidebar }`. A `single` slot renders one entry, so
registering here shadows the shipped `WorkspaceBrowser` (the catalog marks
this seat `replaceRisk: "shadows-shipped-ui"`). A dynamic plugin or a slot
injection therefore cannot add a button to the existing rows — owning the
region is the supported path, and this plugin takes it.

## Upstream source decision

The upstream repo `deepseek-ai/deepseek-harness` defaults to branch
**`master`** (resolved with `git ls-remote ... HEAD`; `.../tree/main/...`
is a 404). The pane source **is fetchable** there
(`packages/client/ui-workspace/src/client/rows/`, `master`), and this
plugin's row anatomy is modelled 1:1 on the real `SessionNodeItem`
(`Rows.tsx`): status dot, title, relative time, hover actions cell, archive
via `onArchive(id)` with no dialog, archive-set echo filtering.

It is still a **minimal flat pane** ("In one list" equivalent), not a
full-parity port, for two reasons: this repo ships no TS/JSX toolchain
(sibling `lib/client.js` bundles are plain `React.createElement`, and this
one matches), and porting the 56KB `WorkspaceBrowser.tsx` (grouping,
drag-reorder, workspace dialogs, stores) into dependency-free JS would be
high-risk for no hover-archive benefit. Consequences, stated plainly:

- Grouped-by-workspace view, drag-reorder, and the workspace rename/delete
  dialogs are not carried over. The shell still owns New Session, the brand,
  panels, and Settings — none of that moves.
- Status dots are plain CSS (running / needs-attention / done); the shipped
  `StateDot` primitive is not imported so the bundle needs only `react`.
- Labels are terse English literals; the workspace locale namespace is not
  joined (no `t` dependency).
- Time labels are compact relative ("now", "5min", "2h", "3d").

## The directory-flow hole

Upstream `WorkspaceBrowser` declares the `single`
`sidebar.workspaces.directoryFlow` hole, and both shipped pickers
(`dsh-client-ui-directory-picker-browse`, `-native`) inject **by hole
name** — so an undeclared hole would silently drop "Add workspace". This
pane **redeclares the hole with the identical contract**
(`{ kind: "single", scope: "root" }`) and renders it through `renderSlot`
with the identical owner share
(`{ open, busy, onPicked, onCancel, onError }`); adoption calls
`createWorkspace({ path })` then starts a session in it. The Add button only
appears while the hole is occupied, mirroring upstream hiding the button
when a composition offers no picking affordance. Evidence is static
(the live GUI was not touched): the picker `inject("sidebar.workspaces.directoryFlow")`
lines in the installed bundles plus the runner catalog entry
(`occupants: BrowseDirectoryFlow, NativeDirectoryFlow`).

## Installing

Per the repo root README (three steps per plugin):

1. **Place the directory** in `$DSH_PLUGIN_DIR`
   (`$DSH_HOME/profiles/web/plugins/dsh-session-archive`).
2. **Link it** so bare-specifier resolution works:

   ```powershell
   New-Item -ItemType Junction `
     -Path "$DSH_HOME\profiles\web\node_modules\dsh-session-archive" `
     -Target "$DSH_HOME\profiles\web\plugins\dsh-session-archive"
   ```

3. **List it** in `$DSH_HOME/profiles/web/package.json`, as both a bundle
   and a `link:` dependency (appended after the shipped entries, so this
   registration applies last and shadows the shipped browser):

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-session-archive"
         ],
         "patchReload": "live"
       }
     },
     "dependencies": {
       "dsh-session-archive": "link:D:/path/to/plugins/dsh-session-archive"
     }
   }
   ```

Then restart `dsh web` and reload the browser. Reload paths (repo
convention): `cordis.patch.yml` and `lib/client.js` go live (patch watch +
client HMR + one browser reload for first load); `index.js` needs a
`dsh web` restart. To restore the shipped pane, remove the bundle or set
`enabled: false` — the shipped entry stays installed but unrendered while
this one is active.

## Verifying

```powershell
node plugins\dsh-session-archive\verify-client.mjs
```

Stub-DOM check following the `dsh-mobile-rail` / `dsh-opencode-go-usage`
precedent: envelope, slot replacement + hole redeclaration, archive-button
presence/routing/propagation, archive-set echo, search + Add-workspace
seats, and the hover CSS swap. Needs nothing but Node.

## Files

| File | What it is |
| --- | --- |
| `package.json` | Plugin manifest (`dsh.bundle.patch` + `dsh.client`, sibling pattern) |
| `index.js` | Host half: loader-row presence only, no service/route/hook |
| `lib/client.js` | The pane (flat list, hover-archive rows, search, flow seat) |
| `cordis.patch.yml` | Bundle row (`session-archive`, enabled) |
| `verify-client.mjs` | Self-check (exit 0 on `ALL PASS`) |
