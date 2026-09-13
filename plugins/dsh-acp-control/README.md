# dsh-acp-control

An [Agent Client Protocol](https://agentclientprotocol.com) control plane for
DeepSeek Harness sessions: an explicit session state machine that **refuses
loudly instead of silently doing nothing**, an append-only event log that lets
a reconnecting client **miss nothing and duplicate nothing**, and a loopback
HTTP+SSE transport with Goose-style token auth.

Rename, archive, and fork live in a small `_dsh/…` namespace shaped like the
draft ACP RFDs so migration is mechanical when they stabilise.

## Status

| Half | State |
| --- | --- |
| Protocol core, state machine, event log, replay | **built and verified** (`verify/core-checks.mjs` 49/49) |
| stdio transport | **built and verified** (`verify/stdio-client.mjs`, 49/49) |
| Loopback HTTP+SSE with token auth | **built and verified** (`verify/http-client.mjs` 22/22) |
| `dsh` backend in a real profile | **built and verified** (`verify/plugin-boot.mjs` 12/12, real agent turn) |
| Loaded in the running `dsh web` | **not yet** — see *Loading it* |

## Why this exists

Two ACP servers for DSH already exist. Neither closes the hole this one is
aimed at, and ACP itself will not close it either.

| | `@deepseek-ai/dsh-acp` (first-party) | `dushaobindoudou/dsh-acp` | this plugin |
| --- | --- | --- | --- |
| transport | stdio only | stdio + HTTP+SSE + web-mounted | stdio + loopback HTTP+SSE |
| replay after a reconnect | **none** — "no transcript replay"; `session/resume` restores the log "without replaying old updates" | **none** — its `pending[]` only covers frames emitted *before the first attach*; a disconnect loses everything in the gap | **append-only log + cursor**; SSE `id:` makes a browser resume for free |
| concurrency guard | `inflight` + one error string | `prompting` boolean + one error string | **7-state machine + transition table**; every refusal carries `{state, allowedIn, eventId, hint}` |
| actor on a change | absent | absent | **`human:<client>` / `agent:<id>` / `system:acp-control`**, on the wire in `_meta` |
| durability of the ACP view | in-memory table | in-memory table | **rebuilt from the log at boot** |
| auth | none (stdio) | `Authorization: Bearer` | `X-Secret-Key` + `?token=`, timing-safe, loopback default |

ACP will not fix the resync: the
[Streamable HTTP & WebSocket Transport RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport)
is still Active, targets v1, and states that in-flight messages are explicitly
**not** replayed, with resumability deferred to v2. A control plane is where
that is fixable, because a control plane owns the event stream.

## The invariant, and the bug it is aimed at

> **Nothing changes a session except an admitted command, and no admitted
> command is ever silent.**

Every command produces exactly one of two observable outcomes: it is
**accepted** and appends at least one event, or it is **refused** with a
structured error naming the state that blocked it. There is no third outcome.

That third outcome is the real-world bug this is designed against: DSH's own
rename dialog once accepted text and silently discarded it while a session was
generating. `lib/session.js` enforces the rule **mechanically** — an admitted
command that appends no event is raised as an internal error rather than
returned as a success — so there is no code path that can report success after
dropping the caller's input.

A refusal looks like this, and it is also *logged*, so a client that never saw
the response still learns about it after reconnecting:

```json
{"code":-32003,
 "message":"delete is not allowed while the session is generating",
 "data":{"type":"refused","command":"delete","state":"generating",
         "allowedIn":["idle","closed","failed"],
         "reason":"a turn is writing to the session",
         "hint":"send session/cancel and wait for the turn to end, then delete",
         "sessionId":"acp-4564b4c6-…","eventId":42,"actor":"human:curl"}}
```

Clients discriminate on `data.type`, never on the numeric code.

## Session states

| State | Meaning |
| --- | --- |
| `idle` | no turn in flight — the resting state |
| `generating` | a prompt turn is running |
| `awaiting_permission` | the turn is blocked on a client permission decision |
| `cancelling` | cancellation accepted; the turn is winding down |
| `closing` | teardown in flight |
| `closed` | terminal; resumable and deletable |
| `failed` | terminal-by-error; closable, deletable, resumable |

`_dsh/session/state` returns the full record, and `_dsh/session/state_changed`
notifies on every move. Two table entries are deliberate decisions:

- **`rename` is allowed *during* `generating`.** A title is not part of the
  turn, so forbidding it would fail a legitimate write for a reason the user
  cannot act on. The bug was never that rename was allowed — it was that rename
  was *silent*.
- **`fork` is `idle`-only**, because a fork cuts the log at a settled turn
  boundary and `generating` has none.

## Running it

### As a server, without DSH

```
node lib/standalone.js --stdio                          # NDJSON JSON-RPC on stdin/stdout
node lib/standalone.js --http --port 7810               # loopback HTTP+SSE
node lib/standalone.js --http --port 0                  # any free port; prints the bound one
```

`--backend scripted` (the default here) is a **deterministic fixture**, and it
says so on stderr at boot. `--backend dsh` is refused from this entry with an
explanation: the DSH backend creates agents through `ctx.agents`, so it must
run inside a profile. That is what `index.js` is for.

### Inside a DSH profile

`cordis.patch.yml` mounts it with `transport: auto`, which serves **loopback
HTTP only**. It deliberately does not fall back to stdio when stdout is not a
terminal: `dsh web` runs with stdout redirected to a log file, and a stdio
transport that mistook that for an editor's pipe would write JSON-RPC frames
into the log. A stdio server has to be asked for.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | turn the service off |
| `transport` | `auto` | `auto` (loopback HTTP) / `http` / `stdio` / `both` |
| `host` | `127.0.0.1` | bind address; anything else is an explicit opt-in |
| `port` | `7810` | HTTP port; `0` asks the OS for one |
| `token` | `""` | shared secret; empty generates one at boot and logs it to stderr |
| `allowedOrigins` | `[]` | CORS allowlist; empty emits no CORS headers at all |
| `dataDir` | `$DSH_HOME/acp-control` | where `events.jsonl` lives |
| `maxLogBytes` | `67108864` | at the cap the plugin refuses writes; it never drops events |
| `provider` / `model` | `""` | route for created agents; empty uses the profile default |

## Transports

### stdio

NDJSON JSON-RPC on stdin/stdout. **stdout carries protocol frames and nothing
else** — every diagnostic goes to stderr, because a stray `console.log`
corrupts the stream and the symptom is a client that hangs rather than an error
anyone can read.

### Loopback HTTP+SSE

Follows the shape of the ACP remote-transport RFD (it is the future stable
path) and adds the replay layer the RFD defers.

```
POST   /acp             one JSON-RPC message
                          initialize        → 200 + JSON body + Acp-Connection-Id
                          everything else   → 202 Accepted; the response arrives on the stream
GET    /acp/stream      SSE; ?after= / Last-Event-ID / ?session= / ?connection=
DELETE /acp             close the connection
GET    /healthz         liveness; unauthenticated; no data
```

Auth is Goose's pattern, because it is the shape that works for browsers:
loopback by default, a random 32-byte secret when none is configured (logged
to stderr), **`X-Secret-Key`** for HTTP clients, and **`?token=`** as well
because a browser's `EventSource` and `WebSocket` cannot set request headers.
Comparison is `timingSafeEqual` over fixed-length digests, never `===`.

## Replay

The log is one append-only NDJSON file, `<dataDir>/events.jsonl`, with a single
global monotonic `eventId` starting at 1:

```json
{"eventId":41,"sessionId":"acp-3f9c…","ts":"2026-05-04T10:22:31.004Z",
 "actor":"human:zed","type":"session.update","data":{…},
 "frame":{"jsonrpc":"2.0","method":"session/update","params":{…}}}
```

`frame` is the **exact** frame that went on the wire, and replay re-emits it
verbatim. Re-deriving on replay would let the replay path drift from the live
path; storing it makes them the same bytes by construction. Live delivery reads
the same `record.frame`, so there is one delivery path, not two.

To resume, a client names the last `eventId` it received:

| Source | Example |
| --- | --- |
| `?after=` | `GET /acp/stream?after=40` |
| `Last-Event-ID` (sent by a browser automatically) | `Last-Event-ID: 40` |
| `after: -1` | "everything" — the OpenHands `latest_event_id` convention |

Nothing missed, nothing duplicated falls out of one property: the cursor is the
last id the client *actually received*, the client advances it only on receipt,
and the server resumes **strictly after** it. Replay and the switch to live
delivery happen in the same synchronous block, so no event can slip between
them — the usual "buffer during replay" dance is unnecessary here, not omitted.

Log records with no wire representation (state transitions, refusals, archive
flags) consume ids but are not re-emitted, so a stream's `id:` values may
legitimately skip. The cursor is a log position, not a frame counter.

Measured, over `curl` on a live server: `?after=40` replayed ids `41, 42, 44,
45, 47` — exactly the frames after 40 — and `Last-Event-ID: 45` replayed `47`
alone. `verify/http-client.mjs` drops a stream mid-turn and reconnects: 40
frames expected, 40 replayed, zero duplicated.

If a cursor ever falls below the log's retained floor the client is sent a
`_dsh/log/gap` naming `firstRetainedEventId` first, so it can re-fetch rather
than render a transcript with an invisible hole. Slice 1 never truncates, so
the floor is always 1; the mechanism exists so that adding retention later
cannot silently regress the guarantee.

## Actor identity

Every mutation and every emitted event carries an actor, and the actor rides
the wire in the schema-sanctioned `_meta`:

| Actor | When |
| --- | --- |
| `human:<client>` | a command from an ACP connection — slugged from `clientInfo.name` (`human:zed`), falling back to the transport (`human:stdio`, `human:curl`) |
| `agent:<sessionId>` | effects the agent produced inside a turn |
| `system:acp-control` | plugin lifecycle: boot recovery, log exhaustion, gap notices |

## Methods

**Implemented — stable ACP v1**: `initialize`, `session/new`, `session/list`,
`session/resume`, `session/close`, `session/delete`, `session/prompt`,
`session/cancel` (notification), and the agent→client `session/update` and
`session/request_permission`. `initialize` advertises only
`{list, resume, close, delete}` — nothing that is not implemented, and
deliberately **not** `fork`, whose RFD is still Draft.

**Extensions — `_dsh/…`**, sent only to clients that opt in through
`initialize.params.clientCapabilities._meta["dsh-acp-control/extensions"]`:

| Method | Notes |
| --- | --- |
| `_dsh/session/rename` | its *effect* is published on the stable wire as `session_info_update`; the extension exists only because stable ACP has no client→agent request for setting a title |
| `_dsh/session/archive` / `unarchive` | archive omits the session from `session/list`; `_dsh/session/list` brings it back |
| `_dsh/session/fork` | creates the child and records lineage; copying the parent's turn prefix is slice 2 |
| `_dsh/session/state` | the full state record, including which commands are admitted |
| `_dsh/events/replay` | `{sessionId?, after, limit?}` → events, `lastEventId`, `firstRetainedEventId` |
| `_dsh/log/info` | log position, size, cap, backend, connection count |

Plus the `_dsh/session/state_changed` and `_dsh/session/changed` notifications.

**Refused by name, never silently**: `session/load` (`unimplemented`, pointing
at `_dsh/events/replay` — replay is a cursor, not a load), `session/set_mode`,
`session/set_config_option`, `authenticate`, `logout`. `session/fork` called as
a *stable* method is refused with a pointer to the `_dsh/` one.

**Why `_dsh/` and not `dsh/`**: the third-party plugin already uses the bare
`dsh/` namespace for different methods with different shapes. Two incompatible
things must not claim one namespace.

## Verifying

Checks are the reason this works — each of them caught a real bug during
development, listed at the bottom of this file.

```powershell
# protocol, state machine, replay over the real stdio transport, in process
node plugins\dsh-acp-control\verify\core-checks.mjs        # 49 checks

# the same, over a real child process's pipes, driven by the official ACP client
node plugins\dsh-acp-control\verify\stdio-client.mjs       # 49 checks

# loopback HTTP+SSE: auth, the RFD's POST contract, and the reconnect guarantee
node plugins\dsh-acp-control\verify\http-client.mjs        # 22 checks

# mounted in a live DSH profile, with the dsh backend and a real agent turn
node plugins\dsh-acp-control\verify\plugin-boot.mjs        # 12 checks
```

`core-checks.mjs` and `http-client.mjs` need nothing but Node. `stdio-client.mjs`
spawns a child with piped stdio, so it cannot run where that is denied.
`plugin-boot.mjs` needs a profile running (below).

The stdio checks drive the server with **`@agentclientprotocol/sdk`** — the
reference client — deliberately, because this server implements the ACP wire
directly rather than through that SDK. Agreement between two independent
implementations is evidence; agreement between a library and itself is not. The
SDK is therefore a *verification* dependency only; the plugin itself imports
nothing outside `node:` and the Cordis/Schemastery peers every plugin here
already uses.

### The profile check

`plugin-boot.mjs` talks to an `acpctl` profile that mounts this plugin. That
profile is not committed here (it lives in `$DSH_HOME`), and it was removed
after the slice-1 run — recreate it as:

1. create `$DSH_HOME/profiles/acpctl/`, copying `cordis.yml` and
   `pnpm-workspace.yaml` from the `headless` profile,
2. **copy** this plugin to `$DSH_HOME/profiles/acpctl/plugins/dsh-acp-control/`
   (a copy, not a junction: Node resolves a junction to its target, so the
   plugin's own parent-walk would never reach the profile's `node_modules` for
   `@deepseek-ai/cordis`), and junction it into
   `$DSH_HOME/profiles/acpctl/node_modules/`,
3. set `package.json` bundles to `["@deepseek-ai/dsh-base", "dsh-acp-control"]`,
4. set `cordis.patch.yml` to override the token so the check need not scrape
   the boot log:

   ```yaml
   - id: acp-control
     config:
       token: acpctl-boot-check
       port: 7810
   ```

5. boot it, and run the check:

   ```
   dsh --profile acpctl
   node plugins\dsh-acp-control\verify\plugin-boot.mjs
   ```

If the profile's `settings.yaml` pins a model that only
`dsh-opencode-go-session` registers, add that bundle *first* (it must activate
before `@deepseek-ai/dsh-llm-pi-ai`), or the turn fails with `llm-pi-ai:
provider "…" modelOverrides names "…", which the installed catalog does not
describe`. That failure is reported as a structured `turn_failed` with the
reason, which is the point.

## Loading it into `dsh web`

The plugin is **not** in the running `dsh web` profile. To add it, follow this
repository's install steps (`README.md`): place the directory, junction it into
`$DSH_HOME/profiles/web/node_modules/`, and list it in the profile's bundles
**after** `@deepseek-ai/dsh-base` — the backend needs `ctx.agents`. Then restart
`dsh web`; host `index.js` edits are not hot-reloaded.

## Notes from building this

Findings that cost real debugging time, recorded so they need not be
rediscovered. Several were found by the checks rather than by reading.

- **This DSH build has no `assistant/chunk` event.** Its vocabulary is the
  *committed* `assistant/message` plus `tool/call`, `tool/result`, `turn/*`,
  `step/*` — generated into
  `@deepseek-ai/dsh-session/lib/types/known-event-types.js`. An earlier
  revision of the `dsh` adapter translated raw `assistant/chunk` deltas, a
  shape an older third-party plugin was written against. The symptom was the
  worst kind: the turn completed with `stopReason: end_turn` and delivered
  **nothing at all**, which looks exactly like a model that said nothing. Only
  the live-profile check caught it.

- **Serializing a turn on the session queue deadlocks `session/cancel`.** The
  obvious way to make admission race-free is to run the whole command —
  including the agent turn — inside the per-session promise chain. But
  `session/cancel` is itself a command on that chain, so a long turn holds the
  queue and cancellation can never be admitted: the one moment cancellation
  matters most is the one moment it is impossible. Admission is therefore
  quick and queued; the turn runs outside the queue and its settlement
  re-enters it.

- **A registry whose broadcaster is not wired fails silently and looks fine.**
  `SessionRegistry` delivers live frames through a sink that has to reach the
  control plane, which is constructed *after* the registry. Passing a snapshot
  left the registry writing into a dead callback: every command committed and
  `lastEventId` advanced, so every log-based assertion passed, while **no
  notification ever reached a client**. The check that caught it asserted on
  what the client received, not on what the server recorded — a distinction
  worth building into a check on purpose.

- **A "dropped" SSE stream that was never dropped manufactures the exact bug
  the check is looking for.** `fetch` ignores an `AbortController` unless its
  `signal` is passed. Without it the original reader keeps receiving frames, so
  the "reconnect" test had two readers on one connection and reported
  duplicates that the server had not produced.

- **`server.close()` does not close a long-lived SSE stream.** It waits for
  existing sockets to go idle, and neither an SSE response nor a keep-alive
  socket ever is. Shutdown hangs until the peer gives up — which, for a stream,
  may be never. `server.closeAllConnections()` is the missing half.

- **A second stream attach on one connection replaces the first.** That is
  correct — it is what a reconnect *is* — but it means a client that opens a
  probe stream on its `Acp-Connection-Id` stops receiving responses on the one
  it was reading. Two live streams on one connection would deliver every frame
  twice, which is indistinguishable from a replay bug, so the previous stream
  is ended explicitly.

- **`Set.prototype.includes` does not exist.** It is `has`. This cost one
  mystifying timeout: the `TypeError` propagated into a `finally` whose
  `transport.close()` then hung on an open socket, so the crash was invisible
  and only the hang was observable.

- **Node resolves a junction to its target, so a linked plugin cannot find the
  profile's `node_modules`.** This is why this repository's install steps put
  the plugin directory *inside* the profile tree and junction it from there:
  the parent-walk starts at the module's realpath.

## Licence

MIT. See [LICENSE](../../LICENSE).
