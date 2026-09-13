# dsh-acp-control — design

A control plane for DeepSeek Harness sessions, spoken over the Agent Client
Protocol. This document is the design; the reasoning behind each decision is
here rather than in the code, so the code can stay about mechanism.

Read this before the source. Every "why" below is a decision that was made
against an alternative, and the alternative is named.

---

## Read this first: status, known deviations, and what is invented here

Four things a reader should know before trusting anything below, because each
one is a place where this implementation is *not* simply "what the spec says".

### 0. The blocking product gap: this is discovery, not attachment

**Co-presence does not work yet, and it is slice 2's first job — ahead of the
stream fix below.**

`backend-dsh.js` discovers the GUI's sessions through
`sessionQuery.listSessions()`, but `server.js` marks them `backendOnly: true`,
gives them an artificial `closed` state, and never enters them into
`SessionRegistry`. Every mutating path starts at `registry.require(sessionId)`,
so a GUI-originated session cannot be resumed, prompted, renamed, archived,
forked or state-queried through this server. `SessionRegistry.recover()` only
rebuilds from *our own* `session.created` records, so a boot does not adopt
them either.

The topology is therefore **discovery-only**: this server can list the
sessions a human is working in and cannot touch a single one of them. A more
conformant controller that still cannot drive the session the human is looking
at misses the point of the project, which is why attachment outranks the
transport deviation below.

**The investigation is done, and the answer is that attachment needs no DSH
core change** — provided the plugin is co-resident in the same process as the
GUI. What the installed packages actually expose:

| Question | Answer |
| --- | --- |
| Does `ctx.agents` expose an already-live agent by session id? | **Yes.** `AgentRegistry.get(id: SessionId): Agent \| undefined`, plus `list()`, `roots()`, `isOwnedBy()`. There is no `attach()` that hands back a `dispose` handle for an agent you did not create — and that is the right shape, because a second controller must not be able to tear down the first one's agent. |
| What can the live `Agent` do? | `followup(message)`, `steer`, `inject`, `send`, `cancel(cause, options)`, `whenIdle()`, `runMaintenance`, and it carries `id`, `options`, `session`, `status: 'idle'\|'running'`, and **`ctx` — the agent-scoped Context**, which is the same object `setup` receives at create/resume time. So a scoped `agent.ctx.on('session/event', …)` subscription is available on an agent this plugin never created. |
| Who owns the live handle for a session the user opens? | `ctx.sessionController` (`@deepseek-ai/dsh-api-session-controller`, `super(ctx, "sessionController")`), whose private `ApiSessionAgentController` is the singleton authority: `resolveAgent(sessionId)` "deduplicating concurrent resumes", `ensureSession(...)` "creating or resuming it once". Its public face is `ctx.sessionController.resolveAgent(sessionId)` → `{agent} \| {error}`. |
| Is there a canonical mutation service? | **Mostly.** `sessionController.rename({sessionId, title})`, `.selectModel(...)`, `.prompt({requestId, mode, content})`, `.fork({sessionId, atSeq?})`, `.cancel(...)`; **access mode** via `ctx.planMode`, presets via `ctx.permissionPresets`; **archive** via `ctx.workspaceController.archiveSession({sessionId})` → `ctx.workspaceRegistry`, where it is a *workspace-scoped `archivedSessionIds` set*, not a session property. |
| Is there a canonical event stream? | **Two.** `ctx.sessionController.follow({address, maxMessages?, assistantStream?})` yields a `snapshot` frame carrying `{header, cursor, records, hasMore, projections}` followed by durable events and opted-in live assistant frames — the GUI's own transcript stream. Lower down, `ctx.on('session/event', …)` at the plugin fiber sees committed events for **all** sessions, including ones the plugin did not create; the third-party `dushaobindoudou/dsh-acp` relies on exactly that. |

Two consequences worth stating plainly, because both contradict something this
plugin currently implies:

- **`archive` is modelled wrongly today.** This plugin keeps an `archived` flag
  on its own session record; DSH keeps a workspace-scoped set of archived
  session ids. Two sources of truth for one fact is a bug regardless of which
  one is right, and it is recorded here rather than quietly left.
- **`delete` has no canonical implementation to delegate to.** There is no host
  "delete session" method — `WorkspaceDeleteRequest` deletes a *workspace* —
  and the only `_deleteSession` is private inside `dsh-session-query-sqlite`.
  So `session/delete` is necessarily plugin-local, and should be described that
  way rather than as parity with the GUI.

**Slice 2 item 1 is therefore: adopt live sessions into the registry, drive
them through `agent.followup`/`cancel`, observe them through `agent.ctx`, and
delegate mutations to the canonical services above — never disposing a handle
this plugin did not create.** A standalone HTTP server has no live agents and
must *refuse* to `resume()` a session the GUI holds, rather than guess: the
first-party server already throws `session is already active` in that case, and
this plugin should pre-check with `agents.get()` and refuse in its own words.

The one thing genuinely absent is a **policy seam**: nothing in DSH says what
should happen when two frontends drive one agent, so "who may prompt right now"
would be decided independently by each side. That is a design decision above
this plugin, and attachment is worth building without it — but it should be a
recorded decision rather than an accident.

### 1. Known deviation: the stream model (slice 2, and it is a real non-conformance)

**The ACP remote-transport RFD requires one connection-scoped stream *plus* one
session-scoped stream per session, all concurrently attachable**, and its
message-flow diagram shows them open together across the session lifecycle. A
connection-scoped stream carries what cannot be session-scoped — the responses
to `session/new` and `session/load`, which a client cannot receive on a stream
it does not yet have an id for — while session-scoped streams carry that
session's updates, permission requests, and the responses to its POSTs.

