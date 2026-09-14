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
import { classifyResume } from "./cursor.js";
import { Command, SessionState, allows, availableCommands } from "./state.js";
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

/** Cap on how many replay events one call may return, so a cursor of -1 cannot flood a socket. */
const REPLAY_LIMIT_MAX = 5000;

/**
 * This plugin's idempotency key, inside the schema-sanctioned `params._meta`.
 *
 * DSH's own session API carries the same idea in `SessionPromptRequest.requestId`
 * ("client-minted identity persisted on the exact accepted user message"), so a
 * client-minted key is the ecosystem's established shape rather than an
 * invention of this plugin. Namespaced like every other extension key here.
 */
export const IDEMPOTENCY_KEY = "dsh-acp-control/idempotency-key";

/**
 * Methods whose repetition must not repeat the effect.
 *
 * `session/new` is absent deliberately: it has no session id to key on, and
 * creating a session twice is what a client asking twice means. Reads are
 * absent because running them twice is free.
 */
const IDEMPOTENT_METHODS = new Set([
	AGENT_METHODS.sessionPrompt,
	AGENT_METHODS.sessionCancel,
	AGENT_METHODS.sessionClose,
	AGENT_METHODS.sessionDelete,
	AGENT_METHODS.sessionResume,
	"_dsh/session/rename",
	"_dsh/session/archive",
	"_dsh/session/unarchive",
	"_dsh/session/fork",
]);

