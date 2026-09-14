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
| Protocol core, state machine, event log, replay | **built and verified** (`verify/core-checks.mjs` 76/76) |
| stdio transport | **built and verified** (`verify/stdio-client.mjs`, 65/65 over a real child process) |
| Loopback HTTP+SSE with token auth | **built and verified** (`verify/http-client.mjs` 33/33) |
| `dsh` backend in a real profile | **built and verified** (`verify/plugin-boot.mjs` 12/12 on the run before this round's changes; not re-run this round because the `acpctl` profile would not boot, and the web gate below covers the same backend in a stronger composition) |
| **Attachment to a session somebody else owns** | **built and verified** — `verify/attach-check.mjs` 19/19 against a fixture that owns an agent the way the GUI does, and `verify/web-gate.mjs` **21/22** inside the **real web composition**, driven from both ends. The one failure is deviation 7 below, found by that check. |
| Loaded in the running `dsh web` | **not yet** — that is your move, not mine; see *Loading it* |

## Known deviations

Read these before relying on the plugin. Full reasoning is in
[`DESIGN.md`](DESIGN.md), at the top.

| # | What | Status |
| --- | --- | --- |
| 0 | **Attachment, not discovery.** A session that belongs to someone else — the GUI — is attached by resolving the live agent, binding to its own event surface, and routing every mutation through DSH's canonical session services. It is no longer listed with an artificial `closed` state. It needs **no DSH core change**, but it does require **co-residence**: the plugin must be loaded in the process that owns the session, so a standalone ACP server can still only *discover* sessions, never drive them. | **Implemented** (slice 2, item 1). Verified inside the real web composition by `verify/web-gate.mjs`. |
| 1 | **The stream model does not conform to the RFD.** It requires one connection-scoped stream *plus* one session-scoped stream per session, concurrently attachable. This serves **one stream per connection** with an optional `?session=` filter, so a client that follows the RFD and opens both gets its connection stream torn down by its session stream and stops receiving responses. | Known defect. Slice 2, item 2. |
| 2 | `_dsh/session/refused` is an **invention** — ACP is silent on how a refused *notification* is reported, since a notification has no response channel. The log entry is the part that needs no permission; the notification is this plugin's own mechanism. | Deliberate, labelled as ours |
| 3 | The SSE `id:` field is used as the replay cursor. The RFD does **not** define event ids in v1 — it defers them to v2 as a "last replay ID". Unclaimed today and pointing v2's way, but v2 could assign it a different meaning. | Contained in `lib/cursor.js` |
| 4 | **`archive` is delegated, and one-way.** The plugin no longer keeps its own archived flag as a second source of truth: it calls `ctx.workspaceController.archiveSession` and *reads* the workspace registry's own set. DSH has no unarchive in any form, so `_dsh/session/unarchive` is refused as `unavailable` rather than implemented one-sidedly. | Implemented (slice 2); the refusal is deliberate |
| 5 | **`_dsh/session/fork` is refused as `unavailable`.** DSH's canonical `fork` copies a *completed-turn prefix* into a new session; the plugin could only have created an empty child and called it a fork. A method that returns a session which is not the one the caller asked for is worse than one that says no. | Deliberate decline (slice 2) |
| 6 | **`session/delete` is plugin-local.** There is no host "delete a session" method — `WorkspaceDeleteRequest` deletes a *workspace*, and the only `_deleteSession` is private inside `dsh-session-query-sqlite`. The removal is real but its scope is stated on the wire as `scope: "acp-control-only"`. | Not parity with the GUI, and should not be described as such |
| 7 | **An approval raised during this plugin's *own* turn is not routed to the ACP client — it is left to the host.** Found by the gate, in the real web composition, and **not fixed**. The fail-closed direction is proven (an approval during the *human's* turn never reaches the client, and the host answers it), but the claim in the policy table above is therefore only half-implemented: with a client attached, a tool that needs approval inside the client's own turn is never put to that client. The turn does not hang — the host's answerer resolves it, and the tool is denied — but the client is not asked. | **Open defect, reproduced by `verify/web-gate.mjs`.** Diagnostics are in `backend-dsh.js` at the point of decision; the listener is registered on both the agent's context and the plugin's own, and the remaining unknown is which predicate declines. Fails closed, so the safe direction is the one that works. |

### What the replay guarantee does *not* cover

