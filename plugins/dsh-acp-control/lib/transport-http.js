/**
 * The loopback HTTP + SSE transport.
 *
 * Follows the shape of the ACP "Streamable HTTP & WebSocket Transport" RFD —
 * `POST` for client→server, a long-lived `GET` stream for server→client,
 * `Acp-Connection-Id` binding them — because that is the future stable path
 * and following it now makes migration mechanical. What the RFD does *not*
 * provide is replay: it states that in-flight messages are not replayed and
 * defers resumability to v2. That layer is added here (DESIGN.md §5), on top
 * of the RFD's shape rather than instead of it.
 *
 * ```
 * POST   /acp             one JSON-RPC message
 *                           initialize        → 200 + JSON body + Acp-Connection-Id
 *                           everything else   → 202 Accepted; the response arrives on the stream
 * GET    /acp/stream      SSE; ?after= / Last-Event-ID / ?session= / ?connection=
 * DELETE /acp             close the connection
 * GET    /healthz         liveness; unauthenticated; no data
 * ```
 *
 * ## Why the replay cannot race the live tail
 *
 * Attaching replays the backlog and switches to live delivery inside a single
 * synchronous block. Node runs JavaScript on one thread, so no event can be
 * appended between the last replayed frame and the first live one — the
 * classic "buffer during replay" dance is unnecessary, not merely omitted.
 * Replay and live delivery read the *same* `record.frame` object, so the two
 * paths cannot drift; there is only one path.
 *
 * ## Authentication is Goose's pattern
 *
 * Loopback by default, a random shared secret generated at boot when none is
 * configured, `X-Secret-Key` for HTTP clients, and `?token=` as well because a
 * browser's `EventSource` cannot set request headers — the same constraint
 * Goose hit, and the reason the query parameter is not a convenience but a
 * requirement. Comparison is timing-safe.
 *
 * @module dsh-acp-control/transport-http
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Connection } from "./connection.js";
import { encodeEventId, hasGap, isAfter, readCursor } from "./cursor.js";
import { classify, readChunk, serialize } from "./jsonrpc.js";

/** The longest a single request body may be before it is refused. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** SSE keep-alive interval; SSE through a proxy dies quietly without one. */
const HEARTBEAT_MS = 15_000;

/** How long a connection with no stream and no traffic is kept before it is reaped. */
const DEFAULT_IDLE_MS = 10 * 60_000;

/**
 * A connection whose server→client channel is an SSE response.
 *
 * Extends the base connection with three things the HTTP transport needs: a
 * cursor, a session filter, and the buffering of frames emitted before a
 * stream is attached.
 */
class SseConnection extends Connection {
	/** @type {import('node:http').ServerResponse|undefined} */
	stream;
	/** The session this stream is scoped to, when it is a session-scoped stream. */
	sessionFilter;
	/** Frames produced before a stream attached; only ever the pre-attach window. */
	pending = [];
	/** Last time this connection did anything, for idle reaping. */
	touchedAt = Date.now();
	#logger;
	#heartbeat;

	constructor(options) {
		super(options);
		this.#logger = options.logger ?? (() => {});
	}

	/**
	 * Write a frame, stamping the SSE `id:` field with the log position.
	 *
	 * The `id:` field is what makes a browser `EventSource` resend
	 * `Last-Event-ID` on reconnect without any client code — the cursor is
	 * carried by the transport the client already uses.
	 *
	 * A frame that did not come from the log (a direct response to a POST, a
	 * keep-alive) has no position and is written without an `id:`, which is
	 * correct: it is not replayable and must not move the client's cursor.
	 *
	 * @param {object} frame - the frame.
	 * @param {object} [record] - the log record, when the frame came from one.
	 */
	send(frame, record) {
		if (this.closed) return;
		// The extension gate, before anything is buffered or written. Checked
		// here as well as in the base class because this override is the whole
		// write path for an SSE connection.
		if (!this.allowsFrame(frame)) return;
		const sessionId = record?.sessionId ?? frame?.params?.sessionId;
		if (this.sessionFilter !== undefined && sessionId !== undefined && sessionId !== this.sessionFilter) return;
		if (this.sessionFilter !== undefined && sessionId === undefined && record !== undefined) return;
		if (this.stream === undefined || this.stream.writableEnded) {
			// No stream yet. A response to an in-flight POST still has to reach
			// the client when it attaches, so hold it. This window is per
			// connection and short; anything older is recovered from the log,
			// which is what survives a real disconnect.
			this.pending.push({ frame, record });
			if (this.pending.length > 512) this.pending.shift();
			return;
		}
		writeSse(this.stream, record?.eventId, frame);
	}

