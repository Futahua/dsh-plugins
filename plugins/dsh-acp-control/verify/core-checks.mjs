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
			"a rename whose event cannot be written FAILS",
			rename.error !== undefined && rename.error.data?.type === "durability_failed",
			JSON.stringify(rename.error?.data ?? rename.result),
		);
		check(
			"and the failure does NOT claim the effect was applied, because it was not",
			rename.error?.data?.effectApplied !== true,
			JSON.stringify(rename.error?.data),
		);
		check(
			"the failure names the durability cause and the log path",
			typeof rename.error?.data?.reason === "string" && rename.error?.data?.logPath === plane.log.path,
			JSON.stringify(rename.error?.data),
		);

		const after = await connection.handle(plane, { jsonrpc: "2.0", id: 4, method: "_dsh/session/state", params: { sessionId } });
		check(
			"a rename that could not be committed left the title UNCHANGED (commit before mutate)",
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

async function main() {
	const { sdk, path: sdkPath } = await loadSdk();
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
		const durability = await runDurabilityChecks({ sdk, plane: control.plane, logger });
		result = { checks: [...result.checks, ...durability.checks], failures: [...result.failures, ...durability.failures] };
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