**Slice 1 serves one stream per connection, with an optional `?session=`
filter.** That is not the RFD's model, and it is not a matter of taste: a client
that follows the RFD and opens both at once gets its session stream replaced by
its connection stream, and stops receiving that session's responses. Nothing in
slice 1's checks catches this, because they attach one stream at a time.

Slice 1 shipped this way deliberately — one stream was enough to build and
demonstrate the replay guarantee, which is the part the RFD does not provide —
but it is a defect against the transport spec, it is the **first** item of slice
2, and it is recorded here rather than discovered later. See §7 for the current
behaviour and what the fix touches.

### 2. Which ACP surface is stable, and one trap

| Surface | Status | What this plugin does |
| --- | --- | --- |
| `session/list`, `resume`, `close`, `delete`, `set_config_option`, `set_mode` | **Completed** | uses the stable method where implemented; refuses the rest by name |
| session config options, message ID, `$/cancel_request` | **Completed** | message ids are carried; `$/cancel_request` is honoured |
| `session_info_update` | **Completed** | rename's *effect* is published on it (§4) |
| session fork | **Draft** (2025-11-20) | kept in `_dsh/`; see the trap below |
| v2 prompt lifecycle | **Draft** (2026-04-23) | not used |
| Streamable HTTP & WebSocket transport | **Active**, targets v1, does not replay in-flight messages and defers resumability to v2 | transport shape followed; replay added here (§5) |

**The trap:** `AGENT_METHODS.session_fork = "session/fork"` is present in the
schema that ships with `@agentclientprotocol/sdk` 1.4.0, so the next person to
read that file will conclude fork is stable and promote it. It is not: the
constant is marked unstable, sits behind the `unstable_session_fork` feature
flag, and ships in the **unstable** schema artifact, whereas the stable v1
schema contains only completed features. **The RFD status is authoritative, not
the presence of a method constant.** Fork therefore stays in `_dsh/`, and this
plugin does not advertise it in `sessionCapabilities`.

### 3. Two things here are inventions, not spec-sanctioned mechanisms

Labelled because an unlabelled invention reads as a guarantee.

