/**
 * The session registry: admission, state, and the invariant that makes
 * "no silent no-ops" true by construction rather than by discipline.
 *
 * The whole of DESIGN.md §2 lives in {@link SessionRegistry.admit}. Read that
 * method first; everything else in this file is bookkeeping for it.
 *
 * @module dsh-acp-control/session
 */

import { randomUUID } from "node:crypto";
import { CLIENT_METHODS, EXTENSION_PREFIX, notificationFrame, ErrorCode, RpcError, internalError, notFound } from "./jsonrpc.js";
import { EventLog, EventType } from "./eventlog.js";
import { Command, SessionState, allows, nextState, refusal } from "./state.js";

/**
 * Re-exported from `lib/jsonrpc.js`, which is where the wire facts live.
 * Kept here so the modules that already import it from this file keep working.
 */
export { EXTENSION_PREFIX };

/** Notification carrying the full state record whenever a session moves. */
export const STATE_CHANGED = "_dsh/session/state_changed";

/** Notification carrying metadata changes that stable ACP cannot express. */
export const SESSION_CHANGED = "_dsh/session/changed";

/**
 * Notification carrying a refusal.
 *
 * **This notification is an invention, not a spec-sanctioned mechanism.** ACP
 * is silent on how an agent reports a notification it refused — a
 * notification has no response channel by construction (JSON-RPC 2.0 §4), so
 * for `session/cancel` there is no in-band way to answer. The spec does not
 * address the case; it does not forbid this either.
 *
 * Two honest halves, therefore:
 *
 *  - the refusal is **appended to the log** as `session.refused`, always, for
 *    every command — that is an audit trail, and it needs no permission from
 *    anyone;
 *  - this notification additionally makes it **observable in-band** to clients
 *    that opted into the `_dsh/` namespace, so such a client learns of a
 *    refused `session/cancel` when it happens rather than only on replay.
 *
 * Because it rides the ordinary wire-frame path, it is filtered to opted-in
 * connections by `ControlPlane#broadcast` (a standard client never sees it) and
 * it replays like any other frame, so a client that was disconnected when the
 * refusal happened still receives it on resume.
 */
export const REFUSED = "_dsh/session/refused";

/**
 * Commands that change nothing and therefore commit nothing.
 *
 * Only `state` qualifies: it is a read, and a read that writes is a read that
 * lies — the previous version appended a `{read: true}` event, which bumped the
 * session's `updatedAt` and therefore its position in `session/list`, so merely
 * polling a session made it look recently active and reordered the list
 * (DESIGN.md §2). Reads are exempt from the commit requirement because they are
 * required to be silent, not despite it.
 */
const READ_ONLY_COMMANDS = new Set([Command.state]);

/**
 * Event types that do not constitute session activity, and so must not move
 * `updatedAt`.
 *
 * Empty today — removing the read event removed the only offender — and kept as
 * an explicit, named policy rather than an implicit "every event counts", so
 * that the next bookkeeping event someone adds has an obvious place to
 * register.
 */
const NON_ACTIVITY_EVENTS = new Set([]);

/** Monotonic counter behind `scope.id`, so a command id is unique within a process. */
let commandSeq = 0;

/**
 * One session's record.
 *
 * `state` is the single source of truth about what may happen next; it is never
 * inferred from the presence of a promise or a boolean. `committed` counts
 * events appended for this session, which is how {@link SessionRegistry.admit}
 * proves an admitted command was not silent.
 */
export class SessionRecord {
	/** @type {string} */
	sessionId;
	/** @type {string} */
	cwd;
	/** @type {string|undefined} */
	title;
	/**
	 * Whether this plugin borrowed a live agent it does not own.
	 *
	 * The distinction is not bookkeeping: an adopted session must never be
	 * disposed by this plugin, and `session/delete` must refuse it, because
	 * another frontend is still showing it.
	 * @type {boolean}
	 */
	adopted = false;
	/** @type {string} one of {@link SessionState}. */
	state = SessionState.idle;
	/** @type {string} ISO 8601. */
	createdAt;
	/** @type {string} ISO 8601. */
	updatedAt;
	/** @type {string|undefined} the in-flight turn's id. */
	turnId;
	/** @type {string|undefined} the session this was forked from. */
	forkedFrom;
	/** @type {object|undefined} the backend's session object. */
	backendSession;
	/** @type {number} events appended for this session. */
	committed = 0;
	/**
	 * The command scope currently running an effect on this session, if any.
	 *
	 * Set by {@link SessionRegistry.admit} for exactly the duration of the
	 * effect and read by {@link SessionRegistry.commit}. Safe as implicit state
	 * because commands are serialized on `queue`, so no second scope can be
	 * open on this session at the same time.
	 * @type {{id: string, commits: number}|undefined}
	 */
	scope;
	/** @type {Promise<unknown>} serializes commands within this session. */
	queue = Promise.resolve();
	/** @type {AbortController|undefined} aborts the in-flight turn. */
	turnAbort;

