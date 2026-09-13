/**
 * The control plane: ACP method dispatch.
 *
 * Transport-independent by construction — nothing here imports `node:http`,
 * `process.stdin`, or Cordis. A caller supplies a *connection*, which is
 * anything that can send a frame, notify, and ask a question; the stdio and
 * HTTP+SSE transports (lib/transport-*.js) are the two implementations.
 *
 * Every method either succeeds having committed at least one event, or fails
 * with a structured error. The admission gate that enforces that lives in
 * `lib/session.js`; this module's job is to route methods into it and to keep
 * the ACP wire shapes exact against the stable v1 schema.
 *
 * @module dsh-acp-control/server
 */

import {
	AGENT_METHODS,
	CLIENT_METHODS,
	PROTOCOL_METHODS,
	PROTOCOL_VERSION,
	ErrorCode,
	RpcError,
	classify,
	errorFrame,
	internalError,
	invalidParams,
	methodNotFound,
	notificationFrame,
	requestCancelled,
	resultFrame,
} from "./jsonrpc.js";
import { EventType } from "./eventlog.js";
import { Command, SessionState, allows } from "./state.js";
import { EXTENSION_PREFIX, SESSION_CHANGED, SessionRecord } from "./session.js";
import { promptToText } from "./backends.js";

/**
 * This plugin's extension opt-in key, inside the schema-sanctioned
 * `initialize.params.clientCapabilities._meta` record.
 *
 * Namespaced to this plugin so it cannot collide with the other DSH ACP
 * plugin's `dsh/extensions` key. A standard client never sets `_meta`, so it
 * never receives `_dsh/*` notifications and is never surprised.
 */
export const EXTENSIONS_KEY = "dsh-acp-control/extensions";

/** Methods whose absence is deliberate, with the reason a client is told. */
const STUBS = Object.freeze({
	[AGENT_METHODS.sessionLoad]: {
		reason: "replay is a cursor, not a load",
		use: "_dsh/events/replay",
	},
	[AGENT_METHODS.sessionSetMode]: { reason: "modes are not modelled by this server" },
	[AGENT_METHODS.sessionSetConfigOption]: { reason: "config options are not modelled by this server" },
	[AGENT_METHODS.authenticate]: { reason: "this server authenticates its transport, not the ACP session" },
	[AGENT_METHODS.logout]: { reason: "this server authenticates its transport, not the ACP session" },
});

/** Cap on how many events one replay may return, so a cursor of -1 cannot flood a socket. */
const REPLAY_LIMIT_MAX = 5000;

/**
 * Turn a `clientInfo.name` into an actor label.
 *
 * The actor has to be stable and greppable — `grep '"actor":"human:zed"'` is
 * the point (DESIGN.md §6) — so anything that would break a one-token label is
 * folded to a dash rather than escaped.
 *
 * @param {object|undefined} clientInfo - `initialize.params.clientInfo`.
 * @param {string} fallback - the transport's name, when the client said nothing.
 * @returns {string} the actor label.
 */
export function actorFrom(clientInfo, fallback) {
	const raw = typeof clientInfo?.name === "string" ? clientInfo.name.trim() : "";
	if (raw === "") return `human:${fallback}`;
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `human:${slug === "" ? fallback : slug}`;
}

/**
 * The control plane.
 *
 * One instance serves every connection. Sessions are shared, so two clients
 * attached to the same control plane see the same sessions — which is the
 * whole point of a control plane, and the reason a reconnecting client can
 * pick up where it left off at all.
 */
export class ControlPlane {
	#registry;
	#log;
	#agentName;
	#version;
	#logger;
	#connections = new Set();
	#capabilities;

