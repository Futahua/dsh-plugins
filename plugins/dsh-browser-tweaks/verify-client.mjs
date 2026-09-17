/**
 * Structural and behavioural self-check for the dsh-browser-tweaks client
 * bundle and its stealth-profile config override — no browser needed.
 *
 * Proves, without a page:
 *
 *  1. The package shape matches the repo pattern (`dsh.bundle.patch` +
 *     `dsh.client`, `./client` export, `__ModuleLoader__` envelope, no
 *     TS/JSX, no Node APIs, no filesystem touches).
 *  2. The stealth profile override wires the SHIPPED pane's `userDataDir` to
 *     the shortcut-created Chrome profile — not the default
 *     `~/.dsh/browser-stealth-profile`. `launchStealthBrowser()` in
 *     `@try-works/dsh-browser-agent` lib/index.js spawns Chrome with
 *     `--user-data-dir=<cfg.userDataDir>`, so this config entry is the whole
 *     of half (a).
 *  3. The bundle hides the "My Chrome" mode button while Headless + Plugin
 *     stay visible and clickable, ignores a same-named button outside the
 *     pane, re-hides a re-rendered toggle (collapse/expand survival), and
 *     restores everything on unload.
 *  4. The connect guard keeps the pane attached to the shortcut Chrome: it
 *     POSTs `/browser-pane/mode {mode:"connect"}` on install (before the
 *     pane's own EventSource can trigger an own-mode launch onto our profile
 *     dir) and re-posts on any pane state whose mode is not connect — and it
 *     talks to no other route, so it can neither launch nor drive anything.
 *
 * Run: node plugins\dsh-browser-tweaks\verify-client.mjs
 */
import { readFileSync } from "node:fs";

/**
 * DSH_CHROME_PROFILE_DIR — read from the shortcut itself, not guessed:
 *
 *   $sh = New-Object -ComObject WScript.Shell
 *   $sh.CreateShortcut('C:\Users\Public\Desktop\Chrome (DSH Browser).lnk').Arguments
 *   # --remote-debugging-port=9222 --user-data-dir="D:\Letters\MatTroiSeConMoc\.dsh\browser-profile"
 *
 * (Re-read 2026-09-17 after the profile moved out of evTEMP; the old
 * `D:\Programs\evTEMP\dsh-chrome-profile` directory is deleted.)
 *
 * The check below requires cordis.patch.yml to carry exactly this value.
 */
const EXPECTED_PROFILE_DIR = "D:\\Letters\\MatTroiSeConMoc\\.dsh\\browser-profile";