- **Refusing a notification (§2, §4).** A JSON-RPC notification has no response
  channel, so when a client sends `session/cancel` in a state that refuses it,
  there is **no in-band way to answer**. The spec is silent on the case; it does
  not address it and it does not forbid what is done here. Two mechanisms stand
  in: every refusal is appended to the log as `session.refused` (an audit trail,
  which needs nobody's permission), and — this plugin's own addition — an
  opted-in client additionally receives `_dsh/session/refused` so it learns of
  the refusal when it happens rather than only on replay.
- **The SSE `id:` field as the replay cursor (§5).** The RFD does **not** define
  event ids in v1. It defers them to v2, where streamed chunks carry an id
  described as a "last replay ID" for retry and resumption. So the field is
  unclaimed today and points where v2 is going — the good case — but v2 could
  still assign it a different meaning. The exposure is contained in
  `lib/cursor.js` (§5).

---

## 1. The gap this fills

Two ACP servers for DSH already exist, and neither closes the hole this plugin
is aimed at.

**First-party `@deepseek-ai/dsh-acp`** (v0.1.5-rc.2, installed in this
profile) is a stdio-only automation transport. Its own README lists what it
does not do: *"No transcript replay or interactive extensions — session
deletion, fork, `session/load`, modes, commands, plans, terminals, client
filesystem operations, and elicitation remain outside this automation
surface."* `session/resume` is documented as restoring the log **"without
replaying old updates"**. There is no remote transport at all.

**Third-party `dushaobindoudou/dsh-acp`** adds a standalone HTTP+SSE endpoint
plus a web-mounted mode, and a read-only `dsh/*` extension namespace
(`dsh/sessions/list`, `dsh/sessions/read`, `dsh/jobs/list`, `dsh/goals/list`,
`dsh/skills/list`, `dsh/agents/tree`, `dsh/sessions/watch`). This is the
closest prior art and it is good work. Where it stops is what this design is
about — see §8.

**ACP itself does not solve resync.** The Streamable HTTP & WebSocket
Transport RFD is still Active, targets v1, and states that in-flight messages
are explicitly **not** replayed, with resumability deferred to v2. So a client
that drops its connection and comes back misses everything emitted while it was
gone, and nothing in the protocol tells it that it missed anything.

A control plane is where that is fixable, because the control plane owns the
event stream. Hence this plugin.

### What "control plane" means here

The ACP server is not the agent. It is the process that *admits commands
against a session, records what happened, and can replay it*. That framing is
what makes the state machine and the event log first-class rather than
bolt-ons.

---

## 2. Command / event model

Three nouns, and everything else follows.

| Noun | What it is |
| --- | --- |
| **Command** | A request to change a session. One ACP method, or one `_dsh/…` method. |
| **State** | Where a session is right now. Exactly one per session, always. |
| **Event** | An immutable, ordered record that something happened. |

The rule that ties them together:

> **Nothing changes a session except an admitted command, and no admitted
> command is ever silent.**

Concretely, every command produces **exactly one** of two observable outcomes:

- **Accepted** — the effect happens *and* at least one event is appended to
  the log **by that command's own effect**, and that event is **on disk**; or
- **Refused** — a structured error is returned naming the state that blocked
  it, the states it would have been allowed in, and the current log position.

There is no third outcome. There is no path where a command returns success
and the effect was dropped, and no path where a command fails without saying
why in machine-readable terms.

This is the whole point. DSH's own rename dialog once accepted text and
silently discarded it while a session was generating; that is a *third
outcome* — accepted-and-discarded — and this model has no room for it. A
refusal is a first-class, logged, replayable record, not an absence.

### What "accepted" is now measured to mean

Two words in the paragraph above are load-bearing, and an earlier revision
used both of them loosely. Both are now enforced and checked.

**"by that command's own effect."** The check used to be a counter of events
appended for the session. But every command with a state edge appended its edge
event *before* running its effect, so `prompt`, `cancel`, `close`, `delete` and
`resume` all satisfied the check **vacuously** — the counter had already moved
before their effects did anything. Worse, `cancel`'s effect committed nothing
at all and was passing purely on its edge.

Each admission now opens a *command scope* with a unique id. Only events the
effect itself commits count toward it; the automatic edge event is appended
outside the scope. Every event carries `commandId` in the log, so the log
answers "which command produced this" rather than leaving it to be inferred.
Commands whose effects genuinely changed nothing had to start recording
themselves: `session/cancel` now appends an explicit `session.cancel`.

**"on disk."** `EventLog.append` only *queues* a write. Success used to be
reported as soon as the event was in memory and on the wire, so a rename could
return success, reach every live client, advance every cursor, and be gone
after a restart — the durability claim was simply false. Success now means the
events are written: `admit` awaits the write before answering.

That, in turn, is why effects order themselves **append → await durability →
mutate**. Awaiting durability *after* mutating would leave the failure mode
exactly where it was: a reported failure with the effect applied. The check
proves this rather than asserting it — it deletes the log's directory out from
under a running control plane and asserts that a rename fails *and* that the
title is unchanged (`verify/core-checks.mjs`).

The two places that deliberately do **not** wait are named in the code: the
turn's return edge (`generating` → `idle`), because the turn is over and
stranding the session would be worse than a state change that outlives a log
entry; and streaming `session/update` events, whose durability is confirmed
once, at turn settlement, rather than per chunk.

Every read is exempt in the opposite direction: `_dsh/session/state` is a
read-only command that commits nothing at all. It used to append a
`{read: true}` event, which bumped the session's `updatedAt` and could
therefore reorder `session/list` — polling a session made it look active.

### Sessions are state machines

| State | Meaning |
| --- | --- |
| `idle` | No turn in flight. The resting state. |
| `generating` | A prompt turn is running. |
| `awaiting_permission` | The running turn is blocked on a client permission decision. |
| `cancelling` | Cancellation accepted; the turn is winding down. |
| `closing` | Teardown in flight. |
| `closed` | Terminal. The session may be resumed or deleted. |
| `failed` | Terminal-by-error. Close, delete, or resume. |

### The transition table

`—` means the command is refused in that state, with a refusal naming it.

| Command | ACP method | idle | generating | awaiting_permission | cancelling | closing | closed | failed |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `prompt` | `session/prompt` | ✅ | — | — | — | — | — | — |
| `cancel` | `session/cancel` | — | ✅ | ✅ | — | — | — | — |
| `close` | `session/close` | ✅ | ✅ | ✅ | ✅ | — | — | ✅ |
| `delete` | `session/delete` | ✅ | — | — | — | — | ✅ | ✅ |
| `rename` | `_dsh/session/rename` | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| `archive` | `_dsh/session/archive` | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| `unarchive` | `_dsh/session/unarchive` | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| `fork` | `_dsh/session/fork` | ✅ | — | — | — | — | — | — |
| `state` | `_dsh/session/state` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

Two entries deserve their reasons stated, because both are decisions against
the obvious alternative:

- **`rename` is allowed *during* `generating`.** The tempting fix for the
  silent-discard bug is to forbid rename while generating. That is the wrong
  fix: it makes a legitimate, independent metadata write fail for a reason the
  user cannot act on. A title is not part of the turn. Rename is allowed in
  every non-teardown state, and `prompt` is the only command that is
  exclusive. The bug was never that rename was *allowed* — it was that rename
  was *silent*. §2's rule is what fixes it.
- **`fork` is `idle`-only.** A fork must cut the log at a settled turn
  boundary; the draft fork RFD forks a *completed-turn prefix*. Mid-turn there
  is no such boundary, so the refusal says so rather than picking one.
- **`delete` is not `generating`.** Deleting a session while the agent is
  still writing to it is how you get orphaned writes. Cancel or close first;
  the refusal names the state and the way out.

### Refusal shape

A refusal is a JSON-RPC error whose `data` is the machine-readable part:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": {
    "code": -32003,
    "message": "_dsh/session/fork is not allowed while the session is generating",
    "data": {
      "type": "refused",
      "command": "_dsh/session/fork",
      "sessionId": "acp-3f9c…",
      "state": "generating",
      "allowedIn": ["idle"],
      "eventId": 41,
      "reason": "a fork needs a settled turn boundary; this session has a turn in flight",
      "hint": "wait for the turn to end, or session/cancel first"
    }
  }
}
```

- `code` is `-32003`, in the implementation-defined server-error range
  (`-32000…-32099`). It is **not** `-32602 invalid params`: a refusal is not a
  malformed request, the request was perfectly well formed and the *world*
  said no. Conflating the two is how "invalid input" and "wrong time" get
  confused in a UI.
- Clients must discriminate on `data.type === "refused"`, never on the numeric
  code alone, so the code can change without breaking them.
- `eventId` is the log position at refusal time. The refusal itself is also
  appended as a `session.refused` event, so a client that never saw the RPC
  response still learns about it after reconnecting.

### Serialization

Commands against one session are serialized through a per-session promise
chain. Two commands can never interleave inside a session, so the state read
by the transition check is the state the command's effect runs in. Concurrent
`prompt` calls therefore produce one `generating` and one refusal, not two
racing turns.

---

## 3. ACP method mapping

Against the stable v1 schema shipped with `@agentclientprotocol/sdk` 1.4.0
(`schema/schema.json`, `PROTOCOL_VERSION = 1`), read from the installed copy.

### Implemented — stable ACP

| Method | Kind | Notes |
| --- | --- | --- |
| `initialize` | req | Returns `protocolVersion: 1`, `agentInfo`, `agentCapabilities`, `authMethods: []`. |
| `session/new` | req | Creates a session in `idle`; returns `sessionId`. |
| `session/list` | req | Newest-first; optional absolute `cwd` filter; includes `title` and `updatedAt`. |
| `session/resume` | req | Reopens a persisted session; does **not** replay (`session/load`'s job, and see §4 for why the replay is a client-driven cursor instead). |
| `session/close` | req | Quiescent teardown; the session stays listable and resumable. |
| `session/delete` | req | Removes the session. |
| `session/prompt` | req | `idle` → `generating`; streams `session/update`; resolves with a stable `stopReason`. |
| `session/cancel` | **notification** | `generating`/`awaiting_permission` → `cancelling` → `idle`. |
| `session/update` | notification (agent→client) | `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `session_info_update`, `usage_update`. |
| `session/request_permission` | req (agent→client) | Drives the `awaiting_permission` state. |

