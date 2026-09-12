# Launching the harness

`start-harness.ps1` in the workspace root is the launcher this setup actually
uses. It pins `DSH_HOME` for the process (a Windows process inherits its parent's
environment, so a newly persisted variable would otherwise be missed until the
next sign-out) and resolves `dsh` in three tiers: `dsh` on PATH, then the cached
npx install run directly with node, then `npx @latest` as a last resort.

```
cd D:\Letters\MatTroiSeConMoc
pwsh -File .\start-harness.ps1
```

Verify resolution without launching:

```
pwsh -File .\start-harness.ps1 -Check
```

## Correcting an earlier mistake

Earlier revisions of `TAILSCALE-SERVE.md` told you to restart with:

```
dsh web --resume session-cedb656f-621c-4671-9e0f-02e556746177
```

**`--resume` is not valid on this version.** The web profile rejects it:

```
$ dsh web --resume test
error: unknown option '--resume'
```

Sessions are persisted under `.dsh\sessions\` regardless; reopen one from the GUI
session list rather than from a command-line flag. The `web` profile accepts only:

| Flag | Meaning |
| --- | --- |
| `--host <host>` | bind host |
| `--port <port>` | listen port; `0` picks a free one |
| `--no-open` | do not open a browser |
| `--trusted-host <authority...>` | extra authority the `/api` browser-trust fence accepts (repeatable) |

## Restarting after a plugin change

Host-side plugin code (`index.js`) is not watched — `dsh-base` disables module
HMR — so a new or edited host half needs a full restart:

```
# stop the old server, then
pwsh -File D:\Letters\MatTroiSeConMoc\start-harness.ps1
```

That also takes the Tailscale bridge down with the session, so re-run:

```
pwsh -File D:\Letters\MatTroiSeConMoc\.dsh\startup.ps1
```

Then reload the browser. Confirm the new instance is serving the plugins:

```
node D:\Letters\MatTroiSeConMoc\.dsh\profiles\web\plugins\dsh-mobile-rail\check-live.mjs
```

It should print `in boot graph: true` for both plugins and `HTTP 200` for the
usage route.

## What hot-reloads without a restart

| Change | Applies |
| --- | --- |
| `cordis.patch.yml` (row config, adding/removing rows) | live — `patchReload: "live"` watches it |
| `lib/client.js` | live — `dsh-client-hmr` polls it and swaps the bundle in the browser |
| `index.js` (host plugin code) | **needs a restart** |

A **newly added** client-plugin row is not injected into an already-running page,
so the first load of a new plugin also needs a browser reload.
