// Plumbing for measuring the LIVE GUI through the shared browser.
//
// Every verification script in this directory needs the same three things, and
// two of them were hardcoded before:
//
//   1. WHICH PORT the shared browser's DevTools endpoint is on. It used to be
//      passed as `--port 63681`; that port belongs to whichever Chrome the
//      browser-agent pane happened to launch, and it CHANGES between sessions
//      (observed: 63681 one session, 57120 the next). A hardcoded default made
//      the scripts fail with "no 3080 page among 3 targets" for a reason that
//      had nothing to do with the thing being verified. So the port is
//      discovered here, in this order:
//        a. an explicit `--port`;
//        b. `$DSH_CDP_PORT`;
//        c. the `DevToolsActivePort` file of the browser-agent's stealth
//           profile (`~/.dsh/browser-stealth-profile`), which is where that
//           plugin records the ephemeral port it launched with — a stale file
//           simply fails the liveness probe and falls through;
//        d. `netstat -ano` filtered to chrome processes, probing each listening
//           port, preferring the one that already has a 3080 page.
//
//   2. WHICH TARGET is the GUI. The pane is not the only page, and the two
//      DevTools endpoints on this machine are indistinguishable without asking.
//
//   3. THE COOKIE. The GUI answers 401 to anything without a valid browser
//      session, so a freshly opened page is a login screen, not the app. The
//      cookie is minted from the local credential store exactly as
//      check-live.mjs does and installed with `Network.setCookie` before the
//      navigation, which is the only way a measurement script can see the real
//      application.
//
// Nothing here is imported by `lib/client.js`; this file never runs in the page.
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const DSH_HOME = process.env.DSH_HOME ?? resolve(HERE, "../../../..");

/** host:port the GUI answers on. */
export const AUTHORITY = process.env.DSH_AUTHORITY ?? "127.0.0.1:3080";

/** Read a pid→name map so candidate ports can be filtered to Chrome. */
function chromePids() {
	const pids = new Set();
	try {
		const csv = execFileSync(
			"tasklist",
			["/FI", "IMAGENAME eq chrome.exe", "/NH", "/FO", "CSV"],
			{ encoding: "utf8", timeout: 10_000 },
		);
		for (const line of csv.split(/\r?\n/u)) {
			const match = /^"chrome\.exe","(\d+)"/u.exec(line.trim());
			if (match) pids.add(match[1]);
		}
	} catch {
		/* tasklist unavailable: fall back to probing every candidate */
	}
	return pids;
}

/** Every IPv4 loopback LISTENING port, with owning pid, from `netstat -ano`. */
function listeningPorts() {
	const out = [];
	let text = "";
	try {
		text = execFileSync("netstat", ["-ano"], { encoding: "utf8", timeout: 15_000 });
	} catch {
		return out;
	}
	for (const line of text.split(/\r?\n/u)) {
		const parts = line.trim().split(/\s+/u);
		if (parts.length < 5) continue;
		const [proto, local, , state, pid] = parts;
		if (proto !== "TCP" || state !== "LISTENING") continue;
		if (!local.startsWith("127.0.0.1:")) continue;
		const port = Number(local.slice(local.lastIndexOf(":") + 1));
		if (Number.isFinite(port) && port > 1024) out.push({ port, pid });
	}
	return out;
}

/** The port recorded by the browser-agent's stealth launch, if it is still live. */
function stealthPort() {
	const file = join(homedir(), ".dsh", "browser-stealth-profile", "DevToolsActivePort");
	if (!existsSync(file)) return null;
	const first = (readFileSync(file, "utf8").split(/\r?\n/u)[0] ?? "").trim();
	const port = Number(first);
	return Number.isFinite(port) && port > 0 ? port : null;
}

/** Ask one port whether it is a DevTools endpoint, and list its pages. */
async function probe(port, timeoutMs = 700) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal });
		if (!res.ok) return null;
		const list = await res.json();
		if (!Array.isArray(list)) return null;
		return list;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Find the shared browser's DevTools port.
 *
 * Candidates are probed concurrently; the endpoint that already shows a GUI page
 * wins, then any endpoint with page targets, then any endpoint at all.
 */
export async function devtoolsPort(explicit) {
	const wanted = explicit ?? process.env.DSH_CDP_PORT;
	if (wanted !== undefined && wanted !== null && String(wanted) !== "") {
		const port = Number(wanted);
		if (!Number.isFinite(port)) throw new Error(`bad --port ${wanted}`);
		return port;
	}

	const candidates = [];
	const push = (port) => {
		if (Number.isFinite(port) && port > 1024 && !candidates.includes(port)) candidates.push(port);
	};
	push(stealthPort());
	push(9222);
	const pids = chromePids();
	for (const { port, pid } of listeningPorts()) {
		if (pids.size === 0 || pids.has(pid)) push(port);
	}
	if (candidates.length === 0) throw new Error("no Chrome listening ports found — is the browser-agent pane running?");

	const probed = await Promise.all(candidates.map(async (port) => ({ port, list: await probe(port) })));
	const live = probed.filter((p) => p.list !== null);
	if (live.length === 0) {
		throw new Error(`none of ${candidates.length} candidate ports (${candidates.join(", ")}) is a DevTools endpoint`);
	}
	const host = AUTHORITY.split(":")[0];
	const withGui = live.find((p) => p.list.some((t) => t.type === "page" && t.url.includes(AUTHORITY.split(":")[1] ?? "3080")));
	const withPage = live.find((p) => p.list.some((t) => t.type === "page"));
	return (withGui ?? withPage ?? live[0]).port;
}

