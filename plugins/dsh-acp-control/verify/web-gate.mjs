#!/usr/bin/env node
/**
 * The gate: attachment inside the **real web composition**.
 *
 * Not the co-driver fixture. This profile mounts `@deepseek-ai/dsh-web-app`, so
 * the canonical services the browser talks to are present and real:
 * `ctx.sessionController` (create-or-resume dedup, prompt admission,
 * cancellation with `keepInbox`), `ctx.workspaceController`, and the host's own
 * answerer for permissions. The human side drives those services directly
 * rather than through the browser transport.
 *
 * **What this does not cover**, stated here because it is the honest boundary
 * of the evidence: the browser's own wire protocol (typert remote over the
 * web server) is not exercised, and neither is the GUI's rendering. What is
 * exercised is everything the plugin reasons about — who owns a turn, who may
 * answer a permission, and who may cancel.
 *
 * The five things the gate is for:
 *
 *  1. a prompt from the human side, which the ACP client must be able to watch;
 *  2. a prompt from the ACP client, which the human side must receive;
 *  3. a permission request during **each** direction — the probe is a write to a
 *     path outside the session workspace, so the approval is real (reads are
 *     permitted silently, and raise nothing). Answered by ACP when the turn is
 *     ACP's, and neither seen nor answered by ACP when it is the human's;
 *  4. the human cancelling an ACP turn — the ACP request settles as cancelled;
 *  5. ACP attempting to cancel the human's turn — refused, and the human's turn
 *     is left alone.
 *
 * Usage: node verify/web-gate.mjs
 */

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PLUGIN_DIR = resolve(import.meta.dirname, "..");
const DSH_HOME = process.env.DSH_HOME ?? "D:/Letters/MatTroiSeConMoc/.dsh";
const DSH_BIN =
	process.env.DSH_BIN ??
	"C:/Users/admin/AppData/Local/npm-cache/_npx/b86ed90107c62dab/node_modules/@deepseek-ai/dsh/lib/bin.js";
const PROFILE = "acpctl-web";
/** The ACP endpoint this profile serves. Not the GUI's port. */
const ACP_PORT = 7815;
/** The profile's own web server, on a port that is *not* the live GUI's. */
const WEB_PORT = 7816;
const TOKEN = "web-gate";

const failures = [];
const checks = [];
const unproven = [];