Advertised capabilities are exactly what is mounted:

```json
{"sessionCapabilities": {"list": {}, "resume": {}, "close": {}, "delete": {}}}
```

Nothing is advertised that is not implemented. `session/fork` is deliberately
**not** in that object — see below.

### Stubbed — accepted, then refused with a named reason

| Method | Response |
| --- | --- |
| `session/load` | `-32601` with `data.type: "unimplemented"`, naming `_dsh/events/replay` as the supported path. Replay is a cursor, not a load. |
| `session/set_mode` | `-32601`, `unimplemented`. Modes are not modelled in slice 1 (the first-party server omits them too). |
| `session/set_config_option` | `-32601`, `unimplemented`. |
| `authenticate` / `logout` | `-32601`. The plugin authenticates its *transport*, not the ACP session; there is no `authMethods` entry to satisfy. |
| `fs/*`, `terminal/*`, `elicitation/*` (client→agent directions) | Not implemented; the corresponding capabilities are not advertised, so a conforming client never calls them. |

Every stub returns a structured `data.type`, never a bare error string, so a
client can render "not supported here" differently from "you sent garbage".

---

## 4. `_dsh/…` extensions

ACP has no stable surface for rename, archive, or fork-shaped operations. The
two candidates were: (a) wait for ACP, or (b) extend. Waiting is not viable —
the fork RFD has been Draft since 2025-11-20 and v2 is a moving target — so
this plugin extends, under a namespace that is deliberately shaped like the
draft RFDs so migration is mechanical when they stabilise.

| Method | Params | Returns | Draft RFD it mirrors |
| --- | --- | --- | --- |
| `_dsh/session/rename` | `{sessionId, title}` | `{sessionId, title, eventId}` | Session Info Update; also emits the **stable** `session_info_update` update |
| `_dsh/session/archive` | `{sessionId, archived?}` | `{sessionId, archived, eventId}` | — (no ACP equivalent; DSH concept) |
| `_dsh/session/unarchive` | `{sessionId}` | `{sessionId, archived, eventId}` | — |
| `_dsh/session/fork` | `{sessionId, atEventId?}` | `{sessionId, forkedFrom, headEventId}` | Forking of existing sessions (Draft 2025-11-20) |
| `_dsh/session/state` | `{sessionId}` | full state record | — |
| `_dsh/events/replay` | `{sessionId?, after, limit?}` | `{events[], lastEventId, firstRetainedEventId}` | v2 Session Resume Replay (Draft) |
| `_dsh/log/info` | `{}` | `{lastEventId, firstRetainedEventId, path, bytes}` | — |

Plus one notification:

| Notification | Payload |
| --- | --- |
| `_dsh/session/state_changed` | `{sessionId, from, to, command, eventId, actor}` |
| `_dsh/session/changed` | `{sessionId, changed, archived, actor, eventId}` |
| `_dsh/session/refused` | `{sessionId, command, state, allowedIn, reason, actor, eventId}` |

**`_dsh/session/refused` is an invention.** A JSON-RPC notification has no
response channel, so a refused notification cannot be answered in-band. The spec
does not address the case. Sending this notification is therefore this plugin's
own mechanism, not something ACP sanctions — an opted-in client may rely on it,
a standard client is unaffected (it never sees `_dsh/*`), and a client that
wants only what the spec guarantees has the log entry. Both halves are asserted
in `verify/`: the refusal is recorded, *and* it reaches an opted-in client
in-band, *and* it reaches a non-opted-in client not at all.

**Why `_dsh/` and not `dsh/`.** The third-party plugin already uses the bare
`dsh/` namespace for different methods with different shapes. Two
incompatible things must not claim one namespace; the leading underscore
matches ACP's own convention for reserved/extension space (`_meta`,
`$/cancel_request`). It also means a client can detect this plugin's
extensions with a single prefix test that cannot false-positive on the other
plugin's methods.

**Rename emits stable ACP, not just the extension.** `session_info_update`
with `{title}` is in the stable schema ("Completed — Session Info Update").
So `_dsh/session/rename` is a *command*, and its *effect* is published on the
stable wire: any client that understands `session_info_update` sees the rename
even if it has never heard of `_dsh/`. The extension exists only because
stable ACP has no **client→agent request** for setting a title — the stable
surface only lets the agent announce one. This is the "use stable where it
covers the operation" rule applied honestly: stable where it reaches, an
extension only for the reach it lacks.

