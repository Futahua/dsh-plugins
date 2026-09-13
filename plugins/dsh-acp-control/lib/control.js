/**
 * Wiring: log + backend + registry + plane, in the order they depend on each
 * other.
 *
 * Both entry points use this — the Cordis plugin (`index.js`) and the runnable
 * server (`lib/standalone.js`) — so the two can never drift into subtly
 * different control planes.
 *
 * @module dsh-acp-control/control
 */

import { join } from "node:path";
import { EventLog } from "./eventlog.js";
import { SessionRegistry } from "./session.js";
import { ControlPlane } from "./server.js";

/**
 * Build a control plane over a backend.
 *
 * @param {object} options - build options.
 * @param {object} options.backend - the backend adapter (lib/backends.js).
 * @param {string} options.dataDir - directory holding `events.jsonl`.
 * @param {(message: string) => void} [options.logger] - diagnostics; must not write to stdout during stdio service.
 * @param {string} [options.agentName] - reported by `initialize`.
 * @param {string} [options.version] - reported by `initialize`.
 * @param {number} [options.maxLogBytes] - the log's size cap.
 * @returns {Promise<{plane: ControlPlane, registry: SessionRegistry, log: EventLog, recovery: object, close: () => Promise<void>}>}
 */
export async function createControlPlane({
	backend,
	dataDir,
	logger,
	agentName = "dsh-acp-control",
	version = "1.0.0",
	maxLogBytes,
}) {
	const log = await EventLog.open({ path: join(dataDir, "events.jsonl"), maxBytes: maxLogBytes });
	// The registry delivers live frames through the plane's broadcaster, and
	// the plane needs the registry — so the sink closes over a binding that is
	// assigned one line later. Passing a snapshot of the plane here instead
	// would leave the registry writing into a dead callback, which is exactly
	// the silent-no-op shape this plugin exists to eliminate.
	let plane;
	const registry = new SessionRegistry({
		log,
		backend,
		sink: (frame, record) => plane?.broadcast(frame, record),
	});
	plane = new ControlPlane({ registry, logger, agentName, version });
	const recovery = registry.recover();

	logger?.(
		`recovered ${recovery.recovered} session(s) from ${log.path}; ` +
			`last event ${recovery.lastEventId}` +
			(recovery.dropped > 0 ? `, ${recovery.dropped} unreadable line(s) dropped` : ""),
	);
	if (log.exhausted) {
		logger?.(`the event log is at its size cap and will refuse further mutations (${log.path})`);
		log.appendExhaustionNotice();
	}

	return {
		plane,
		registry,
		log,
		recovery,
		async close() {
			registry.dispose();
			await log.close();
		},
	};
}