	/**
	 * Attach an SSE response and replay from a cursor.
	 *
	 * @param {import('node:http').ServerResponse} res - the response to stream on.
	 * @param {object} log - the event log.
	 * @param {object} query - `{after, sessionId, gapFirstRetainedEventId}`.
	 */
	attachStream(res, log, query) {
		// One stream per connection. A second attach is a reconnect, so the
		// previous stream is ended rather than left writing to a peer that has
		// moved on — two live streams on one connection would deliver every
		// frame twice, which is indistinguishable from a replay bug.
		if (this.stream !== undefined && !this.stream.writableEnded) {
			this.#logger(`connection ${this.id} re-attached; ending the previous stream`);
			this.stream.end();
		}
		clearInterval(this.#heartbeat);
		this.stream = res;
		this.sessionFilter = query.sessionId;
		this.touchedAt = Date.now();
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			// Tell nginx and friends not to buffer: a buffered SSE stream looks
			// exactly like a hung server, and the client has no way to tell.
			"x-accel-buffering": "no",
			"acp-connection-id": this.id,
		});
		res.write(`: dsh-acp-control ${this.id}\n\n`);

		if (query.gapFirstRetainedEventId !== undefined) {
			writeSse(res, undefined, {
				jsonrpc: "2.0",
				method: "_dsh/log/gap",
				params: { requestedAfter: query.after, firstRetainedEventId: query.gapFirstRetainedEventId },
			});
		}

		// Replay, then go live, with no await between them: see the module note.
		const missed = log.read({ sessionId: query.sessionId, after: query.after });
		let replayed = 0;
		for (const record of missed) {
			if (record.frame === undefined) continue;
			if (!isAfter(record.eventId, query.after)) continue;
			// The same extension gate the live path uses. Applying it at the
			// broadcaster only would hand a non-opted-in client the entire
			// `_dsh/*` history on reconnect — and it did, until this check
			// caught it.
			if (!this.allowsFrame(record.frame)) continue;
			writeSse(res, record.eventId, record.frame);
			replayed += 1;
		}
		for (const { frame, record } of this.pending) {
			if (record !== undefined) continue; // came from the log; already replayed
			writeSse(res, undefined, frame);
		}
		this.pending = [];

		this.#heartbeat = setInterval(() => {
			if (res.writableEnded) return;
			res.write(`: ping ${Date.now()}\n\n`);
		}, HEARTBEAT_MS);
		this.#heartbeat.unref?.();
		this.#logger(
			`stream attached to ${this.id}: replayed ${replayed} frame(s) after event ${query.after} ` +
				`(cursor from ${query.cursorSource ?? "none"})`,
		);

		const detach = () => {
			// Only if this response is *still* the current one. A re-attach
			// ends the previous stream and installs a new one, and the old
			// response's `close` fires afterwards — so an unguarded detach
			// clears the NEW stream and sends every subsequent live frame into
			// `pending`, where nobody reads it. Replay still works (it writes
			// straight to the response), so the symptom is a client that
			// reconnects, receives its backlog, and then goes silently deaf.
			if (this.stream !== res) return;
			clearInterval(this.#heartbeat);
			this.stream = undefined;
			this.touchedAt = Date.now();
			// The connection deliberately survives its stream: a client that
			// reconnects re-attaches with the same id and resumes from its
			// cursor. The cursor lives in the log, not in the connection, so
			// even a connection that is reaped loses nothing.
		};
		res.on("close", detach);
		res.on("error", detach);
		return { replayed };
	}

	close() {
		clearInterval(this.#heartbeat);
		if (this.stream !== undefined && !this.stream.writableEnded) this.stream.end();
		this.stream = undefined;
		super.close();
	}
}