**Opt-in.** `_dsh/…` and `_dsh/…` notifications are only sent to connections
that opt in through the schema-sanctioned extension point:

```json
{"clientCapabilities": {"_meta": {"dsh-acp-control/extensions": true}}}
```

A standard client never sets `_meta`, never receives `_dsh/*` notifications,
and is never surprised. (`_meta` is an official `record<string, unknown>` on
`ClientCapabilities`; the key is namespaced to this plugin so the two DSH ACP
plugins cannot collide.)

---

## 5. Event log and replay

### The log

One process-wide append-only NDJSON file, `<dataDir>/events.jsonl`:

```json
{"eventId":41,"sessionId":"acp-3f9c…","ts":"2026-05-04T10:22:31.004Z",
 "actor":"human:zed","type":"session.update","data":{…},
 "frame":{"jsonrpc":"2.0","method":"session/update","params":{…}}}
```

- **`eventId` is a single global monotonic counter**, starting at 1, shared by
  every session. Per-session counters were rejected: the connection-scoped
  stream would then need a second ordering, and two orderings is one too many.
  Sessions are distinguished by the `sessionId` field, and a session-scoped
  replay is the same query with a filter.
- **`frame`, when present, is the exact ACP frame that was put on the wire.**
  Replay re-emits stored frames verbatim rather than re-deriving them from
  `data`. Re-deriving would mean the replay path could drift from the live
  path; storing the frame makes them the same bytes by construction.
- Records with no wire representation (state transitions, refusals, archive
  flags) have no `frame` and are not re-emitted. Their `eventId`s are still
  consumed, so SSE `id:` values may legitimately skip — the cursor is a log
  position, not a frame counter.
- The log is flushed on every append. A crash costs at most the in-progress
  write, never a committed event.
- On boot the log is read back and replayed into the registry: `session.created`
  rebuilds the session, `session.title` its title, `session.archived` its flag.
  So the log is not a side-channel — it is the durable truth about sessions.

### Replay — attach after event N

Three equivalent ways to name the cursor, in precedence order:

| Source | Example |
| --- | --- |
| `?after=` query param | `GET /acp/stream?after=40` |
| `Last-Event-ID` header | sent automatically by a browser `EventSource` on reconnect |
| `after: -1` | "I want everything from the beginning" (the OpenHands convention) |

The server then: replays every retained event with `eventId > after` that has
a `frame`, in `eventId` order, **and only then** switches that stream to live
delivery — with the live tail buffered during the replay and spliced after it,
so an event emitted mid-replay cannot overtake the backlog or be dropped.

**Nothing missed, nothing duplicated** falls out of one property: the cursor
is the last `eventId` the client actually received, the client advances it
only on receipt, and the server resumes *strictly after* it. Replay is an
idempotent function of `(log, cursor)`. There is no window where an event is
neither replayed nor live-delivered, because the switch is a splice under the
same lock that appends.

**A gap is announced, never silent.** If `after` is below the log's retained
floor, the client gets a `_dsh/log/gap` notification naming
`firstRetainedEventId` before the replay starts, so it knows to re-fetch
rather than silently rendering a transcript with a hole in it. Slice 1 never
truncates, so the floor is always 1 — the mechanism exists so that adding
retention later cannot silently regress the guarantee. Symmetrically, when
the log hits `maxLogBytes` the plugin emits `log.exhausted` once and *refuses*
further mutations with that reason, rather than dropping events to stay under
the cap.

### What the replay guarantee does and does not cover

The claim, stated precisely, because the loose version of it was too strong:

> **Gapless for logged event frames, across a transient stream disconnect,
> within one process.** A client that names the last `eventId` it received gets
> every subsequent logged frame, in order, exactly once.

It is **not** exactly-once delivery of commands, and the following are outside
it. Each is listed with what happens instead, so the gap is a known bound
rather than a surprise:

| Not covered | What happens |
| --- | --- |
| **Duplicate command delivery.** A client that resends `session/prompt` because it never saw the response used to run a *second turn* — the first had already returned the session to `idle`, so the retry was admitted rather than refused. | **Fixed for clients that opt in.** A client-minted key in `params._meta["dsh-acp-control/idempotency-key"]` makes a repeat re-observe the first outcome instead of re-running it, including while the first is still in flight. Keys are cached per session, bounded at 256, evicted oldest-first. DSH's own session API carries the same idea in `SessionPromptRequest.requestId`, so this is the ecosystem's shape rather than an invention. A client that sends no key gets no protection. |
| **Outstanding `session/request_permission` frames.** The permission *event* is logged, but the JSON-RPC request frame is transient — replaying it would ask a reconnected client to answer a question it may have already answered. | The **state** carries the truth: a reconnecting client sees `awaiting_permission` in `_dsh/session/state`, and the permission event in the log. It cannot re-answer the prompt, which is the honest outcome — the turn is still parked on the original client. |
| **Long-running prompt responses.** A `session/prompt` response is produced at turn settlement and written straight to the reply channel, not to the log. If the stream dies mid-turn, the response frame is lost with it. | The turn's *events* are all in the log, so a reconnecting client can see exactly what happened; what it cannot recover is the correlated `stopReason` for that one request. A client that needs the outcome should re-issue the prompt with an idempotency key. |
| **A cursor ahead of the log.** A crash that lost the tail of the file, or a restart against a different data directory, leaves a client holding a cursor *above* the recovered high-water mark. It would be told "nothing to replay", receive only new events numbered above its cursor, and silently never see the missing ones. | **Fixed.** `cursor.js#classifyResume` reports `ahead_of_log` and the client is sent a `_dsh/log/gap` with `reason: "ahead_of_log"` and the current `lastEventId`, so it knows its position is stale rather than current. `_dsh/events/replay` reports the same in its `gap` field. This was the one gap that *looked* like success, which is why it was worth closing rather than documenting. |
| **Log retention.** Slice 1 never truncates, so the retained floor is always 1. | Nothing is dropped, and the `below_floor` gap notice exists so that adding retention later cannot silently start losing a client's events. |



