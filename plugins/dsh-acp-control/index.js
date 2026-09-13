/**
 * dsh-acp-control — an ACP control plane for DeepSeek Harness sessions.
 *
 * WHY THIS EXISTS
 *
 * Two ACP servers for DSH already exist and neither closes the hole this one
 * is aimed at.
 *
 * `@deepseek-ai/dsh-acp` (the first-party server) is stdio-only and, in its
 * own words, supports no "transcript replay" — `session/resume` restores a log
 * "without replaying old updates". There is no remote transport at all.
 *
 * `dushaobindoudou/dsh-acp` adds HTTP+SSE, but its stream buffers frames only
 * before the *first* attach: after a disconnect, everything emitted during the
 * gap is gone and the client is not told. Its only concurrency guard is a
 * `prompting` boolean with an ad-hoc error string, and nothing on the wire
 * says who caused a change.
 *
 * ACP itself will not fix the resync: the Streamable HTTP & WebSocket
 * Transport RFD is still Active, targets v1, and states outright that
 * in-flight messages are **not** replayed, deferring resumability to v2.
 *
 * So this plugin adds the three things neither has:
 *
 *  1. **An append-only event log with a monotonic id and replay from a
 *     cursor**, so a reconnecting client misses nothing and duplicates
 *     nothing. The cursor rides the SSE `id:` field, which means a browser's
 *     `EventSource` supplies it on reconnect with no client code at all.
 *  2. **An explicit session state machine.** Every command is admitted or
 *     refused by a transition table, and every refusal is a structured error
 *     naming the state that blocked it. This is the part that matters most:
 *     DSH's own rename dialog once accepted text and silently discarded it
 *     while a session was generating, and that bug class — accepted and
 *     discarded — is designed out here rather than patched. `lib/session.js`
 *     proves it mechanically: an admitted command that appends no event is
 *     raised as an internal error, never returned as a success.
 *  3. **Actor identity on every mutation and every event** (`human:zed`,
 *     `agent:<id>`, `system:acp-control`), so "who changed this" is answerable
 *     from the log and renderable on the wire in `_meta`.
 *
 * Rename, archive, and fork live in a small `_dsh/…` namespace shaped like the
 * draft RFDs, so migration is mechanical when they stabilise. Rename in
 * particular is *published* on the stable wire as `session_info_update`; the
 * extension exists only because stable ACP has no client→agent request for
 * setting a title.
 *
 * The design and the reasoning behind each decision are in DESIGN.md. The
 * checks are in verify/.
 *
 * DEPENDENCIES: none beyond the Cordis/Schemastery peers every plugin in this
 * repository already uses, and the `@deepseek-ai/dsh-*` packages a DSH profile
 * provides. The ACP wire is implemented directly in `lib/jsonrpc.js` against
 * the stable v1 schema (DESIGN.md §8).
 *
 * @module dsh-acp-control
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createControlPlane } from "./lib/control.js";
import { createDshBackend } from "./lib/backend-dsh.js";
import { serveStdio } from "./lib/transport-stdio.js";
import { startHttpTransport } from "./lib/transport-http.js";

export const name = "acp-control";

/**
 * The backend creates agents through `ctx.agents`, so the registry must exist
 * before this plugin mounts. `agentDefaultModel` is optional: without it a
 * session is created with the profile's own default route.
 */
export const inject = ["agents"];

/** VERSION is reported by `initialize` and is what a client shows in its agent list. */
const VERSION = "1.0.0";

/** Where the event log lives when the configuration does not say. */
function defaultDataDir() {
	const home = process.env.DSH_HOME;
	return home !== undefined && home.length > 0 ? join(home, "acp-control") : resolve(homedir(), ".dsh", "acp-control");
}

/**
 * The control plane as a DSH service.
 *
 * The transports are chosen explicitly rather than guessed. `transport: auto`
 * means **HTTP on loopback and nothing else** — deliberately not "stdio if
 * stdout is not a terminal", because `dsh web` runs with its stdout redirected
 * to a log file, and a stdio transport that mistook a redirected stdout for an
 * editor's pipe would write JSON-RPC frames into that log. A stdio server must
 * be asked for, and belongs in a profile booted for it (see README.md).
 */