/** Write one SSE frame. `id` is omitted when the frame has no log position. */
function writeSse(res, eventId, frame) {
	if (res.writableEnded) return;
	const encoded = encodeEventId(eventId);
	const id = encoded === undefined ? "" : `id: ${encoded}\n`;
	try {
		res.write(`${id}data: ${JSON.stringify(frame)}\n\n`);
	} catch {
		// The peer is gone; the 'close' handler owns cleanup.
	}
}

/**
 * Constant-time secret comparison.
 *
 * Both sides are hashed first so the comparison is over fixed-length buffers:
 * `timingSafeEqual` throws on length mismatch, and short-circuiting on length
 * would leak exactly the thing this is here to avoid.
 *
 * @param {string|undefined} provided - what the client sent.
 * @param {string} expected - the configured secret.
 * @returns {boolean} whether they match.
 */
export function secretMatches(provided, expected) {
	const a = createHash("sha256").update(String(provided ?? "")).digest();
	const b = createHash("sha256").update(String(expected)).digest();
	return timingSafeEqual(a, b);
}

/**
 * Generate the shared secret used when none is configured.
 * @returns {string} a 32-byte URL-safe secret.
 */
export function generateSecret() {
	return randomBytes(32).toString("base64url");
}

/**
 * Start the HTTP+SSE transport.
 *
 * @param {object} options - transport options.
 * @param {object} options.plane - the control plane.
 * @param {string} [options.host] - bind address; loopback by default.
 * @param {number} [options.port] - port; 0 asks the OS for a free one.
 * @param {string} [options.token] - the shared secret; generated when absent.
 * @param {string[]} [options.allowedOrigins] - browser origins allowed by CORS; empty means no CORS headers at all.
 * @param {number} [options.idleMs] - reap a connection after this long with no stream and no traffic.
 * @param {(message: string) => void} [options.logger] - diagnostics.
 * @returns {Promise<{port: number, host: string, token: string, url: string, acl: string, close: () => Promise<void>}>}
 */