It is gapless for **logged event frames across a transient stream disconnect
within one process** — it is not exactly-once delivery of commands. Duplicate
command delivery is covered for clients that send an idempotency key; an
outstanding `session/request_permission` frame and a long-running
`session/prompt` response are not recoverable from the log (the *state* and the
turn's *events* are). The full table is in DESIGN.md §5.

Two things worth knowing when reading the ACP schema:

- **`session/fork` looks stable and is not.** The constant is present in the
  schema shipped with `@agentclientprotocol/sdk` 1.4.0, but it is marked
  unstable, sits behind the `unstable_session_fork` flag, and ships in the
  *unstable* schema artifact; the stable v1 schema holds only completed
  features, and the RFD status (Draft since 2025-11-20) is authoritative. Fork
  therefore stays in `_dsh/` and is not advertised in `sessionCapabilities`.
- **`session/cancel` is a notification**, so a disallowed cancel has no response
  channel. The refusal is recorded in the log, and — for clients that opted into
  `_dsh/` — also sent as `_dsh/session/refused`.

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

## Policy: two actors, one session

Once an external client can attach to the session the human is looking at, the
interesting question is no longer *can* it act, but *may* it. ACP says nothing
about a second frontend, and neither does DSH, so this is a decision this plugin
has to make and state rather than discover. **It is not settled policy** — it is
the most conservative behaviour that is still useful, chosen so that the human
never loses control of their own session to a program.

**What was chosen.**

| Rule | Why this one |
| --- | --- |
| **Fail closed on permissions.** A `session/request_permission` reaches the ACP client **only** while the current turn is the exact turn ACP authored. Anything else — an adopted GUI turn, a turn whose owner is unknown, a race — is left for the host's own answerer. | Answering a permission means authorizing an irreversible side effect on someone else's turn. It is the one action where being wrong cannot be undone, so it is the one action that requires positive proof of ownership rather than the absence of a reason to refuse. **The refusal half is verified; the grant half is not** — see deviation 7: a permission raised inside ACP's own turn is also left to the host, which is too conservative and is an open defect. |
| **Turn ownership, not "is the agent busy".** Every command is scoped to a turn this connection authored: a minted message identity, correlated against `turn/start` and `turn/end`, and carried on refusals. | "Busy" is the wrong predicate in both directions — it refuses work that is safe (a rename mid-turn) and permits work that is not (answering a question asked by a different actor's turn). |
| **Cancel only your own turn**, with the inbox kept (`keepInbox: true`). | Cancelling is destructive to the turn and *not* to the queue; dropping the human's queued follow-ups as collateral would be a second, silent failure. |
| **Write provenance.** A prompt ACP admits carries `{kind: 'plugin', plugin: 'dsh-acp-control'}`. | It is the only way the transcript stays honest about who spoke. It also keeps the GUI's own attribution and the host's `user-rpc` dedup working untouched. |
| **Never a second source of truth.** Rename and archive call the canonical DSH service first and record second; if the log write then fails the result is reported as `partially_applied`, naming both halves. | The plugin's log is a view of the session, not a rival copy of it. A view that disagrees with the thing it views is how the original bug class starts. |

**Alternatives considered, and why not.**

| Alternative | Why it is worse |
| --- | --- |
| *First come, first served*: while attached, ACP answers every permission. | The human watching the GUI would see a tool run they did not approve. Attaching a second client would silently delegate authority over the first client's turns. |
| *Take over*: an attached client owns the session exclusively until it detaches. | Turns a read-only-ish convenience into a lockout. The human's own GUI would start refusing them in their own session. |
| *Pure observer*: attach, stream, but allow no mutation. | Safe, and useless — it fails the acceptance test this was built for (an attached client sends a follow-up and the reply lands in the GUI). Observers already have a mechanism: replay. |
| *Serialize everything behind one lock.* | Correct but destructive: a long ACP turn would block the human's rename, which is precisely the interaction that produced the motivating bug. The point is to make the write *legible*, not to make it wait. |

**Recommendation.** Keep the conservative behaviour, and treat the remaining gap
as a product decision rather than a bug: there is currently **no way for a human
to grant an attached client authority over their turns**, and no way for a client
to ask for it. If driving a GUI session from outside turns out to be genuinely
useful — which is the bet this slice makes — the honest next step is a
**session lease**: an explicit, revocable, visible grant of turn ownership,
recorded in the log like every other decision, rather than an implicit one
inferred from who happened to be attached. Until then, an external client can
start turns of its own, watch everything, and rename or archive the session; it
cannot answer for the human or stop them.

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
| `_dsh/session/archive` | delegates to `ctx.workspaceController.archiveSession`; archive omits the session from `session/list`, `_dsh/session/list` brings it back |
| `_dsh/session/unarchive` | present, and refused as `unavailable` — DSH has no unarchive, so this plugin will not invent a second source of truth for it |
| `_dsh/session/fork` | present, and refused as `unavailable`. DSH's canonical fork copies a completed-turn prefix; a child created empty would not be the session the caller asked for |
| `_dsh/session/state` | the full state record, including which commands are admitted |
| `_dsh/events/replay` | `{sessionId?, after, limit?}` → events, `lastEventId`, `firstRetainedEventId` |
| `_dsh/log/info` | log position, size, cap, backend, connection count |

Plus the `_dsh/session/state_changed`, `_dsh/session/changed`, and
`_dsh/session/refused` notifications. The last is an **invention** — ACP does
not define how a refused notification is reported, because a notification has no
response channel. A standard client never sees it; an opted-in client may rely
on it; the log entry is the part that needs no permission.

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
# protocol, state machine, replay, plus durability and rollback against a log
# whose directory is deleted out from under a running plane
node plugins\dsh-acp-control\verify\core-checks.mjs        # 76 checks

# the same scenario over a real child process's pipes, driven by the official
# ACP client (the durability section needs the plane object, so it is in-process only)
node plugins\dsh-acp-control\verify\stdio-client.mjs       # 65 checks

# loopback HTTP+SSE: auth, the RFD's POST contract, the reconnect guarantee,
# cursor edge cases, and idempotency
node plugins\dsh-acp-control\verify\http-client.mjs        # 33 checks

# mounted in a live DSH profile, with the dsh backend and a real agent turn
node plugins\dsh-acp-control\verify\plugin-boot.mjs        # 12 checks
# attachment, against a fixture that owns an agent the way the GUI does
node plugins\dsh-acp-control\verify\attach-check.mjs       # 19 checks

# THE GATE: attachment inside the real web composition, both ends driven for
# real. Boots its own profile on its own ports; the running GUI is not touched.
# 21/22 — the one failure is deviation 7 in "Known deviations", and it is why
# the check exists.
node plugins\dsh-acp-control\verify\web-gate.mjs           # 22 checks
```

`core-checks.mjs` and `http-client.mjs` need nothing but Node. `stdio-client.mjs`
spawns a child with piped stdio, so it cannot run where that is denied.
`plugin-boot.mjs` needs the `acpctl` profile running (below).
`attach-check.mjs` and `web-gate.mjs` build and tear down their own throwaway
profiles, so they need nothing but a `DSH_HOME` and the network access a real
model turn needs. **Neither touches the running `dsh web`**: they bind other
ports, and they remove their profile and their session store entries afterwards.

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

The plugin is **not** in the running `dsh web` profile, and installing it is your
move rather than mine — loading it requires restarting `dsh web`, which would end
whatever sessions are live at the time. Everything up to that line is done and
verified; this is the only step left, and it is a decision about *when*.

To add it, follow this repository's install steps (`README.md`): place the
directory, junction it into `$DSH_HOME/profiles/web/node_modules/`, and list it
in the profile's bundles **after** `@deepseek-ai/dsh-base` — the backend needs
`ctx.agents`. Then restart `dsh web`; host `index.js` edits are not hot-reloaded.

### What to expect once it is loaded

This is the test the whole slice was built against, and it is worth running
exactly as written:

1. Open a session in the DSH web GUI and type a prompt there yourself. Watch it
   answer. (Nothing about this changes — adoption issues no command, so a
   session you are working in is untouched by the plugin being present.)
2. From an external ACP client, attach to **that** session by its DSH session id
   — `session/resume`, or `_dsh/session/state` to inspect it first.
3. Send a follow-up from the ACP client and watch the reply arrive in the GUI you
   are already looking at, in the same conversation, without reloading.
4. Both ends observe the same state transitions: `_dsh/session/state_changed`
   fires for the human's turns as well as the client's.

Adoption is on by default and can be turned off:

| Key | Default | Meaning |
| --- | --- | --- |
| `adoptLiveSessions` | `true` | adopt ordinary live sessions this plugin did not create, so an external client can attach to a session the GUI owns. With it off, the plugin only ever drives sessions it created itself — which is the whole of slice 1's behaviour, and useful if you would rather attach nothing until you have read the policy above. |

A session is adopted when its agent appears, when the plugin boots into a
process that already has live sessions, and on demand from `session/resume`.
Subagents are never adopted.

**If it goes wrong, the failure mode to look for** is a session that answers
`session/resume` with `cannot_attach` — that means the plugin is running
somewhere that cannot see live agents, i.e. it is not co-resident with the
session, and it is refusing rather than guessing. The other one is a refusal
naming a state: `{state, allowedIn, hint}` in `error.data`, which is the plugin
telling you exactly which state blocked it and how to get out of it.

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
