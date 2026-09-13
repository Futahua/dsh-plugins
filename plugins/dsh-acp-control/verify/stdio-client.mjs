#!/usr/bin/env node
/**
 * Slice-1 check A (strongest form): drive the stdio server **as a real child
 * process over real OS pipes**, with the **official ACP client**.
 *
 * `core-checks.mjs` runs the identical scenario over in-process pipes, which is
 * portable but not the same thing: this form additionally exercises process
 * spawn, real pipe framing, and the `process.stdin`/`process.stdout` wiring
 * that an editor actually uses. When it can run, prefer it.
 *
 * It may not be runnable everywhere — a sandbox that denies a child process
 * piped stdio fails at `spawn` with `EPERM`, and that is a property of the
 * environment rather than of the plugin. `core-checks.mjs` is the fallback, and
 * it is the same assertions by construction: both call `runScenario`.
 *
 * Usage: node verify/stdio-client.mjs
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runScenario } from "./scenario.mjs";
import { loadSdk } from "./sdk.mjs";

const PLUGIN_DIR = resolve(import.meta.dirname, "..");

async function main() {
	const { sdk, path: sdkPath } = await loadSdk();
	const entry = join(PLUGIN_DIR, "lib", "standalone.js");
	const dataDir = await mkdtemp(join(tmpdir(), "dsh-acp-control-stdio-"));
	console.log("\n=== dsh-acp-control — stdio transport (real child process) ===");
	console.log(`client   @agentclientprotocol/sdk  ${sdkPath}`);
	console.log(`server   ${process.execPath} ${entry} --stdio`);
	console.log(`log dir  ${dataDir}\n`);

	const child = spawn(process.execPath, [entry, "--stdio", "--data-dir", dataDir, "--chunk-delay-ms", "1"], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: PLUGIN_DIR,
	});
	const stderr = [];
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		for (const text of String(chunk).split("\n")) if (text.trim() !== "") stderr.push(text.trim());
	});

	const stdout = child.stdout;
	const stream = sdk.ndJsonStream(
		new WritableStream({
			write(chunk) {
				child.stdin.write(chunk);
			},
		}),
		new ReadableStream({
			start(controller) {
				stdout.on("data", (chunk) => {
					// The child can exit while a chunk is in flight, and closing
					// an already-closed controller throws. A reader that has
					// gone away is not an error worth crashing a check over.
					try {
						controller.enqueue(new Uint8Array(chunk));
					} catch {
						/* stream already closed */
					}
				});
				stdout.on("end", () => {
					try {
						controller.close();
					} catch {
						/* already closed */
					}
				});
				stdout.on("error", () => {
					try {
						controller.close();
					} catch {
						/* already closed */
					}
				});
			},
		}),
	);

	let result;
	try {
		result = await runScenario({ sdk, stream, cwd: PLUGIN_DIR, serverStderr: () => stderr });
	} finally {
		child.kill();
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
	if (error?.code === "EPERM") {
		console.error(
			"\nverify/stdio-client.mjs could not spawn a child process with piped stdio (EPERM).\n" +
				"That is an environment restriction, not a plugin failure. Run verify/core-checks.mjs, " +
				"which executes the same scenario over in-process pipes.",
		);
	} else {
		console.error(`\nverify/stdio-client.mjs crashed: ${error?.stack ?? error}`);
	}
	process.exitCode = 1;
});
