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
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { createControlPlane } from "../lib/control.js";
import { createScriptedBackend } from "../lib/backends.js";
import { serveStdio } from "../lib/transport-stdio.js";
import { runScenario } from "./scenario.mjs";
import { loadSdk } from "./sdk.mjs";

const PLUGIN_DIR = resolve(import.meta.dirname, "..");

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
