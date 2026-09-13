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
import { CLIENT_METHODS, notificationFrame, ErrorCode, RpcError, internalError, notFound } from "./jsonrpc.js";
import { EventLog, EventType } from "./eventlog.js";
import { Command, SessionState, allows, nextState, refusal } from "./state.js";

/** The `_dsh/` namespace prefix. One prefix test, and it cannot collide with the `dsh/` namespace the other plugin uses. */
export const EXTENSION_PREFIX = "_dsh/";

/** Notification carrying the full state record whenever a session moves. */
export const STATE_CHANGED = "_dsh/session/state_changed";

/** Notification carrying metadata changes that stable ACP cannot express. */
export const SESSION_CHANGED = "_dsh/session/changed";

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
	/** @type {boolean} */
	archived = false;
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
			archived: this.archived,
			state: this.state,
			createdAt: this.createdAt,
			updatedAt: this.updatedAt,
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

	/**
	 * @param {object} options - registry options.
	 * @param {EventLog} options.log - the append-only log.
	 * @param {object} options.backend - the backend adapter (lib/backends.js).
	 * @param {(frame: object, record: object) => void} [options.sink] - delivers a live frame to every subscriber.
	 */
	constructor({ log, backend, sink }) {
		this.#log = log;
		this.#backend = backend;
		this.#sink = sink ?? (() => {});
		// One delivery path, deliberately. Live frames are read off the log
		// record's `frame`, which is the same object replay reads — so the live
		// and replay paths cannot drift, because there is only one of them.
		this.#unsubscribe = this.#log.subscribe((record) => {
			const session = record.sessionId === null ? undefined : this.#sessions.get(record.sessionId);
			if (session !== undefined) {
				session.committed += 1;
				session.updatedAt = record.ts;
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
	 * its title, its archive flag, and — critically — the log position, so a
	 * reconnecting client's cursor still means something. What does *not*
	 * survive is the agent handle, so a recovered session is honestly `closed`
	 * rather than pretending to be `idle`; `session/resume` reopens it.
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
				case EventType.archived:
				case EventType.unarchived: {
					const session = this.#sessions.get(record.sessionId);
					if (session !== undefined) session.archived = record.type === EventType.archived;
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
				this.#log.append({
					sessionId: session.sessionId,
					actor,
					type: EventType.refused,
					data: {
						command,
						state: session.state,
						reason: error.data.reason,
						allowedIn: error.data.allowedIn,
					},
				});
				throw error;
			}

			const edge = nextState(command, session.state);
			const before = session.committed;
			if (edge !== null) {
				const from = session.state;
				session.state = edge;
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
			}

			const result = await effect(session);

			if (session.committed === before) {
				throw internalError(
					`${command} was admitted in state ${session.state} but committed no event; refusing to report success for an effect that left no trace`,
					{ type: "invariant_violation", command, sessionId: session.sessionId, state: session.state },
				);
			}
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
	 * Append an event for a session.
	 * @param {SessionRecord} session - the session.
	 * @param {object} input - `{actor, type, data, frame}`.
	 * @returns {object} the stored record.
	 */
	commit(session, input) {
		return this.#log.append({ sessionId: session.sessionId, ...input });
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
	 * @param {SessionRecord} session - the session.
	 * @param {string} to - the destination state.
	 * @param {string} reason - what caused the move, recorded in the event.
	 * @param {string} actor - who caused it.
	 * @returns {object} the stored record.
	 */
	setState(session, to, reason, actor) {
		const from = session.state;
		session.state = to;
		if (to !== SessionState.generating && to !== SessionState.awaitingPermission) session.turnId = undefined;
		return this.commit(session, {
			actor,
			type: EventType.state,
			data: { from, to, reason },
			frame: (eventId) =>
				notificationFrame(STATE_CHANGED, { sessionId: session.sessionId, from, to, command: reason, actor, eventId }),
		});
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
			this.setState(session, SessionState.failed, "backend_create_failed", "system:acp-control");
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
	 * @param {SessionRecord} session - the session.
	 * @param {string} actor - who asked.
	 * @returns {Promise<SessionRecord>} the session.
	 */
	async reopen(session, actor) {
		session.backendSession = await this.#backend.resume({ sessionId: session.sessionId, cwd: session.cwd });
		this.setState(session, SessionState.idle, "resumed", actor);
		return session;
	}
}
