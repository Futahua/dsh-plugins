/**
 * The connection abstraction both transports implement.
 *
 * A connection is everything the control plane needs from a peer and nothing
 * more: somewhere to write frames, a way to ask a question and await the
 * answer, and a per-request cancellation signal. `lib/server.js` never learns
 * whether it is talking to a pipe or a socket, which is why the same protocol
 * core serves stdio and HTTP+SSE with no branching.
 *
 * @module dsh-acp-control/connection
 */

import { randomUUID } from "node:crypto";
import { PROTOCOL_METHODS, RpcError, ErrorCode, requestCancelled } from "./jsonrpc.js";

/**
 * One peer.
 *
 * Request/response correlation is per connection, because JSON-RPC ids are
 * only meaningful within a connection. Agent→client requests (the permission
 * prompt) get ids from a separate counter, so an agent request can never be
 * confused with a client request.
 */
export class Connection {
	/** @type {string} */
	id;
	/** @type {string} the transport's short name, used for the actor fallback. */
	transportName;
	/** @type {string} who this peer is; `human:<client>` after `initialize`. */
	actor;
	/** @type {boolean} whether the peer opted into the `_dsh/` namespace. */
	extensions = false;
	/** @type {object|undefined} `initialize.params.clientInfo`, kept for diagnostics. */
	clientInfo;
	/** @type {boolean} */
	closed = false;

	#write;
	#logger;
	#pending = new Map();
	#inflight = new Map();
	#nextRequestId = 1;

	/**
	 * @param {object} options - connection options.
	 * @param {(frame: object) => void} options.write - put one frame on the wire.
	 * @param {string} options.transportName - `stdio` or `web`.
	 * @param {(message: string) => void} [options.logger] - diagnostics.
	 * @param {string} [options.id] - supply an id (the HTTP transport does, so a client can name it).
	 */
	constructor({ write, transportName, logger, id }) {
		this.#write = write;
		this.#logger = logger ?? (() => {});
		this.transportName = transportName;
		this.id = id ?? randomUUID();
		this.actor = `human:${transportName}`;
	}

	/**
	 * Write one frame.
	 *
	 * `record` is accepted and ignored here; the HTTP transport overrides this
	 * to stamp the SSE `id:` field with the event's log position, which is what
	 * lets a browser's `EventSource` resume from the right place for free.
	 *
	 * @param {object} frame - the frame to send.
	 * @param {object} [record] - the log record it came from, when it came from one.
	 */
	send(frame, record) {
		if (this.closed) return;
		try {
			this.#write(frame);
		} catch (error) {
			this.#logger(`write failed on ${this.id}: ${String(error)}`);
			this.closed = true;
		}
	}

	/**
	 * Send a notification.
	 * @param {string} method - the method name.
	 * @param {object} params - the params.
	 */
	notify(method, params) {
		this.send({ jsonrpc: "2.0", method, params });
	}

	/**
	 * Ask the peer a question and await its answer.
	 *
	 * `signal` is how a cancelled turn stops waiting: the pending entry is
	 * removed and the promise rejects, so a client that never answers cannot
	 * hold a session in `awaiting_permission` forever. A late answer for a
	 * removed id is dropped rather than mis-delivered.
	 *
	 * @param {string} method - the method name.
	 * @param {object} params - the params.
	 * @param {AbortSignal} [signal] - aborts the wait.
	 * @returns {Promise<any>} the peer's `result`.
	 */
	request(method, params, signal) {
		if (this.closed) {
			return Promise.reject(requestCancelled(`connection ${this.id} is closed`, { method }));
		}
		const id = `s${this.#nextRequestId++}`;
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				this.#pending.delete(id);
				reject(requestCancelled(`${method} was cancelled before the client answered`, { method }));
			};
			if (signal?.aborted === true) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#pending.set(id, {
				resolve: (value) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(value);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
			});
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	/**
	 * Resolve a pending agent→client request from an inbound response frame.
	 * @param {object} frame - the response frame.
	 * @returns {boolean} whether it matched something outstanding.
	 */
	acceptResponse(frame) {
		const entry = this.#pending.get(frame.id);
		if (entry === undefined) return false;
		this.#pending.delete(frame.id);
		if (frame.error !== undefined) {
			entry.reject(new RpcError(frame.error.code ?? ErrorCode.internalError, frame.error.message ?? "peer error", frame.error.data));
		} else {
			entry.resolve(frame.result);
		}
		return true;
	}

	/**
	 * Record the peer's identity and extension opt-in.
	 * @param {object} input - `{actor, extensions, clientInfo}`.
	 */
	negotiate({ actor, extensions, clientInfo }) {
		if (typeof actor === "string" && actor.length > 0) this.actor = actor;
		this.extensions = extensions === true;
		this.clientInfo = clientInfo;
	}

	/**
	 * Give a caller a signal tied to one inbound request id.
	 *
	 * This is what implements `$/cancel_request` and a stream abort for
	 * `session/prompt`: the caller passes the signal into the command, and a
	 * later `$/cancel_request` naming that id aborts it.
	 *
	 * @param {string|number} id - the inbound request id.
	 * @returns {AbortSignal} the signal.
	 */
	signalFor(id) {
		const key = String(id);
		let entry = this.#inflight.get(key);
		if (entry === undefined) {
			entry = new AbortController();
			this.#inflight.set(key, entry);
		}
		return entry.signal;
	}

	/** Release a request's signal once its response has been produced. */
	releaseRequest(id) {
		this.#inflight.delete(String(id));
	}

	/**
	 * Dispatch one inbound frame, handling the protocol-level cancellation
	 * method here rather than in the plane — cancellation is a transport
	 * concern, and the plane should never see it.
	 *
	 * @param {object} plane - the control plane.
	 * @param {object} frame - the parsed frame.
	 * @returns {Promise<object|null>} the response frame, if any.
	 */
	async handle(plane, frame) {
		if (frame?.method === PROTOCOL_METHODS.cancelRequest && frame.id === undefined) {
			const target = frame.params?.requestId;
			const entry = this.#inflight.get(String(target));
			if (entry === undefined) {
				this.#logger(`$/cancel_request for unknown request ${String(target)} was ignored`);
				return null;
			}
			entry.abort();
			return null;
		}
		const response = await plane.dispatch(this, frame);
		if (response !== null) this.releaseRequest(frame.id);
		return response;
	}

	/** Fail every outstanding question and stop writing. */
	close() {
		if (this.closed) return;
		this.closed = true;
		for (const [id, entry] of this.#pending) {
			this.#pending.delete(id);
			entry.reject(requestCancelled(`connection ${this.id} closed`, { pendingRequest: id }));
		}
		for (const controller of this.#inflight.values()) controller.abort();
		this.#inflight.clear();
	}
}
