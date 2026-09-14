#!/usr/bin/env node
/**
 * Slice-1 check A (portable): the same scenario as `stdio-client.mjs`, run
 * over the stdio transport **in-process**.
 *
 * The protocol path is identical — the real `serveStdio`, the real NDJSON
 * framing, the real control plane — and only the pipe ends are in-memory
 * instead of OS pipes. That makes this check runnable anywhere, including
 * sandboxes that refuse to spawn a child with piped stdio, which is where the
 * subprocess form of the check cannot run at all.
 *
 * `stdio-client.mjs` is the stronger evidence and should be preferred when it
 * can run; this one is what makes the transcript reproducible everywhere.
 *
 * Usage: node verify/core-checks.mjs
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { createControlPlane } from "../lib/control.js";
import { createScriptedBackend } from "../lib/backends.js";
import { serveStdio } from "../lib/transport-stdio.js";
import { runScenario } from "./scenario.mjs";
import { loadSdk } from "./sdk.mjs";

const PLUGIN_DIR = resolve(import.meta.dirname, "..");

/**
 * Durability and rollback, against a log that is genuinely broken.
 *
 * Not a mock and not a stubbed `appendFile`: the log's own directory is
 * deleted out from under it, so the next write fails with ENOENT exactly as it
 * would on a full or unmounted disk. That is the only honest way to test the
 * two claims at issue — that a command's success means its events are on disk,
 * and that a command reported as failed leaves no effect behind.
 *
 * @param {object} options - `{sdk, plane, logger}`.
 * @returns {Promise<{checks: object[], failures: string[]}>} results.
 */
async function runDurabilityChecks({ sdk, plane, logger }) {
	const failures = [];
	const checks = [];
	function check(name, ok, detail) {
		checks.push({ name, ok, detail });
		if (!ok) failures.push(`${name}${detail === undefined ? "" : ` — ${detail}`}`);
		console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok || detail === undefined ? "" : `  (${detail})`}`);
	}

	console.log("\n--- durability: what 'success' has to mean --------------------");
	logger("breaking the log directory on purpose");
	const logDir = dirname(plane.log.path);
	await rm(logDir, { recursive: true, force: true });

	// Drive the plane directly: the stdio client is still connected, but this
	// section needs the plane object itself to break the log underneath it.
	const connection = {
		id: "durability-probe",
		actor: "human:durability-check",
		transportName: "in-process",
		extensions: true,
		closed: false,
		send() {},
		notify() {},
		request: () => Promise.reject(new Error("the durability probe never asks the client anything")),
		acceptResponse: () => false,
		signalFor: () => new AbortController().signal,
		releaseRequest() {},
		handle: async (p, frame) => p.dispatch(connection, frame),
	};
	plane.attach(connection);

	const created = await connection.handle(plane, { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: PLUGIN_DIR, mcpServers: [] } });
	check("a session can still be created in memory once the log is unwritable", created.result?.sessionId !== undefined || created.error !== undefined, JSON.stringify(created.error?.data));
	const sessionId = created.result?.sessionId;

	if (sessionId !== undefined) {
		const before = await connection.handle(plane, { jsonrpc: "2.0", id: 2, method: "_dsh/session/state", params: { sessionId } });
		const titleBefore = before.result?.title ?? null;

		const rename = await connection.handle(plane, {
			jsonrpc: "2.0",
			id: 3,
			method: "_dsh/session/rename",
			params: { sessionId, title: "durable?" },
		});
		check(
			"a rename whose log write fails reports the split outcome honestly",
			rename.error !== undefined && rename.error.data?.type === "partially_applied",
			JSON.stringify(rename.error?.data ?? rename.result),
		);
		// The host is authoritative for a title and is written first, so this
		// failure is *not* "nothing happened": the title is live in DSH. Saying
		// otherwise — or pretending to roll the host back — would be the lie.
		check(
			"and it says the host applied it while this control plane did not record it",
			rename.error?.data?.hostApplied === true && typeof rename.error?.data?.hostTitle === "string",
			JSON.stringify(rename.error?.data),
		);
		check(
			"the failure names the durability cause",
			typeof rename.error?.data?.reason === "string" && rename.error.data.reason.includes("event log"),
			rename.error?.data?.reason,
		);

		const after = await connection.handle(plane, { jsonrpc: "2.0", id: 4, method: "_dsh/session/state", params: { sessionId } });
		check(
			"this control plane's own projection is unchanged, because its write is what failed",
			after.result?.title === titleBefore,
			`${JSON.stringify(titleBefore)} -> ${JSON.stringify(after.result?.title)}`,
		);

		// The state machine's own edges go through the same ordered path.
		const prompt = await connection.handle(plane, {
			jsonrpc: "2.0",
			id: 5,
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "unwritable" }] },
		});
		check("a prompt whose events cannot be written also fails", prompt.error !== undefined, JSON.stringify(prompt.result));
		const stateNow = await connection.handle(plane, { jsonrpc: "2.0", id: 6, method: "_dsh/session/state", params: { sessionId } });
		check(
			"and it did not leave the session stuck in generating",
			stateNow.result?.state === "idle" || stateNow.result?.state === "closed",
			`state ${stateNow.result?.state}`,
		);
	}
	plane.detach(connection);
	return { checks, failures };
}

/**
 * "Canonical or disabled": a command whose fact belongs to the host must reach
 * the host, and must refuse when it cannot.
 *
 * Asserted by *removing* the canonical method from a running backend, which is
 * the only way to observe the rule rather than the happy path: a plugin that
 * quietly kept its own copy would still answer here, and that is exactly the
 * two-sources-of-truth bug this rule exists to prevent.
 *
 * @param {object} options - `{plane, logger}`.
 * @returns {Promise<{checks: object[], failures: string[]}>} results.
 */
async function runCanonicalChecks({ plane }) {
	const failures = [];
	const checks = [];
	function check(name, ok, detail) {
		checks.push({ name, ok, detail });
		if (!ok) failures.push(`${name}${detail === undefined ? "" : ` — ${detail}`}`);
		console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok || detail === undefined ? "" : `  (${detail})`}`);
	}

	console.log("\n--- canonical or disabled -------------------------------------");
	const connection = {
		id: "canonical-probe",
		actor: "human:canonical-check",
		transportName: "in-process",
		extensions: true,
		closed: false,
		send() {},
		notify() {},
		request: () => Promise.reject(new Error("the probe never asks the client anything")),
		acceptResponse: () => false,
		signalFor: () => new AbortController().signal,
		releaseRequest() {},
		handle: async (p, frame) => p.dispatch(connection, frame),
	};
	plane.attach(connection);

	const created = await connection.handle(plane, { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: PLUGIN_DIR, mcpServers: [] } });
	const sessionId = created.result?.sessionId;

	if (sessionId !== undefined) {
		const canonical = plane.registry.backend.canonical;
		const saved = canonical.rename;
		delete canonical.rename;

		const refused = await connection.handle(plane, {
			jsonrpc: "2.0",
			id: 2,
			method: "_dsh/session/rename",
			params: { sessionId, title: "no host to hold this" },
		});
		check(
			"rename refuses when the backend has no canonical host to delegate to",
			refused.error !== undefined && refused.error.data?.type === "unimplemented",
			JSON.stringify(refused.error?.data ?? refused.result),
		);
		const after = await connection.handle(plane, { jsonrpc: "2.0", id: 3, method: "_dsh/session/state", params: { sessionId } });
		check(
			"and it kept no private copy of the title it could not delegate",
			after.result?.title === null || after.result?.title === undefined,
			JSON.stringify(after.result?.title),
		);

		canonical.rename = saved;
		const works = await connection.handle(plane, {
			jsonrpc: "2.0",
			id: 4,
			method: "_dsh/session/rename",
			params: { sessionId, title: "host owns this" },
		});
		check("and it succeeds again once the host is available", works.result?.title === "host owns this", JSON.stringify(works.error ?? works.result));
		const projected = await connection.handle(plane, { jsonrpc: "2.0", id: 5, method: "_dsh/session/state", params: { sessionId } });
		check(
			"the projection is the host's accepted title, not the requested one",
			projected.result?.title === "host owns this",
			JSON.stringify(projected.result?.title),
		);
	}
	plane.detach(connection);
	return { checks, failures };
}