The RFD does not define event ids in v1; it defers them to v2, where streamed
chunks carry an id described as a "last replay ID" for retry and resumption.
Using the SSE `id:` field as the log position is therefore **unclaimed today and
pointing the same way v2 is going** — the good case — but it also means v2 could
assign the field a meaning that differs from ours.

All cursor semantics live in `lib/cursor.js`: `readCursor` (precedence between
`?after=`, `Last-Event-ID`, and "everything"), `encodeEventId` (what goes in
`id:`), `decodeCursor`, `isAfter`, and `hasGap`. The transport calls those and
never parses a cursor itself. If v2 redefines the id as an opaque token rather
than a log position, the change is confined to that file — `transport-http.js`
keeps calling the same functions, and the log keeps its own monotonic
`eventId`.

Deliberately *not* abstracted: the fact that the cursor is a log position at
all. Hiding that behind an opaque cursor type today would be ceremony for a
problem that does not exist yet, and it would make the replay guarantee harder
to read — which is the one thing this design cannot afford.

Every attach also logs which channel supplied the cursor (`cursor from query`,
`last-event-id`, or `none`), because "which channel did the client use" is the
difference between diagnosing a stuck reconnect and guessing at it.

### Why an event log rather than replaying the transcript

`session/load` semantics (re-derive updates from the session log) were
rejected as the resync mechanism because they answer the wrong question: they
reconstruct a *conversation*, not the *client's position in a stream*. A
reconnecting client needs "everything since event 41", which includes a
refusal, a title change, and a state transition — none of which are
conversation. The OpenHands WebSocket API's `latest_event_id` is the pattern:
the client names the last event it saw, the server continues from there. This
plugin implements that pattern over SSE, where the browser supplies the cursor
for free.

---

## 6. Actor identity

Every mutation and every emitted event carries an `actor`. There is no
anonymous write.

| Actor | When |
| --- | --- |
| `human:<client>` | A command from an ACP connection. `<client>` is the slugged `clientInfo.name` from `initialize` (`human:zed`, `human:acp-chat`), falling back to the transport when absent (`human:stdio`, `human:web`). |
| `agent:<sessionId>` | Effects the agent produced inside a turn — streamed message chunks, tool calls, turn endings. |
| `system:acp-control` | Plugin lifecycle: boot recovery, log exhaustion, gap announcements. |

The actor rides the wire in the schema-sanctioned `_meta` of every
notification this plugin emits:

```json
{"sessionId":"acp-3f9c…","update":{…},"_meta":{"actor":"agent:acp-3f9c…","eventId":42}}
```

Two reasons this matters beyond bookkeeping. It is what lets a client render
"you renamed this" differently from "the agent titled it" — DSH does both, and
today a title can appear from either with no way to tell which. And it is the
minimum needed to make the log auditable: `grep '"actor":"human:web"'` answers
"what did the web client change", which is unanswerable from a transcript
alone.

---

## 7. Transports

One protocol core, two transports. The core (`lib/server.js`) dispatches
methods against an abstract connection that can `send`, `notify`, and
`request`; neither transport knows what a session is.

### stdio — the established path

NDJSON JSON-RPC on stdin/stdout, one JSON object per line. **stdout carries
protocol frames and nothing else**; all logging goes to stderr, because a
stray `console.log` corrupts the stream. This is the path editors use.

### Loopback HTTP+SSE — the remote path

Follows the Streamable HTTP & WebSocket Transport RFD's shape (it is the
future stable path), and adds the replay layer the RFD defers.

```
POST   /acp        one JSON-RPC message
                     initialize            → 200 + JSON body + Acp-Connection-Id
                     everything else       → 202 Accepted (response arrives on the stream)
GET    /acp/stream SSE; ?after= / Last-Event-ID / ?session= / ?connection=
DELETE /acp        close the connection
GET    /healthz    liveness, unauthenticated, no data
```

#### Deviation from the RFD: one stream per connection, not one-per-connection plus one-per-session

The RFD requires **one connection-scoped stream plus one session-scoped stream
per session, concurrently attachable**, and shows them open together across the
lifecycle. Slice 1 instead serves **one stream per connection**, with an
optional `?session=` filter to scope it.

Why this is a defect and not a simplification: a client that follows the RFD
opens both at once, and the second attach replaces the first — so its
connection-scoped stream (which carries the `session/new` response it cannot
get anywhere else) is torn down by its session stream. It then stops receiving
responses, and nothing tells it why.

Why it shipped anyway: one stream is sufficient to build and demonstrate the
replay guarantee, which is the part the RFD does *not* provide and therefore the
part slice 1 exists to prove. The checks attach one stream at a time and so do
not catch it.

What the fix touches, recorded now so slice 2 starts from the shape rather than
rediscovering it: `SseConnection` holds a single `stream` field and must hold a
set keyed by scope (`connection` plus zero or more `sessionId`s); `send` must
fan out to the matching scopes instead of filtering one stream by session;
`attachStream`'s "a re-attach replaces the previous stream" rule must become
"a re-attach replaces only the stream with the same scope"; and the reaper and
`close()` must count streams rather than connections. The cursor and replay
logic is already per-stream and needs no change — which is the main reason the
replay layer was worth building first.

**Slice 2, item 1.**

