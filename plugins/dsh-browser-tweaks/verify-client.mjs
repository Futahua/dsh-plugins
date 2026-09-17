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
 *     of half (a); the bundle itself never touches launch behaviour
 *     (it posts no `/browser-pane/mode`).
 *  3. The bundle hides the "My Chrome" mode button while Headless + Plugin
 *     stay visible and clickable, ignores a same-named button outside the
 *     pane, re-hides a re-rendered toggle (collapse/expand survival), and
 *     restores everything on unload.
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
check("never posts a mode itself (launch/switch behaviour untouched)",
	!clientSource.includes("/browser-pane/mode"));
check("never defers work to requestAnimationFrame (background tabs skip it)",
	!/requestAnimationFrame\s*\(/.test(clientSource));
check("the only timer is the usage poll (observer-driven otherwise)",
	clientSource.includes("setInterval(refreshUsage, POLL_MS)") && clientSource.includes("clearInterval(pollTimer)") &&
		!clientSource.includes("setTimeout("));
check("usage comes only from the sibling plugin's status route",
	clientSource.includes('"/api/opencode-go-usage.status"') && !clientSource.includes("/browser-pane/mode"));
check("names the real pill seat", clientSource.includes('[data-slot="conversation.input.model"]'));
check("never rewrites pill text (badge is appended)", clientSource.includes("appendChild(badge)"));
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

// --- composer model pill (the shipped ModelSelect seat) ----------------------
// The trigger shows the model display name in `title` (plus " · effort"); the
// label span is React-owned and must never change. The menu is a portal: one
// section per provider, one checked menuitemradio for the current model.
const PILL_SEAT = '[data-slot="conversation.input.model"]';
let pillTitle = "Muse Spark 1.3 Contributor · xhigh"; // the live default
let pillControls = null; // trigger aria-controls while the menu is open
let menuOptions = [];
const fetchCalls = [];
let fetchWindows = [
	{ key: "rolling", label: "5h", percent: 32 },
	{ key: "monthly", label: "30d", percent: 10 },
];
let fetchMode = "ready";
globalThis.fetch = async (url) => {
	fetchCalls.push(url);
	if (fetchMode === "error") return { ok: false, status: 500, json: async () => ({}) };
	return { ok: true, json: async () => ({ windows: fetchWindows }) };
};
let intervalsCreated = 0;
let intervalsCleared = 0;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms) => { intervalsCreated += 1; return realSetInterval(fn, ms); };
globalThis.clearInterval = (id) => { intervalsCleared += 1; return realClearInterval(id); };
const clickListeners = [];

const makePillBadge = () => ({
	tagName: "SPAN",
	textContent: "",
	style: {},
	attrs: {},
	parentNode: null,
	setAttribute(n, v) { this.attrs[n] = String(v); },
	getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; },
	removeAttribute(n) { delete this.attrs[n]; },
	hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); },
	remove() { if (this.parentNode !== null) this.parentNode.removeChild(this); },
});
/** React-owned label span: the test keeps this reference to prove it is never rewritten. */
let pillLabelSpan = { tagName: "SPAN", textContent: "Muse Spark 1.3 Contributor" };
const makeTrigger = () => {
	const trigger = {
		tagName: "BUTTON",
		style: {},
		attrs: { title: pillTitle, ...(pillControls === null ? {} : { "aria-controls": pillControls }) },
		children: [{ tagName: "svg" }, pillLabelSpan, { tagName: "svg" }],
		parentNode: null,
		setAttribute(n, v) { this.attrs[n] = String(v); },
		getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; },
		removeAttribute(n) { delete this.attrs[n]; },
		hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); },
		get textContent() { return pillLabelSpan.textContent; },
		querySelector(sel) {
			if (sel === 'button[aria-haspopup="menu"]' || sel === "button") return null;
			const m = sel.match(/^\[(.+)\]$/);
			return m === null ? null : (this.children.find((c) => c.hasAttribute?.(m[1])) ?? null);
		},
		appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
		removeChild(child) {
			const at = this.children.indexOf(child);
			if (at >= 0) this.children.splice(at, 1);
			child.parentNode = null;
			return child;
		},
	};
	return trigger;
};
let pillTrigger = makeTrigger();
const pillSeat = {
	querySelector: (sel) =>
		(sel === 'button[aria-haspopup="menu"]' || sel === "button") && pillTrigger !== null ? pillTrigger : null,
};
const makeMenuSection = (selectId, providerId) => ({
	tagName: "SECTION",
	getAttribute: (n) => (n === "aria-labelledby" ? `${selectId}-${providerId}` : null),
});
const makeMenuOption = (title, checked, section) => {
	const option = {
		tagName: "BUTTON",
		textContent: title,
		getAttribute: (n) =>
			n === "role" ? "menuitemradio" : n === "aria-checked" ? (checked ? "true" : "false") :
				n === "title" ? title : null,
		closest: (sel) => {
			if (sel.includes("menuitemradio")) return option;
			if (sel.includes('section[role="group"]')) return section;
			return null;
		},
	};
	return option;
};
/** Re-render the pill the way React does: fresh trigger, fresh label span. */
const rerenderPill = (title) => {
	pillTitle = title;
	pillLabelSpan = { tagName: "SPAN", textContent: title.split(" · ")[0] };
	pillTrigger = makeTrigger();
};

