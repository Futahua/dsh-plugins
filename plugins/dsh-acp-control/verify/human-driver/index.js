/**
 * The *human* side of the gate test, driven through DSH's own session
 * controller.
 *
 * This is deliberately not the co-driver fixture: it mounts no agents itself
 * and touches `ctx.agents` only to read. Every action goes through
 * `ctx.sessionController` — the service the browser's API layer wraps — so the
 * gate exercises the real composition's create-or-resume dedup, its prompt
 * admission, and its cancellation, rather than a stand-in that happens to
 * produce similar events.
 *
 * What it does **not** do: speak the browser's wire protocol. The transport
 * between the GUI and this service is a thin typert wrapper over exactly these
 * calls, and that transport is not exercised here. That limit is stated in the
 * gate's output rather than glossed.
 *
 * File protocol, as the co-driver's, because the two halves run in different
 * processes:
 *
 * | file | direction | meaning |
 * | --- | --- | --- |
 * | `session.txt` | out | the session this side is looking at |
 * | `observed.jsonl` | out | prompt admissions, turn boundaries, approvals seen, cancel outcomes |
 * | `command.txt` | in | `prompt:<text>` or `cancel[:<n>]` — every line must differ from the last, because only a change is acted on |
 * | `human-driver.log` | out | diagnostics, including whether `session/event` is being received at all |
 *
 * @module dsh-acp-control/verify/human-driver
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const name = "human-driver";
export const inject = ["sessionController", "agents", "permissionPresets"];

const DIR = process.env.HUMAN_DRIVER_DIR ?? process.cwd();

function observe(record) {
	let line;
	try {
		line = JSON.stringify({ at: Date.now(), ...record });
	} catch {
		// Approval payloads are host objects and need not be serializable.
		line = JSON.stringify({ at: Date.now(), kind: String(record?.kind), unserializable: true });
	}
	try {
		appendFileSync(join(DIR, "observed.jsonl"), `${line}\n`, "utf8");
	} catch {
		// The gate may already have torn the directory down.
	}
}

/** The discriminant of a `turn/end` reason, which is a string or a tagged object. */
function reasonKind(reason) {
	if (typeof reason === "string") return reason;
	if (reason === null || typeof reason !== "object") return String(reason);
	return String(reason.kind ?? reason.reason ?? JSON.stringify(reason));
}

function readIfPresent(path) {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return undefined;
	}
}

/**
 * Mount the human side.
 * @param {object} ctx - the Cordis context.
 */