/** The GUI page among a DevTools endpoint's targets. */
export async function findTarget(port, { required = true } = {}) {
	const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const port3080 = AUTHORITY.split(":")[1] ?? "3080";
	const page = list.find((t) => t.type === "page" && t.url.includes(port3080));
	if (!page && required) {
		throw new Error(`no ${AUTHORITY} page among ${list.length} targets on ${port}: ${list.map((t) => t.url).join(", ")}`);
	}
	return page ?? null;
}

/** A minimal CDP client over one target's own WebSocket. */
export function connect(url) {
	return new Promise((resolve_, reject) => {
		const socket = new WebSocket(url);
		const pending = new Map();
		let next = 1;
		socket.addEventListener("open", () =>
			resolve_({
				send(method, params = {}) {
					const id = next++;
					socket.send(JSON.stringify({ id, method, params }));
					return new Promise((res, rej) => pending.set(id, { res, rej }));
				},
				close: () => socket.close(),
			}),
		);
		socket.addEventListener("message", (event) => {
			const msg = JSON.parse(event.data);
			if (msg.id === undefined) return;
			const slot = pending.get(msg.id);
			if (slot === undefined) return;
			pending.delete(msg.id);
			if (msg.error) slot.rej(new Error(`${msg.error.message}`));
			else slot.res(msg.result);
		});
		socket.addEventListener("error", () => reject(new Error(`cannot open ${url}`)));
	});
}

/** Read the browser-session signing secret from the local credential store. */
function readSecret() {
	const file = join(DSH_HOME, ".credentials.yaml");
	const text = readFileSync(file, "utf8");
	const match = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{43})/u.exec(text);
	if (!match) throw new Error(`${file} has no client-connection/browser-session secret`);
	return match[1];
}

const b64url = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

/** A signed browser-session cookie for one authority, backdated for clock skew. */
export function cookieFor(authority = AUTHORITY) {
	const key = Buffer.from(readSecret().replaceAll("-", "+").replaceAll("_", "/"), "base64");
	const issuedAt = Date.now() - 60_000;
	const expiresAt = issuedAt + 30 * 864e5;
	const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), "utf8"));
	const sig = b64url(createHmac("sha256", key).update(body).digest());
	const name = `dsh-auth-${b64url(createHash("sha256").update(authority).digest())}`;
	return { name, value: `v1.${body}.${sig}` };
}

/**
 * Install the session cookie and navigate to the GUI if the page is not already
 * there. Returns true when a navigation happened, so the caller knows it must
 * wait for the application to boot.
 */
export async function ensureGui(cdp, { authority = AUTHORITY } = {}) {
	await cdp.send("Network.enable");
	const { name, value } = cookieFor(authority);
	await cdp.send("Network.setCookie", { name, value, domain: "127.0.0.1", path: "/", httpOnly: true });
	const where = await tryEvaluate(cdp, "location.pathname");
	const loaded = await tryEvaluate(
		cdp,
		"document.querySelector('#root,#app,[data-dsh-root]') !== null || document.querySelectorAll('script').length > 3",
	);
	if (where === "/" && loaded === true) return false;
	await cdp.send("Page.navigate", { url: `http://${authority}/` });
	return true;
}

/** Evaluate one expression, returning `null` instead of throwing. */
export async function tryEvaluate(cdp, expression) {
	try {
		const out = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (out?.exceptionDetails) return null;
		return out?.result?.value ?? null;
	} catch {
		// A navigation in flight destroys the execution context and CDP rejects;
		// "the document is being replaced" is exactly the not-ready case.
		return null;
	}
}

/**
 * Wait until the conversation surface exists, or give up loudly.
 *
 * Every probe is guarded: the first seconds after `Page.navigate` are a storm of
 * destroyed execution contexts, and an unguarded evaluate turns that into a
 * crash inside the wait loop rather than a wait.
 */
export async function waitForApp(cdp, { timeoutMs = 30_000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	for (;;) {
		const v = await tryEvaluate(
			cdp,
			`(() => ({
				ready: document.readyState,
				root: document.querySelector('#root,#app,[data-dsh-root]') !== null,
				presence: typeof window.__ModuleLoader__ === "object",
				plugin: typeof window.__dshCodeColors === "object",
				text: (document.body.innerText || "").slice(0, 120),
			}))()`,
		);
		if (v !== null) {
			last = v;
			if (v.ready === "complete" && v.root && v.presence) return v;
		}
		if (Date.now() > deadline) throw new Error(`GUI did not boot in ${timeoutMs}ms: ${JSON.stringify(last)}`);
		await new Promise((r) => setTimeout(r, 250));
	}
}