	/**
	 * @param {object} options - plane options.
	 * @param {import('./session.js').SessionRegistry} options.registry - the session registry.
	 * @param {(message: string) => void} [options.logger] - diagnostics; never writes to stdout.
	 * @param {string} [options.agentName] - reported in `initialize.agentInfo`.
	 * @param {string} [options.version] - reported in `initialize.agentInfo`.
	 */
	constructor({ registry, logger, agentName = "dsh-acp-control", version = "1.0.0" }) {
		this.#registry = registry;
		this.#log = registry.log;
		this.#logger = logger ?? (() => {});
		this.#agentName = agentName;
		this.#version = version;
		this.#capabilities = Object.freeze({
			promptCapabilities: Object.freeze({ image: false, audio: false, embeddedContext: false }),
			// Advertised only because each one is implemented (DESIGN.md §3).
			// `session/fork` is deliberately absent: the RFD is Draft.
			sessionCapabilities: Object.freeze({ list: {}, resume: {}, close: {}, delete: {} }),
		});
	}

	/** @returns {object} the advertised capabilities, for checks and for `initialize`. */
	get capabilities() {
		return this.#capabilities;
	}

	/** @returns {object} the event log, which the SSE transport replays from. */
	get log() {
		return this.#log;
	}

	/** @returns {object} the session registry. */
	get registry() {
		return this.#registry;
	}

	/** Register a connection so it receives live frames. */
	attach(connection) {
		this.#connections.add(connection);
	}

	/** Unregister a connection. */
	detach(connection) {
		this.#connections.delete(connection);
	}

	/** @returns {number} how many connections are attached. */
	get connectionCount() {
		return this.#connections.size;
	}

	/**
	 * Deliver one live frame to every connection.
	 *
	 * The extension gate is **not** applied here: it lives on the connection
	 * (`Connection#allowsFrame`), because the live path and the replay path must
	 * make the same decision and there must be one copy of it. This method's
	 * job is only to reach every peer.
	 *
	 * @param {object} frame - the frame, straight off the log record.
	 * @param {object} record - the log record it came from.
	 */
	broadcast(frame, record) {
		for (const connection of this.#connections) connection.send(frame, record);
	}

	/**
	 * Dispatch one inbound frame.
	 *
	 * Requests get a response frame; notifications and responses do not. A
	 * malformed frame gets an error response when it carries an id, and a
	 * diagnostic otherwise — never silence, because silence is the failure mode
	 * this design exists to remove.
	 *
	 * @param {object} connection - the sending connection.
	 * @param {unknown} raw - the parsed frame.
	 * @returns {Promise<object|null>} the response frame, or null.
	 */
	async dispatch(connection, raw) {
		const { kind, frame } = classify(raw);
		if (kind === "invalid") {
			this.#logger(`discarded a malformed frame: ${JSON.stringify(raw).slice(0, 200)}`);
			return errorFrame(frame?.id ?? null, new RpcError(ErrorCode.invalidRequest, "Invalid request", { type: "invalid_request" }));
		}
		if (kind === "response") {
			connection.acceptResponse(frame);
			return null;
		}
		if (kind === "notification") {
			try {
				await this.#notification(connection, frame.method, frame.params ?? {});
			} catch (error) {
				// A notification has no id to answer, so the only honest thing
				// is to say so where an operator will see it.
				this.#logger(`notification ${frame.method} failed: ${describe(error)}`);
			}
			return null;
		}
		try {
			const result = await this.#request(connection, frame.method, frame.params ?? {}, connection.signalFor(frame.id));
			return resultFrame(frame.id, result ?? {});
		} catch (error) {
			return errorFrame(frame.id, normalizeError(error, frame.method));
		}
	}

	/** Route one request. */
	async #request(connection, method, params, signal) {
		switch (method) {
			case AGENT_METHODS.initialize:
				return this.#initialize(connection, params);
			case AGENT_METHODS.sessionNew:
				return this.#sessionNew(connection, params);
			case AGENT_METHODS.sessionList:
				return this.#sessionList(connection, params);
			case AGENT_METHODS.sessionResume:
				return this.#sessionResume(connection, params);
			case AGENT_METHODS.sessionClose:
				return this.#sessionClose(connection, params);
			case AGENT_METHODS.sessionDelete:
				return this.#sessionDelete(connection, params);
			case AGENT_METHODS.sessionPrompt:
				return this.#sessionPrompt(connection, params, signal);
			case AGENT_METHODS.sessionFork:
				// Only reachable if a client ignores the advertised capabilities;
				// the method is deliberately absent from them (the RFD is Draft).
				throw methodNotFound(method, { use: `${EXTENSION_PREFIX}session/fork` });
			case "_dsh/session/rename":
				return this.#rename(connection, params);
			case "_dsh/session/archive":
				return this.#archive(connection, params, true);
			case "_dsh/session/unarchive":
				return this.#archive(connection, params, false);
			case "_dsh/session/fork":
				return this.#fork(connection, params);
			case "_dsh/session/state":
				return this.#state(connection, params);
			case "_dsh/session/list":
				return this.#list(connection, params);
			case "_dsh/events/replay":
				return this.#replay(params);
			case "_dsh/log/info":
				return { ...this.#log.info(), backend: this.#registry.backend.name, connections: this.connections };
			default:
				break;
		}
		if (STUBS[method] !== undefined) throw methodNotFound(method, STUBS[method]);
		throw methodNotFound(method);
	}

	/** `connections` as a number, kept separate so `_dsh/log/info` stays JSON-plain. */
	get connections() {
		return this.#connections.size;
	}

	/** Route one notification. */
	async #notification(connection, method, params) {
		switch (method) {
			case AGENT_METHODS.sessionCancel:
				return this.#sessionCancel(connection, params);
			case PROTOCOL_METHODS.cancelRequest:
				// The transport already correlates `$/cancel_request` with the
				// request it names; nothing further to do here.
				return undefined;
			default:
				this.#logger(`ignored unknown notification: ${method}`);
				return undefined;
		}
	}

	// ── initialize ───────────────────────────────────────────────────────────

	#initialize(connection, params) {
		const meta = params?.clientCapabilities?._meta;
		connection.negotiate({
			actor: actorFrom(params?.clientInfo, connection.transportName),
			extensions: meta !== undefined && Boolean(meta[EXTENSIONS_KEY]),
			clientInfo: params?.clientInfo,
		});
		this.#logger(
			`initialize from ${connection.actor} (${connection.transportName}${connection.extensions ? ", extensions on" : ""}), ` +
				`client protocol ${String(params?.protocolVersion ?? "?")}`,
		);
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentInfo: { name: this.#agentName, version: this.#version },
			agentCapabilities: {
				...this.#capabilities,
				sessionCapabilities: { ...this.#capabilities.sessionCapabilities },
			},
			authMethods: [],
			_meta: {
				"dsh-acp-control": {
					backend: this.#registry.backend.name,
					replay: `${EXTENSION_PREFIX}events/replay`,
					extensions: [
						`${EXTENSION_PREFIX}session/rename`,
						`${EXTENSION_PREFIX}session/archive`,
						`${EXTENSION_PREFIX}session/unarchive`,
						`${EXTENSION_PREFIX}session/fork`,
						`${EXTENSION_PREFIX}session/state`,
						`${EXTENSION_PREFIX}session/list`,
						`${EXTENSION_PREFIX}events/replay`,
						`${EXTENSION_PREFIX}log/info`,
					],
					/** Notifications an opted-in client will receive. `session/refused` is this plugin's own mechanism; ACP does not define one. */
					notifications: [`${EXTENSION_PREFIX}session/state_changed`, `${EXTENSION_PREFIX}session/changed`, `${EXTENSION_PREFIX}session/refused`],
				},
			},
		};
	}

	// ── sessions ─────────────────────────────────────────────────────────────

	async #sessionNew(connection, params) {
		const cwd = params?.cwd;
		if (typeof cwd !== "string" || cwd.length === 0) {
			throw invalidParams("session/new requires an absolute cwd", { field: "cwd" });
		}
		const session = await this.#registry.create({ cwd, actor: connection.actor });
		this.#logger(`session ${session.sessionId} created by ${connection.actor}`);
		return { sessionId: session.sessionId };
	}

	async #sessionList(connection, params) {
		// Stable `session/list` omits archived sessions: that is what archive
		// means. `_dsh/session/list` brings them back on request.
		return this.#list(connection, params, false);
	}

	async #list(_connection, params, includeArchived = true) {
		const cwdFilter = typeof params?.cwd === "string" ? params.cwd : undefined;
		const backendSessions = await this.#registry.backend.list();
		const byId = new Map();
		for (const summary of backendSessions) {
			byId.set(summary.sessionId, {
				sessionId: summary.sessionId,
				cwd: summary.cwd ?? "/",
				title: summary.title ?? null,
				updatedAt: summary.updatedAt ?? null,
				state: SessionState.closed,
				archived: false,
				backendOnly: true,
			});
		}
		for (const session of this.#registry.all()) {
			const existing = byId.get(session.sessionId);
			byId.set(session.sessionId, {
				...(existing ?? {}),
				sessionId: session.sessionId,
				cwd: session.cwd,
				title: session.title ?? existing?.title ?? null,
				updatedAt: session.updatedAt,
				state: session.state,
				archived: session.archived,
				backendOnly: false,
			});
		}
		const sessions = [...byId.values()]
			.filter((session) => (cwdFilter === undefined ? true : session.cwd === cwdFilter))
			.filter((session) => (includeArchived ? true : session.archived !== true))
			.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
		return { sessions };
	}

	async #sessionResume(connection, params) {
		const sessionId = params?.sessionId;
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw invalidParams("session/resume requires a sessionId", { field: "sessionId" });
		}
		const session = this.#registry.require(sessionId);
		await this.#registry.admit(session, Command.resume, connection.actor, async (record) => {
			await this.#registry.reopen(record, connection.actor);
		});
		this.#logger(`session ${sessionId} resumed by ${connection.actor}`);
		return { sessionId };
	}

	async #sessionClose(connection, params) {
		const session = this.#requireSessionParam(params);
		await this.#registry.admit(session, Command.close, connection.actor, async (record) => {
			await this.#disposeBackend(record, connection.actor);
			this.#registry.setState(record, SessionState.closed, "closed", connection.actor);
			this.#registry.commit(record, { actor: connection.actor, type: EventType.closed, data: {} });
		});
		this.#logger(`session ${session.sessionId} closed by ${connection.actor}`);
		return {};
	}

	async #sessionDelete(connection, params) {
		const session = this.#requireSessionParam(params);
		await this.#registry.admit(session, Command.delete, connection.actor, async (record) => {
			await this.#disposeBackend(record, connection.actor);
			this.#registry.commit(record, { actor: connection.actor, type: EventType.deleted, data: {} });
			this.#registry.forget(record.sessionId);
		});
		this.#logger(`session ${session.sessionId} deleted by ${connection.actor}`);
		return {};
	}

	async #sessionPrompt(connection, params, signal) {
		const session = this.#requireSessionParam(params);
		const content = params?.prompt;
		if (!Array.isArray(content) || content.length === 0) {
			throw invalidParams("session/prompt requires a non-empty prompt array", { field: "prompt" });
		}
		const text = promptToText(content);
		const turnId = `turn-${this.#log.lastEventId + 1}`;

		// Admission is quick and serialized: it moves the session to
		// `generating` and records the prompt. The turn itself then runs
		// *outside* the session queue, because `session/cancel` is another
		// command on that same queue — holding it for the turn's lifetime would
		// make cancellation impossible exactly when it is wanted. See
		// SessionRegistry#admit.
		await this.#registry.admit(session, Command.prompt, connection.actor, (record) => {
			const abort = new AbortController();
			record.turnId = turnId;
			record.turnAbort = abort;
			this.#registry.commit(record, {
				actor: connection.actor,
				type: EventType.prompt,
				data: { turnId, content, text },
			});
		});

		const abort = session.turnAbort;
		if (abort === undefined) {
			throw internalError(`session ${session.sessionId} was admitted but has no turn to run`, {
				type: "invariant_violation",
				sessionId: session.sessionId,
			});
		}
		const onRequestAbort = () => abort.abort();
		signal?.addEventListener("abort", onRequestAbort, { once: true });

		const agentActor = `agent:${session.sessionId}`;
		let stopReason = "end_turn";
		let failure;
		try {
			if (session.backendSession === undefined) {
				throw internalError(`session ${session.sessionId} has no backend handle`, {
					type: "no_backend",
					sessionId: session.sessionId,
				});
			}
			const outcome = await session.backendSession.prompt({
				content,
				signal: abort.signal,
				emit: (update) => this.#registry.emitUpdate(session, update, agentActor),
				requestPermission: (request) => this.#requestPermission(connection, session, request, abort.signal),
			});
			stopReason = outcome?.stopReason ?? "end_turn";
		} catch (error) {
			failure = error;
		} finally {
			signal?.removeEventListener("abort", onRequestAbort);
		}

		// Settlement re-enters the queue, so the return edge is ordered against
		// anything admitted while the turn ran — a `session/cancel` that landed
		// first has already moved the session to `cancelling`, and a
		// `session/close` has already taken it to `closing` and disposed the
		// backend. Overwriting those would be the silent-clobber bug in a new
		// costume, so each case is handled rather than assumed.
		await this.#registry.queue(session, () => {
			if (failure !== undefined) {
				this.#registry.commit(session, {
					actor: agentActor,
					type: EventType.error,
					data: { turnId, message: describe(failure) },
				});
			} else {
				this.#registry.commit(session, { actor: agentActor, type: EventType.turnEnd, data: { turnId, stopReason } });
			}
			if (session.state === SessionState.generating || session.state === SessionState.awaitingPermission || session.state === SessionState.cancelling) {
				session.turnId = undefined;
				session.turnAbort = undefined;
				this.#registry.setState(
					session,
					SessionState.idle,
					abort.signal.aborted ? "turn_cancelled" : failure === undefined ? "turn_complete" : "turn_failed",
					agentActor,
				);
			} else {
				// Closing or closed: teardown owns the state from here.
				session.turnId = undefined;
				session.turnAbort = undefined;
			}
		});

		if (failure === undefined) return { stopReason };
		// A cancelled turn is not a failure: ACP requires `cancelled` to be a
		// normal stop reason, so the request settles and the client shows a
		// stop rather than an error.
		if (abort.signal.aborted) return { stopReason: "cancelled" };
		throw internalError(`agent turn failed: ${describe(failure)}`, {
			type: "turn_failed",
			sessionId: session.sessionId,
			turnId,
		});
	}

	async #sessionCancel(connection, params) {
		const sessionId = params?.sessionId;
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			this.#logger("session/cancel without a sessionId was ignored");
			return;
		}
		const session = this.#registry.get(sessionId);
		if (session === undefined) {
			// A notification cannot be answered, so unknown ids are a no-op —
			// the stable schema's own wording for this method.
			this.#logger(`session/cancel for unknown session ${sessionId} was ignored`);
			return;
		}
		await this.#registry.admit(session, Command.cancel, connection.actor, async (record) => {
			record.backendSession?.cancel?.();
			record.turnAbort?.abort();
		});
	}

	// ── permission ───────────────────────────────────────────────────────────

	/**
	 * Ask the client for a permission decision, moving the session into
	 * `awaiting_permission` for exactly as long as the question is outstanding.
	 *
	 * The state is not bookkeeping: it is what makes `delete` and a second
	 * `prompt` refuse *during* the question, with a reason, instead of running
	 * concurrently with a turn that has not been authorised to continue.
	 *
	 * A client that answers `cancelled`, or a turn that is cancelled while the
	 * question is outstanding, resolves to `{optionId: null}` — distinct from a
	 * rejection, because "never answered" and "answered no" are different facts
	 * and a backend is entitled to treat them differently.
	 *
	 * @param {object} connection - the connection to ask.
	 * @param {SessionRecord} session - the session.
	 * @param {object} request - `{toolCall, options}`.
	 * @param {AbortSignal} signal - aborted when the turn is cancelled.
	 * @returns {Promise<{optionId: string|null}>} the client's decision.
	 */
	async #requestPermission(connection, session, request, signal) {
		const agentActor = `agent:${session.sessionId}`;
		const toolCallId = request?.toolCall?.toolCallId ?? `permission-${this.#log.lastEventId + 1}`;
		const options = request?.options ?? [
			{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
			{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
		];
		const pending = this.#registry.commit(session, {
			actor: agentActor,
			type: EventType.permission,
			data: { toolCallId, options, phase: "asked" },
		});
		this.#registry.setState(session, SessionState.awaitingPermission, "permission_requested", agentActor);

		let outcome = null;
		try {
			const response = await connection.request(
				CLIENT_METHODS.sessionRequestPermission,
				{
					sessionId: session.sessionId,
					toolCall: request?.toolCall ?? { toolCallId },
					options,
					_meta: { actor: agentActor, eventId: pending.eventId },
				},
				signal,
			);
			const answer = response?.outcome;
			if (answer?.outcome === "selected" && typeof answer.optionId === "string") {
				outcome = answer.optionId;
			}
		} catch (error) {
			// A cancelled turn makes the client answer with -32800, or makes the
			// request never come back at all. Either way the honest reading is
			// "no answer", not "no".
			this.#logger(`session/request_permission for ${session.sessionId} did not resolve: ${describe(error)}`);
			outcome = null;
		} finally {
			if (session.state === SessionState.awaitingPermission) {
				this.#registry.setState(session, SessionState.generating, "permission_answered", agentActor);
			}
		}
		this.#registry.commit(session, {
			actor: agentActor,
			type: EventType.permission,
			data: { toolCallId, optionId: outcome, phase: "answered" },
		});
		return { optionId: outcome };
	}

	// ── _dsh extensions ──────────────────────────────────────────────────────

	async #rename(connection, params) {
		const session = this.#requireSessionParam(params);
		const title = params?.title;
		if (typeof title !== "string" || title.trim() === "") {
			throw invalidParams("_dsh/session/rename requires a non-empty title", { field: "title" });
		}
		const trimmed = title.trim();
		return this.#registry.admit(session, Command.rename, connection.actor, async (record) => {
			const previous = record.title;
			record.title = trimmed;
			// The effect is published on the *stable* wire: `session_info_update`
			// is Completed in the ACP schema, so a client that has never heard
			// of `_dsh/` still sees the rename. The extension exists only
			// because stable ACP has no client→agent request for setting a
			// title — the stable surface only lets the agent announce one.
			const event = this.#registry.commit(record, {
				actor: connection.actor,
				type: EventType.title,
				data: { title: trimmed, previous: previous ?? null },
				frame: (eventId) =>
					notificationFrame(CLIENT_METHODS.sessionUpdate, {
						sessionId: record.sessionId,
						update: { sessionUpdate: "session_info_update", title: trimmed },
						_meta: { actor: connection.actor, eventId },
					}),
			});
			return { sessionId: record.sessionId, title: trimmed, eventId: event.eventId, previous: previous ?? null };
		});
	}

	async #archive(connection, params, archived) {
		const session = this.#requireSessionParam(params);
		const command = archived ? Command.archive : Command.unarchive;
		return this.#registry.admit(session, command, connection.actor, async (record) => {
			const previous = record.archived;
			record.archived = archived;
			const event = this.#registry.commit(record, {
				actor: connection.actor,
				type: archived ? EventType.archived : EventType.unarchived,
				data: { archived, previous },
				// No stable ACP update says "archived" — there is no such concept
				// in the protocol — so this one rides the extension namespace.
				frame: (eventId) =>
					notificationFrame(SESSION_CHANGED, {
						sessionId: record.sessionId,
						changed: ["archived"],
						archived,
						actor: connection.actor,
						eventId,
					}),
			});
			return { sessionId: record.sessionId, archived, eventId: event.eventId };
		});
	}

	async #fork(connection, params) {
		const session = this.#requireSessionParam(params);
		return this.#registry.admit(session, Command.fork, connection.actor, async (record) => {
			const headEventId = this.#log.lastEventId;
			const child = await this.#registry.create({
				cwd: record.cwd,
				actor: connection.actor,
				forkedFrom: record.sessionId,
			});
			await this.#registry.admit(child, Command.rename, connection.actor, async (target) => {
				const title = `${record.title ?? "session"} (fork)`;
				target.title = title;
				this.#registry.commit(target, {
					actor: connection.actor,
					type: EventType.title,
					data: { title, previous: null },
					frame: (eventId) =>
						notificationFrame(CLIENT_METHODS.sessionUpdate, {
							sessionId: target.sessionId,
							update: { sessionUpdate: "session_info_update", title },
							_meta: { actor: connection.actor, eventId },
						}),
				});
			});
			this.#registry.commit(record, {
				actor: connection.actor,
				type: EventType.forked,
				data: { childSessionId: child.sessionId, headEventId },
			});
			return { sessionId: child.sessionId, forkedFrom: record.sessionId, headEventId };
		});
	}

	async #state(connection, params) {
		const session = this.#requireSessionParam(params);
		return this.#registry.admit(session, Command.state, connection.actor, async (record) => {
			// Reading state is still a command, and still leaves a trace: an
			// observable-read event is what makes "who looked at this session,
			// and when" answerable from the log alone.
			this.#registry.commit(record, { actor: connection.actor, type: EventType.state, data: { read: true } });
			return record.toWire();
		});
	}

	async #replay(params) {
		const sessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined;
		const rawAfter = params?.after;
		const after = typeof rawAfter === "number" && Number.isFinite(rawAfter) ? Math.floor(rawAfter) : -1;
		const rawLimit = params?.limit;
		const limit = typeof rawLimit === "number" && rawLimit > 0 ? Math.min(Math.floor(rawLimit), REPLAY_LIMIT_MAX) : undefined;
		const events = this.#log.read({ sessionId, after, limit });
		const floor = this.#log.firstRetainedEventId;
		const gap = after >= 0 && after < floor - 1 ? { firstRetainedEventId: floor } : undefined;
		if (gap !== undefined) {
			this.#log.append({
				sessionId: sessionId ?? null,
				actor: "system:acp-control",
				type: EventType.gap,
				data: { requestedAfter: after, firstRetainedEventId: floor },
			});
		}
		return {
			events,
			lastEventId: this.#log.lastEventId,
			firstRetainedEventId: floor,
			...(gap === undefined ? {} : { gap }),
		};
	}

	// ── helpers ──────────────────────────────────────────────────────────────

	#requireSessionParam(params) {
		const sessionId = params?.sessionId;
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw invalidParams("a sessionId is required", { field: "sessionId" });
		}
		return this.#registry.require(sessionId);
	}

	async #disposeBackend(record, actor) {
		const backendSession = record.backendSession;
		record.backendSession = undefined;
		record.turnAbort?.abort();
		record.turnAbort = undefined;
		if (backendSession === undefined) return;
		try {
			await backendSession.dispose();
		} catch (error) {
			this.#registry.commit(record, {
				actor,
				type: EventType.error,
				data: { message: `backend dispose failed: ${describe(error)}` },
			});
		}
	}
}

/** A short, safe description of a thrown value. */
function describe(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * Convert anything thrown into a JSON-RPC error carrying `data.type`.
 *
 * The point is that no failure reaches a client as a bare string: a client
 * needs to know *which kind* of no it got — refused by state, unimplemented
 * here, malformed, or the server broke — and that distinction has to survive
 * the wire.
 */
function normalizeError(error, method) {
	if (error instanceof RpcError) return error;
	if (error?.name === "AbortError") return requestCancelled(`${method} was cancelled`, { method });
	return internalError(`${method} failed: ${describe(error)}`, { method });
}

/** True when a session is in a state where a command is admitted. */
export function admits(session, command) {
	return allows(command, session.state);
}
