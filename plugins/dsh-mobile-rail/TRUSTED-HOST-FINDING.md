# Simplification available: `--trusted-host` can replace the bridge

**Verified on this machine — not yet applied.** The current bridge works; this
records a simpler architecture and the evidence for it.

## What the bridge is for

`dsh web` enforces a Host fence on `/api`. Bound to loopback with an empty
`trustedHosts`, it accepts only loopback authorities. Plain-HTTP `tailscale serve`
preserves the client's Host header (the tailnet name), so proxying straight to
`dsh web` returned **403 forbidden** on every API call. HTTPS Serve would have
solved it via SNI, but this tailnet cannot issue certs. Hence the bridge, which
rewrites `Host`/`Origin` to the loopback authority the fence accepts.

## What changed

This DSH version's `web` profile accepts a flag earlier notes missed:

```
--trusted-host <authority...>   extra authority the /api browser-trust fence
                                accepts (host or host:port; repeatable)
```

Declaring the tailnet authority makes the fence pass, so no rewriting is needed.

## Evidence

Started a scratch `dsh web --trusted-host sloptop.taild88607.ts.net:3093` and sent
raw requests with chosen Host headers:

| Host presented | Answer | Meaning |
| --- | --- | --- |
| `127.0.0.1:3094` | 401 | fence passes, auth required (baseline) |
| `sloptop.taild88607.ts.net:3093` | 401 | **fence passes** |
| `evil.example.com` | 403 | control — fence still rejects strangers |

The control matters: the fence is satisfied, not disabled.

Then through the real Serve path with no bridge, `3093 → 127.0.0.1:3094`:

```
GET /api/rpc  -> HTTP 401 unauthorized
GET /         -> HTTP 401 dsh web authentication required
```

401, not 403 — the exact symptom the bridge exists to avoid.

**The authority must match exactly.** Trusting `:3080` while Serve presented
`:3093` still produced 403. The trusted string has to be the authority the
browser will actually use.

## What the bridge still does that the flag does not

The flag fixes the **fence** only. The bridge additionally:

1. **Signs the browser in.** DSH requires a signed session cookie; the bridge
   verifies one and re-signs it for the loopback authority, and signs in any
   top-level navigation that arrives without one.
2. **Auto signs-in document navigations**, so a plain bookmarked URL works.

Neither is covered by `--trusted-host`. Without the bridge you would sign in via
the tokenised URL DSH prints at startup, and re-do that whenever the cookie
lapses.

So the honest comparison is not "bridge vs no bridge" but:

| Approach | Fence | Sign-in |
| --- | --- | --- |
| Bridge (today) | rewritten to loopback | auto sign-in, no credential |
| `--trusted-host` alone | satisfied by flag | tokenised launch URL each time |

## If you want to drop the bridge

You would still need a sign-in story. Options:

- **Keep the bridge**, which now looks like the right call — its sign-in
  convenience is the part you actually use.
- **Use the flag plus the tokenised URL**, accepting manual re-sign-in.
- **Use the flag and keep only a tiny sign-in endpoint**, dropping the Host
  rewriting. This is the smallest change: the bridge keeps its login and cookie
  logic but forwards `Host` unchanged.

To enable the flag, add it to the launcher's invocation:

```powershell
# start-harness.ps1, near the final invocation
& $launcherName @launcherArgs $Profile @Passthrough
# becomes
& $launcherName @launcherArgs @('--trusted-host', 'sloptop.taild88607.ts.net:3080') $Profile @Passthrough
```

Note the ordering: the profile name is positional, so the flag must come before
it.

## Reproducing the test

```
# scratch server trusting the authority Serve presents
node <dsh>/lib/bin.js web --port 3094 --no-open --trusted-host sloptop.taild88607.ts.net:3093
# temporary mapping
tailscale serve --bg --http=3093 3094
# probe the fence directly
node .dsh\profiles\web\plugins\dsh-mobile-rail\test-trusted-host.mjs 3094
# clean up
tailscale serve --http=3093 off
```