export async function apply(ctx, config) {
	mkdirSync(DIR, { recursive: true });
	const log = (message) => {
		try {
			appendFileSync(join(DIR, "human-driver.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
		} catch {
			/* torn down */
		}
		ctx.logger?.info?.(`human-driver: ${message}`);
	};

	const controller = ctx.sessionController;
	const sessionId = config.sessionId;

	// Approvals and turn boundaries are observed from the durable event stream
	// rather than intercepted. A listener that *answered* an approval would be a
	// third answerer and would destroy the very property the gate is testing.
	//
	// Whether this listener is reached at all is itself reported (the first few
	// events, whatever their session) so that a silent observer is visible as a
	// silent observer rather than mistaken for a quiet session.
	let seen = 0;
	ctx.on("session/event", (session, event) => {
		seen += 1;
		const id = String(session?.id ?? "");
		if (seen <= 4) log(`session/event #${seen}: session=${id || "<unknown>"} type=${event?.type} data=${JSON.stringify(event?.data)}`);
		if (id !== sessionId) return;
		if (event?.type === "turn/start") {
			observe({ kind: "human-turn-start", turn: event.data?.turn });
		} else if (event?.type === "turn/end") {
			observe({ kind: "human-turn-end", turn: event.data?.turn, reason: reasonKind(event.data?.reason) });
		} else if (event?.type === "approval/asked" || event?.type === "approval/decided") {
			observe({ kind: event.type, data: event.data });
		} else if (event?.type === "approval/policy" || event?.type === "sandbox/mode" || event?.type === "permission/preset") {
			observe({ kind: "knob", knob: event.type, value: event.data });
		}
	});

	// The GUI's own create-or-resume path. `create` is documented as
	// "create or idempotently adopt one ordinary Session", which is exactly what
	// opening a session in the browser does, and it deduplicates against
	// anything else already resolving the same id.
	//
	// `ensureSession` is deliberately not called: it lives on the controller's
	// private agent port, not on the mounted service, so reaching for it would
	// be driving something the browser cannot reach either.
	let created;
	try {
		created = await controller.create({ sessionId, cwd: config.cwd });
	} catch (error) {
		observe({ kind: "create-failed", message: String(error?.message ?? error) });
		throw error;
	}
	writeFileSync(join(DIR, "session.txt"), String(created?.sessionId ?? sessionId), "utf8");
	observe({ kind: "ready", sessionId: String(created?.sessionId ?? sessionId) });
	log(`owning session ${created?.sessionId ?? sessionId} through ctx.sessionController`);

	// Pin the permission preset the way a human does from the GUI's own
	// permission selector, so that a command reaching outside the sandbox
	// raises a real approval instead of being silently permitted or silently
	// denied. Without this the gate can only report the permission directions
	// as unproven, because nothing in the profile ever asks.
	if (typeof config.preset === "string" && config.preset !== "") {
		try {
			const agent = ctx.agents.get(sessionId);
			if (agent === undefined) {
				observe({ kind: "preset-failed", message: "no live agent for the session yet" });
			} else {
				ctx.permissionPresets.set(agent.session, config.preset);
				observe({ kind: "preset-pinned", preset: config.preset });
				log(`pinned permission preset ${config.preset}`);
			}
		} catch (error) {
			observe({ kind: "preset-failed", message: String(error?.message ?? error) });
			log(`could not pin permission preset: ${String(error?.message ?? error)}`);
		}
	}

	let lastCommand;
	let rpc = 0;
	// How often the command file is read. The gate shortens this to race its own
	// ACP admission deliberately: a human prompt has to be able to land inside
	// the window between an ACP prompt being admitted and its message reaching
	// the Agent, and a 200 ms poll cannot hit a window that size.
	const pollMs = Number.isInteger(config.pollMs) && config.pollMs > 0 ? config.pollMs : 200;
	const timer = setInterval(() => {
		const command = readIfPresent(join(DIR, "command.txt"));
		if (command === undefined || command === lastCommand) return;
		lastCommand = command;
		if (command.startsWith("prompt:")) {
			const text = command.slice("prompt:".length);
			rpc += 1;
			observe({ kind: "human-prompt", text });
			void controller
				.prompt(
					{
						requestId: `gate-${rpc}`,
						sessionId,
						mode: "queue",
						content: [{ type: "text", text }],
					},
					new AbortController().signal,
				)
				.then((value) => observe({ kind: "human-prompt-accepted", accepted: value?.accepted }))
				.catch((error) => observe({ kind: "human-prompt-failed", message: String(error?.message ?? error) }));
			return;
		}
		// `cancel` is accepted bare or with a suffix. The suffix exists because
		// this loop only reacts to a *change* in the file, so two cancels with
		// the same text are one cancel — which silently disarmed a later step of
		// the gate that believed it had cancelled something.
		if (command === "cancel" || command.startsWith("cancel:")) {
			observe({ kind: "human-cancel-requested" });
			try {
				const value = controller.cancel({ sessionId });
				observe({ kind: "human-cancel-returned", accepted: value?.accepted === true });
			} catch (error) {
				observe({ kind: "human-cancel-failed", message: String(error?.message ?? error) });
			}
		}
	}, pollMs);
	ctx.effect(() => () => clearInterval(timer));
}