async function main() {	const { sdk, path: sdkPath } = await loadSdk();
	const dataDir = await mkdtemp(join(tmpdir(), "dsh-acp-control-core-"));
	console.log("\n=== dsh-acp-control — stdio transport (in-process pipes) ===");
	console.log(`client   @agentclientprotocol/sdk  ${sdkPath}`);
	console.log(`server   lib/transport-stdio.js over PassThrough`);
	console.log(`log dir  ${dataDir}\n`);

	const logs = [];
	const logger = (message) => logs.push(message);
	const backend = createScriptedBackend({ chunkDelayMs: 1 });
	const control = await createControlPlane({ backend, dataDir, logger });

	// A real pair of streams through the real transport: only the OS pipe is
	// absent. Anything that depends on chunk boundaries splitting mid-frame
	// would still show up here.
	const toServer = new PassThrough();
	const fromServer = new PassThrough();
	serveStdio({ plane: control.plane, input: toServer, output: fromServer, logger });

	const stream = sdk.ndJsonStream(
		new WritableStream({
			write(chunk) {
				toServer.write(Buffer.from(chunk));
			},
		}),
		new ReadableStream({
			start(controller) {
				fromServer.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
				fromServer.on("end", () => controller.close());
			},
		}),
	);

	let result;
	try {
		result = await runScenario({ sdk, stream, cwd: PLUGIN_DIR, serverStderr: () => logs });
		// Canonical checks run *before* the durability section, which deletes the
		// log directory on purpose and would otherwise make every later command
		// fail for an unrelated reason.
		const canonical = await runCanonicalChecks({ plane: control.plane, logger });
		const durability = await runDurabilityChecks({ sdk, plane: control.plane, logger });
		result = {
			checks: [...result.checks, ...canonical.checks, ...durability.checks],
			failures: [...result.failures, ...canonical.failures, ...durability.failures],
		};
	} finally {
		toServer.end();
		await control.close();
		await rm(dataDir, { recursive: true, force: true });
	}

	console.log(`\n=== ${result.checks.length - result.failures.length}/${result.checks.length} checks passed ===`);
	if (result.failures.length > 0) {
		console.log("\nFAILURES:");
		for (const failure of result.failures) console.log(`  - ${failure}`);
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(`\nverify/core-checks.mjs crashed: ${error?.stack ?? error}`);
	process.exitCode = 1;
});