function check(name, ok, detail) {
	checks.push({ name, ok, detail });
	if (!ok) failures.push(`${name}${detail === undefined ? "" : ` — ${detail}`}`);
	console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok || detail === undefined ? "" : `  (${detail})`}`);
}

/** Record something the gate could not establish, rather than asserting it. */
function cannotProve(name, why) {
	unproven.push(`${name}: ${why}`);
	console.log(`  N/A   ${name}  (${why})`);
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function observed(dir, file = "observed.jsonl") {
	try {
		return readFileSync(join(dir, file), "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

async function until(predicate, { timeoutMs = 90_000, every = 200 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() > deadline) return undefined;
		await delay(every);
	}
}

/**
 * Build the throwaway web-composition profile.
 *
 * The webserver port is overridden explicitly: the bundle's fallback is 3080,
 * which is where the operator's live GUI is listening. A profile that tried to
 * bind it would fail at best, and disturb a running session at worst.
 */
function writeProfile(home, dir) {
	const profileDir = join(home, "profiles", PROFILE);
	rmSync(profileDir, { recursive: true, force: true });
	mkdirSync(join(profileDir, "plugins"), { recursive: true });
	mkdirSync(join(profileDir, "node_modules"), { recursive: true });

	const fixtureSessionId = `gate-${Date.now().toString(36)}`;
	writeFileSync(join(profileDir, "cordis.yml"), "[]\n", "utf8");
	writeFileSync(join(profileDir, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n", "utf8");
	writeFileSync(
		join(profileDir, "package.json"),
		`${JSON.stringify(
			{
				name: `dsh-profile-${PROFILE}`,
				private: true,
				dependencies: {
					"dsh-acp-control": `link:${join(profileDir, "plugins", "dsh-acp-control").replace(/\\/g, "/")}`,
					"dsh-opencode-go-session": `link:${join(profileDir, "plugins", "dsh-opencode-go-session").replace(/\\/g, "/")}`,
					"dsh-acp-control-human-driver": `link:${join(profileDir, "plugins", "dsh-acp-control-human-driver").replace(/\\/g, "/")}`,
				},
				dsh: {
					profile: {
						// The real web composition, so the canonical services exist.
						bundles: ["dsh-opencode-go-session", "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-acp-control"],
					},
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	const copy = (from, to) => {
		rmSync(to, { recursive: true, force: true });
		cpSync(from, to, { recursive: true, dereference: true });
	};
	copy(PLUGIN_DIR, join(profileDir, "plugins", "dsh-acp-control"));
	rmSync(join(profileDir, "plugins", "dsh-acp-control", "verify"), { recursive: true, force: true });
	copy(join(home, "profiles", "web", "plugins", "dsh-opencode-go-session"), join(profileDir, "plugins", "dsh-opencode-go-session"));
	copy(join(PLUGIN_DIR, "verify", "human-driver"), join(profileDir, "plugins", "dsh-acp-control-human-driver"));
	for (const name of ["dsh-acp-control", "dsh-opencode-go-session", "dsh-acp-control-human-driver"]) {
		const link = join(profileDir, "node_modules", name);
		rmSync(link, { recursive: true, force: true });
		symlinkSync(join(profileDir, "plugins", name), link, "junction");
	}

	writeFileSync(
		join(profileDir, "cordis.patch.yml"),
		[
			"# The throwaway web composition. Both ports are moved off the operator's",
			"# live GUI so this profile cannot disturb it.",
			"- id: webserver",
			"  config:",
			"    host: 127.0.0.1",
			`    port: ${WEB_PORT}`,
			"    compression: gzip",
			"    compressionLevel: 1",
			"    compressionThresholdBytes: 1024",
			"- id: web-runtime",
			"  config:",
			"    openBrowser: false",
			"    printUrl: false",
			"    surfaceContext: false",
			"    trustedHosts: []",
			"- id: acp-control",
			"  config:",
			`    token: ${TOKEN}`,
			`    port: ${ACP_PORT}`,
			// Its own log, so a gate run cannot read or disturb another run's
			// event history — and so this run's history is exactly this run's.
			`    dataDir: ${JSON.stringify(`${dir.replace(/\\/g, "/")}/acp-log`)}`,
			"- insert:",
			"    - id: human-driver",
			"      name: dsh-acp-control-human-driver",
			"      config:",
			`        sessionId: ${JSON.stringify(fixtureSessionId)}`,
			`        cwd: ${JSON.stringify(dir.replace(/\\/g, "/"))}`,
			"        preset: workspace-write",
			"",
		].join("\n"),
		"utf8",
	);
	return { profileDir, fixtureSessionId };
}

async function main() {
	const dir = join(tmpdir(), `dsh-acp-gate-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	console.log("\n=== the gate: attachment inside the real web composition ===");
	console.log(`profile  ${PROFILE}  (web server on ${WEB_PORT}, ACP on ${ACP_PORT})`);
	console.log(`the live GUI on 3080 is not touched\n`);

	const { fixtureSessionId } = writeProfile(DSH_HOME, dir);
	const child = spawn(process.execPath, [DSH_BIN, "--profile", PROFILE], {
		cwd: DSH_HOME,
		env: { ...process.env, DSH_HOME, HUMAN_DRIVER_DIR: dir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const log = [];
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			for (const line of String(chunk).split("\n")) if (line.trim() !== "") log.push(line.trim());
		});
	}

	const base = `http://127.0.0.1:${ACP_PORT}`;
	try {
		const ready = await until(() => existsSync(join(dir, "session.txt")), { timeoutMs: 180_000 });
		if (!ready) {
			throw new Error(`the human side never became ready.\nprofile output:\n${log.slice(-40).join("\n")}`);
		}
		const sessionId = readFileSync(join(dir, "session.txt"), "utf8").trim();
		check("the real web composition mounted and the human side owns a session", sessionId === fixtureSessionId, sessionId);
		await until(async () => (await fetch(`${base}/healthz`).catch(() => undefined))?.status === 200, { timeoutMs: 60_000 });

		// ── ACP client ───────────────────────────────────────────────────────
		const pending = new Map();
		const updates = [];
		const stateChanges = [];
		const refusalNotices = [];
		const permissionRequests = [];
		let permissionAnswer = "allow-once";
		let connectionId;
		let nextId = 1;
		const post = async (frame) => {
			const res = await fetch(`${base}/acp`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-secret-key": TOKEN,
					...(connectionId === undefined ? {} : { "acp-connection-id": connectionId }),
				},
				body: JSON.stringify(frame),
			});
			await res.arrayBuffer();
			if (frame.method === "initialize" && res.status === 200) connectionId = res.headers.get("acp-connection-id");
			return res.status;
		};
		const request = async (method, params) => {
			const id = nextId++;
			const promise = new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 300_000);
				pending.set(id, {
					resolve: (frame) => {
						clearTimeout(timer);
						resolve(frame);
					},
				});
			});
			await post({ jsonrpc: "2.0", id, method, params });
			const frame = await promise;
			if (frame.error !== undefined) {
				const error = new Error(frame.error.message);
				error.data = frame.error.data;
				throw error;
			}
			return frame.result;
		};

		await post({
			jsonrpc: "2.0",
			id: 0,
			method: "initialize",
			params: {
				protocolVersion: 1,
				clientCapabilities: { _meta: { "dsh-acp-control/extensions": true } },
				clientInfo: { name: "web-gate", version: "1.0.0" },
			},
		});
		const controller = new AbortController();
		const pump = (async () => {
			const res = await fetch(`${base}/acp/stream?token=${TOKEN}&after=-1&connection=${connectionId}`, { signal: controller.signal });
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done === true) return;
				buffer += decoder.decode(value, { stream: true });
				let split;
				while ((split = buffer.indexOf("\n\n")) !== -1) {
					const block = buffer.slice(0, split);
					buffer = buffer.slice(split + 2);
					if (block.startsWith(":")) continue;
					for (const line of block.split("\n")) {
						if (!line.startsWith("data:")) continue;
						const frame = JSON.parse(line.slice(5).trim());
						if (frame.id !== undefined && frame.method === undefined && pending.has(frame.id)) {
							pending.get(frame.id).resolve(frame);
							pending.delete(frame.id);
							continue;
						}
						if (frame.method === "session/request_permission" && frame.params?.sessionId === sessionId) {
							permissionRequests.push(frame.params);
							// Answer on the next tick, so the transcript shows the
							// question arriving before the answer.
							setTimeout(() => {
								post({
									jsonrpc: "2.0",
									id: frame.id,
									result: { outcome: { outcome: "selected", optionId: permissionAnswer } },
								});
							}, 50);
						}
						if (frame.method === "session/update" && frame.params?.sessionId === sessionId) updates.push(frame.params.update);
						if (frame.method === "_dsh/session/state_changed" && frame.params?.sessionId === sessionId) stateChanges.push(frame.params);
						if (frame.method === "_dsh/session/refused" && frame.params?.sessionId === sessionId) refusalNotices.push(frame.params);
					}
				}
			}
		})().catch(() => {});
		await delay(100);

		console.log("\n--- the ACP client sees the human's session ------------------");
		const listed = await request("session/list", {});
		const row = listed.sessions?.find((entry) => entry.sessionId === sessionId);
		check("session/list shows it", row !== undefined);
		check("as live and adopted, owned elsewhere", row?.live === true && row?.owned === false, JSON.stringify(row));

		// Every wait below is anchored to an index into `stateChanges` taken
		// *before* the turn is started. Counting idle transitions cumulatively
		// is the obvious way to write these and it is wrong: by the third step
		// the earlier turns have already satisfied the count, so the wait
		// returns instantly and the next step races a turn that is still
		// running. That mistake is what the first run of this gate did.
		const mark = () => stateChanges.length - 1;
		const idleAfter = (from) => until(() => stateChanges.slice(from + 1).some((change) => change.to === "idle"), { timeoutMs: 240_000 });
		const startAfter = (from) => until(() => stateChanges.slice(from + 1).some((change) => change.to === "generating"), { timeoutMs: 120_000 });
		const turnsEnded = (reason) => observed(dir).filter((entry) => entry.kind === "human-turn-end" && entry.reason === reason).length;
		// The *state*, asked for directly, rather than a transition scanned out
		// of the stream. A transition scan is wrong whenever a state is passed
		// through: DSH ends one queued turn and starts the next in the same
		// breath, so a momentary `idle` sits in the stream that no longer
		// describes the session by the time it is read. Everything below that
		// has to know whether the session is *actually* at rest asks this.
		const stateNow = async () => (await request("_dsh/session/state", { sessionId }).catch(() => undefined))?.state;
		const idleNow = () => until(async () => (await stateNow()) === "idle", { timeoutMs: 240_000, every: 400 });

		console.log("\n--- [1] a human-originated prompt ----------------------------");
		let at = mark();
		writeFileSync(join(dir, "command.txt"), "prompt:Reply with exactly: human-one", "utf8");
		const sawHuman = await startAfter(at);
		check("the ACP client is told the human's turn started", sawHuman === true, JSON.stringify(stateChanges.slice(-3)));
		check("and told it ended", (await idleAfter(at)) === true, JSON.stringify(stateChanges.slice(-3)));
		const humanAcks = observed(dir).filter((entry) => entry.kind === "human-prompt-accepted");
		check(
			"the human's prompt was admitted by the real session controller",
			humanAcks.length > 0 && humanAcks.every((entry) => entry.accepted === true),
			JSON.stringify(humanAcks),
		);
		if (turnsEnded("completed") > 0) {
			check("and its turn ended as completed, observed by the human side itself", true);
		} else {
			cannotProve(
				"that the human's turn ended as `completed` in the host log",
				"the human side's session/event observer recorded no completed turn boundary (see its log)",
			);
		}
		check(
			"and the ACP client received that turn's streamed output",
			updates.some((update) => update.sessionUpdate === "agent_message_chunk"),
			`${updates.length} update(s)`,
		);

		console.log("\n--- [2] an ACP-originated prompt -----------------------------");
		at = mark();
		const before = observed(dir).length;
		const acpTurn = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Reply with exactly: acp-one" }] });
		check("the ACP prompt completes", typeof acpTurn?.stopReason === "string", JSON.stringify(acpTurn));
		check(
			"and it ended because its own turn completed, not on a timeout or a guess",
			acpTurn?.stopReason === "end_turn",
			`stopReason ${acpTurn?.stopReason}`,
		);
		const after = observed(dir).slice(before);
		const sawStart = after.filter((entry) => entry.kind === "human-turn-start").length;
		const sawEnd = after.filter((entry) => entry.kind === "human-turn-end").length;
		if (after.length > 0) {
			check("the human side observed a turn it did not start", sawStart > 0 && sawEnd > 0, `${sawStart} start(s), ${sawEnd} end(s)`);
		} else {
			cannotProve("that the human side observed the ACP turn", "the human side's session/event observer recorded nothing at all");
		}

		console.log("\n--- [3] permission requests, in each direction ---------------");
		// A permission request only exists if the agent reaches outside what the
		// sandbox permits. The pinned knobs are `sandbox: workspace-write`,
		// `approval: ask`, which confine **writes**: a read outside the
		// workspace is permitted silently (measured — a read probe raised
		// nothing), so the probe is a write to a path outside the workspace.
		// The target is a single clearly-named file that this gate removes
		// afterwards, and the probe is attempted in both directions so the
		// approval is real whichever turn owns it.
		const PROBE_FILE = "C:\\ProgramData\\dsh-acp-gate-probe.txt";
		const askForTool = `Run the shell command \`Set-Content -LiteralPath ${PROBE_FILE} -Value gate -ErrorAction Stop\` and tell me what happened.`;
		const knob = (type) => observed(dir).filter((entry) => entry.kind === "knob" && entry.knob === type).map((entry) => entry.value);
		const pinned = observed(dir).filter((entry) => entry.kind === "preset-pinned").length > 0;
		if (pinned) {
			check(
				"the human side pinned a permission preset, so an approval can actually be raised",
				knob("approval/policy").some((value) => /ask/i.test(JSON.stringify(value))) &&
					knob("sandbox/mode").some((value) => /workspace-write/i.test(JSON.stringify(value))),
				`policy ${JSON.stringify(knob("approval/policy"))}, sandbox ${JSON.stringify(knob("sandbox/mode"))}`,
			);
		} else {
			cannotProve(
				"that a permission preset was pinned",
				`the human side could not pin one: ${JSON.stringify(observed(dir).filter((entry) => entry.kind === "preset-failed").slice(-1))}`,
			);
		}

		// Both directions use the same probe and the same shape: start the turn,
		// wait until an approval is asked for or the turn ends, assert what
		// happened to that approval, then release the turn. A profile with no
		// browser attached has nobody to answer the host's own approval, so a
		// parked turn is cancelled rather than waited on — otherwise this step
		// burns its whole timeout and, worse, leaves the session busy for the
		// steps after it.
		const askedCount = () => observed(dir).filter((entry) => entry.kind === "approval/asked").length;
		let cancelSeq = 0;
		const release = async () => {
			cancelSeq += 1;
			writeFileSync(join(dir, "command.txt"), `cancel:${cancelSeq}`, "utf8");
			await idleNow();
			await delay(400);
		};

		const acpAsked = permissionRequests.length;
		const askedBeforeAcp = askedCount();
		at = mark();
		const acpProbe = request("session/prompt", { sessionId, prompt: [{ type: "text", text: askForTool }] }).then(
			(value) => ({ value }),
			(error) => ({ error: error.data ?? String(error?.message ?? error) }),
		);
		const askedAcp = await until(() => askedCount() > askedBeforeAcp, { timeoutMs: 150_000 });
		if (askedAcp === true && permissionRequests.length > acpAsked) {
			check("an approval during an ACP turn was routed to the ACP client", true);
			check("and the host log agrees an approval was asked for", askedCount() > askedBeforeAcp, `${askedCount() - askedBeforeAcp}`);
		} else if (askedAcp === true) {
			check(
				"an approval during an ACP turn was routed to the ACP client",
				false,
				"an approval was asked for during this control plane's own turn and was not routed to it",
			);
		} else {
			cannotProve(
				"an approval during an ACP turn is routed to the ACP client",
				"the agent reached no approval on this profile's policy, so no request existed to route",
			);
		}
		await release();
		const acpOutcome = await acpProbe;
		if (askedAcp === true && permissionRequests.length > acpAsked) {
			check(
				"and the ACP client's answer settled the turn rather than leaving it parked",
				acpOutcome?.value?.stopReason !== undefined,
				JSON.stringify(acpOutcome),
			);
		}

		// The other direction: the human's turn. ACP must not answer it, and
		// must not even see it.
		const humanPermissionsBefore = permissionRequests.length;
		const askedBeforeHuman = askedCount();
		at = mark();
		writeFileSync(join(dir, "command.txt"), `prompt:${askForTool}`, "utf8");
		await startAfter(at);
		const askedHuman = await until(() => askedCount() > askedBeforeHuman, { timeoutMs: 150_000 });
		const leaked = permissionRequests.length > humanPermissionsBefore;
		if (leaked) {
			check(
				"a permission during the HUMAN's turn is NOT answered by the ACP client",
				false,
				`the ACP client received ${permissionRequests.length - humanPermissionsBefore} request(s) it must not own`,
			);
		} else if (askedHuman === true) {
			check("an approval was raised during the HUMAN's turn, and the ACP client never saw it", true);
		} else {
			cannotProve(
				"a permission during the HUMAN's turn is NOT answered by the ACP client",
				"no approval was raised during the human's turn either, so the fail-closed path had nothing to refuse",
			);
		}
		await release();
		if (askedHuman === true) {
			const decided = observed(dir).filter((entry) => entry.kind === "approval/decided");
			if (decided.length === 0) {
				cannotProve("that the human's approval was answered by the host", "no decision was recorded before the turn was cancelled");
			} else {
				check("the human's approval was answered on the host side, not by this plugin", true);
			}
		}

		console.log("\n--- [4] the human cancels an ACP turn ------------------------");
		// A long turn the ACP client owns, cancelled from the other side.
		//
		// The settlement is converted to a value *immediately*. A bare floating
		// promise here rejects while the gate is still waiting for the turn to
		// start, and an unhandled rejection takes the whole process down —
		// which is how the first run of this gate died, skipping its own
		// cleanup. `.then(ok, err)` is attached before anything is awaited.
		at = mark();
		const settled = request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "Write a detailed 1200-word essay on the history of the printing press. Do not use any tools." }],
		}).then(
			(value) => ({ value }),
			(error) => ({ error: error.data ?? String(error?.message ?? error) }),
		);
		await startAfter(at);
		await delay(800);
		cancelSeq += 1;
		writeFileSync(join(dir, "command.txt"), `cancel:${cancelSeq}`, "utf8");
		const cancelled = await settled;
		const humanCancelled = await until(() => observed(dir).some((entry) => entry.kind === "human-cancel-requested"), { timeoutMs: 30_000 });
		check("the human's cancel reached the controller", humanCancelled === true);
		check(
			"and the ACP request settled as cancelled rather than as a clean end",
			cancelled?.value?.stopReason === "cancelled",
			JSON.stringify(cancelled),
		);
		await idleNow();
		await delay(300);

		console.log("\n--- [5] ACP tries to stop the HUMAN's turn -------------------");
		// The human starts a turn; ACP must not be able to stop it, and must
		// not be able to slip work in behind it either. The prompt is chosen to
		// run for a while: an earlier revision used a shorter one and the turn
		// finished inside the 2.7 s this step needs, which turned three real
		// checks into races against the model's typing speed.
		const completedBefore = turnsEnded("completed");
		at = mark();
		writeFileSync(join(dir, "command.txt"), "prompt:Write a detailed 1200-word essay on the history of the printing press. Do not use any tools.", "utf8");
		await startAfter(at);
		await delay(400);
		await post({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
		await delay(900);
		const stillRunning = await request("_dsh/session/state", { sessionId }).catch(() => undefined);
		check("ACP cancelling the human's turn does NOT stop it", stillRunning?.state === "generating", `state ${stillRunning?.state}`);
		check(
			"and the refused cancel is reported, because a notification has no response channel",
			refusalNotices.some((notice) => notice.command === "cancel"),
			JSON.stringify(refusalNotices.filter((notice) => notice.command === "cancel").slice(-1)),
		);

		// A refused command has a response channel, so the refusal can be
		// asserted rather than inferred. This is the multi-actor case the whole
		// invariant is for: the session is busy, but not with *our* turn.
		const refused = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "this must not be admitted" }] }).then(
			() => ({ admitted: true }),
			(error) => ({ data: error.data, message: String(error?.message ?? error) }),
		);
		check(
			"an ACP prompt during the human's turn is refused, not queued behind it",
			refused.admitted !== true && refused.data?.type === "refused" && refused.data?.command === "prompt",
			JSON.stringify(refused),
		);
		check(
			"and the refusal names the state that blocked it, what is allowed, and what to do",
			refused.data?.allowedIn?.includes("idle") === true && typeof refused.data?.hint === "string" && refused.data?.eventId > 0,
			JSON.stringify({ state: refused.data?.state, allowedIn: refused.data?.allowedIn, hint: refused.data?.hint, eventId: refused.data?.eventId }),
		);

		await idleNow();
		await delay(500);
		const completedAfter = turnsEnded("completed");
		if (completedBefore === 0 && completedAfter === 0) {
			cannotProve(
				"that the human's turn went on to finish normally",
				"the human side observed no completed turn boundary to count",
			);
		} else {
			check(
				"the human's turn went on to finish normally",
				completedAfter > completedBefore,
				`${completedBefore} → ${completedAfter} completed turn(s)`,
			);
		}

		console.log("\n--- [6] a queued human turn replaces ours with no idle gap -----");
		// DSH runs queued turns back to back: `while (await this.turn()) {}`. So
		// a human turn queued while an ACP turn runs *starts* the moment ours
		// ends, with no Agent-idle in between. The settlement of our prompt used
		// to clear `generating` unconditionally on its way out, which cleared
		// the *human's* turn instead — `_dsh/session/state` then described a
		// working session as idle, and the next ACP prompt passed the idle-only
		// admission check and was queued behind the human's turn.
		check("the session is at rest before this step", (await idleNow()) === true, `state ${await stateNow()}`);
		const completedBeforeHandoff = turnsEnded("completed");
		at = mark();
		const shortTurn = request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Reply with exactly: acp-a" }] }).then(
			(value) => ({ value }),
			(error) => ({ error: error.data ?? String(error?.message ?? error) }),
		);
		await startAfter(at);
		// The human queues a long turn behind ours, while ours is still running.
		const acksBeforeQueue = observed(dir).filter((entry) => entry.kind === "human-prompt-accepted").length;
		writeFileSync(
			join(dir, "command.txt"),
			"prompt:Write a detailed 1200-word essay on the history of the mechanical clock. Do not use any tools.",
			"utf8",
		);
		const queued = await until(
			() => observed(dir).filter((entry) => entry.kind === "human-prompt-accepted").length > acksBeforeQueue,
			{ timeoutMs: 60_000 },
		);
		check("the human's follow-up was admitted while the ACP turn was still running", queued === true);
		const firstTurn = await shortTurn;
		check("the ACP turn it was queued behind completed", typeof firstTurn?.value?.stopReason === "string", JSON.stringify(firstTurn));
		// The response above is sent only after our settlement block has run, so
		// the clobber — when it happens — has already happened by now. Polling
		// rather than sampling once only tolerates the human's turn starting a
		// moment later; it cannot mask a clobber, because that turn's
		// `turn/start` has already fired and cannot fire twice.
		const handedOff = await until(async () => (await stateNow()) === "generating", { timeoutMs: 20_000, every: 300 });
		check(
			"the session is still generating, because the turn that is running is the human's",
			handedOff === true,
			`state ${await stateNow()}`,
		);
		const contending = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "must not be queued behind the human" }] }).then(
			() => ({ admitted: true }),
			(error) => ({ data: error.data, message: String(error?.message ?? error) }),
		);
		check(
			"and a second ACP prompt is refused rather than queued behind the human's turn",
			contending.admitted !== true && contending.data?.type === "refused" && contending.data?.state === "generating",
			JSON.stringify(contending),
		);
		await post({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
		await delay(900);
		check("and an ACP cancel cannot stop the turn it does not own", (await stateNow()) === "generating", `state ${await stateNow()}`);
		check(
			"and the human's queued turn then ran to completion",
			(await until(() => turnsEnded("completed") > completedBeforeHandoff, { timeoutMs: 240_000 })) === true,
			`${completedBeforeHandoff} → ${turnsEnded("completed")} completed turn(s)`,
		);
		check("and the session came back to rest after it", (await idleNow()) === true, `state ${await stateNow()}`);

		console.log("\n--- [7] closing the session during an ACP turn ---------------");
		// `session/close` used to be admitted from `generating`: it aborted the
		// request and detached the listeners that were the only thing that could
		// ever see the turn end. For a session this plugin *adopted*, dispose
		// correctly leaves the GUI's agent alone — and that is exactly what made
		// the request unfinishable. It must refuse, or it must settle first.
		at = mark();
		const doomed = request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "Write a detailed 1200-word essay on the history of papermaking. Do not use any tools." }],
		}).then(
			(value) => ({ value }),
			(error) => ({ error: error.data ?? String(error?.message ?? error) }),
		);
		const doomedStarted = await startAfter(at);
		if (doomedStarted !== true) {
			cannotProve("closing during an ACP-authored turn is refused", "no ACP-owned turn started, so there was nothing to contend with");
		} else {
			await delay(600);
			check("the ACP turn this step contends with is one this connection owns", (await stateNow()) === "generating", `state ${await stateNow()}`);
			const closeAttempt = await request("session/close", { sessionId }).then(
				() => ({ closed: true }),
				(error) => ({ data: error.data, message: String(error?.message ?? error) }),
			);
			check(
				"closing during an ACP-authored turn is refused, not admitted",
				closeAttempt.closed !== true && closeAttempt.data?.type === "refused" && closeAttempt.data?.command === "close",
				JSON.stringify(closeAttempt),
			);
			check(
				"and the refusal says to stop the turn first",
				typeof closeAttempt.data?.hint === "string" && /cancel/i.test(closeAttempt.data.hint),
				JSON.stringify(closeAttempt.data?.hint),
			);
			check("and the session was not closed", (await stateNow()) === "generating", `state ${await stateNow()}`);
		}
		// The request must still be able to finish: that is the whole point.
		cancelSeq += 1;
		writeFileSync(join(dir, "command.txt"), `cancel:${cancelSeq}`, "utf8");
		const doomedOutcome = await Promise.race([doomed, delay(120_000).then(() => "timeout")]);
		check(
			"and the in-flight request settled rather than hanging",
			doomedOutcome !== "timeout",
			doomedOutcome === "timeout" ? "no settlement after 120s" : JSON.stringify(doomedOutcome),
		);
		if (doomedOutcome !== "timeout") {
			check(
				"as cancelled, because the human stopped it",
				doomedOutcome?.value?.stopReason === "cancelled",
				JSON.stringify(doomedOutcome),
			);
		}
		check("and the session came back to rest", (await idleNow()) === true, `state ${await stateNow()}`);
		// A close that is *not* contending still works, and the session is then
		// gone from this control plane's view.
		const closedNow = await request("session/close", { sessionId }).then(
			() => ({ closed: true }),
			(error) => ({ data: error.data, message: String(error?.message ?? error) }),
		);
		check("closing an idle session still works", closedNow.closed === true, JSON.stringify(closedNow));

		controller.abort();
		await pump;
	} catch (error) {
		console.log(`\n${error?.stack ?? error}`);
		failures.push(`gate aborted: ${error?.message ?? error}`);
	} finally {
		console.log("\n--- what the human side observed -----------------------------");
		for (const entry of observed(dir).slice(-20)) {
			console.log(`  | ${entry.kind}${entry.stopReason ? ` ${entry.stopReason}` : ""}${entry.text ? ` ${entry.text}` : ""}`);
		}
		const humanLog = (() => {
			try {
				return readFileSync(join(dir, "human-driver.log"), "utf8").trim().split("\n");
			} catch {
				return [];
			}
		})();
		if (humanLog.length > 0) {
			console.log("\n--- the human side's log -------------------------------------");
			for (const line of humanLog.slice(-10)) console.log(`  | ${line}`);
		}
		const acpLog = log.filter((line) => /acp-control|error|refus|adopt|claim|authored|approval|quiescence|ownership/i.test(line));
		if (acpLog.length > 0) {
			console.log("\n--- the plugin's log -----------------------------------------");
			for (const line of acpLog.slice(-20)) console.log(`  | ${line}`);
		}
		child.kill();
		await delay(800);
		// The permission probe's target, if an approval was granted and the
		// command actually ran. Removed unconditionally: the gate should not
		// leave a trace of itself behind, whether or not it succeeded.
		rmSync("C:\\ProgramData\\dsh-acp-gate-probe.txt", { force: true });
		rmSync(join(DSH_HOME, "profiles", PROFILE), { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	}

	console.log(`\n=== ${checks.length - failures.length}/${checks.length} checks passed ===`);
	if (unproven.length > 0) {
		console.log("\nNOT PROVEN (reported rather than asserted):");
		for (const item of unproven) console.log(`  - ${item}`);
	}
	if (failures.length > 0) {
		console.log("\nFAILURES:");
		for (const failure of failures) console.log(`  - ${failure}`);
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(`\nverify/web-gate.mjs crashed: ${error?.stack ?? error}`);
	process.exitCode = 1;
});
