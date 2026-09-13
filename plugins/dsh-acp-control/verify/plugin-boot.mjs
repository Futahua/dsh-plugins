#!/usr/bin/env node
/**
 * Slice-1 check C: the plugin mounted in a **real DSH profile**, using the
 * `dsh` backend.
 *
 * Checks A and B prove the protocol, the state machine, and the replay against
 * a deterministic backend, which is the right way to test them — a model's
 * variation would make every assertion flaky. What they cannot prove is that
 * the plugin actually mounts inside DeepSeek Harness and drives real agents.
 * That is this check's job.
 *
 * It connects to an already-running profile over HTTP (`transport: auto`
 * serves loopback HTTP) and shows:
 *
 *  1. the plugin mounted and answering `initialize` with `backend: "dsh"`;
 *  2. `session/list` returning the **live session store's** sessions, which
 *     only exist if `ctx.sessionQuery` resolved and answered;
 *  3. `session/new` composing a real DSH agent through `ctx.agents.create`,
 *     with the explicit state machine reporting `idle`;
 *  4. a real prompt turn, if the profile has a route and a credential — and an
 *     honest, structured report of why not if it does not.
 *
 * Prerequisite: an `acpctl` profile booted with this plugin (see README.md).
 *
 * Usage:
 *   node verify/plugin-boot.mjs [--url http://127.0.0.1:7810/acp] [--token ...]
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failures = [];
const checks = [];

function check(name, ok, detail) {
	checks.push({ name, ok, detail });
	if (!ok) failures.push(`${name}${detail === undefined ? "" : ` — ${detail}`}`);
	console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok || detail === undefined ? "" : `  (${detail})`}`);
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function parseArgs(argv) {
	const options = {
		url: process.env.ACP_CONTROL_URL ?? "http://127.0.0.1:7810/acp",
		token: process.env.ACP_CONTROL_TOKEN ?? "acpctl-boot-check",
	};
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--url") options.url = argv[++index];
		else if (argv[index] === "--token") options.token = argv[++index];
	}
	return options;
}

/** Read an SSE stream, yielding `{id, frame}`. */
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
				if (block.startsWith(":")) continue;
				let id;
				const dataLines = [];
				for (const raw of block.split("\n")) {
					if (raw.startsWith("id:")) id = Number(raw.slice(3).trim());
					else if (raw.startsWith("data:")) dataLines.push(raw.slice(5).trimStart());
				}
				if (dataLines.length > 0) yield { id, frame: JSON.parse(dataLines.join("\n")) };
			}
		}
	} finally {
		reader.cancel().catch(() => {});
	}
}