	constructor({ sessionId, cwd, title, createdAt }) {
		this.sessionId = sessionId;
		this.cwd = cwd;
		this.title = title;
		this.createdAt = createdAt ?? new Date().toISOString();
		this.updatedAt = this.createdAt;
	}

	/** The wire shape of this session, for `session/list`, `_dsh/session/state`, and events. */
	toWire() {
		return {
			sessionId: this.sessionId,
			cwd: this.cwd,
			title: this.title ?? null,
			state: this.state,
			createdAt: this.createdAt,
			updatedAt: this.updatedAt,
			/**
			 * `live` says a real agent is behind this session; `owned` says this
			 * plugin may tear it down. A session can be live and not owned —
			 * that is what adoption means — and a client that wants to know
			 * whether it is looking at the human's session needs the first,
			 * while only this plugin needs the second.
			 */
			live: this.backendSession !== undefined,
			owned: this.backendSession !== undefined && this.adopted === false,
			...(this.forkedFrom === undefined ? {} : { forkedFrom: this.forkedFrom }),
			...(this.turnId === undefined ? {} : { turnId: this.turnId }),
		};
	}
}

/**
 * The registry.
 *
 * Owns every session, the event log, and the one live-delivery path. It knows
 * nothing about transports and nothing about DSH: commands in, events out.
 */
export class SessionRegistry {
	/** @type {Map<string, SessionRecord>} */
	#sessions = new Map();
	#log;
	#backend;
	#sink;
	#unsubscribe;
	#archivedIds;
	/** @type {Map<string, {onEvent: (event: object) => void}>} adopted sessions' event routing. */
	#observers = new Map();