class AcpControl extends Service {
	static Config = z.object({
		enabled: z.boolean().default(true),
		/** `auto` (loopback HTTP only) | `http` | `stdio` | `both`. */
		transport: z.union(["auto", "http", "stdio", "both"]).default("auto"),
		/** Bind address. Loopback by default; anything else is an explicit opt-in. */
		host: z.string().default("127.0.0.1"),
		/** HTTP port; `0` asks the operating system for a free one. */
		port: z.number().default(7810),
		/** Shared secret. Empty generates one at boot and logs it to stderr. */
		token: z.string().default(""),
		/** Browser origins allowed by CORS. Empty means no CORS headers at all. */
		allowedOrigins: z.array(z.string()).default([]),
		/** Where `events.jsonl` lives. Empty uses `$DSH_HOME/acp-control`. */
		dataDir: z.string().default(""),
		/** Refuse further writes past this log size rather than dropping events. */
		maxLogBytes: z.number().default(64 * 1024 * 1024),
		/** Provider route for sessions this plugin creates; empty uses the profile default. */
		provider: z.string().default(""),
		/** Model for sessions this plugin creates; empty uses the profile default. */
		model: z.string().default(""),
	});

	constructor(ctx, config) {
		super(ctx, "acpControl");
		if (!config.enabled) {
			ctx.logger?.info?.("acp-control: disabled by configuration");
			return;
		}
		/** Diagnostics go to the logger, never to stdout: stdout may be a protocol channel. */
		this.#logger = (message) => {
			const logger = ctx.logger;
			if (logger?.info !== undefined) logger.info(`acp-control: ${message}`);
			else process.stderr.write(`dsh-acp-control: ${message}\n`);
		};
		this.#config = config;
		// An async start cannot be awaited from a constructor, so the promise is
		// kept and every failure is reported through the logger rather than
		// becoming an unhandled rejection nobody sees.
		this.ready = this.#start(ctx, config).catch((error) => {
			this.#logger(`failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
			this.startError = error;
		});
		ctx.effect(() => () => {
			void this.stop();
		});
	}

	#config;
	#logger = () => {};
	#control;
	#transports = [];

	/** The event log, for `_dsh/log/info` and for other plugins. */
	get log() {
		return this.#control?.log;
	}

	/** The control plane, exposed so another plugin can drive or inspect it. */
	get plane() {
		return this.#control?.plane;
	}

	/** A snapshot for a status surface; never throws. */
	info() {
		if (this.#control === undefined) return { ready: false, error: this.startError?.message };
		return {
			ready: true,
			http: this.#transports.filter((entry) => entry.kind === "http").map((entry) => entry.url),
			stdio: this.#transports.some((entry) => entry.kind === "stdio"),
			connections: this.#control.plane.connectionCount,
			sessions: this.#control.registry.all().length,
			...this.#control.log.info(),
		};
	}

	async #start(ctx, config) {
		const dataDir = config.dataDir === "" ? defaultDataDir() : resolve(config.dataDir);
		const backend = await createDshBackend({
			ctx,
			logger: this.#logger,
			provider: config.provider === "" ? undefined : config.provider,
			model: config.model === "" ? undefined : config.model,
		});
		this.#control = await createControlPlane({
			backend,
			dataDir,
			logger: this.#logger,
			agentName: `dsh-acp-control (${backend.name})`,
			version: VERSION,
			maxLogBytes: config.maxLogBytes,
		});

		const wantsHttp = config.transport === "auto" || config.transport === "http" || config.transport === "both";
		const wantsStdio = config.transport === "stdio" || config.transport === "both";

		if (wantsHttp) {
			const transport = await startHttpTransport({
				plane: this.#control.plane,
				host: config.host,
				port: config.port,
				token: config.token === "" ? undefined : config.token,
				allowedOrigins: config.allowedOrigins,
				logger: this.#logger,
			});
			this.#transports.push({ kind: "http", url: transport.url, close: () => transport.close() });
			this.#logger(
				`serving ACP at ${transport.url} (backend ${backend.name}, secret ${transport.acl}); ` +
					`clients send X-Secret-Key, or ?token= where a header is impossible`,
			);
		}
		if (wantsStdio) {
			const stdio = serveStdio({
				plane: this.#control.plane,
				input: process.stdin,
				output: process.stdout,
				logger: this.#logger,
			});
			this.#transports.push({ kind: "stdio", close: () => stdio.close() });
			this.#logger("serving ACP on stdin/stdout; stdout now carries protocol frames only");
		}
		if (!wantsHttp && !wantsStdio) this.#logger("no transport selected; nothing is being served");
	}

	/** Close every transport, then the log. Idempotent. */
	async stop() {
		for (const transport of this.#transports.splice(0)) {
			try {
				await transport.close();
			} catch (error) {
				this.#logger(`closing the ${transport.kind} transport failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		await this.#control?.close();
		this.#control = undefined;
	}
}

export { AcpControl };
export default AcpControl;