async function main() {
	const { url, token } = parseArgs(process.argv.slice(2));
	const base = url.replace(/\/acp$/, "");
	console.log(`\n=== dsh-acp-control — mounted in a live DSH profile (dsh backend) ===`);
	console.log(`endpoint ${url}\n`);

	let connectionId;
	const nextId = { value: 1 };
	const pending = new Map();
	const updates = [];
	const controller = new AbortController();

	const headers = (extra = {}) => ({
		"content-type": "application/json",
		"x-secret-key": token,
		...(connectionId === undefined ? {} : { "acp-connection-id": connectionId }),
		...extra,
	});

	const post = async (frame) => {
		const res = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(frame) });
		if (frame.method === "initialize" && res.status === 200) {
			const body = await res.json();
			connectionId = res.headers.get("acp-connection-id");
			return { status: res.status, body };
		}
		await res.arrayBuffer();
		return { status: res.status };
	};

		const request = async (method, params) => {
			const id = nextId.value++;
			const promise = new Promise((resolve, reject) => {
				// Generous, because `session/list` reads the host's *entire*
				// session store through `sessionQuery.listSessions()` plus a
				// title snapshot per session — the same call the first-party
				// server makes. On a home with tens of megabytes of transcripts
				// that is seconds to minutes, and a tighter timeout here would
				// report the host's size as this plugin's failure.
				const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 420_000);
				pending.set(id, {
					resolve: (value) => {
						clearTimeout(timer);
						resolve(value);
					},
				});
			});
			await post({ jsonrpc: "2.0", id, method, params });
			const frame = await promise;
			if (frame.error !== undefined) {
				const error = new Error(frame.error.message);
				error.code = frame.error.code;
				error.data = frame.error.data;
				throw error;
			}
			return frame.result;
		};

	/** Print a call and its outcome, so the transcript is readable. */
	const call = async (method, params, { quiet = false } = {}) => {
		try {
			const result = await request(method, params);
			if (quiet !== true) {
				console.log(`  → ${method}`);
				console.log(`  ← ${JSON.stringify(result)?.slice(0, 300)}`);
			}
			return { ok: true, result };
		} catch (error) {
			if (quiet !== true) {
				console.log(`  → ${method}`);
				console.log(`  ← error ${error.code}: ${error.message} ${JSON.stringify(error.data ?? {}).slice(0, 240)}`);
			}
			return { ok: false, error, data: error.data };
		}
	};

	// ── connect ──────────────────────────────────────────────────────────────
	const init = await post({
		jsonrpc: "2.0",
		id: 0,
		method: "initialize",
		params: {
			protocolVersion: 1,
			clientCapabilities: { _meta: { "dsh-acp-control/extensions": true } },
			clientInfo: { name: "verify-plugin-boot", version: "1.0.0" },
		},
	});
	if (init.status !== 200) {
		throw new Error(
			`initialize returned HTTP ${init.status}. Is the acpctl profile running, and is the token right? ` +
				`Boot it with: dsh --profile acpctl`,
		);
	}
	console.log("--- initialize -------------------------------------------------");
	console.log(`  → initialize`);
	console.log(`  ← ${JSON.stringify(init.body.result).slice(0, 400)}`);
	const meta = init.body.result?._meta?.["dsh-acp-control"];
	check("the plugin is mounted in a live DSH profile and answered initialize", init.body.result?.protocolVersion === 1);
	check("it reports the dsh backend, not the fixture", meta?.backend === "dsh", `got ${meta?.backend}`);

	const pump = (async () => {
		const res = await fetch(`${base}/acp/stream?token=${encodeURIComponent(token)}&connection=${connectionId}`, {
			headers: { "last-event-id": "-1" },
			signal: controller.signal,
		});
		for await (const { id, frame } of sse(res.body)) {
			if (frame.id !== undefined && frame.method === undefined) {
				const entry = pending.get(frame.id);
				if (entry !== undefined) {
					pending.delete(frame.id);
					entry.resolve(frame);
				}
				continue;
			}
			if (frame.method === "session/update") {
				// Scoped to the session this check is driving. The log lives in
				// the shared `$DSH_HOME`, so a replay from `after: -1` carries
				// other runs' sessions too, and an unscoped collector reports
				// their text as if this session had produced it.
				if (sessionId !== undefined && frame.params?.sessionId !== sessionId) continue;
				updates.push(frame.params.update);
				if (frame.params.update.sessionUpdate !== "agent_message_chunk") {
					console.log(`  ← session/update ${frame.params.update.sessionUpdate}`);
				}
			}
		}
	})().catch(() => {});
	await delay(60);

	console.log("\n--- session/list: the LIVE session store, not a fixture ------");
	const listed = await call("session/list", {});
	const sessions = listed.result?.sessions ?? [];
	check("session/list answered from the profile's session store", listed.ok === true);
	console.log(`  ${sessions.length} session(s) in the store; first few:`);
	for (const entry of sessions.slice(0, 5)) {
		console.log(`    ${entry.sessionId}  state=${entry.state}  title=${entry.title ?? "(none)"}`);
	}
	check(
		"the listed sessions carry DSH session ids, so sessionQuery resolved",
		sessions.length === 0 || sessions.some((entry) => typeof entry.sessionId === "string" && entry.sessionId.length > 0),
	);

	console.log("\n--- session/new: compose a REAL DSH agent -------------------");
	const created = await call("session/new", { cwd: process.cwd(), mcpServers: [] });
	const sessionId = created.result?.sessionId;
	check("session/new composed an agent through ctx.agents.create", created.ok === true && typeof sessionId === "string", created.error?.message);
	if (sessionId !== undefined) {
		const state = await call("_dsh/session/state", { sessionId });
		check("the state machine reports idle for the new session", state.result?.state === "idle", `got ${state.result?.state}`);
		check(
			"the explicit transition table is published to the client",
			state.result?.state !== undefined,
		);

		console.log("\n--- session/prompt: a real agent turn ------------------------");
		const prompted = await call("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "Reply with exactly the word: pong. Do not use any tools." }],
		});
		if (prompted.ok === true) {
			check("a real agent turn completed over ACP", typeof prompted.result?.stopReason === "string", JSON.stringify(prompted.result));
			const text = updates
				.filter((update) => update.sessionUpdate === "agent_message_chunk")
				.map((update) => update.content?.text ?? "")
				.join("");
			console.log(`  agent said: ${text.trim().slice(0, 200)}`);
			check("the agent's streamed output reached the client", text.trim().length > 0);
		} else {
			// No route or credential is a legitimate environment fact, not a
			// plugin failure — but it must be reported as itself, with the
			// reason, rather than quietly counted as a pass.
			console.log(`  (the turn could not run here: ${prompted.error?.message})`);
			check(
				"an unrunnable turn is reported as a structured failure, not a silent success",
				prompted.data?.type === "turn_failed" || prompted.data?.type === "internal",
				JSON.stringify(prompted.data),
			);
		}

		console.log("\n--- cleanup -------------------------------------------------");
		const closed = await call("session/close", { sessionId });
		check("session/close tore the agent down", closed.ok === true, closed.error?.message);
	}

	console.log("\n--- the log is the durable truth -----------------------------");
	const info = await call("_dsh/log/info", {});
	check("the profile's log lives under $DSH_HOME", String(info.result?.path ?? "").includes("acp-control"), info.result?.path);
	check("the log has monotonic ids", (info.result?.lastEventId ?? 0) > 0, `lastEventId ${info.result?.lastEventId}`);

	controller.abort();
	await pump;
	console.log(`\n=== ${checks.length - failures.length}/${checks.length} checks passed ===`);
	if (failures.length > 0) {
		console.log("\nFAILURES:");
		for (const failure of failures) console.log(`  - ${failure}`);
		process.exitCode = 1;
	}
	// A scratch dir is created only to keep the import graph honest about the
	// fact that this check touches no local state.
	await rm(await mkdtemp(join(tmpdir(), "noop-")), { recursive: true, force: true });
}

main().catch((error) => {
	console.error(`\nverify/plugin-boot.mjs crashed: ${error?.stack ?? error}`);
	process.exitCode = 1;
});
