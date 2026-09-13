/**
 * A stand-in for the frontend that *owns* a session.
 *
 * This fixture exists to test attachment honestly, and its honesty rests on one
 * thing: it owns its agent exactly the way the web GUI does — it calls
 * `ctx.agents.create` itself, holds the resulting handle, drives the turn with
 * `agent.followup`, and is the only party entitled to dispose it. The plugin
 * under test has to reach that agent through `ctx.agents.get` and must never
 * tear it down.
 *
 * What it deliberately does **not** claim to be: the web GUI. It does not mount
 * `@deepseek-ai/dsh-api-session-controller`, so the canonical-service
 * delegation (`rename`, `archive`, `planMode`) is *not* exercised by this
 * fixture and says so in the check's output. What it does exercise is the part
 * attachment actually depends on — `agents.get`, `agent.ctx`, `followup`,
 * `cancel`, and ownership.
 *
 * It talks to the check through a directory of small files, because the two
 * halves run in different processes and a file is the least machinery that can
 * cross that boundary without adding a service to the profile:
 *
 * | file | direction | meaning |
 * | --- | --- | --- |
 * | `session.txt` | out | the id of the session this fixture owns |
 * | `observed.jsonl` | out | one line per committed session event, and per status change |
 * | `command.txt` | in | `prompt:<text>` makes the fixture run a turn as the human |
 *
 * @module dsh-acp-control/verify/codriver
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const name = "codriver";
export const inject = ["agents"];

/** Where the fixture talks to the check. */
const DIR = process.env.CODRIVER_DIR ?? process.cwd();

/** Append one JSON line to the observation log. */
function observe(record) {
	try {
		appendFileSync(join(DIR, "observed.jsonl"), `${JSON.stringify({ at: Date.now(), ...record })}\n`, "utf8");
	} catch {
		// The check may already have torn the directory down.
	}
}

/** Read a file, or undefined when it is not there yet. */
function readIfPresent(path) {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return undefined;
	}
}

/**
 * Mount the fixture.
 * @param {object} ctx - the Cordis context.
 */
export async function apply(ctx, config) {
	const [{ createUserMessage }, { SessionId }, { installModelSelection }] = await Promise.all([
		import("@deepseek-ai/dsh-llm"),
		import("@deepseek-ai/dsh-session"),
		import("@deepseek-ai/dsh-agent"),
	]);
	mkdirSync(DIR, { recursive: true });

	const sessionId = config.sessionId;
	const log = (message) => {
		// Written to the fixture directory as well as the host logger: a profile
		// boot's logger output is not reachable from the check that spawned it,
		// and "the turn produced nothing" is exactly the failure that must not
		// be allowed to happen silently.
		try {
			appendFileSync(join(DIR, "codriver.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
		} catch {
			// The check may already have torn the directory down.
		}
		ctx.logger?.info?.(`codriver: ${message}`);
	};

	// The route for this session. A real frontend resolves one before composing
	// its agent (`ApiSessionAgentController.composeAgent`); without it the agent
	// has no model to call and a turn ends with no assistant message at all —
	// which is exactly the silent-looking failure this fixture hit first.
	const fallback = ctx.get("agentDefaultModel")?.currentSelection?.();
	const route =
		config.agentOptions ??
		(fallback === undefined ? undefined : { provider: fallback.provider, model: fallback.model });
	if (route === undefined) log("no model route resolved; turns will fail");
	else log(`using route ${route.provider}/${route.model}`);

	// Subscribe to the agent's own events *before* anything can happen, so the
	// observation log is a full transcript rather than a partial one. This is
	// what a GUI does with the session it is displaying, and it is how the
	// check can prove the ACP client's turn reached the other frontend.
	let sink;
	const setup = (agentCtx) => {
		if (route !== undefined) installModelSelection(agentCtx, { current: route, assembled: undefined });
		agentCtx.on("session/event", (_session, event) => {
			observe({
				kind: "session/event",
				type: event?.type,
				data: event?.data,
				// The attribution the check reads. `user/message` carries the
				// `UserMessage` directly as its data (unlike `assistant/message`,
				// which wraps one), so the source is on `data.source`.
				source: event?.type === "user/message" ? event.data?.source : event?.data?.message?.source,
			});
			if (event?.type === "assistant/message") {
				const text = (event.data?.message?.content ?? [])
					.filter((block) => block?.type === "text")
					.map((block) => block.text)
					.join("");
				if (text.length > 0) observe({ kind: "assistant-text", text });
			}
		});
	};

	const handle = await ctx.agents.create({
		sessionId: SessionId(sessionId),
		meta: { cwd: config.cwd },
		agentOptions: route,
		setup,
	});
	ctx.effect(() => () => handle.dispose());
	sink = handle.agent;

	// Announce ownership, and the fact that only this fixture may dispose it.
	writeFileSync(join(DIR, "session.txt"), sessionId, "utf8");
	observe({ kind: "owner", sessionId, status: sink.status });
	log(`owning session ${sessionId} (status ${sink.status})`);

	// The command channel: `prompt:<text>` runs a turn as the *human* would —
	// `source: {kind: 'user'}`, which is exactly what the GUI sends.
	let lastCommand;
	let lastStatus = sink.status;
	const timer = setInterval(() => {
		if (sink.status !== lastStatus) {
			lastStatus = sink.status;
			observe({ kind: "status", status: sink.status });
		}
		const command = readIfPresent(join(DIR, "command.txt"));
		if (command === undefined || command === lastCommand) return;
		lastCommand = command;
		if (!command.startsWith("prompt:")) return;
		const text = command.slice("prompt:".length);
		observe({ kind: "human-prompt", text });
		sink.followup(
			createUserMessage({
				content: [{ type: "text", text }],
				source: { kind: "user" },
			}),
		);
	}, 200);
	ctx.effect(() => () => clearInterval(timer));
}