/** How many idempotency records to keep before evicting the oldest. */
const IDEMPOTENCY_MAX = 256;

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
	 * In-flight and settled idempotent operations, keyed
	 * `sessionId \0 clientKey`. Bounded by {@link IDEMPOTENCY_MAX}.
	 * @type {Map<string, Promise<any>>}
	 */
	#idempotency = new Map();

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

	/**
	 * Route one request, applying the idempotency key first when the client
	 * supplied one.
	 *
	 * A CP transport can deliver the same request twice — a retry after a
	 * dropped connection, a client that resends because it never saw the
	 * response — and without a key the second delivery simply runs again. For
	 * `session/prompt` that is not a duplicate response, it is a **second
	 * agent turn**: the first has already returned the session to `idle`, so
	 * the retry is admitted rather than refused. The key makes the retry
	 * re-observe the first outcome instead (DESIGN.md §5).
	 */
	async #request(connection, method, params, signal) {
		if (IDEMPOTENT_METHODS.has(method) && typeof params?.sessionId === "string") {
			return this.#idempotent(params.sessionId, params, () => this.#dispatchRequest(connection, method, params, signal));
		}
		return this.#dispatchRequest(connection, method, params, signal);
	}

	/**
	 * Run `operation` once per `(sessionId, client key)`.
	 *
	 * The promise is cached **before** it settles, so a duplicate that arrives
	 * while the first is still in flight joins it and observes the same
	 * outcome rather than racing it. A cached rejection is kept on purpose:
	 * the same key must yield the same answer, including a failure, or a client
	 * retrying a genuinely failed command would quietly turn it into a retry
	 * loop.
	 *
	 * The cache is bounded and evicted oldest-first, so a client that mints a
	 * fresh key per request cannot grow it without limit.
	 */
	#idempotent(sessionId, params, operation) {
		const key = params?._meta?.[IDEMPOTENCY_KEY];
		if (typeof key !== "string" || key.length === 0 || key.length > 200) return operation();
		const composite = `${sessionId}\u0000${key}`;
		const existing = this.#idempotency.get(composite);
		if (existing !== undefined) {
			this.#logger(`idempotent replay: ${sessionId} key ${JSON.stringify(key).slice(0, 60)}`);
			return existing;
		}
		const promise = operation();
		this.#idempotency.set(composite, promise);
		// A joined retry may be the only consumer of a rejection, so keep Node
		// from reporting it as unhandled while the original caller awaits it.
		promise.catch(() => {});
		while (this.#idempotency.size > IDEMPOTENCY_MAX) {
			const oldest = this.#idempotency.keys().next().value;
			this.#idempotency.delete(oldest);
		}
		return promise;
	}

	/** Route one request. */
	async #dispatchRequest(connection, method, params, signal) {
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
				return this.#listSessions(connection, params);
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
		// Stable `session/list` omits archived sessions, and omits subagent
		// sessions entirely. A standard client has no way to know that an entry
		// there is a delegated worker rather than a conversation, and would
		// reasonably read it as something it may prompt. `_dsh/session/list`
		// shows them, marked, for clients that asked for the extension.
		return this.#listSessions(connection, params, { includeArchived: false, includeSubagents: false });
	}


	async #listSessions(_connection, params, { includeArchived = true, includeSubagents = true } = {}) {
		const cwdFilter = typeof params?.cwd === "string" ? params.cwd : undefined;
		const backendSessions = await this.#registry.backend.list();
		// The *canonical* archived set, read fresh. Not a local flag: DSH owns
		// this fact, and keeping a copy here was two sources of truth for one
		// thing.
		const archivedIds = (await this.#registry.archivedIds()) ?? new Set();

		const byId = new Map();
		for (const summary of backendSessions) {
			byId.set(summary.sessionId, {
				sessionId: summary.sessionId,
				cwd: summary.cwd ?? "/",
				title: summary.title ?? null,
				updatedAt: summary.updatedAt ?? null,
				// A persisted session with no live agent is `closed` because it
				// *is* closed, which is a fact about the session rather than a
				// verdict on this plugin's ability to touch it.
				state: SessionState.closed,
				live: false,
				attached: false,
				kind: summary.kind ?? "ordinary",
				controllable: summary.controllable !== false,
				...(summary.controllable === false ? { reason: summary.reason } : {}),
			});
		}
		for (const session of this.#registry.all()) {
			const existing = byId.get(session.sessionId);
			byId.set(session.sessionId, {
				...(existing ?? {}),
				sessionId: session.sessionId,
				cwd: session.cwd,
				// **The host's title wins**, and this record's is the fallback.
				// It used to be the other way round, which made this a stale
				// second source of truth for one fact: rename the session in the
				// GUI and `session/list` kept showing the title this control
				// plane last wrote, with nothing to correct it. `existing.title`
				// is the *canonical* title, read fresh from the host on this
				// call; `session.title` is a cache, kept current by
				// `SessionRegistry#observe` for the window before that read.
				title: existing?.title ?? session.title ?? null,
				updatedAt: session.updatedAt,
				state: session.state,
				live: session.backendSession !== undefined,
				attached: true,
				owned: session.adopted === false,
				kind: "ordinary",
				controllable: true,
			});
		}
		// A session this control plane has *not* attached to, but knows is live.
		// Subagents are marked rather than hidden here, because this is the
		// extension list and hiding them would make the control plane's view of
		// the process a lie.
		for (const entry of (await this.#registry.backend.live?.()) ?? []) {
			const existing = byId.get(entry.sessionId);
			byId.set(entry.sessionId, {
				...(existing ?? { cwd: entry.cwd ?? "/", title: null, updatedAt: null }),
				sessionId: entry.sessionId,
				state: existing?.state ?? (entry.status === "running" ? SessionState.generating : SessionState.idle),
				live: true,
				attached: existing?.attached ?? false,
				adoptable: existing?.attached !== true && entry.controllable !== false,
				kind: entry.kind ?? existing?.kind ?? "ordinary",
				controllable: entry.controllable !== false,
			});
		}

		const sessions = [...byId.values()]
			.map((session) => ({ ...session, archived: archivedIds.has(session.sessionId) }))
			.filter((session) => (includeSubagents ? true : (session.kind ?? "ordinary") !== "subagent"))
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

		// Already ours: the ordinary reopen path.
		const known = this.#registry.get(sessionId);
		if (known !== undefined) {
			// A session that is already live here is *already attached*, so
			// resuming it is a no-op that succeeds rather than a refusal. This
			// matters because adoption is automatic: the plugin attaches a live
			// session the moment it appears, so a client that then says "attach
			// me to this session id" is asking for something already true.
			// Refusing with "already open here" would be technically accurate
			// and completely misleading.
			if (known.backendSession !== undefined) {
				this.#logger(`session ${sessionId} is already attached; resume is a no-op for ${connection.actor}`);
				return { sessionId, attached: true, alreadyAttached: true, state: known.state };
			}
			await this.#registry.admit(known, Command.resume, connection.actor, async (record) => {
				await this.#registry.reopen(record, connection.actor);
			});
			this.#logger(`session ${sessionId} resumed by ${connection.actor}`);
			return { sessionId, attached: false };
		}

		// Unknown here. If a real agent already exists, this is attachment —
		// the operation the whole plugin exists for — and it must come *before*
		// any resume, because resuming a session another frontend is driving
		// would create a second owner of one conversation.
		// A session that is not a person's conversation is refused outright
		// rather than adopted: an external client driving a subagent would be
		// operating a delegated worker, not a conversation.
		const verdict = this.#registry.backend.classify?.(sessionId);
		if (verdict?.kind === "subagent") {
			throw new RpcError(ErrorCode.refused, `session ${sessionId} belongs to subagent routing`, {
				type: "subagent_owned",
				command: "resume",
				sessionId,
				reason: verdict.reason,
				hint: "subagent sessions appear in _dsh/session/list with controllable:false, and are never driven from here",
			});
		}

		// If a real agent already exists this is attachment — the operation the
		// whole plugin exists for — and it must come *before* any resume,
		// because resuming a session another frontend is driving would create a
		// second owner of one conversation.
		const attached = await this.#attach(sessionId, connection.actor, params?.cwd);
		if (attached !== undefined) {
			this.#logger(`session ${sessionId} attached by ${connection.actor} (a live agent already existed)`);
			return { sessionId, attached: true, state: attached.state };
		}

		// Nothing is live. Whether resuming a persisted session is safe depends
		// on whether this process can *see* live agents: if it can, a missing
		// one is evidence that nothing holds the session; if it cannot, saying
		// "nobody has it" would be a guess, and guessing wrong produces two
		// owners of one conversation.
		if (this.#registry.backend.observesLiveAgents !== true) {
			throw new RpcError(
				ErrorCode.refused,
				`session ${sessionId} is not attached here and this server cannot see live agents`,
				{
					type: "cannot_attach",
					command: "resume",
					sessionId,
					reason:
						"this control plane has no view of live agents in the process that owns the session, so it cannot tell whether resuming it would create a second owner of a conversation someone else is already driving",
					hint:
						"run the plugin inside the DSH profile that holds the session (its Cordis plugin, index.js), where attachment is possible; a standalone server deliberately refuses instead of racing",
				},
			);
		}

		// Cold, and this process can see live agents — so nothing holds it. Ask
		// the *host's own* controller to resolve it rather than calling
		// `agents.resume` directly: `sessionController.resolveAgent` is the
		// deduplicating authority the GUI also goes through, so a GUI resume and
		// an ACP resume of the same id converge on one agent instead of racing
		// to create two.
		const resolved = await this.#registry.backend.canonical?.resolveAgent?.(sessionId);
		if (resolved?.refused !== undefined) {
			throw new RpcError(ErrorCode.resourceNotFound, `the host could not open session ${sessionId}`, {
				type: "not_found",
				command: "resume",
				sessionId,
				reason: String(resolved.refused?.message ?? resolved.refused),
				hostCode: resolved.refused?.code,
			});
		}
		if (resolved?.ok === true) {
			const nowLive = await this.#attach(sessionId, connection.actor, params?.cwd);
			if (nowLive !== undefined) {
				this.#logger(`session ${sessionId} resolved through the host controller and attached by ${connection.actor}`);
				return { sessionId, attached: true, resolvedCold: true, state: nowLive.state };
			}
		}

		// Otherwise this must be a session this control plane recovered from its
		// own log: no live agent, and nothing else that could hold it. An id we
		// have never seen is genuinely unknown, and saying so is the honest
		// answer — the previous revision called `require()` here, which threw
		// `not_found` for the very id the branch existed to import.
		const recovered = this.#registry.get(sessionId);
		if (recovered === undefined) {
			throw notFound(`unknown session: ${sessionId}`, { sessionId });
		}
		await this.#registry.admit(recovered, Command.resume, connection.actor, async (record) => {
			await this.#registry.reopen(record, connection.actor);
		});
		this.#logger(`session ${sessionId} resumed by ${connection.actor}`);
		return { sessionId, attached: false };
	}

	/**
	 * Adopt a live session into the registry, or report that nothing is live.
	 *
	 * One place, so `session/resume` and the automatic adoption in `index.js`
	 * cannot drift into adopting different things.
	 *
	 * @returns {Promise<object|undefined>} the record, or undefined when there is nothing adoptable.
	 */
	async #attach(sessionId, actor, cwd) {
		if (this.#registry.backend.classify?.(sessionId)?.kind === "subagent") return undefined;
		const live = await this.#registry.backend.live?.();
		const entry = live?.find((candidate) => candidate.sessionId === sessionId);
		return await this.#registry.attach({
			sessionId,
			cwd: cwd ?? entry?.cwd,
			state: entry?.status === "running" ? SessionState.generating : SessionState.idle,
			actor,
		});
	}

	async #sessionClose(connection, params) {
		const session = this.#requireSessionParam(params);
		// An **adopted** session is someone else's, and this control plane holds
		// only a borrowed view of it. Closing that view while a turn this
		// connection authored is running is a refusal rather than a race: the
		// view is what observes the turn's `turn/end`, and the prompt waiting on
		// it would be left with no way to settle while `_dsh/session/state` said
		// `closed`. The caller can stop its own turn first, which is a thing it
		// can actually decide.
		//
		// A session this plugin *created* is not refused: closing it disposes
		// the agent, which is the ending the turn was always going to have, and
		// the backend settles the waiting request as part of that teardown.
		if (session.adopted === true && session.backendSession?.ownsTurn?.() === true) {
			const refusal = new RpcError(ErrorCode.refused, `session ${session.sessionId} is running a turn this connection started`, {
				type: "refused",
				command: "close",
				sessionId: session.sessionId,
				state: session.state,
				allowedIn: [SessionState.idle, SessionState.closed, SessionState.failed],
				reason:
					"closing now would tear down the only view that can observe this turn ending, leaving the prompt that is waiting on it with nothing to settle it",
				hint: "send session/cancel and wait for the turn to end, then close",
			});
			this.#registry.refuse(session, "close", connection.actor, refusal.data);
			throw refusal;
		}
		await this.#registry.admit(session, Command.close, connection.actor, async (record) => {
			await this.#disposeBackend(record, connection.actor);
			await this.#registry.setStateDurable(record, SessionState.closed, "closed", connection.actor);
			this.#registry.commit(record, { actor: connection.actor, type: EventType.closed, data: {} });
		});
		this.#logger(`session ${session.sessionId} closed by ${connection.actor}`);
		return {};
	}

	/**
	 * Delete a session's record from this control plane.
	 *
	 * **This is plugin-local, and it is not a host operation.** DSH has no
	 * "delete a session" method — `WorkspaceDeleteRequest` deletes a
	 * *workspace*, and the only `_deleteSession` is private inside
	 * `dsh-session-query-sqlite` — so this removes *this plugin's* record and
	 * nothing else. The wording matters: calling it parity with the GUI would
	 * be a lie.
	 *
	 * Which is why it **refuses a live session**. If an agent is behind the
	 * session, another frontend is showing it right now; reporting a successful
	 * delete while the human still has the conversation open on screen is
	 * exactly the "accepted and discarded" shape this project exists to
	 * eliminate. The refusal names the way out — close it first.
	 */
	async #sessionDelete(connection, params) {
		const session = this.#requireSessionParam(params);
		if (session.backendSession !== undefined) {
			const refusal = new RpcError(ErrorCode.refused, `session ${session.sessionId} is live and cannot be deleted from here`, {
				type: "refused",
				command: "delete",
				sessionId: session.sessionId,
				state: session.state,
				allowedIn: [],
				reason:
					session.adopted === true
						? "another frontend created this agent and is still showing the session; deleting the record here would leave the GUI displaying a conversation this control plane claims no longer exists"
						: "this control plane still holds a live agent for the session",
				hint: "close the session first, which releases the agent without touching the host's own session store",
			});
			// Recorded through the same path a table refusal uses, so a refusal
			// decided outside `admit` is exactly as audible as one decided by
			// it — otherwise the loudest refusal in the system would be the one
			// nothing logged.
			this.#registry.refuse(session, "delete", connection.actor, refusal.data);
			throw refusal;
		}
		await this.#registry.admit(session, Command.delete, connection.actor, async (record) => {
			this.#registry.commit(record, { actor: connection.actor, type: EventType.deleted, data: { scope: "acp-control-only" } });
			this.#registry.forget(record.sessionId);
		});
		this.#logger(`session ${session.sessionId} deleted from this control plane by ${connection.actor} (host state untouched)`);
		return { sessionId: session.sessionId, scope: "acp-control-only" };
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
		let ownedTurn;
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
			// Which DSH turn this request actually ran as, when the backend can
			// say. It is what makes the settlement below turn-aware, and it is
			// the difference between one state machine and two.
			ownedTurn = outcome?.turn;
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
		await this.#registry.queue(session, async () => {
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
				// **Turn-aware.** DSH runs queued turns back to back with no
				// Agent-idle between them (`while (await this.turn()) {}`), so
				// by the time this request settles, the `generating` in front
				// of it may already belong to the *next* turn — the human's,
				// queued while ours ran. Clearing that would do two things at
				// once: make `_dsh/session/state` describe a working session as
				// idle, and let the next ACP prompt pass the idle-only
				// admission check and be *queued behind the human's turn*,
				// which the policy says must be refused.
				//
				// So the return edge is applied only while the running DSH turn
				// is still the one this request owned. When it is not, DSH's
				// own `turn/start` stays the authority for `generating` — one
				// state machine, rather than two that agree by luck.
				//
				// Deliberately the *non*-durable variant, and the one place
				// that is right. This is a turn return edge, not a command edge:
				// the work has already happened, and the session must come back
				// to rest regardless of the disk. Blocking the movement on a
				// write that may have failed would strand the session in
				// `generating` — a worse outcome than a state change that
				// outlives a log entry. The flush below still fails the *prompt
				// response* if the turn's events did not persist, so the client
				// is not told the turn succeeded.
				const anotherTurnIsRunning =
					ownedTurn !== undefined && session.observedTurn !== undefined && session.observedTurn !== ownedTurn;
				if (anotherTurnIsRunning) {
					this.#logger(
						`session ${session.sessionId}: turn ${String(ownedTurn)} settled while DSH turn ${String(session.observedTurn)} is running; the state belongs to that turn, not to this request`,
					);
				} else {
					this.#registry.setState(
						session,
						SessionState.idle,
						abort.signal.aborted ? "turn_cancelled" : failure === undefined ? "turn_complete" : "turn_failed",
						agentActor,
					);
				}
			}
			// Released on every path, including "closing or closed", where
			// teardown owns the state from here: these handles belong to *this*
			// request, and leaving them set would strand the session.
			session.turnId = undefined;
			session.turnAbort = undefined;
			// The turn's own streamed updates were appended as they happened and
			// are on the same write chain, so awaiting it here means the client
			// is not told the turn ended until the turn's events are durable.
			await this.#log.flush().catch((error) => {
				throw internalError(
					`the turn ended but its events could not be written to the log: ${error instanceof Error ? error.message : String(error)}`,
					{ type: "durability_failed", sessionId: session.sessionId, turnId, logPath: this.#log.path },
				);
			});
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
		// Ownership is checked *before* admission, because admission applies the
		// `generating → cancelling` edge. A backend that can say which turn is
		// running is asked first: cancelling a turn this control plane did not
		// start would stop the human's work, and moving the session to
		// `cancelling` on the way to discovering that would leave the state
		// machine describing a cancellation that never happened.
		const ownsTurn = session.backendSession?.ownsTurn;
		if (typeof ownsTurn === "function" && ownsTurn.call(session.backendSession) !== true) {
			const reason =
				"the agent is running a turn this control plane did not start, so cancelling here would stop someone else's work";
			this.#registry.refuse(session, "cancel", connection.actor, { state: session.state, reason, allowedIn: [] });
			this.#logger(`session/cancel for ${sessionId} refused: ${reason}`);
			return;
		}

		await this.#registry.admit(session, Command.cancel, connection.actor, async (record) => {
			// The cancellation is recorded before it is performed, so a cancel
			// that was asked for is never invisible.
			this.#registry.commit(record, {
				actor: connection.actor,
				type: EventType.cancel,
				data: { turnId: record.turnId ?? null },
			});
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
		await this.#registry.setStateDurable(session, SessionState.awaitingPermission, "permission_requested", agentActor);

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
				await this.#registry.setStateDurable(session, SessionState.generating, "permission_answered", agentActor);
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

		// The host is authoritative for a title, and it is asked **first among
		// the effects** — but it is asked *inside* the admitted effect, after
		// the state check. Asking before admission meant a rename that arrived
		// while the session was closing changed the GUI's title and *then* told
		// the caller it had been refused: the third outcome — refused, but
		// applied — that this whole plugin exists to make impossible.
		//
		// The capability check stays outside, because it mutates nothing: a
		// backend with no canonical rename can be told so without entering the
		// state machine at all.
		const canonical = this.#registry.backend.canonical?.rename;
		if (canonical === undefined) {
			throw methodNotFound("_dsh/session/rename", { reason: "this backend has no canonical rename to delegate to" });
		}

		// Hoisted out of the effect so the `partially_applied` report below can
		// name the title the host actually accepted, rather than the one that
		// was asked for.
		let accepted = trimmed;
		try {
			return await this.#registry.admit(session, Command.rename, connection.actor, async (record) => {
				const outcome = await canonical(session.sessionId, trimmed);
				if (outcome?.unavailable !== undefined) {
					throw new RpcError(ErrorCode.methodNotFound, `rename is unavailable here: ${outcome.unavailable}`, {
						type: "unavailable",
						command: "rename",
						sessionId: session.sessionId,
						reason: outcome.unavailable,
					});
				}
				// The host's accepted title, not the one that was asked for: a
				// host may normalise, truncate, or resolve a conflict.
				accepted = typeof outcome?.title === "string" && outcome.title.length > 0 ? outcome.title : trimmed;
				const previous = record.title;
				// Commit, then mutate. Assigning first meant a failed append — a
				// durability failure, say — left the title changed while the
				// caller was told the rename failed.
				//
				// The effect is published on the *stable* wire:
				// `session_info_update` is Completed in the ACP schema, so a
				// client that has never heard of `_dsh/` still sees the rename.
				const event = this.#registry.commit(record, {
					actor: connection.actor,
					type: EventType.title,
					data: { title: accepted, previous: previous ?? null, hostSeq: outcome?.seq },
					frame: (eventId) =>
						notificationFrame(CLIENT_METHODS.sessionUpdate, {
							sessionId: record.sessionId,
							update: { sessionUpdate: "session_info_update", title: accepted },
							_meta: { actor: connection.actor, eventId },
						}),
				});
				await this.#registry.durable("the rename");
				record.title = accepted;
				return { sessionId: record.sessionId, title: accepted, eventId: event.eventId, previous: previous ?? null };
			});
		} catch (error) {
			// The host rename and this log cannot be one transaction, so the
			// failure is reported as what it is rather than disguised. Rolling
			// the host back is deliberately not attempted: the host has already
			// published the new title to every other frontend, and undoing it
			// would be a second racing write.
			if (error?.data?.type === "durability_failed" || error?.data?.type === "invariant_violation") {
				throw new RpcError(ErrorCode.internalError, "the host accepted the new title but this control plane could not record it", {
					type: "partially_applied",
					command: "rename",
					sessionId: session.sessionId,
					hostApplied: true,
					hostTitle: accepted,
					reason: error.message,
					hint: "the title is live in DSH; this control plane's own log is behind and resyncs from the host on the next session/list",
				});
			}
			throw error;
		}
	}

	async #archive(connection, params, archived) {
		const session = this.#requireSessionParam(params);
		const command = archived ? Command.archive : Command.unarchive;
		const canonical = this.#registry.backend.canonical?.[archived ? "archive" : "unarchive"];
		if (canonical === undefined) {
			throw methodNotFound(archived ? "_dsh/session/archive" : "_dsh/session/unarchive", {
				reason: "this backend has no canonical archive to delegate to",
			});
		}
		return this.#registry.admit(session, command, connection.actor, async (record) => {
			// Delegated, never mirrored. DSH keeps archive as a workspace-scoped
			// set of session ids behind `workspaceRegistry`; this plugin used to
			// keep its own `archived` flag beside it, which is two sources of
			// truth for one fact. The canonical call is the only write, and the
			// event below is a *record of the delegation*, not a second copy.
			const outcome = await canonical(record.sessionId);
			if (outcome?.unavailable !== undefined) {
				throw new RpcError(
					ErrorCode.methodNotFound,
					`${archived ? "archive" : "unarchive"} is unavailable here: ${outcome.unavailable}`,
					{ type: "unavailable", command: archived ? "archive" : "unarchive", sessionId: record.sessionId, reason: outcome.unavailable },
				);
			}
			const event = this.#registry.commit(record, {
				actor: connection.actor,
				type: archived ? EventType.archived : EventType.unarchived,
				data: { archived, delegatedTo: "workspaceController.archiveSession", archivedSessionIds: outcome?.archivedSessionIds },
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

	/**
	 * Fork through the host, or not at all.
	 *
	 * The previous implementation created an empty child carrying a lineage
	 * marker and called it a fork. DSH's canonical fork is a materially
	 * different operation — it picks a completed-turn boundary, copies the
	 * parent's event prefix, preserves lineage, and attaches the child to the
	 * workspace — so offering the second under the first's name promised one
	 * thing and did another. A warning would not fix that; the method is
	 * disabled until it delegates.
	 */
	async #fork(connection, params) {
		const session = this.#requireSessionParam(params);
		const canonical = this.#registry.backend.canonical?.fork;
		if (canonical === undefined) {
			throw methodNotFound("_dsh/session/fork", { reason: "this backend has no canonical fork to delegate to" });
		}
		const outcome = await canonical(session.sessionId, params?.atEventId);
		if (outcome?.unavailable !== undefined) {
			throw new RpcError(ErrorCode.methodNotFound, `fork is unavailable here: ${outcome.unavailable}`, {
				type: "unavailable",
				command: "fork",
				sessionId: session.sessionId,
				reason: outcome.unavailable,
			});
		}
		// The host did the forking; this records that it happened, under the
		// transition table, so the `idle`-only rule still holds for any backend
		// that can actually fork.
		return await this.#registry.admit(session, Command.fork, connection.actor, async (record) => {
			this.#registry.commit(record, {
				actor: connection.actor,
				type: EventType.forked,
				data: { childSessionId: outcome.sessionId },
			});
			return { sessionId: outcome.sessionId, forkedFrom: record.sessionId };
		});
	}

	async #state(connection, params) {
		const session = this.#requireSessionParam(params);
		// Routed through `admit` so the transition table stays the single place
		// that decides what is permitted, but it is a READ_ONLY_COMMAND: it
		// commits nothing. It used to append a `{read: true}` event, which
		// bumped the session's `updatedAt` and could reorder `session/list` —
		// so polling a session made it look active.
		return this.#registry.admit(session, Command.state, connection.actor, async (record) => {
			const state = record.toWire();
			return {
				...state,
				// The admitted commands are derived from the same table that
				// admitted this read, so a client never has to hardcode the
				// rules to decide what to enable.
				availableCommands: availableCommands(state.state),
			};
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
		// The bounds are captured **before** the diagnostic below is appended.
		// Reporting `lastEventId` afterwards would describe a log that already
		// includes the notice about the log, so the number a client uses as its
		// next cursor would not be the number it was told about.
		const head = this.#log.lastEventId;
		// A cursor can be wrong in two directions, and the one that looks like
		// success is the dangerous one: a client holding a cursor from before a
		// crash that lost the tail of the log is *ahead* of the recovered
		// high-water mark, so it is told "nothing to replay", receives only new
		// events numbered above its cursor, and silently never sees the gap.
		// `classifyResume` reports whichever applies, with the remedy.
		const resume = classifyResume(after, { firstRetainedEventId: floor, lastEventId: head });
		if (resume.kind !== "ok") {
			this.#log.append({
				sessionId: sessionId ?? null,
				actor: "system:acp-control",
				type: EventType.gap,
				data: { requestedAfter: after, ...resume },
			});
		}
		return {
			events,
			lastEventId: head,
			firstRetainedEventId: floor,
			...(resume.kind === "ok" ? {} : { gap: resume }),
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