**Auth is Goose's pattern**, because Goose shipped it and it is the shape that
actually works for browsers:

- bind **loopback by default** (`127.0.0.1`); a non-loopback bind is an
  explicit opt-in,
- a **random shared secret** generated at boot when none is configured, and
  printed to stderr so an operator can find it,
- **`X-Secret-Key`** header for HTTP clients,
- **`?token=`** query parameter as well, because a browser's `EventSource` and
  `WebSocket` cannot set request headers — the same constraint Goose hit,
- compared with `crypto.timingSafeEqual`, never `===`,
- `401` and nothing else when absent or wrong.

`?token=` is accepted on every authenticated route, not only the stream,
because a browser page that holds the token has no way to attach a header to
the stream request specifically.

---

## 8. What this deliberately does differently from `dushaobindoudou/dsh-acp`

The prior art is the closest thing to this plugin, so the differences are
worth naming precisely rather than implying.

| | prior art | this plugin |
| --- | --- | --- |
| **Replay** | `pending[]` buffers frames *before the first SSE attach only*. After a disconnect, events emitted during the gap are gone, and the client is not told. | Append-only log with a monotonic global `eventId`; SSE frames carry `id:`; reconnect replays strictly after the cursor. Gaps are announced. |
| **Refusals** | `entry.prompting` boolean → `RequestError(-32602, 'a prompt is already in flight for this session')`. One guard, one message. | Explicit 7-state machine + transition table. Every refusal carries `{state, allowedIn, eventId, hint}`. Refusals are logged. |
| **Actor** | Absent. | Every mutation and event stamped; rides the wire in `_meta`. |
| **Session state** | Implicit in booleans (`prompting`). | Explicit, queryable (`_dsh/session/state`), change-notified. |
| **Durability** | In-memory table; a restart loses the session table (DSH persistence still has the sessions, but not the ACP view). | The log is replayed into the registry at boot, so the ACP view survives a restart. |
| **Auth** | `Authorization: Bearer <token>`. | `X-Secret-Key` + `?token=`, loopback default, timing-safe compare — the Goose pattern. |
| **Namespace** | `dsh/…`, read-only. | `_dsh/…`, mutating, deliberately disjoint. |
| **Dependencies** | `@agentclientprotocol/sdk`, `@deepseek-ai/dsh-*`. | Zero new runtime dependencies: `node:` builtins plus the Cordis/Schemastery peers every plugin in this repo already uses. The ACP wire is implemented directly against the stable v1 schema. |

The last row deserves its reason. The SDK is a fine library, but this plugin's
subject matter — cursors, log positions, refusals, a transport-independent
core — is entirely outside what the SDK models. The SDK's `onRequest` is typed
as a closed union of standard methods (the prior art has to cast around it to
register `dsh/*` at all), and its connection layer is per-connection with no
notion of a resumable position. Implementing the ~200 lines of JSON-RPC
framing directly buys an exact fit and keeps the plugin installable with no
`npm install` step, which is what the rest of this repo does.

Where the SDK *is* used is verification — as an independent, reference ACP
**client** driving this server. That is a stronger check than using it as the
server, because agreement between two independent implementations is evidence,
while agreement between a library and itself is not.

---

## 9. Verification

The claim is not "this should work". The checks are in `verify/`, each produces
a transcript, and each one found at least one real bug.

| Check | What it drives | Result |
| --- | --- | --- |
| `verify/core-checks.mjs` | the scenario below plus the durability/rollback section, over the real `serveStdio` on in-process pipes | **65/65** |
| `verify/stdio-client.mjs` | the same scenario, over a real child process's OS pipes (the durability section needs the plane object, so it runs only in-process) | **58/58** |
| `verify/http-client.mjs` | the loopback HTTP+SSE transport from real `fetch` calls on a real socket | **32/32** |
| `verify/plugin-boot.mjs` | the plugin mounted in a live DSH profile, `dsh` backend, a real agent turn | **12/12** |

**The client is the reference implementation, not this plugin's own code.** The
scenario is driven by `@agentclientprotocol/sdk` — deliberately, because this
server implements the ACP wire directly (for the reasons in §8). Agreement
between two independent implementations is evidence; agreement between a
library and itself is not. The SDK is a *verification* dependency only.

What the stdio scenario asserts, in order of importance:

1. **The anti-silent-discard invariant, over a state × command matrix.** Every
   accepted command must advance the log *by its own effect*; every rejected
   one must be a structured refusal carrying `data.state` and `data.allowedIn`.
   A command that returns success without moving `lastEventId` fails the check.
2. **Durability and rollback, against a log that is genuinely broken.** The
   check deletes the event log's directory out from under a running control
   plane and asserts that a rename fails with `durability_failed`, that the
   failure does *not* claim the effect was applied, and — the part that matters
   — that **the title is unchanged**. No mock and no stubbed `appendFile`: the
   write fails with a real `ENOENT`.
3. `_dsh/session/rename` is **accepted mid-turn** and its `session_info_update`
   reaches the client while the turn is still running — the deliberate design
   choice of §2, asserted rather than asserted-about.
4. `session/request_permission` parks the session in `awaiting_permission`, and
   that state is observable *while the question is outstanding* (the check's
   client deliberately delays its answer, because an instant answer would make
   the window unobservably short and prove nothing).
5. `session/cancel` settles the prompt with `stopReason: "cancelled"`, and a
   cancel is recorded as its own `session.cancel` event.
6. **A read writes nothing.** `_dsh/session/state` appends no event and does not
   move `updatedAt`, and it reports the commands the state admits.
7. **The idempotency key.** A prompt retried with the same key returns the same
   stop reason and runs **no second turn**; a different key does run one.