	/**
	 * @param {object} options - registry options.
	 * @param {EventLog} options.log - the append-only log.
	 * @param {object} options.backend - the backend adapter (lib/backends.js).
	 * @param {(frame: object, record: object) => void} [options.sink] - delivers a live frame to every subscriber.
	 * @param {() => Promise<Set<string>|undefined>} [options.archivedIds] - reads the *canonical* archived set, or undefined when the composition has none.
	 */
	constructor({ log, backend, sink, archivedIds }) {
		this.#log = log;
		this.#backend = backend;
		this.#sink = sink ?? (() => {});
		this.#archivedIds = archivedIds;
		// One delivery path, deliberately. Live frames are read off the log
		// record's `frame`, which is the same object replay reads — so the live
		// and replay paths cannot drift, because there is only one of them.
		this.#unsubscribe = this.#log.subscribe((record) => {
			const session = record.sessionId === null ? undefined : this.#sessions.get(record.sessionId);
			if (session !== undefined) {
				session.committed += 1;
				// `updatedAt` tracks real activity only. Reads no longer log
				// anything at all (see READ_ONLY_COMMANDS), so every remaining
				// event is a genuine change — but the exemption list is kept
				// explicit so that adding a bookkeeping event later cannot
				// silently make `session/list` reorder itself when nobody did
				// anything.
				if (!NON_ACTIVITY_EVENTS.has(record.type)) session.updatedAt = record.ts;
			}
			if (record.frame !== undefined) this.#sink(record.frame, record);
		});
	}

	/** @returns {EventLog} the log, for `_dsh/log/info` and `_dsh/events/replay`. */
	get log() {
		return this.#log;
	}

	/** @returns {object} the backend adapter. */
	get backend() {
		return this.#backend;
	}

	/**
	 * Look up a session, or fail with `not_found`.
	 * @param {string} sessionId - the session id.
	 * @returns {SessionRecord} the record.
	 */
	require(sessionId) {
		const session = this.#sessions.get(sessionId);
		if (session === undefined) {
			throw notFound(`unknown session: ${sessionId}`, { sessionId });
		}
		return session;
	}

	/** @returns {SessionRecord|undefined} the record, if present. */
	get(sessionId) {
		return this.#sessions.get(sessionId);
	}

	/** @returns {SessionRecord[]} every known session. */
	all() {
		return [...this.#sessions.values()];
	}

	/** Register a record. Used by `session/new`, fork, and boot recovery. */
	add(session) {
		this.#sessions.set(session.sessionId, session);
		return session;
	}

	/** Remove a record entirely. Used by `session/delete`. */
	forget(sessionId) {
		this.#sessions.delete(sessionId);
	}

	/**
	 * Rebuild the registry from the log.
	 *
	 * What survives a restart is exactly what the log recorded: the session,
	 * its title, and — critically — the log position, so a reconnecting
	 * client's cursor still means something. What does *not* survive is the
	 * agent handle, so a recovered session is honestly `closed` rather than
	 * pretending to be `idle`; `session/resume` reopens it — or, when the agent
	 * turns out to be live, adopts it instead.
	 *
	 * Archive is deliberately **not** recovered here: it is not this plugin's
	 * fact to remember. `session/list` asks the canonical workspace registry
	 * instead (see the `archivedIds` provider).
	 *
	 * @returns {{recovered: number, lastEventId: number, dropped: number}} summary for the boot log.
	 */
	recover() {
		let recovered = 0;
		for (const record of this.#log.read({ after: -1 })) {
			switch (record.type) {
				case EventType.created: {
					if (this.#sessions.has(record.sessionId)) break;
					const session = new SessionRecord({
						sessionId: record.sessionId,
						cwd: record.data?.cwd ?? "/",
						title: record.data?.title,
						createdAt: record.ts,
					});
					session.state = SessionState.closed;
					session.createdAt = record.ts;
					this.#sessions.set(session.sessionId, session);
					recovered += 1;
					break;
				}
				case EventType.title: {
					const session = this.#sessions.get(record.sessionId);
					if (session !== undefined) session.title = record.data?.title;
					break;
				}
				case EventType.forked: {
					const session = this.#sessions.get(record.sessionId);
					if (session !== undefined) session.forkedFrom = record.data?.forkedFrom;
					break;
				}
				case EventType.deleted: {
					this.#sessions.delete(record.sessionId);
					break;
				}
				default:
					break;
			}
		}
		return { recovered, lastEventId: this.#log.lastEventId, dropped: this.#log.recovery.dropped };
	}

	/** Stop following the log. */
	dispose() {
		this.#unsubscribe?.();
	}

	/**
	 * Admit one command against one session — the gate every mutation passes
	 * through, and the only place the invariant is enforced.
	 *
	 * In order:
	 *
	 *  1. **Serialize** on the session's own queue, so the state read by the
	 *     check below is the state the effect runs in. Two concurrent prompts
	 *     therefore produce one `generating` and one refusal, never two racing
	 *     turns.
	 *  2. **Check the transition table.** A command the state does not admit is
	 *     refused with a structured error naming the state, and the refusal is
	 *     itself appended to the log — so a client that never saw the response
	 *     still learns about it after reconnecting.
	 *  3. **Apply the command's state edge**, if it has one, before the effect
	 *     runs, so an observer sees `generating` while the turn is generating.
	 *  4. **Run the effect** — which must be *short*. See the note below.
	 *  5. **Prove the effect was not silent:** at least one event must have been
	 *     appended *for this session*. If none was, that is a bug in this
	 *     plugin, and it is raised as an internal error rather than returned as
	 *     a success. This check is the mechanical form of §2's rule: there is no
	 *     code path that can report success after dropping the caller's input.
	 *
	 * **The effect must not be long-running.** The queue serializes *admission*,
	 * not the work. A `session/prompt` whose effect awaited the whole agent turn
	 * would hold this session's queue for the turn's lifetime, and
	 * `session/cancel` — which is also a command on this queue — could never be
	 * admitted. That is a deadlock, not a policy, and it would make cancellation
	 * impossible exactly when it is most wanted. Long work is admitted here and
	 * then awaited outside, with {@link queue} used to serialize the settlement.
	 *
	 * @param {SessionRecord} session - the session to mutate.
	 * @param {string} command - one of {@link Command}.
	 * @param {string} actor - who is asking.
	 * @param {(session: SessionRecord) => any} effect - the short mutation.
	 * @returns {Promise<any>} the effect's result.
	 * @throws {RpcError} `data.type === 'refused'` when the state blocks it.
	 */
	async admit(session, command, actor, effect) {
		const run = async () => {
			if (!allows(command, session.state)) {
				const error = refusal(command, session.state, {
					sessionId: session.sessionId,
					eventId: this.#log.lastEventId,
					actor,
				});
				// Logged *and* framed, through the same helper an out-of-band
				// refusal uses. The log entry is the audit trail — it is the
				// only report a refused notification can have, since a
				// notification has no response channel. The frame additionally
				// lets an opted-in client observe the refusal in-band; the
				// plane filters `_dsh/*` away from everyone else, so a standard
				// client is never sent a method it did not ask to hear about.
				this.refuse(session, command, actor, { ...error.data, state: session.state });
				throw error;
			}

			const edge = nextState(command, session.state);
			if (edge !== null) {
				const from = session.state;
				// Commit **before** mutating. Appending first means a failed
				// append leaves the session exactly as it was, so a reported
				// failure never carries an applied effect; assigning first —
				// which this did — left the state moved while the caller was
				// told the command failed. The frame factory only needs the
				// captured locals, so it does not depend on the mutation.
				this.#log.append({
					sessionId: session.sessionId,
					actor,
					type: EventType.state,
					data: { from, to: edge, command },
					frame: (eventId) =>
						notificationFrame(STATE_CHANGED, {
							sessionId: session.sessionId,
							from,
							to: edge,
							command,
							actor,
							eventId,
						}),
				});
				// Durable before the state moves: otherwise a failed write
				// leaves the session in the new state while the caller is told
				// the command failed — which is how a prompt could be reported
				// as failed and still strand its session in `generating`.
				await this.durable(`${command}'s state transition`);
				session.state = edge;
			}

			// The effect's own commits are counted in `scope`, which is set on
			// the session for exactly as long as the effect runs. The automatic
			// edge event above deliberately does **not** count: it is appended
			// before the effect, so counting it would satisfy the check below
			// vacuously for every command that has an edge — which is how the
			// previous version of this check passed `prompt`, `cancel`, `close`,
			// `delete` and `resume` without ever proving their effects did
			// anything at all.
			const scope = { id: `${command}#${++commandSeq}`, commits: 0 };
			session.scope = scope;
			let result;
			try {
				result = await effect(session);
			} finally {
				session.scope = undefined;
			}

			if (!READ_ONLY_COMMANDS.has(command) && scope.commits === 0) {
				throw internalError(
					`${command} was admitted in state ${session.state} but its effect committed no event; refusing to report success for an effect that left no trace`,
					{ type: "invariant_violation", command, commandId: scope.id, sessionId: session.sessionId, state: session.state },
				);
			}

			// Durability is part of success (DESIGN.md §5). Until this awaited
			// flush, a command could return success, reach live clients, advance
			// every cursor, and be gone after a restart, because the write chain
			// swallowed its own failures.
			await this.#log.flush().catch((error) => {
				throw internalError(
					`${command} was applied but its events could not be written to the log: ${error instanceof Error ? error.message : String(error)}`,
					{
						type: "durability_failed",
						command,
						commandId: scope.id,
						sessionId: session.sessionId,
						state: session.state,
						logPath: this.#log.path,
						effectApplied: true,
					},
				);
			});

			return result;
		};

		// Chain on the session's queue. The `catch` keeps one refusal from
		// poisoning every later command on this session.
		const queued = session.queue.then(run, run);
		session.queue = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	}

	/**
	 * Adopt a session that already exists, without taking ownership of it.
	 *
	 * This is what makes the plugin a control plane rather than a second
	 * harness: the agent was created by another frontend — the web GUI, most
	 * likely — and this registry gains a *view* of it. The agent handle stays
	 * with whoever created it, and this plugin never disposes it.
	 *
	 * Idempotent, because a GUI session can be discovered by more than one
	 * route (an `agent/created` announcement, a `session/resume` naming it, a
	 * `session/list` sweep) and adopting it twice must not produce two records
	 * or two sets of listeners.
	 *
	 * @param {object} input - the session to adopt.
	 * @param {string} input.sessionId - the DSH session id.
	 * @param {string} [input.cwd] - its workspace, when the caller knows it.
	 * @param {string} [input.title] - its title, when the caller knows it.
	 * @param {string} [input.state] - the state to start from, derived from the live agent's status.
	 * @param {string} [input.actor] - who caused the adoption.
	 * @returns {Promise<SessionRecord|undefined>} the record, or undefined when nothing is live to adopt.
	 */
	async attach({ sessionId, cwd, title, state, actor = "system:acp-control" }) {
		const existing = this.#sessions.get(sessionId);
		if (existing?.backendSession !== undefined) return existing;

		const record = existing ?? new SessionRecord({ sessionId, cwd: cwd ?? "/", title });
		// `observe` is bound through the map rather than closed over here, so a
		// re-attach after a detach cannot leave a listener pointing at a stale
		// record.
		this.#observers.set(sessionId, { onEvent: (event) => this.observe(sessionId, event) });

		const backendSession = await this.#backend.adopt?.({
			sessionId,
			cwd: record.cwd,
			onEvent: (event) => this.#observers.get(sessionId)?.onEvent(event),
		});
		if (backendSession === undefined) {
			this.#observers.delete(sessionId);
			return undefined;
		}

		record.adopted = true;
		record.backendSession = backendSession;
		if (existing === undefined) {
			this.#sessions.set(sessionId, record);
			this.commit(record, {
				actor,
				type: EventType.attached,
				data: { cwd: record.cwd, state: state ?? SessionState.idle, owner: "external" },
			});
		}
		// The live agent's own status is the truth about whether a turn is
		// running, so the state machine starts from it rather than from an
		// assumption. This is what lets an ACP client see a turn the human
		// started before the client ever connected.
		this.setState(record, state ?? SessionState.idle, "attached", actor);
		return record;
	}

	/**
	 * React to one event from an adopted session's live agent.
	 *
	 * Two jobs, and the second is the one that makes attachment visible from
	 * both ends:
	 *
	 *  1. **Track the turn** the way the state machine models it, so a turn the
	 *     *human* started shows up as `generating` and a client's
	 *     `_dsh/session/state` agrees with what the GUI is doing.
	 *  2. **Forward the conversation** as `session/update`, so an attached ACP
	 *     client watches the human's session stream past it — and, because the
	 *     GUI is subscribed to the same session, so does the GUI when the ACP
	 *     client prompts.
	 *
	 * Updates are attributed to the agent, not to the ACP client, because that
	 * is what produced them.
	 *
	 * @param {string} sessionId - the session the event belongs to.
	 * @param {object} event - a committed DSH session event.
	 */
	observe(sessionId, event) {
		const session = this.#sessions.get(sessionId);
		if (session === undefined) return;
		const actor = `agent:${sessionId}`;
		if (event?.type === "turn/start") {
			if (session.state === SessionState.idle) {
				this.setState(session, SessionState.generating, "observed_turn_start", actor);
			}
			return;
		}
		if (event?.type === "turn/end") {
			if (session.state === SessionState.generating || session.state === SessionState.awaitingPermission) {
				this.setState(session, SessionState.idle, "observed_turn_end", actor);
			}
			return;
		}
		for (const update of this.#backend.translate?.(event) ?? []) {
			this.emitUpdate(session, update, actor);
		}
	}

	/** Stop observing and release an adopted session's borrowed handle. */
	async detach(sessionId, actor = "system:acp-control") {
		const session = this.#sessions.get(sessionId);
		this.#observers.delete(sessionId);
		if (session === undefined) return;
		const backendSession = session.backendSession;
		session.backendSession = undefined;
		session.adopted = false;
		// A borrowed session's dispose only removes this plugin's listeners; the
		// agent itself stays with its owner.
		if (backendSession?.adopted === true) await backendSession.dispose?.();
		if (session.state !== SessionState.closed) this.setState(session, SessionState.closed, "owner_gone", actor);
	}

	/** The canonical archived set, or undefined when this composition has none. */
	async archivedIds() {
		return await this.#archivedIds?.();
	}

	/**
	 * Serialize an operation on a session's queue **without** a state check.
	 *
	 * This is how a long-running command's *settlement* re-enters the queue:
	 * the turn runs outside it (see {@link admit}), and when it finishes the
	 * return edge — `generating`/`cancelling` → `idle` — is applied here, in
	 * order relative to any command admitted while the turn was running.
	 *
	 * @param {SessionRecord} session - the session.
	 * @param {() => Promise<any>|any} operation - the work to serialize.
	 * @returns {Promise<any>} the operation's result.
	 */
	async queue(session, operation) {
		const queued = session.queue.then(operation, operation);
		session.queue = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	}

	/**
	 * Await durability of everything appended so far, or fail.
	 *
	 * This is the step that makes "commit before mutate" mean something. An
	 * append only *queues* a write, so a mutation performed immediately after
	 * one is still exposed to a disk that is full or gone — which is exactly
	 * what `verify/core-checks.mjs` demonstrated when it deleted the log
	 * directory and watched a rename report `durability_failed` while the title
	 * had already changed.
	 *
	 * Effects therefore order themselves: append, await this, *then* mutate.
	 * Commands pay one disk round trip at their mutation point, which is the
	 * price of the guarantee and is nowhere near a streaming path.
	 *
	 * @throws {RpcError} `data.type === 'durability_failed'` when the write failed.
	 */
	async durable(what) {
		try {
			await this.#log.flush();
		} catch (error) {
			throw new RpcError(
				ErrorCode.internalError,
				`${what} could not be written to the event log: ${error instanceof Error ? error.message : String(error)}`,
				{ type: "durability_failed", logPath: this.#log.path, reason: error instanceof Error ? error.message : String(error) },
			);
		}
	}

	/**
	 * Record a refusal that was decided **outside** {@link admit}.
	 *
	 * A command can be refused before admission — `session/delete` refuses a
	 * live session, because another frontend is still showing it — and such a
	 * refusal must be exactly as audible as one the transition table produced.
	 * Otherwise the loudest-looking refusal in the system would be the one
	 * nothing recorded.
	 *
	 * @param {SessionRecord} session - the session that refused.
	 * @param {string} command - the command name.
	 * @param {string} actor - who asked.
	 * @param {object} error - the refusal's `data`.
	 * @returns {object} the stored record.
	 */
	refuse(session, command, actor, error) {
		return this.#log.append({
			sessionId: session.sessionId,
			actor,
			type: EventType.refused,
			data: {
				command,
				state: error?.state ?? session.state,
				reason: error?.reason,
				allowedIn: error?.allowedIn ?? [],
			},
			frame: (eventId) =>
				notificationFrame(REFUSED, {
					sessionId: session.sessionId,
					command,
					state: error?.state ?? session.state,
					reason: error?.reason,
					allowedIn: error?.allowedIn ?? [],
					actor,
					eventId,
				}),
		});
	}

	/**
	 * Append an event for a session.
	 *
	 * When an admission scope is open (see {@link admit}), the append counts
	 * toward it and the record carries the command id — so the log answers "which
	 * command produced this event", which is what makes the admission check
	 * mean something and what a reader needs to reconstruct intent from the log.
	 *
	 * @param {SessionRecord} session - the session.
	 * @param {object} input - `{actor, type, data, frame, scope}`.
	 * @returns {object} the stored record.
	 */
	commit(session, input) {
		const scope = input.scope ?? session.scope;
		const record = this.#log.append({
			sessionId: session.sessionId,
			...(scope === undefined ? {} : { commandId: scope.id }),
			actor: input.actor,
			type: input.type,
			data: input.data,
			frame: input.frame,
		});
		if (scope !== undefined) scope.commits += 1;
		return record;
	}

	/**
	 * Emit one ACP `session/update` for a session: logged with its frame, and
	 * delivered live down the single path the registry opened in its
	 * constructor.
	 *
	 * @param {SessionRecord} session - the session the update belongs to.
	 * @param {object} update - a stable ACP `SessionUpdate` payload.
	 * @param {string} actor - who caused it (normally `agent:<id>`).
	 * @returns {object} the stored record.
	 */
	emitUpdate(session, update, actor) {
		return this.commit(session, {
			actor,
			type: EventType.update,
			data: { update },
			frame: (eventId) =>
				notificationFrame(CLIENT_METHODS.sessionUpdate, {
					sessionId: session.sessionId,
					update,
					_meta: { actor, eventId },
				}),
		});
	}

	/**
	 * Move a session to a state outside the command table — the return edges a
	 * command's effect owns (`generating` → `idle` when a turn ends,
	 * `closing` → `closed` when teardown finishes).
	 *
	 * Commit first, mutate second, for the same reason as everywhere else: a
	 * failed append must leave the session as it was.
	 *
	 * @param {SessionRecord} session - the session.
	 * @param {string} to - the destination state.
	 * @param {string} reason - what caused the move, recorded in the event.
	 * @param {string} actor - who caused it.
	 * @returns {object} the stored record.
	 */
	setState(session, to, reason, actor) {
		const from = session.state;
		const record = this.commit(session, {
			actor,
			type: EventType.state,
			data: { from, to, reason },
			frame: (eventId) =>
				notificationFrame(STATE_CHANGED, { sessionId: session.sessionId, from, to, command: reason, actor, eventId }),
		});
		session.state = to;
		if (to !== SessionState.generating && to !== SessionState.awaitingPermission) session.turnId = undefined;
		return record;
	}

	/**
	 * {@link setState}, but the state moves only once the transition is on disk.
	 *
	 * Used wherever a caller is entitled to treat the movement as part of the
	 * command's success — resume in particular, where a backend that refuses to
	 * reopen must leave the session `closed` rather than `idle` with no handle.
	 *
	 * @param {SessionRecord} session - the session.
	 * @param {string} to - the destination state.
	 * @param {string} reason - what caused the move.
	 * @param {string} actor - who caused it.
	 * @returns {Promise<object>} the stored record.
	 */
	async setStateDurable(session, to, reason, actor) {
		const from = session.state;
		const record = this.commit(session, {
			actor,
			type: EventType.state,
			data: { from, to, reason },
			frame: (eventId) =>
				notificationFrame(STATE_CHANGED, { sessionId: session.sessionId, from, to, command: reason, actor, eventId }),
		});
		await this.durable(`${reason} state transition`);
		session.state = to;
		if (to !== SessionState.generating && to !== SessionState.awaitingPermission) session.turnId = undefined;
		return record;
	}

	/**
	 * Create a session and its backend counterpart.
	 *
	 * The record is inserted before the backend is asked to open, so a backend
	 * failure still leaves an audible trace rather than a session that vanished.
	 *
	 * @param {object} input - creation input.
	 * @param {string} input.cwd - absolute working directory.
	 * @param {string} input.actor - who asked.
	 * @param {string} [input.sessionId] - supply an id (fork, resume); generated otherwise.
	 * @param {string} [input.forkedFrom] - the parent session, for forks.
	 * @returns {Promise<SessionRecord>} the created session.
	 */
	async create({ cwd, actor, sessionId = `acp-${randomUUID()}`, forkedFrom }) {
		const session = new SessionRecord({ sessionId, cwd });
		session.forkedFrom = forkedFrom;
		this.#sessions.set(sessionId, session);
		this.commit(session, {
			actor,
			type: EventType.created,
			data: { cwd, ...(forkedFrom === undefined ? {} : { forkedFrom }) },
		});
		try {
			session.backendSession = await this.#backend.create({ sessionId, cwd });
		} catch (error) {
			await this.setStateDurable(session, SessionState.failed, "backend_create_failed", "system:acp-control");
			this.commit(session, {
				actor: "system:acp-control",
				type: EventType.error,
				data: { message: error instanceof Error ? error.message : String(error) },
			});
			throw new RpcError(ErrorCode.internalError, `could not open a backend session: ${error instanceof Error ? error.message : String(error)}`, {
				type: "backend_failed",
				sessionId,
			});
		}
		return session;
	}

	/**
	 * Reopen a recovered or closed session's backend handle.
	 *
	 * The backend is asked **first** and the handle is stored **last**: a
	 * backend that refuses to resume must leave the session `closed`, not
	 * `idle` with no handle. `resume` therefore has no automatic transition
	 * edge (see `EDGES` in lib/state.js) and this method owns both halves in
	 * order.
	 *
	 * @param {SessionRecord} session - the session.
	 * @param {string} actor - who asked.
	 * @returns {Promise<SessionRecord>} the session.
	 */
	async reopen(session, actor) {
		const backendSession = await this.#backend.resume({ sessionId: session.sessionId, cwd: session.cwd });
		await this.setStateDurable(session, SessionState.idle, "resumed", actor);
		session.backendSession = backendSession;
		return session;
	}
}