globalThis.window = {
	__ModuleLoader__: { load: (value) => { globalThis.__registration = value; } },
};
globalThis.document = {
	documentElement: { kind: "root" },
	body: { kind: "body" },
	querySelector: (selector) => (selector === PILL_SEAT ? pillSeat : null),
	querySelectorAll: (selector) => {
		if (selector === "button") return buttons;
		if (selector === 'button[role="menuitemradio"]') return menuOptions;
		return [];
	},
	createElement: (tag) => (tag === "span" ? makePillBadge() : makeButton(tag, "x", false)),
	addEventListener: (type, fn) => { if (type === "click") clickListeners.push(fn); },
	removeEventListener: (type, fn) => {
		const at = clickListeners.indexOf(fn);
		if (at >= 0) clickListeners.splice(at, 1);
	},
};
const fireClick = (target) => { for (const fn of [...clickListeners]) fn({ target }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
check("exports the badge attribute", exported.BADGE_ATTRIBUTE === "data-dsh-browser-tweaks-provider");
check("exports the status path", exported.STATUS_PATH === "/api/opencode-go-usage.status");
check("exports the provider resolver", typeof exported.resolveProvider === "function");

console.log("provider resolution (read, never assumed):");
check("unique opencode-go name resolves", exported.resolveProvider("DeepSeek V4.1 Flash") === "opencode-go");
check("unique codex name resolves", exported.resolveProvider("GPT-5.4") === "openai-codex");
check("unique meta name resolves", exported.resolveProvider("Muse Spark 1.3") === "meta");
check("shared contributor name stays ambiguous", exported.resolveProvider("Muse Spark 1.3 Contributor") === null);
check("shared Luna name stays ambiguous", exported.resolveProvider("GPT-5.6 Luna") === null);
check("provider/model fallback resolves", exported.resolveProvider("meta/muse-spark-1.3") === "meta");
check("unknown text resolves to no badge", exported.resolveProvider("Loading model…") === undefined);

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
	observers.length === 2 && observers.every((o) => o.targets.length === 1 &&
		!!o.targets[0].opts.subtree && !!o.targets[0].opts.childList),
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
check("the bundle itself posted nothing new", posts.length === 2, `${posts.length} post(s)`);

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

const pillBadge = () => pillTrigger.querySelector(`[${exported.BADGE_ATTRIBUTE}]`);

console.log("the pill badge — ambiguous default falls back to free:");
await sleep(30);
check("badge appended inside the pill", pillBadge() !== null);
check("ambiguous contributor shows the safe fallback", pillBadge()?.textContent === "free",
	JSON.stringify(pillBadge()?.textContent));
check("pill's own label span untouched", pillLabelSpan.textContent === "Muse Spark 1.3 Contributor");
check("no usage fetch for an unmetered fallback", fetchCalls.length === 0, `${fetchCalls.length} call(s)`);
check("marker reports the fallback",
	globalThis.window.__dshBrowserTweaks?.badge?.text === "free");

console.log("a unique opencode-go model shows live usage:");
rerenderPill("DeepSeek V4.1 Flash");
for (const o of observers) o.fire();
await sleep(30);
check("badge names the provider with usage left", pillBadge()?.textContent === "opencode-go · 68% left",
	JSON.stringify(pillBadge()?.textContent));
check("usage read from the sibling status route", fetchCalls.every((u) => u === "/api/opencode-go-usage.status") &&
	fetchCalls.length > 0, JSON.stringify(fetchCalls));
check("polling started for the metered provider", intervalsCreated === 1, `${intervalsCreated}`);
check("marker reports the provider", globalThis.window.__dshBrowserTweaks?.badge?.provider === "opencode-go");

console.log("a unique codex model shows free (and stops the poll):");
const callsBeforeCodex = fetchCalls.length;
rerenderPill("GPT-5.4");
for (const o of observers) o.fire();
await sleep(30);
check("badge names codex as free", pillBadge()?.textContent === "openai-codex · free",
	JSON.stringify(pillBadge()?.textContent));
check("no usage fetch for an unmetered provider", fetchCalls.length === callsBeforeCodex);
check("poll timer cleared", intervalsCleared === 1, `${intervalsCleared}`);

console.log("the open menu teaches the true provider:");
rerenderPill("Muse Spark 1.3 Contributor · xhigh");
pillControls = ":r0-menu";
pillTrigger = makeTrigger();
menuOptions = [makeMenuOption("Muse Spark 1.3 Contributor", true, makeMenuSection(":r0", "opencode-go"))];
for (const o of observers) o.fire();
await sleep(30);
check("menu-checked provider wins over the fallback",
	pillBadge()?.textContent === "opencode-go · 68% left", JSON.stringify(pillBadge()?.textContent));
check("menu learning cached", globalThis.window.__dshBrowserTweaks?.badge?.cached === 1,
	String(globalThis.window.__dshBrowserTweaks?.badge?.cached));

console.log("a clicked option teaches immediately, and the cache survives the menu closing:");
menuOptions = [makeMenuOption("GPT-5.6 Luna", false, makeMenuSection(":r0", "openai-codex"))];
fireClick({ closest: (sel) => (sel.includes("menuitemradio") ? menuOptions[0] : null) });
rerenderPill("GPT-5.6 Luna");
pillControls = null;
menuOptions = [];
for (const o of observers) o.fire();
await sleep(10);
check("cached provider applies with no menu open", pillBadge()?.textContent === "openai-codex · free",
	JSON.stringify(pillBadge()?.textContent));

console.log("a re-rendered pill keeps its text and regains its badge:");
const survivingLabel = pillLabelSpan;
rerenderPill("Muse Spark 1.3");
for (const o of observers) o.fire();
await sleep(10);
check("fresh badge on the fresh trigger", pillBadge() !== null && pillBadge()?.textContent === "meta · free",
	JSON.stringify(pillBadge()?.textContent));
check("the old label span was replaced, not rewritten", pillLabelSpan !== survivingLabel);
check("the new label span is intact", pillLabelSpan.textContent === "Muse Spark 1.3");

console.log("unknown pill text means no badge:");
rerenderPill("Loading model…");
for (const o of observers) o.fire();
await sleep(10);
check("badge removed for unrecognized text", pillBadge() === null);

console.log("unloading:");
for (const dispose of disposers) if (typeof dispose === "function") dispose();
check("observers disconnected", observers.every((o) => o.disconnected));
check("My Chrome restored", myChrome2.style.display === "" && !myChrome2.hasAttribute(exported.HIDE_ATTRIBUTE),
	`display=${myChrome2.style.display}`);
check("survivors untouched by restore",
	byLabel("Headless").style.display !== "none" && byLabel("Plugin").style.display !== "none");
check("badge removed on unload", pillBadge() === null);
check("menu click listener removed", clickListeners.length === 0, `${clickListeners.length} left`);
check("poll timer cleared on unload", intervalsCleared === intervalsCreated,
	`created ${intervalsCreated}, cleared ${intervalsCleared}`);
check("marker reports no badge", globalThis.window.__dshBrowserTweaks?.badge?.text === null);

console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