let failures = 0;
const check = (label, condition, detail = "") => {
	if (!condition) failures += 1;
	console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

const dirUrl = new URL("./", import.meta.url);
const clientSource = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
const patchText = readFileSync(new URL("./cordis.patch.yml", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// --- package shape (the repo pattern) ----------------------------------------
console.log("package shape:");
check("name is dsh-browser-tweaks", pkg.name === "dsh-browser-tweaks", String(pkg.name));
check("declares the bundle patch", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");
check("declares a web client", pkg.dsh?.client?.platform === "web");
check("exports ./client", typeof pkg.exports?.["./client"] === "string", String(pkg.exports?.["./client"]));

// --- stealth profile wiring (config, not DOM) ---------------------------------
console.log("stealth profile override:");
check("patch targets the shipped row", patchText.includes("id: dsh-browser-agent"));
const userDataDir = (patchText.match(/userDataDir:\s*['"]?([^'"\n]+)['"]?/)?.[1] ?? "").trim().replace(/'$/, "");
check("userDataDir is set", userDataDir !== "", JSON.stringify(userDataDir));
check("userDataDir is the shortcut profile (not the default)",
	userDataDir === EXPECTED_PROFILE_DIR, JSON.stringify(userDataDir));
check("userDataDir is not the packaged default", !userDataDir.includes("browser-stealth-profile"),
	JSON.stringify(userDataDir));
check("patch inserts our own row", patchText.includes("id: browser-tweaks") && patchText.includes("dsh-browser-tweaks"));
check("documents the layer-order caveat (profile layer replaces config)",
	/cordis\.patch\.yml/.test(patchText) && /AFTER/.test(patchText));

// --- bundle hygiene: a page has no Node APIs -----------------------------------
console.log("bundle hygiene:");
check("touches no filesystem (so nothing outside this plugin can be patched)",
	!clientSource.includes("readFileSync") && !clientSource.includes("writeFileSync") &&
		!clientSource.includes('require("fs")') && !clientSource.includes("require('fs')"),
	"no fs API in the bundle");
check("spawns no processes", !clientSource.includes("child_process"));
check("requires no modules", !clientSource.includes('require("') && !clientSource.includes("require('"));
check("talks to exactly one route, the mode switch",
	clientSource.includes('"/browser-pane/mode"') && !clientSource.includes("/browser-pane/back") &&
		!clientSource.includes("/browser-pane/forward") && !clientSource.includes("/browser-pane/reload") &&
		!clientSource.includes("/browser-pane/goto") && !clientSource.includes("/browser-pane/input"),
	"mode only, never drive/input routes");
check("always posts the attach mode, never a launch mode",
	clientSource.includes('{ mode: CONNECT_MODE }') && !clientSource.includes('"own"') &&
		!clientSource.includes('"stealth"'),
	"no own/stealth literal in the bundle");
check("never defers work to requestAnimationFrame (background tabs skip it)",
	!/requestAnimationFrame\s*\(/.test(clientSource));
check("no timers at all (observer-driven)", !clientSource.includes("setInterval") && !clientSource.includes("setTimeout("));
check("names the real pane hook", clientSource.includes("[data-dsh-browser-pane]"));
check("matches the shipped button text exactly", clientSource.includes('"My Chrome"'));

// --- a DOM small enough to reason about ---------------------------------------
// Models the shipped toggle: three ModeButtons in the expanded pane header,
// each posting its mode. Plus a same-named decoy OUTSIDE the pane.
const posts = [];
const paneContainer = { kind: "pane" };
const makeButton = (label, mode, inPane = true) => ({
	tagName: "BUTTON",
	textContent: label,
	isConnected: true,
	style: {},
	attrs: {},
	setAttribute(n, v) { this.attrs[n] = String(v); },
	getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; },
	removeAttribute(n) { delete this.attrs[n]; },
	hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); },
	closest: (sel) => (inPane && sel.includes("data-dsh-browser-pane") ? paneContainer : null),
	clicked: 0,
	click() { this.clicked += 1; posts.push({ mode }); },
});
let buttons = [
	makeButton("Headless", "own"),
	makeButton("Plugin", "stealth"),
	makeButton("My Chrome", "connect"),
	makeButton("My Chrome", "decoy", false),
];

const observers = [];
globalThis.MutationObserver = class {
	constructor(fn) { this.fn = fn; this.targets = []; this.disconnected = false; observers.push(this); }
	observe(target, opts) { this.targets.push({ target, opts }); }
	disconnect() { this.disconnected = true; }
	fire() { this.fn(); }
};
// Every connect post the bundle issues, with its exact shape.
const fetchPosts = [];
globalThis.fetch = async (url, opts) => {
	fetchPosts.push({ url, method: opts?.method, body: opts?.body });
	return { ok: true, json: async () => ({}) };
};
// The pane stream as the bundle sees it: state events fired by hand.
const sseSources = [];
globalThis.EventSource = class {
	constructor(url) { this.url = url; this.listeners = {}; this.closed = false; sseSources.push(this); }
	addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
	removeEventListener(type, fn) {
		const list = this.listeners[type] ?? [];
		const at = list.indexOf(fn);
		if (at >= 0) list.splice(at, 1);
	}
	fire(type, data) { for (const fn of [...(this.listeners[type] ?? [])]) fn({ data: JSON.stringify(data) }); }
	close() { this.closed = true; }
};
globalThis.window = {
	__ModuleLoader__: { load: (value) => { globalThis.__registration = value; } },
};
globalThis.document = {
	documentElement: { kind: "root" },
	body: { kind: "body" },
	querySelectorAll: (selector) => (selector === "button" ? buttons : []),
};

new Function("window", "document", "MutationObserver", clientSource)(
	globalThis.window, globalThis.document, globalThis.MutationObserver);

const registration = globalThis.__registration;
console.log("bundle envelope:");
check("registered with __ModuleLoader__", registration !== undefined);
check("declares its own id", registration?.id === "dsh-browser-tweaks", String(registration?.id));

const exported = registration.factory(() => {
	throw new Error("this bundle must not require any module");
});
console.log("exports:");
check("exports apply", typeof exported.apply === "function");
check("exports inject", Array.isArray(exported.inject));
check("exports the matched label", exported.MY_CHROME_LABEL === "My Chrome");
check("exports the mode route", exported.MODE_PATH === "/browser-pane/mode");
check("exports the stream path", exported.STREAM_PATH === "/browser-pane/stream");
check("exports the attach mode", exported.CONNECT_MODE === "connect");

console.log("effect registration:");
const effects = [];
exported.apply({ effect: (fn, label) => effects.push({ fn, label }) });
check("registers both effects", effects.length === 2, String(effects.length));
check("labels every effect", effects.every((e) => typeof e.label === "string"));
check("publishes a build marker",
	globalThis.window.__dshBrowserTweaks?.version === 2 &&
		globalThis.window.__dshBrowserTweaks?.label === "My Chrome");

console.log("the toggle, as shipped:");
const disposers = effects.map((e) => e.fn());
const byLabel = (label, inPane = true) =>
	buttons.find((b) => b.textContent === label && (b.closest("[data-dsh-browser-pane]") !== null) === inPane);
const myChrome = byLabel("My Chrome");
const headless = byLabel("Headless");
const plugin = byLabel("Plugin");
const decoy = byLabel("My Chrome", false);
check("observes the document root",
	observers.length === 1 && observers[0].targets.length === 1 &&
		!!observers[0].targets[0].opts.subtree && !!observers[0].targets[0].opts.childList,
	`${observers.length} observer(s)`);
check("My Chrome is hidden", myChrome.style.display === "none", `display=${myChrome.style.display}`);
check("hiding is marked", myChrome.hasAttribute(exported.HIDE_ATTRIBUTE));
check("Headless stays visible", headless.style.display !== "none");
check("Plugin stays visible", plugin.style.display !== "none");
check("a same-named button outside the pane is untouched",
	decoy.style.display !== "none" && !decoy.hasAttribute(exported.HIDE_ATTRIBUTE));

console.log("the survivors still switch modes:");
headless.click();
plugin.click();
check("Headless posts mode own", posts.some((p) => p.mode === "own"), JSON.stringify(posts));
check("Plugin posts mode stealth", posts.some((p) => p.mode === "stealth"), JSON.stringify(posts));
check("the shipped buttons' clicks still post their own modes", posts.length === 2, `${posts.length} post(s)`);

console.log("collapse/expand survival (React re-renders the toggle):");
// A re-render replaces the buttons with fresh, visible ones — as the pane does
// on collapse/expand — and the observer fires for the DOM change. The old
// nodes are detached first, the way React removes them.
for (const b of buttons) b.isConnected = false;
buttons = [
	makeButton("Headless", "own"),
	makeButton("Plugin", "stealth"),
	makeButton("My Chrome", "connect"),
];
for (const o of observers) o.fire();
const myChrome2 = byLabel("My Chrome");
check("the re-rendered My Chrome is hidden again", myChrome2.style.display === "none");
check("the re-rendered survivors are visible",
	byLabel("Headless").style.display !== "none" && byLabel("Plugin").style.display !== "none");
check("marker counts the hidden button", globalThis.window.__dshBrowserTweaks?.hiddenCount === 1,
	String(globalThis.window.__dshBrowserTweaks?.hiddenCount));

console.log("the connect guard — only the shortcut Chrome owns the profile:");
const guardPosts = () => fetchPosts.filter((p) => p.url === "/browser-pane/mode");
check("posts connect on install, before the pane can launch",
	guardPosts().length === 1, `${guardPosts().length} post(s)`);
check("post is an exact mode switch",
	guardPosts()[0]?.method === "POST" && guardPosts()[0]?.body === '{"mode":"connect"}',
	JSON.stringify(guardPosts()[0]));
check("watches the pane stream", sseSources.length === 1 && sseSources[0].url === "/browser-pane/stream",
	`${sseSources.length} source(s)`);
check("state resolvers are pure (unit level)",
	exported.notePaneState({ mode: "own" }) === true &&
		exported.notePaneState({ mode: "stealth" }) === true &&
		exported.notePaneState({ mode: "connect" }) === false &&
		exported.notePaneState({}) === false &&
		exported.notePaneState(null) === false &&
		exported.notePaneState("own") === false);
const postsAfterUnits = guardPosts().length;
sseSources[0].fire("state", { mode: "own", active: false, url: "" });
check("a drifted state re-posts connect", guardPosts().length === postsAfterUnits + 1);
sseSources[0].fire("state", { mode: "connect", active: true, url: "https://example.com" });
check("an attached state stays quiet", guardPosts().length === postsAfterUnits + 1);
check("marker counts the posts", globalThis.window.__dshBrowserTweaks?.guard?.posts === guardPosts().length,
	String(globalThis.window.__dshBrowserTweaks?.guard?.posts));

console.log("unloading:");
for (const dispose of disposers) if (typeof dispose === "function") dispose();
check("observer disconnected", observers.every((o) => o.disconnected));
check("stream source closed", sseSources.every((s) => s.closed));
check("My Chrome restored", myChrome2.style.display === "" && !myChrome2.hasAttribute(exported.HIDE_ATTRIBUTE),
	`display=${myChrome2.style.display}`);
check("survivors untouched by restore",
	byLabel("Headless").style.display !== "none" && byLabel("Plugin").style.display !== "none");

console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
