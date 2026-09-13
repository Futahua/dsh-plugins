#!/usr/bin/env node
/**
 * Slice-1 check B: the loopback HTTP+SSE transport, driven over a real socket.
 *
 * The server is started in-process — a real `node:http` listener on a real
 * loopback port — and driven with real `fetch` calls, so nothing here is
 * mocked. (The subprocess form is unnecessary for HTTP: unlike stdio, the
 * protocol does not travel over the harness's own pipes.)
 *
 * What it asserts:
 *
 *  1. **Auth is Goose's.** `/healthz` answers unauthenticated; every `/acp`
 *     route answers `401` with no secret, with a wrong secret, and with a
 *     wrong `?token=`; and both `X-Secret-Key` and `?token=` are accepted,
 *     because the query parameter is the only channel a browser's
 *     `EventSource` can use.
 *  2. **The RFD's POST contract.** `initialize` returns `200` with a body and
 *     an `Acp-Connection-Id`; every other POST returns `202` immediately and
 *     its response arrives on the stream, correlated by JSON-RPC id.
 *  3. **`after=N` replays strictly after N** and then goes live.
 *  4. **The reconnect guarantee.** A stream is dropped mid-turn, the client
 *     reconnects with the standard `Last-Event-ID` header, and the union of
 *     what it saw before the drop and what it got after contains **every**
 *     frame exactly once — nothing missed, nothing duplicated. This is the
 *     property the ACP transport RFD explicitly does not provide.
 *
 * Usage: node verify/http-client.mjs
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlane } from "../lib/control.js";
import { createScriptedBackend } from "../lib/backends.js";
import { startHttpTransport } from "../lib/transport-http.js";

const failures = [];
const checks = [];

/** Record one assertion. */
function check(name, ok, detail) {
	checks.push({ name, ok, detail });
	if (!ok) failures.push(`${name}${detail === undefined ? "" : ` — ${detail}`}`);
	console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok || detail === undefined ? "" : `  (${detail})`}`);
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Parse an SSE byte stream into `{id, data}` frames.
 *
 * Deliberately hand-rolled rather than using `EventSource`: this is the
 * check's job — to read what actually went on the wire, including the `id:`
 * fields the resume guarantee depends on, which `EventSource` hides.
 */
async function* sse(body) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done === true) return;
			buffer += decoder.decode(value, { stream: true });
			let split;
			while ((split = buffer.indexOf("\n\n")) !== -1) {
				const block = buffer.slice(0, split);
				buffer = buffer.slice(split + 2);
				if (block.startsWith(":")) continue; // heartbeat/comment
				let id;
				const dataLines = [];
				for (const raw of block.split("\n")) {
					if (raw.startsWith("id:")) id = Number(raw.slice(3).trim());
					else if (raw.startsWith("data:")) dataLines.push(raw.slice(5).trimStart());
				}
				if (dataLines.length === 0) continue;
				yield { id, frame: JSON.parse(dataLines.join("\n")) };
			}
		}
	} finally {
		reader.cancel().catch(() => {});
	}
}

/**
 * A minimal ACP-over-HTTP client: POST requests, read responses off the SSE
 * stream, and correlate by JSON-RPC id — exactly what the RFD describes.
 */
class HttpAcpClient {
	constructor(base, token) {
		this.base = base;
		this.token = token;
		this.connectionId = undefined;
		this.nextId = 1;
		this.pending = new Map();
		this.updates = [];
		this.allFrames = [];
		this.seenIds = [];
		this.controller = undefined;
		this.pumpTask = undefined;
	}

	headers(extra = {}) {
		const out = { "content-type": "application/json", ...extra };
		if (this.token !== undefined) out["x-secret-key"] = this.token;
		if (this.connectionId !== undefined) out["acp-connection-id"] = this.connectionId;
		return out;
	}

	/** POST one message; returns the HTTP status. */
	async post(frame) {
		const res = await fetch(`${this.base}/acp`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(frame),
		});
		if (frame.method === "initialize" && res.status === 200) {
			const body = await res.json();
			this.connectionId = res.headers.get("acp-connection-id") ?? this.connectionId;
			return { status: res.status, body, connectionId: this.connectionId };
		}
		await res.arrayBuffer();
		return { status: res.status };
	}

	/** Send a request and await its response from the stream. */
	async request(method, params, { timeoutMs = 15000 } = {}) {
		const id = this.nextId++;
		const promise = new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`timeout waiting for the response to ${method}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
			});
		});
		await this.post({ jsonrpc: "2.0", id, method, params });
		return await promise;
	}

	/** Send a notification. */
	async notify(method, params) {
		await this.post({ jsonrpc: "2.0", method, params });
	}

	/**
	 * Open (or reopen) the SSE stream.
	 *
	 * `after` is expressed the way a browser would express it — through
	 * `Last-Event-ID` — unless `useQuery` is set, which exercises the explicit
	 * `?after=` form and proves both spellings agree.
	 */
	async openStream({ after, useQuery = after !== undefined, session, lastId } = {}) {
		const params = new URLSearchParams();
		if (this.token !== undefined) params.set("token", this.token);
		if (this.connectionId !== undefined) params.set("connection", this.connectionId);
		if (session !== undefined) params.set("session", session);
		if (useQuery && after !== undefined) params.set("after", String(after));
		const headers = {};
		if (!useQuery && lastId !== undefined) headers["last-event-id"] = String(lastId);
		this.controller = new AbortController();
		// `signal` matters: without it, `dropStream` aborts a controller nobody
		// is listening to, the original pump keeps receiving frames, and the
		// "reconnect" silently becomes two readers on one connection — which
		// would manufacture exactly the duplicates this check exists to rule out.
		const res = await fetch(`${this.base}/acp/stream?${params.toString()}`, { headers, signal: this.controller.signal });
		if (res.status !== 200) {
			await res.arrayBuffer();
			throw new Error(`stream attach failed with HTTP ${res.status}`);
		}
		this.pumpTask = this.#pump(res.body);
		return res;
	}

	async #pump(body) {
		try {
			for await (const { id, frame } of sse(body)) {
				if (id !== undefined) this.seenIds.push(id);
				this.allFrames.push({ id, frame });
				if (frame.id !== undefined && frame.method === undefined) {
					const entry = this.pending.get(frame.id);
					if (entry !== undefined) {
						this.pending.delete(frame.id);
						entry.resolve(frame);
					}
					continue;
				}
				if (frame.method === "session/update") this.updates.push({ id, update: frame.params.update });
			}
		} catch {
			// A dropped stream is the normal case this check exercises.
		}
	}

	/** Drop the stream the way a network failure would. */
	async dropStream() {
		this.controller?.abort();
		this.pumpTask = undefined;
		await delay(30);
	}
}

