#!/usr/bin/env node
/**
 * Slice-2 check: **attachment**, run as the acceptance test it is meant to
 * satisfy.
 *
 * A second frontend owns a session and runs a turn in it, exactly as the web
 * GUI does. An ACP client then attaches to that session *by its DSH session id*
 * and sends a follow-up, and the question this check answers is whether the two
 * frontends are looking at one conversation:
 *
 *  1. the ACP client sees the turn the *other* frontend started, including its
 *     streamed updates and its state transitions;
 *  2. the ACP client's own turn reaches the other frontend — so a human
 *     watching the GUI would see the reply arrive in the same conversation
 *     without reloading;
 *  3. the ACP client's message is attributed to the plugin, not to the human,
 *     so the GUI can say where it came from instead of impersonating the person
 *     watching it;
 *  4. prompting while the other frontend's turn is generating is **refused**,
 *     naming the state — the conservative policy, not a silent queue;
 *  5. the plugin never disposes the agent it borrowed: after the ACP client
 *     detaches, the other frontend's session is still alive and still usable.
 *
 * The fixture is `verify/codriver/`. See its header for what it does and does
 * not stand in for — in particular it does not mount the canonical session
 * controller, so `rename`/`archive`/`planMode` delegation is out of scope here.
 *
 * Usage: node verify/attach-check.mjs
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
const PROFILE = "acpctl-attach";
const PORT = 7813;
const TOKEN = "attach-check";

const failures = [];
const checks = [];

function check(name, ok, detail) {
	checks.push({ name, ok, detail });
	if (!ok) failures.push(`${name}${detail === undefined ? "" : ` — ${detail}`}`);
	console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok || detail === undefined ? "" : `  (${detail})`}`);
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/** Read the fixture's observation log. */
function observed(dir) {
	try {
		return readFileSync(join(dir, "observed.jsonl"), "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

/** Poll until `predicate` holds, or give up. */
async function until(predicate, { timeoutMs = 60_000, every = 150 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() > deadline) return undefined;
		await delay(every);
	}
}

// ── the profile ─────────────────────────────────────────────────────────────

/**
 * Build a throwaway profile that mounts the plugin and the co-driver fixture.
 *
 * Deliberately **not** the web profile: restarting the harness would kill the
 * live sessions the operator is working in. This is a separate profile on a
 * separate port, and it is removed afterwards.
 */
function writeProfile(home, dir) {
	const profileDir = join(home, "profiles", PROFILE);
	// Unique per run: DSH persists sessions in the shared home, so a fixed id
	// collides with the previous run's session and the profile refuses to boot.
	const fixtureSessionId = `codriver-${Date.now().toString(36)}`;
	rmSync(profileDir, { recursive: true, force: true });
	mkdirSync(join(profileDir, "plugins"), { recursive: true });
	mkdirSync(join(profileDir, "node_modules"), { recursive: true });

	// The same scaffolding the headless profile uses.
	writeFileSync(join(profileDir, "cordis.yml"), "[]\n", "utf8");
	writeFileSync(join(profileDir, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n", "utf8");
	writeFileSync(
		join(profileDir, "package.json"),
		`${JSON.stringify(
			{
				name: `dsh-profile-${PROFILE}`,
				private: true,
				dependencies: {
					"dsh-acp-control": `link:${join(home, "profiles", PROFILE, "plugins", "dsh-acp-control").replace(/\\/g, "/")}`,
					"dsh-opencode-go-session": `link:${join(home, "profiles", PROFILE, "plugins", "dsh-opencode-go-session").replace(/\\/g, "/")}`,
					"dsh-acp-control-codriver": `link:${join(home, "profiles", PROFILE, "plugins", "dsh-acp-control-codriver").replace(/\\/g, "/")}`,
				},
				dsh: {
					profile: {
						bundles: ["dsh-opencode-go-session", "@deepseek-ai/dsh-base", "dsh-acp-control"],
					},
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	// The plugin is COPIED into the profile tree: Node resolves a junction to
	// its target, so a linked plugin's parent-walk never reaches the profile's
	// node_modules for `@deepseek-ai/cordis`.
	const copy = (from, to) => {
		rmSync(to, { recursive: true, force: true });
		cpSync(from, to, { recursive: true, dereference: true });
	};
	copy(PLUGIN_DIR, join(profileDir, "plugins", "dsh-acp-control"));
	rmSync(join(profileDir, "plugins", "dsh-acp-control", "verify"), { recursive: true, force: true });
	copy(join(home, "profiles", "web", "plugins", "dsh-opencode-go-session"), join(profileDir, "plugins", "dsh-opencode-go-session"));
	copy(join(PLUGIN_DIR, "verify", "codriver"), join(profileDir, "plugins", "dsh-acp-control-codriver"));

	// The fixture needs its own row, and the plugin needs a fixed token and port
	// so the check can reach it without scraping a boot log.
	writeFileSync(
		join(profileDir, "cordis.patch.yml"),
		[
			"- id: acp-control",
			"  config:",
			`    token: ${TOKEN}`,
			`    port: ${PORT}`,
			"- insert:",
			"    - id: codriver",
			"      name: dsh-acp-control-codriver",
			"      config:",
			`        sessionId: ${JSON.stringify(fixtureSessionId)}`,
			`        cwd: ${JSON.stringify(dir.replace(/\\/g, "/"))}`,
			"        # Given explicitly: a fixture that resolves the profile's default",
			"        # at mount time can win the race against settings loading and end",
			"        # up on an unconfigured provider, which shows up as a turn that",
			"        # produces no assistant message at all.",
			"        agentOptions:",
			"          provider: opencode-go",
			"          model: deepseek-v4.1-flash",
			"",
		].join("\n"),
		"utf8",
	);

	// A directory junction, so the bare specifier resolves and the loader finds
	// the plugin's real directory for its own peer imports.
	for (const name of ["dsh-acp-control", "dsh-opencode-go-session", "dsh-acp-control-codriver"]) {
		const link = join(profileDir, "node_modules", name);
		rmSync(link, { recursive: true, force: true });
		symlinkSync(join(profileDir, "plugins", name), link, "junction");
	}
	return { profileDir, fixtureSessionId };
}

// ── the ACP client ──────────────────────────────────────────────────────────

async function main() {
	const dir = join(tmpdir(), `dsh-acp-attach-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	console.log(`\n=== dsh-acp-control — attachment (two frontends, one session) ===`);
	console.log(`fixture dir ${dir}`);
	console.log(`profile     ${PROFILE} on 127.0.0.1:${PORT} (a throwaway; the web profile is untouched)\n`);

	const { fixtureSessionId } = writeProfile(DSH_HOME, dir);
	const child = spawn(process.execPath, [DSH_BIN, "--profile", PROFILE], {
		cwd: DSH_HOME,
		env: { ...process.env, DSH_HOME, CODRIVER_DIR: dir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const log = [];
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			for (const line of String(chunk).split("\n")) if (line.trim() !== "") log.push(line.trim());
		});
	}

	const base = `http://127.0.0.1:${PORT}`;
	try {
		// ── wait for both frontends ──────────────────────────────────────────
		const owned = await until(() => existsSync(join(dir, "session.txt")), { timeoutMs: 150_000 });
		// `until` returns `undefined` on timeout, so a truthiness test is the
		// only correct guard — `=== false` would fall through and fail later
		// with a confusing ENOENT instead of the profile's own output.
		if (!owned) throw new Error(`the fixture never announced a session.\nprofile output:\n${log.slice(-30).join("\n")}`);
		const sessionId = readFileSync(join(dir, "session.txt"), "utf8").trim();
		check("the fixture owns the session the profile was told to create", sessionId === fixtureSessionId, `${sessionId} vs ${fixtureSessionId}`);
		console.log(`--- the other frontend owns session ${sessionId}`);
		await until(async () => {
			const res = await fetch(`${base}/healthz`).catch(() => undefined);
			return res?.status === 200;
		}, { timeoutMs: 120_000 });

		// ── an ACP client attaches by DSH session id ─────────────────────────
		const nextId = { value: 1 };
		const pending = new Map();
		const updates = [];
		const stateChanges = [];
		let connectionId;
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
			const id = nextId.value++;
			const promise = new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 240_000);
				pending.set(id, { resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
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

		const controller = new AbortController();
		await post({
			jsonrpc: "2.0",
			id: 0,
			method: "initialize",
			params: {
				protocolVersion: 1,
				clientCapabilities: { _meta: { "dsh-acp-control/extensions": true } },
				clientInfo: { name: "attach-check", version: "1.0.0" },
			},
		});
		// The stream comes *after* initialize: it is bound to the
		// Acp-Connection-Id that initialize returns, so opening it first would
		// have no connection to attach to.
		const streamReady = (async () => {
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
						if (frame.id !== undefined && frame.method === undefined) {
							pending.get(frame.id)?.resolve(frame);
							pending.delete(frame.id);
						}
						if (frame.method === "session/update" && frame.params?.sessionId === sessionId) {
							updates.push(frame.params.update);
						}
						if (frame.method === "_dsh/session/state_changed" && frame.params?.sessionId === sessionId) {
							stateChanges.push(frame.params);
						}
					}
				}
			}
		})().catch(() => {});
		await delay(80);

		console.log("\n--- the ACP client sees the other frontend's session ------");
		const listed = await request("session/list", {});
		const row = listed.sessions?.find((entry) => entry.sessionId === sessionId);
		check("session/list shows the other frontend's session", row !== undefined, `got ${listed.sessions?.length} row(s)`);
		check("and reports it as live rather than a dead row", row?.live === true, JSON.stringify(row));
		// The plugin adopts a live session the moment it appears, so by the time
		// any client looks it is already a first-class session here — which is
		// the point, and better than a row waiting to be claimed.
		check("and it is already adopted, not a row waiting to be claimed", row?.attached === true, JSON.stringify(row));
		check("owned by someone else, so this plugin must not dispose it", row?.owned === false, JSON.stringify(row));
		check("with a real state, not an artificial closed", row?.state === "idle", `state ${row?.state}`);

		console.log("\n--- the human types a prompt in the other frontend ---------");
		// Event-driven, not poll-driven: the transition is delivered on the
		// stream the instant it happens, so waiting for the notification is
		// deterministic where sampling the state on a timer would race a fast
		// turn.
		writeFileSync(join(dir, "command.txt"), "prompt:Reply with exactly: from-the-human", "utf8");
		const sawGenerating = await until(() => stateChanges.some((change) => change.to === "generating"), { timeoutMs: 120_000 });
		if (!sawGenerating) {
			console.log(`  observed so far: ${JSON.stringify(observed(dir).map((entry) => `${entry.kind}:${entry.type ?? entry.status ?? ""}`))}`);
		}
		check(
			"the ACP client is told the OTHER frontend's turn started",
			sawGenerating === true,
			`state changes: ${JSON.stringify(stateChanges)}`,
		);
		// Anchor the "turn finished" wait to the generating transition we just
		// saw. A bare `to === 'idle'` matches the *adoption* transition that
		// happened at attach time, so it would return immediately and every
		// assertion after it would run mid-turn.
		const generatingAt = stateChanges.findIndex((change) => change.to === "generating");
		const midTurn = await request("_dsh/session/state", { sessionId }).catch(() => undefined);
		check(
			"and its own view of the state agrees",
			midTurn?.state === "generating",
			`state ${midTurn?.state}`,
		);

		console.log("\n--- an ACP prompt during that turn is refused, not queued ----");
		let refusal;
		try {
			await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "interrupt!" }] });
			refusal = undefined;
		} catch (error) {
			refusal = error.data;
		}
		check(
			"prompting while the human's turn runs is refused, naming the state",
			refusal?.type === "refused" && refusal?.state === "generating",
			JSON.stringify(refusal),
		);

		// Let the human's turn finish — the first `idle` *after* the generating
		// transition, not any idle.
		await until(() => stateChanges.findIndex((change) => change.to === "idle") > generatingAt, { timeoutMs: 180_000 });
		await delay(300);
		const humanText = observed(dir).filter((entry) => entry.kind === "assistant-text").map((entry) => entry.text).join(" ");
		check("the human's turn produced an answer", humanText.trim().length > 0, humanText.trim().slice(0, 120));
		check(
			"and the ACP client received that turn's streamed updates",
			updates.some((update) => update.sessionUpdate === "agent_message_chunk"),
			`${updates.length} update(s)`,
		);

		console.log("\n--- the ACP client attaches and sends a follow-up ----------");
		const attached = await request("session/resume", { sessionId });
		check("session/resume ATTACHES to the live session", attached?.attached === true, JSON.stringify(attached));
		const beforeCount = observed(dir).filter((entry) => entry.kind === "session/event" && entry.type === "turn/start").length;
		const reply = await request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "Reply with exactly: from-the-acp-client" }],
		});
		check("the ACP follow-up completes", typeof reply?.stopReason === "string", JSON.stringify(reply));

		const events = observed(dir);
		const turnStarts = events.filter((entry) => entry.kind === "session/event" && entry.type === "turn/start").length;
		check("the other frontend saw a NEW turn it did not start", turnStarts > beforeCount, `${beforeCount} -> ${turnStarts}`);

		// This is the acceptance criterion: the reply arrives in the frontend the
		// human is watching, in the same conversation, without a reload.
		const acpText = events.filter((entry) => entry.kind === "assistant-text").map((entry) => entry.text).join(" ");
		check(
			"the ACP client's turn produced an answer the OTHER frontend received",
			acpText.includes("from-the-acp-client"),
			acpText.trim().slice(-160),
		);

		console.log("\n--- attribution: the GUI can tell it was not the human ----");
		// The ACP-originated message must be attributed to the plugin, so the
		// frontend rendering the conversation can say where it came from rather
		// than impersonating the person watching it. This is read from the
		// fixture's own observation of the durable event, not from this plugin's
		// claim about what it sent.
		const promptSources = events
			.filter((entry) => entry.kind === "session/event" && entry.type === "user/message")
			.map((entry) => entry.source)
			.filter((source) => source !== undefined);
		check(
			"the other frontend received the ACP message attributed to the plugin",
			promptSources.some((source) => source.kind === "plugin" && source.plugin === "dsh-acp-control"),
			JSON.stringify(promptSources),
		);
		check(
			"and the human's own message stayed attributed to the user",
			promptSources.some((source) => source.kind === "user"),
			JSON.stringify(promptSources),
		);

		console.log("\n--- the borrowed agent survives the ACP client ------------");
		await request("session/close", { sessionId });
		const after = await request("_dsh/session/state", { sessionId }).catch(() => undefined);
		check(
			"closing the ACP view does not close the other frontend's session",
			after === undefined || after.live === false,
			JSON.stringify(after),
		);
		// The owner is still running and still holds its agent: if the plugin had
		// disposed it, the fixture would have crashed or its agent would be gone.
		writeFileSync(join(dir, "command.txt"), "prompt:Reply with exactly: owner-still-alive", "utf8");
		const ownerAlive = await until(
			() => observed(dir).filter((entry) => entry.kind === "assistant-text").some((entry) => entry.text.includes("owner-still-alive")),
			{ timeoutMs: 120_000 },
		);
		check("the owning frontend's session is STILL USABLE after the ACP client detaches", ownerAlive === true);

		controller.abort();
		await streamReady;
	} finally {
		// Always show what the two frontends actually saw. A turn that produces
		// no assistant message is the failure this check exists to make legible,
		// and its reason is in the turn-end event and the fixture's own log.
		const events = observed(dir);
		console.log("\n--- what the other frontend observed --------------------------");
		for (const entry of events.slice(-25)) {
			const detail =
				entry.kind === "session/event" && entry.type === "turn/end"
					? ` reason=${JSON.stringify(entry.data?.reason)}`
					: entry.kind === "assistant-text"
						? ` ${JSON.stringify(entry.text?.slice(0, 80))}`
						: "";
			console.log(`  | ${entry.kind}:${entry.type ?? entry.status ?? ""}${detail}`);
		}
		const fixtureLog = (() => {
			try {
				return readFileSync(join(dir, "codriver.log"), "utf8").trim().split("\n");
			} catch {
				return [];
			}
		})();
		if (fixtureLog.length > 0) {
			console.log("\n--- the owning frontend's log --------------------------------");
			for (const line of fixtureLog.slice(-15)) console.log(`  | ${line}`);
		}
		const interesting = log.filter((line) => /acp-control|error|fail|route|model/i.test(line));
		if (interesting.length > 0) {
			console.log("\n--- profile log (filtered) ------------------------------------");
			for (const line of interesting.slice(-25)) console.log(`  | ${line}`);
		}
		child.kill();
		await delay(500);
		rmSync(join(DSH_HOME, "profiles", PROFILE), { recursive: true, force: true });
		rmSync(dir, { recursive: true, force: true });
	}

	console.log(`\n=== ${checks.length - failures.length}/${checks.length} checks passed ===`);
	if (failures.length > 0) {
		console.log("\nFAILURES:");
		for (const failure of failures) console.log(`  - ${failure}`);
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(`\nverify/attach-check.mjs crashed: ${error?.stack ?? error}`);
	process.exitCode = 1;
});