export async function startHttpTransport({
	plane,
	host = "127.0.0.1",
	port = 7810,
	token,
	allowedOrigins = [],
	idleMs = DEFAULT_IDLE_MS,
	logger,
}) {
	const secret = typeof token === "string" && token.length > 0 ? token : generateSecret();
	const generated = token === undefined || token.length === 0;
	/** @type {Map<string, SseConnection>} */
	const connections = new Map();

	/** Reap connections that nobody is using, so a long-lived server does not leak. */
	const reaper = setInterval(() => {
		const now = Date.now();
		for (const [id, connection] of connections) {
			if (connection.stream !== undefined) continue;
			if (now - connection.touchedAt < idleMs) continue;
			logger?.(`reaping idle connection ${id}`);
			connection.close();
			connections.delete(id);
		}
	}, Math.max(30_000, Math.floor(idleMs / 2)));
	reaper.unref?.();

	/**
	 * Whether the request carries the secret, by header or query.
	 * @param {import('node:http').IncomingMessage} req - the request.
	 * @param {URL} url - the parsed URL.
	 * @returns {boolean} authorized.
	 */
	function authorized(req, url) {
		const header = req.headers["x-secret-key"];
		const fromHeader = Array.isArray(header) ? header[0] : header;
		if (typeof fromHeader === "string" && secretMatches(fromHeader, secret)) return true;
		const authorization = req.headers.authorization;
		if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
			if (secretMatches(authorization.slice(7).trim(), secret)) return true;
		}
		// Required for browsers: EventSource and WebSocket cannot set headers.
		const fromQuery = url.searchParams.get("token");
		if (fromQuery !== null && secretMatches(fromQuery, secret)) return true;
		return false;
	}

	/** Apply CORS only for explicitly allowed origins. */
	function applyCors(req, res) {
		const origin = req.headers.origin;
		if (typeof origin !== "string" || !allowedOrigins.includes(origin)) return false;
		res.setHeader("access-control-allow-origin", origin);
		res.setHeader("vary", "origin");
		res.setHeader("access-control-allow-headers", "content-type, x-secret-key, acp-connection-id, last-event-id");
		res.setHeader("access-control-allow-methods", "POST, GET, DELETE, OPTIONS");
		return true;
	}

	/** Read a request body with a hard cap. */
	function readBody(req) {
		return new Promise((resolve, reject) => {
			const chunks = [];
			let size = 0;
			req.on("data", (chunk) => {
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
			req.on("error", reject);
		});
	}

	/** Create a connection and, for `initialize`, answer inline. */
	async function handlePost(req, res, url) {
		let body;
		try {
			body = await readBody(req);
		} catch (error) {
			res.writeHead(413).end(String(error instanceof Error ? error.message : error));
			return;
		}
		const { frames, errors } = readChunk("", body.endsWith("\n") ? body : `${body}\n`);
		if (errors.length > 0 && frames.length === 0) {
			res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: errors[0].code, message: errors[0].message } }));
			return;
		}
		const first = frames[0];
		const kind = classify(first);

		if (kind.kind === "request" && first.method === "initialize") {
			// A fresh `initialize` always makes a fresh connection, so a client
			// that lost its id can simply start again — and because the replay
			// cursor lives in the log rather than in the connection, starting
			// again costs it nothing.
			const connection = new SseConnection({
				id: randomUUID(),
				transportName: "web",
				logger,
				write: () => {}, // the stream is the only server→client channel
			});
			connections.set(connection.id, connection);
			plane.attach(connection);
			let response = null;
			for (const frame of frames) {
				const produced = await connection.handle(plane, frame);
				if (produced !== null) response = produced;
			}
			res.writeHead(200, { "content-type": "application/json", "acp-connection-id": connection.id });
			res.end(JSON.stringify(response ?? { jsonrpc: "2.0", id: first.id, result: {} }));
			logger?.(`connection ${connection.id.slice(0, 8)} initialized from ${connection.actor} (${describePeer(req)})`);
			return;
		}

		const fromHeader = req.headers["acp-connection-id"];
		const headerValue = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
		const connectionId = String(headerValue ?? url.searchParams.get("connection") ?? "");
		const connection = connections.get(connectionId);
		if (connection === undefined) {
			res.writeHead(404, { "content-type": "application/json" }).end(
				JSON.stringify({ error: "unknown Acp-Connection-Id; POST initialize first", connectionId }),
			);
			return;
		}
		connection.touchedAt = Date.now();
		// 202 first, then dispatch: the RFD's contract is that a POST returns
		// immediately and the response arrives on the stream, so a client is
		// never blocked on a turn it started.
		res.writeHead(202).end();
		for (const frame of frames) {
			void connection
				.handle(plane, frame)
				.then((response) => {
					if (response !== null) connection.send(response);
				})
				.catch((error) => logger?.(`dispatch failed: ${String(error)}`));
		}
	}

	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
			const method = req.method ?? "GET";
			const cors = applyCors(req, res);

			if (method === "OPTIONS") {
				res.writeHead(cors ? 204 : 403).end();
				return;
			}
			if (method === "GET" && (url.pathname === "/healthz" || url.pathname === "/")) {
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
				return;
			}
			if (!authorized(req, url)) {
				res.writeHead(401, { "www-authenticate": "X-Secret-Key", "content-type": "application/json" }).end(
					JSON.stringify({ error: "unauthorized", hint: "send X-Secret-Key, Authorization: Bearer, or ?token=" }),
				);
				return;
			}

			if (method === "POST" && url.pathname === "/acp") {
				await handlePost(req, res, url);
				return;
			}

			if (method === "GET" && url.pathname === "/acp/stream") {
				const fromHeader = req.headers["acp-connection-id"];
				const headerValue = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
				const connectionId = String(headerValue ?? url.searchParams.get("connection") ?? "");
				const connection = connections.get(connectionId);
				if (connection === undefined) {
					res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "unknown Acp-Connection-Id" }));
					return;
				}
				// All cursor semantics live in lib/cursor.js — including the fact
				// that this field is unclaimed by v1 and may be assigned a
				// different meaning by v2. See that module's header.
				const cursor = readCursor({ url, headers: req.headers });
				const sessionId = url.searchParams.get("session") ?? undefined;
				const floor = plane.log.firstRetainedEventId;
				connection.attachStream(res, plane.log, {
					after: cursor.after,
					cursorSource: cursor.source,
					sessionId,
					gapFirstRetainedEventId: hasGap(cursor.after, floor) ? floor : undefined,
				});
				return;
			}

			if (method === "DELETE" && url.pathname === "/acp") {
				const fromHeader = req.headers["acp-connection-id"];
				const headerValue = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
				const connectionId = String(headerValue ?? url.searchParams.get("connection") ?? "");
				const connection = connections.get(connectionId);
				if (connection === undefined) {
					res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "unknown Acp-Connection-Id" }));
					return;
				}
				connection.close();
				plane.detach(connection);
				connections.delete(connectionId);
				res.writeHead(204).end();
				return;
			}

			res.writeHead(404, { "content-type": "application/json" }).end(
				JSON.stringify({ error: "no such route", routes: ["POST /acp", "GET /acp/stream", "DELETE /acp", "GET /healthz"] }),
			);
		})().catch((error) => {
			logger?.(`http handler failed: ${String(error)}`);
			if (!res.writableEnded) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "internal" }));
		});
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.removeAllListeners("error");
			server.on("error", (error) => logger?.(`socket error: ${String(error)}`));
			resolve();
		});
	});
	const address = server.address();
	const boundPort = typeof address === "object" && address !== null ? address.port : port;
	const acl = generated ? "generated" : "configured";
	logger?.(`http transport listening on http://${host}:${boundPort} (secret ${acl}, ${secret.length} chars)`);
	if (generated) {
		// Printed on purpose: an operator starting the server by hand needs to
		// find the secret, and this never goes to stdout during stdio service.
		logger?.(`X-Secret-Key: ${secret}`);
	}

	return {
		port: boundPort,
		host,
		token: secret,
		secretGenerated: generated,
		url: `http://${host}:${boundPort}/acp`,
		acl,
		connectionCount: () => connections.size,
		async close() {
			clearInterval(reaper);
			for (const connection of connections.values()) {
				connection.close();
				plane.detach(connection);
			}
			connections.clear();
			await new Promise((done) => {
				server.close(() => done());
				// `server.close()` only stops accepting; it waits for existing
				// sockets to go idle. An SSE stream and a client's keep-alive
				// socket are both not idle, so without this a shutdown hangs
				// until the peer gives up — which for a long-lived stream may be
				// never.
				server.closeAllConnections?.();
			});
		},
	};
}

/** A short description of the peer, for the boot log. */
function describePeer(req) {
	const forwarded = req.headers["x-forwarded-for"];
	const address = req.socket?.remoteAddress ?? "?";
	return typeof forwarded === "string" ? `${address} via ${forwarded}` : address;
}

/** Serialize a frame for the POST path, exported for checks. */
export { serialize };