async function main() {
	const dataDir = await mkdtemp(join(tmpdir(), "dsh-acp-control-http-"));
	const logs = [];
	const logger = (message) => logs.push(message);
	const backend = createScriptedBackend({ chunkDelayMs: 1 });
	const control = await createControlPlane({ backend, dataDir, logger });
	const transport = await startHttpTransport({
		plane: control.plane,
		port: 0, // ask the OS for a free port; the check must not collide with anything
		token: "verify-secret-token",
		logger,
	});
	const base = `http://127.0.0.1:${transport.port}`;
	console.log(`\n=== dsh-acp-control — loopback HTTP+SSE transcript ===`);
	console.log(`server   ${base} (real socket, in-process listener)`);
	console.log(`secret   configured via config ("verify-secret-token")`);
	console.log(`log dir  ${dataDir}\n`);

	try {
		console.log("--- auth ------------------------------------------------------");
		const health = await fetch(`${base}/healthz`);
		check("GET /healthz answers without a secret", health.status === 200, `got ${health.status}`);
		await health.arrayBuffer();

		const noToken = await fetch(`${base}/acp`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		check("POST /acp without a secret is 401", noToken.status === 401, `got ${noToken.status}`);
		await noToken.arrayBuffer();

		const badHeader = await fetch(`${base}/acp`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-secret-key": "wrong" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		check("a wrong X-Secret-Key is 401", badHeader.status === 401, `got ${badHeader.status}`);
		await badHeader.arrayBuffer();

		const badQuery = await fetch(`${base}/acp?token=wrong`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		check("a wrong ?token= is 401", badQuery.status === 401, `got ${badQuery.status}`);
		await badQuery.arrayBuffer();

		console.log("\n--- initialize over the RFD's POST shape ----------------------");
		const client = new HttpAcpClient(base, "verify-secret-token");
		const init = await client.post({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: 1,
				clientCapabilities: { _meta: { "dsh-acp-control/extensions": true } },
				clientInfo: { name: "curl-and-fetch", version: "1.0.0" },
			},
		});
		console.log(`  POST /acp initialize            → HTTP ${init.status}, Acp-Connection-Id ${String(init.connectionId).slice(0, 8)}…`);
		check("initialize returns 200 with a JSON body", init.status === 200 && init.body?.result?.protocolVersion === 1);
		check("initialize returns an Acp-Connection-Id header", typeof init.connectionId === "string" && init.connectionId.length > 0);

		// The `?token=` spelling, on the route that has no header channel in a browser.
		await client.openStream({ after: -1, useQuery: true });
		await delay(30);
		check("a stream attaches with ?token= instead of a header", true);

		console.log("\n--- POST returns 202; the response arrives on the stream ------");
		const created = await client.request("session/new", { cwd: dataDir, mcpServers: [] });
		const sessionId = created.result?.sessionId;
		console.log(`  session/new                     → ${sessionId}`);
		check("session/new's response arrived on the stream, correlated by id", created.result?.sessionId !== undefined);

		const statusProbe = await client.post({ jsonrpc: "2.0", id: 900, method: "session/list", params: {} });
		check("a non-initialize POST returns 202 immediately", statusProbe.status === 202, `got ${statusProbe.status}`);

		console.log("\n--- a prompt, streamed ---------------------------------------");
		const promptResponse = await client.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "hello over http" }],
		});
		console.log(`  session/prompt                  → stopReason ${promptResponse.result?.stopReason}`);
		check("session/prompt resolves with end_turn", promptResponse.result?.stopReason === "end_turn");
		check("session/update frames carried the SSE id field", client.updates.length > 0 && client.updates.every((u) => typeof u.id === "number"));
		console.log(`  streamed ${client.updates.length} session/update frame(s)`);

		console.log("\n--- after=N replays strictly after N --------------------------");
		const head = control.log.lastEventId;
		const midCursor = Math.max(1, head - 3);
		const replayer = new HttpAcpClient(base, "verify-secret-token");
		replayer.connectionId = client.connectionId;
		await replayer.openStream({ after: midCursor, useQuery: true });
		await delay(60);
		const replayed = replayer.allFrames.filter((entry) => entry.id !== undefined).map((entry) => entry.id);
		console.log(`  ?after=${midCursor}                    → replayed ids [${replayed.join(", ")}]`);
		check("every replayed id is strictly greater than the cursor", replayed.every((id) => id > midCursor));
		check("replayed ids are strictly increasing (no duplicates)", replayed.every((id, index) => index === 0 || id > replayed[index - 1]));
		await replayer.dropStream();

		console.log("\n--- the reconnect guarantee: nothing missed, nothing duplicated ---");
		// Record where the client is, start a turn that will produce many
		// events, then kill the stream mid-turn. Anything emitted in the gap is
		// exactly what a naive SSE implementation loses.
		const survivor = new HttpAcpClient(base, "verify-secret-token");
		survivor.connectionId = client.connectionId;
		await survivor.openStream({ after: -1 });
		await delay(40);

		const slowTurn = survivor.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/slow" }] });
		await delay(25); // let a few chunks land, so the drop is genuinely mid-turn
		await survivor.dropStream();
		// Snapshot *after* the pump has stopped: the client's cursor is by
		// definition the last id it actually received, and taking the snapshot
		// earlier would count the frames delivered in the window between the
		// snapshot and the drop as both "before" and "after".
		const idsBefore = [...survivor.seenIds];
		const cursorBeforeDrop = idsBefore[idsBefore.length - 1] ?? 0;
		console.log(`  before the drop                 → ${idsBefore.length} frame(s), last id ${cursorBeforeDrop}`);
		const missedWindowStart = control.log.lastEventId;
		await delay(120); // events emitted while nobody is listening
		const missedWindowEnd = control.log.lastEventId;
		console.log(`  stream dropped; server emitted  → events ${missedWindowStart}..${missedWindowEnd} with no listener`);
		check("events really were produced while the client was away", missedWindowEnd > missedWindowStart, `${missedWindowStart}..${missedWindowEnd}`);

		// Reconnect the way a browser does: same connection, Last-Event-ID set
		// from the last id it received, no explicit cursor.
		await survivor.openStream({ lastId: cursorBeforeDrop });
		const slowResult = await slowTurn;
		await delay(60);
		console.log(`  session/prompt                  → stopReason ${slowResult.result?.stopReason}`);

		const afterReconnect = survivor.seenIds.filter((id) => id > cursorBeforeDrop);
		const combined = [...idsBefore, ...afterReconnect];
		const unique = new Set(combined);
		check(
			"nothing was duplicated across the reconnect",
			unique.size === combined.length,
			`${combined.length} received, ${unique.size} distinct`,
		);
		check(
			"replay resumed at the first event the client had not seen",
			afterReconnect.length === 0 || afterReconnect[0] === cursorBeforeDrop + 1,
			`first after reconnect was ${afterReconnect[0]}, cursor was ${cursorBeforeDrop}`,
		);
		// Every log event with a wire frame after the cursor must have arrived.
		const expected = control.log
			.read({ sessionId, after: cursorBeforeDrop })
			.filter((record) => record.frame !== undefined)
			.map((record) => record.eventId);
		const missing = expected.filter((id) => !unique.has(id));
		check(
			"every frame the server emitted after the drop reached the client on reconnect",
			missing.length === 0,
			`missing ids ${missing.join(", ")}`,
		);
		console.log(`  after reconnect                 → replayed ${afterReconnect.length} frame(s); ${expected.length} expected`);

		console.log("\n--- a standard client is never sent _dsh/* ---------------------");
		// Extension notifications only reach connections that opted in through
		// `clientCapabilities._meta` at `initialize`. A client that did not opt
		// in must never be sent a method it has never heard of — that is the
		// difference between an extension namespace and a protocol violation.
		// The `client` connection must be the one holding the active stream for
		// the in-band half of this check — one stream per connection, and the
		// reconnect probes above took it over.
		await client.openStream({ after: -1 });
		await delay(40);
		const plain = new HttpAcpClient(base, "verify-secret-token");
		const plainInit = await plain.post({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: 1, clientInfo: { name: "plain-stdlib-client", version: "1.0.0" } },
		});
		check("a client that does not opt in still initializes", plainInit.status === 200);
		await plain.openStream({ after: -1 });
		await delay(40);
		const plainSession = await plain.request("session/new", { cwd: dataDir, mcpServers: [] });
		const plainSessionId = plainSession.result?.sessionId;
		// Provoke a real refusal, so the plugin emits `_dsh/session/refused`.
		const refused = await plain.request("session/resume", { sessionId: plainSessionId });
		check(
			"the standard client receives the refusal as a normal JSON-RPC error",
			refused.error?.data?.type === "refused",
			JSON.stringify(refused.error?.data),
		);
		await delay(80);
		const leaked = plain.allFrames.filter((entry) => typeof entry.frame?.method === "string" && entry.frame.method.startsWith("_dsh/"));
		check(
			"a standard client receives no _dsh/* frame at all",
			leaked.length === 0,
			`leaked ${leaked.map((entry) => entry.frame.method).join(", ")}`,
		);
		check(
			"an OPTED-IN client does receive the same refusal in-band",
			client.allFrames.some(
				(entry) => entry.frame?.method === "_dsh/session/refused" && entry.frame.params?.command === "resume",
			),
			`opted-in client saw: ${client.allFrames
				.filter((entry) => entry.frame?.method !== undefined)
				.map((entry) => entry.frame.method)
				.slice(-6)
				.join(", ") || "(no notification frames)"}`,
		);
		await plain.dropStream();

		console.log("\n--- delete, and the session-scoped filter ---------------------");
		const filtered = new HttpAcpClient(base, "verify-secret-token");
		filtered.connectionId = client.connectionId;
		await filtered.openStream({ after: -1, session: "acp-does-not-exist" });
		await delay(60);
		check(
			"a session-scoped stream carries no other session's frames",
			filtered.allFrames.every((entry) => entry.frame?.params?.sessionId === "acp-does-not-exist"),
			`got ${filtered.allFrames.length} frame(s)`,
		);
		await filtered.dropStream();

		const badConnection = await fetch(`${base}/acp/stream?connection=nope`, { headers: { "x-secret-key": "verify-secret-token" } });
		check("a stream for an unknown connection is 404", badConnection.status === 404, `got ${badConnection.status}`);
		await badConnection.arrayBuffer();

		// The `client` connection's stream was replaced by the filter probe
		// above (one stream per connection), so it re-attaches before asking
		// for anything else — which is also a small extra proof that the
		// `Acp-Connection-Id` survives a stream swap.
		await client.openStream({ after: -1 });
		await delay(30);
		const deleted = await client.request("session/delete", { sessionId });
		check("session/delete settles over HTTP after a stream re-attach", deleted.result !== undefined);
		const afterDelete = await client.request("session/list", {});
		check(
			"the deleted session is gone from session/list",
			afterDelete.result?.sessions?.every((entry) => entry.sessionId !== sessionId) === true,
		);

		const unknownRoute = await fetch(`${base}/nope`, { headers: { "x-secret-key": "verify-secret-token" } });
		check("an unknown route is 404 with the route list", unknownRoute.status === 404);
		await unknownRoute.arrayBuffer();

		await client.dropStream();
	} finally {
		await transport.close();
		await control.close();
		await rm(dataDir, { recursive: true, force: true });
	}

	console.log("\n--- server stderr ----------------------------------------------");
	for (const text of logs) console.log(`  | ${text}`);
	console.log(`\n=== ${checks.length - failures.length}/${checks.length} checks passed ===`);
	if (failures.length > 0) {
		console.log("\nFAILURES:");
		for (const failure of failures) console.log(`  - ${failure}`);
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(`\nverify/http-client.mjs crashed: ${error?.stack ?? error}`);
	process.exitCode = 1;
});