8. **A cursor ahead of the log is reported**, not treated as "nothing to
   replay".
9. Refusals are **logged**, so a client that never saw the response still
   learns of it: the check provokes a refusal and then reads `session.refused`
   back out of the replay.
10. `_dsh/events/replay` returns exactly the events after a cursor, and is
    idempotent for a repeated cursor.

What the HTTP check asserts:

1. Auth: `/healthz` unauthenticated; `401` with no secret, a wrong
   `X-Secret-Key`, and a wrong `?token=`; `?token=` accepted on the stream,
   which is the channel a browser actually has.
2. The RFD's POST contract: `initialize` → `200` + body + `Acp-Connection-Id`;
   everything else → `202`, with the response arriving on the stream correlated
   by JSON-RPC id.
3. `?after=N` replays strictly after N, then goes live.
4. **The reconnect guarantee.** A stream is dropped mid-turn; the client
   reconnects with the standard `Last-Event-ID` header; the union of what it saw
   before the drop and what it got after contains every emitted frame exactly
   once. Measured over `curl` against a live standalone server: `?after=40`
   replayed ids `41, 42, 44, 45, 47` — precisely the frames after 40, with the
   frame-less log positions skipped — and `Last-Event-ID: 45` replayed `47`
   alone.
5. **The extension gate holds on both paths.** A client that opts into `_dsh/`
   receives `_dsh/session/refused` in-band for a refused command; a client that
   does not opt in receives the same refusal as an ordinary JSON-RPC error and
   **no `_dsh/*` frame at all**.

What the profile check asserts: the plugin mounts inside DeepSeek Harness and
answers `initialize` with `backend: "dsh"`; `session/list` returns the **live
session store's** sessions (17 of them, with titles, on the run that was
recorded) rather than a fixture; `session/new` composes a real agent through
`ctx.agents.create`; and a real prompt turn completes with the model's streamed
output reaching the client. The log survives a restart: the same check's second
run recovered 18 events from the first and continued from `eventId` 19.

### What the checks found

Recorded because the point of a check is the bugs it catches, not the green
ticks:

- **The registry's live-frame sink was never wired.** `SessionRegistry`
  delivers through a sink that has to reach the control plane, constructed
  *after* it. A snapshot left the registry writing into a dead callback: every
  command committed, `lastEventId` advanced, every log-based assertion passed,
  and **no notification ever reached a client**. Caught only because a check
  asserted on what the client *received*.
- **Serializing a turn on the session queue deadlocks `session/cancel`.**
  §2's serialization is right for admission and wrong for the turn; the model
  was split accordingly.
- **The `dsh` adapter translated an event this build does not emit.**
  `assistant/chunk` does not exist here — the vocabulary is the committed
  `assistant/message`, per the README's notes. The turn ended `end_turn` with
  no output, which is the silent no-op this design is against, occurring inside
  the plugin itself. Caught only by running it against a live profile.
- **A "dropped" stream that was never dropped.** `fetch` ignores an
  `AbortController` whose `signal` was not passed, so the reconnect check had
  two readers on one connection and reported duplicates the server had not
  produced.
- **Shutdown hung on long-lived SSE sockets**, because `server.close()` waits
  for connections to go idle and a stream never does.
- **The extension filter was applied only where frames were broadcast, not
  where they were replayed.** A standard client that reconnected was handed the
  entire `_dsh/*` history — a protocol violation, since it had never opted in
  and is entitled to treat an unknown method as one. The gate now lives on the
  connection (`Connection#allowsFrame`) and both paths call it, so there is one
  copy of the policy rather than two that agree by luck.
- **A stale stream's `close` handler cleared the *new* stream.** Re-attaching
  ends the previous response and installs a new one; the old response's `close`
  then fired and set `this.stream = undefined` unconditionally. Replay kept
  working — it writes straight to the response — so the symptom was a client
  that reconnected, received its backlog, and then went **silently deaf** to
  every live frame. This one would have hit real clients on every reconnect.

---

## 10. Slice 1 boundaries

Implemented: stdio transport; loopback HTTP+SSE with token auth; `initialize`,
`session/new`, `session/list`, `session/resume`, `session/close`,
`session/delete`, `session/prompt`, `session/cancel`; streaming
`session/update`; the state machine and structured refusals; the append-only
log with monotonic ids and attach-after-N replay; actor identity;
`_dsh/session/{rename,archive,unarchive,fork,state}` and
`_dsh/events/replay`.

Not implemented, and refused by name rather than ignored: WebSocket upgrade
(the RFD's second profile — HTTP+SSE covers slice 1's clients); `session/load`;
`session/set_mode`; `session/set_config_option`; client filesystem, terminal,
and elicitation capabilities; log rotation; and durable fork execution — fork
creates the child session and records lineage, but copying the parent's turn
prefix is slice 2.

**Slice 2 opens with the stream-model deviation** described at the top of this
document and in §7: replacing the single-stream-per-connection model with the
RFD's connection-scoped plus per-session streams. It is a conformance defect,
not an enhancement, and it is listed first so it is not mistaken for polish.

The session backend is a port (`lib/backends.js`) with two adapters:

- **`dsh`** (default inside a profile, `index.js`): binds each ACP session to a
  real DSH agent through `ctx.agents`, streams committed `session/event`s into
  `session/update`, and routes `approval/request` into `awaiting_permission`.
- **`scripted`** (`lib/backends.js`, standalone default): a deterministic
  fixture, and **never** the default inside a profile. It exists so the
  protocol, the refusals, and the replay can be exercised over a real socket
  without a model, a key, or a network. Every transcript produced with it says
  so, and `initialize` reports which backend is live in `_meta`.
