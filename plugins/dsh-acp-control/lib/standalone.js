#!/usr/bin/env node
/**
 * The runnable ACP server.
 *
 * Two jobs, one entry point:
 *
 *  - **Run the control plane without DSH.** An editor can point at this
 *    process directly, which is what makes the plugin usable outside a
 *    harness boot and what makes it verifiable: the transcript in `verify/`
 *    comes from this process over a real socket, not from a mocked call.
 *  - **Be the harness's ACP server when a DSH boot is not what you want** —
 *    for example a headless box running one session store.
 *
 * Inside a real DSH profile the Cordis plugin (`index.js`) builds the same
 * control plane from the same modules and uses the `dsh` backend; this entry
 * defaults to `scripted`, which is a fixture and says so loudly on boot.
 *
 * ```
 * node lib/standalone.js --stdio
 * node lib/standalone.js --http --port 7810
 * ```
 *
 * @module dsh-acp-control/standalone
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createControlPlane } from "./control.js";
import { createScriptedBackend } from "./backends.js";
import { serveStdio } from "./transport-stdio.js";
import { startHttpTransport } from "./transport-http.js";
import { loadDshBackend } from "./backend-dsh.js";

/** Default log directory, overridable so a service can put it on real storage. */
const DEFAULT_DATA_DIR = process.env.DSH_ACP_CONTROL_DIR ?? resolve(process.cwd(), ".dsh-acp-control");

/** Parse the handful of flags this entry accepts. */
function parseArgs(argv) {
	const options = {
		transport: "stdio",
		host: "127.0.0.1",
		port: 7810,
		dataDir: DEFAULT_DATA_DIR,
		backend: "scripted",
		token: undefined,
		allowedOrigins: [],
		maxLogBytes: 64 * 1024 * 1024,
		chunkDelayMs: 12,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = () => argv[++index];
		switch (arg) {
			case "--stdio":
				options.transport = "stdio";
				break;
			case "--http":
				options.transport = "http";
				break;
			case "--port":
				options.port = Number(next());
				break;
			case "--host":
				options.host = next();
				break;
			case "--token":
				options.token = next();
				break;
			case "--data-dir":
				options.dataDir = resolve(next());
				break;
			case "--backend":
				options.backend = next();
				break;
			case "--allow-origin":
				options.allowedOrigins.push(next());
				break;
			case "--max-log-bytes":
				options.maxLogBytes = Number(next());
				break;
			case "--chunk-delay-ms":
				options.chunkDelayMs = Number(next());
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}
	return options;
}

const USAGE = `dsh-acp-control — ACP control plane

  --stdio                    serve NDJSON JSON-RPC on stdin/stdout (default)
  --http                     serve loopback HTTP+SSE
  --host <addr>              bind address for --http (default 127.0.0.1)
  --port <n>                 port for --http (default 7810; 0 = any free port)
  --token <secret>           shared secret; generated when omitted
  --allow-origin <origin>    allow one browser origin (repeatable)
  --backend <name>           scripted (default here) | dsh
  --data-dir <path>          where events.jsonl lives (default ./.dsh-acp-control)
  --max-log-bytes <n>        log size cap (default 67108864)
  --chunk-delay-ms <n>       scripted backend pacing (default 12)
`;

/**
 * Note on logging: everything goes to stderr, always, even in HTTP mode.
 * During stdio service stdout is the protocol channel, and a logger that
 * switches streams based on the transport is a logger that will one day write
 * a log line into a JSON-RPC frame.
 */
function logToStderr(message) {
	process.stderr.write(`dsh-acp-control: ${message}\n`);
}

/** Boot the server described by `argv`. */
export async function main(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	if (options.help === true) {
		process.stdout.write(USAGE);
		return 0;
	}
	await mkdir(options.dataDir, { recursive: true });

	const backend =
		options.backend === "dsh"
			? await loadDshBackend({ logger: logToStderr })
			: createScriptedBackend({ chunkDelayMs: options.chunkDelayMs });
	if (backend.name !== "dsh") {
		logToStderr(
			`using the "${backend.name}" backend — this is a deterministic fixture, not an agent. ` +
				`Use --backend dsh inside a DSH profile for real work.`,
		);
	}

	const control = await createControlPlane({
		backend,
		dataDir: options.dataDir,
		logger: logToStderr,
		maxLogBytes: options.maxLogBytes,
		agentName: `dsh-acp-control (${backend.name})`,
	});

	if (options.transport === "http") {
		const transport = await startHttpTransport({
			plane: control.plane,
			host: options.host,
			port: options.port,
			token: options.token,
			allowedOrigins: options.allowedOrigins,
			logger: logToStderr,
		});
		// One machine-readable line on stderr, so a supervisor or a check can
		// learn the bound port without parsing prose.
		logToStderr(`READY ${JSON.stringify({ port: transport.port, host: transport.host, url: transport.url, token: transport.token, acl: transport.acl, backend: backend.name })}`);
		const stop = async () => {
			await transport.close();
			await control.close();
			process.exit(0);
		};
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
		return { transport, control, stop };
	}

	logToStderr(`READY ${JSON.stringify({ transport: "stdio", backend: backend.name })}`);
	const stdio = serveStdio({
		plane: control.plane,
		input: process.stdin,
		output: process.stdout,
		logger: logToStderr,
		onClose: () => {
			void control.close().finally(() => process.exit(0));
		},
	});
	return { stdio, control };
}

// Run when executed as a program. `pathToFileURL` rather than string surgery:
// on Windows `process.argv[1]` is a backslash path, and hand-built file URLs
// from those put the drive letter in the *host* position and silently never
// compare equal to `import.meta.url`.
const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly || process.env.DSH_ACP_CONTROL_RUN === "1") {
	main().catch((error) => {
		logToStderr(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		process.exit(1);
	});
}
