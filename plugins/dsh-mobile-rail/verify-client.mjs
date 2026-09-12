/**
 * Structural and behavioural self-check for the mobile-rail client bundle.
 *
 * This plugin now drives TWO edges: the sidebar drawer on the left and the
 * browser-agent pane on the right. What follows proves, without a browser:
 *
 *  1. The injected CSS keys off hooks that actually exist (`data-sidebar-collapsed`
 *     and `data-dsh-browser-pane`), is gated to a narrow viewport, and contains none
 *     of the old CSS-reveal machinery.
 *  2. The CSS neutralises the pane's two phone-killers: the `body.margin-right` that
 *     left the GUI 0px wide, and a panel that could be wider than the screen.
 *  3. The toggle finders find real controls. The first attempt at the sidebar found
 *     nothing and left it unreachable; here the exported finder runs against a stub
 *     DOM carrying the measured labels of both edges.
 *  4. The gesture logic behaves, including the regression that `click()` dispatches
 *     at (0,0) and so can be swallowed by the guard meant for the compatibility click.
 *
 * Run: node .dsh/profiles/web/plugins/dsh-mobile-rail/verify-client.mjs
 */
import { readFileSync } from "node:fs";

let failures = 0;
const check = (label, condition, detail = "") => {
	if (!condition) failures += 1;
	console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Accessible names measured on the live phone inside `[data-slot="sidebar"]`. */
const OTHER_LABELS = ["New session", "Add workspace", "Search sessions", "Settings"];
/** Measured on the live phone: the pane's toggle names what it will do next. */
const SIDEBAR_TOGGLE = "Open sidebar";
const PANE_TOGGLE = "Expand browser pane";

// --- a DOM small enough to reason about, rich enough to run the gestures -------
const listeners = [];
let appClicks = 0;
let activations = 0;
let frameOpen = false;
let paneOpen = false;

const dispatch = (type, init = {}) => {
	const event = { clientX: 0, clientY: 0, pointerType: "touch", button: 0, pointerId: 1, ...init };
	event.defaultPrevented = false;
	event.propagationStopped = false;
	event.preventDefault = () => { event.defaultPrevented = true; };
	event.stopPropagation = () => { event.propagationStopped = true; };
	for (const l of listeners.filter((l) => l.type === type)) {
		l.fn(event);
		if (event.propagationStopped) break;
	}
	return event;
};

const makeElement = (tag) => ({
	tagName: String(tag).toUpperCase(),
	className: "",
	attrs: {},
	children: [],
	parentNode: null,
	setAttribute(n, v) { this.attrs[n] = v === undefined ? "" : String(v); },
	getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; },
	removeAttribute(n) { delete this.attrs[n]; },
	hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); },
	appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
});

const button = (label, onClick) => ({
	label,
	getAttribute: (n) => (n === "aria-label" ? label : null),
	click() {
		activations += 1;
		if (onClick) onClick();
		dispatch("click", { clientX: 0, clientY: 0, target: this });
	},
});

/** The sidebar toggle: it swaps its label with the state, and clicking toggles. */
const sidebarToggle = button(SIDEBAR_TOGGLE, () => { frameOpen = !frameOpen; });
/** The pane toggle, exactly as measured: the label names the next action. */
const paneToggle = {
	getAttribute: (n) => (n === "aria-label" ? (paneOpen ? "Collapse browser pane" : PANE_TOGGLE) : null),
	label: PANE_TOGGLE,
	click() {
		activations += 1;
		paneOpen = !paneOpen;
		dispatch("click", { clientX: 0, clientY: 0, target: this });
	},
};

const columnStub = (width) => ({ getBoundingClientRect: () => ({ width, right: width, left: 0 }), children: [] });
const frameStub = {
	className: "pI_x6G_frame dsh-mobile-rail-frame",
	classList: { contains: (c) => c === "dsh-mobile-rail-frame" },
	children: [],
	hasAttribute: (name) => name === "data-sidebar-collapsed" && !frameOpen,
	get firstElementChild() { return columnStub(frameOpen ? 280 : 0); },
	querySelectorAll: () => [],
};
/** The pane's panel, present only while the pane is expanded (as the product does). */
const panelStub = {
	className: "",
	getAttribute: (n) => (n === "data-dsh-browser-pane" ? "expanded" : null),
	getBoundingClientRect: () => ({ width: 394, left: 25, right: 419 }),
};

const sidebarSlot = {
	querySelectorAll: (selector) =>
		selector === "button[aria-label]" ? [sidebarToggle, ...OTHER_LABELS.map((l) => button(l))] : [],
};
const styleTags = [];
const body = [];
const documentStub = {
	activeElement: null,
	documentElement: {
		attrs: {},
		/** The custom properties the keyboard fix writes. */
		style: { props: {}, setProperty(n, v) { this.props[n] = v; }, removeProperty(n) { delete this.props[n]; } },
		setAttribute(n) { this.attrs[n] = ""; },
		removeAttribute(n) { delete this.attrs[n]; },
		hasAttribute(n) { return n in this.attrs; },
	},
	querySelector: (selector) => {
		if (selector === '[data-slot="sidebar"]') return sidebarSlot;
		if (selector === ".dsh-mobile-rail-frame") return frameStub;
		if (selector === '[data-dsh-browser-pane="expanded"]') return paneOpen ? panelStub : null;
		if (selector === ".dsh-mobile-glow") return body.find((el) => el.className === "dsh-mobile-glow") ?? null;
		return styleTags.find((t) => `style[data-plugin-css="${t.dataset.pluginCss}"]` === selector) ?? null;
	},
	querySelectorAll: (selector) => {
		if (selector === "button[aria-label]") return [sidebarToggle, paneToggle, ...OTHER_LABELS.map((l) => button(l))];
		if (selector === "[data-sidebar-collapsed], [data-rightbar-collapsed]") return [];
		return [];
	},
	createElement: (tag) => {
		const el = makeElement(tag);
		if (tag === "style") { el.dataset = {}; el.textContent = ""; }
		return el;
	},
	body: {
		appendChild: (el) => { el.parentNode = documentStub.body; body.push(el); return el; },
		removeChild: (el) => { const at = body.indexOf(el); if (at >= 0) body.splice(at, 1); el.parentNode = null; return el; },
	},
	head: { appendChild: (tag) => styleTags.push(tag) },
	addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture: capture === true }),
	removeEventListener: (type, fn, capture) =>
		listeners.splice(listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === (capture === true)), 1),
};
globalThis.document = documentStub;
/**
 * A `visualViewport` this test can drive.
 *
 * iPadOS shrinks this instead of the layout viewport when the keyboard appears, and
 * `window.innerHeight` stays put -- which is the entire bug the keyboard half fixes.
 * Modelling it here is what lets that half be checked without an iPad.
 */
const viewport = {
	height: 1024,
	offsetTop: 0,
	scale: 1,
	listeners: {},
	addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
	removeEventListener(type, fn) {
		const list = this.listeners[type] ?? [];
		const at = list.indexOf(fn);
		if (at >= 0) list.splice(at, 1);
	},
	/** Fire an event the way the platform would. */
	emit(type) { for (const fn of [...(this.listeners[type] ?? [])]) fn(); },
};
globalThis.window = {
	innerWidth: 419,
	innerHeight: 1024,
	visualViewport: viewport,
	__ModuleLoader__: { load: (value) => { globalThis.__registration = value; } },
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
	// The boot retry is a real interval in the browser. Here it is a stub on purpose:
	// letting it tick during these gesture assertions would let it collapse the pane
	// mid-test, and the behaviour it exists for (settling a pane that mounts late, in
	// a tab that does not render) is verified on the phone instead.
	setInterval: () => 0,
	clearInterval: () => {},
	addEventListener: (type, fn) => { (globalThis.window.listeners[type] ??= []).push(fn); },
	removeEventListener: (type, fn) => {
		const list = globalThis.window.listeners[type] ?? [];
		const at = list.indexOf(fn);
		if (at >= 0) list.splice(at, 1);
	},
	listeners: {},
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);

const source = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
new Function("window", "document", source)(globalThis.window, globalThis.document);

const registration = globalThis.__registration;
console.log("bundle envelope:");
check("registered with __ModuleLoader__", registration !== undefined);
check("declares its own id", registration?.id === "dsh-mobile-rail", String(registration?.id));

const exported = registration.factory(() => {
	throw new Error("this bundle must not require any module");
});
console.log("exports:");
check("exports apply", typeof exported.apply === "function");
check("exports inject", Array.isArray(exported.inject));

console.log("toggle finders (the part that broke the first attempt):");
const sidebarFound = exported.findToggle(exported.EDGES[0]);
check("finds the sidebar toggle", sidebarFound?.label === SIDEBAR_TOGGLE, String(sidebarFound?.label));
check("ignores non-toggle buttons", !OTHER_LABELS.includes(sidebarFound?.label), String(sidebarFound?.label));
const paneFound = exported.findToggle(exported.EDGES[1]);
check("finds the browser pane toggle", paneFound?.label === PANE_TOGGLE, String(paneFound?.label));

console.log("effect registration:");
const effects = [];
exported.apply({ effect: (fn, label) => effects.push({ fn, label }) });
check("registers all three effects", effects.length === 3, String(effects.length));
check("labels every effect", effects.every((e) => typeof e.label === "string"));
check("publishes a build marker with both edges",
	globalThis.window.__dshMobileRail?.version === 11 &&
		JSON.stringify(globalThis.window.__dshMobileRail?.edges) === '["left","right"]',
	JSON.stringify({ version: globalThis.window.__dshMobileRail?.version, edges: globalThis.window.__dshMobileRail?.edges }));

console.log("CSS injected:");
check("exactly one style tag", styleTags.length === 1, `${styleTags.length}`);
const css = String(styleTags[0]?.textContent ?? "");
check("tagged for hmr cleanup", styleTags[0]?.dataset?.plugin === "dsh-mobile-rail");
check("scoped to a narrow viewport", css.includes("@media (max-width: 768px)"));
check("keys off the real sidebar hook", css.includes("[data-sidebar-collapsed]"));
check("keys off the real pane hook", css.includes('[data-dsh-browser-pane="expanded"]'));
check("targets a stable frame class", css.includes(".dsh-mobile-rail-frame"));
check("does NOT depend on a hashed class", !css.includes("pI_x6G"));
check("collapses the sidebar column", css.includes("width:0!important"));
check("avoids display:none for the sidebar (it collapsed the centre)", !css.includes("display:none!important;border"));
check("blanks the squeezed centre column", css.includes(":not([data-sidebar-collapsed]) > :nth-child(2) > *"));
check("the blanking rule paints no colour of its own (the app's background shows)",
	css.includes("> :nth-child(2) > *{visibility:hidden!important}"), "rule text carries no background");

console.log("the browser pane's phone-killers, neutralised:");
check("body can no longer reserve the pane's width", css.includes("body{margin-right:0!important}"));
check("the pane can never be wider than the screen",
	css.includes('max-width:calc(100vw - 18px)!important'), "the packaged panel was 520px on a 419px viewport");
check("the packaged collapsed rail is hidden", css.includes('[data-dsh-browser-pane="collapsed"]{display:none!important}'));
check("the pane slides in from its own side", css.includes("@keyframes dsh-mobile-pane-slide-in"));
check("and the packaged default is hidden while it is settled",
	css.includes('html[data-dsh-pane-boot] [data-dsh-browser-pane="expanded"]{display:none!important}'));
check("the right band's glow clears the pane's z-index 400",
	css.includes('[data-edge="right"]{right:0;z-index:450}'), "otherwise the pane hides its own feedback");
check("both slides share one duration with the stylesheet",
	source.includes("const RAIL_MS = 240") &&
		source.includes("rail-slide-in ${RAIL_MS}ms") && source.includes("pane-slide-in ${RAIL_MS}ms") &&
		css.includes("rail-slide-in 240ms") && css.includes("pane-slide-in 240ms"),
	"the sheet is built from the constant the holds use");

console.log("the strip is a button (hold highlights, click flashes):");
check("has a separate hold layer and flash layer",
	css.includes(".dsh-mobile-glow-hold{") && css.includes(".dsh-mobile-glow-flash{"));
check("the highlight is driven by data-held", css.includes("[data-held]>.dsh-mobile-glow-hold{opacity:1}"));
check("the highlight comes up quickly, like a pressed button", css.includes("transition:opacity 70ms linear"));
check("the flash is instant and only its decay is animated", css.includes("transition-duration:0s"));
check("the flash is brighter than the highlight", css.includes("rgba(150,196,255,.85)"), "highlight peaks at .42");
check("both glows cannot swallow a tap",
	css.includes(".dsh-mobile-glow{") && css.includes("pointer-events:none}"));
check("each edge's gradient faces its own side",
	css.includes("linear-gradient(90deg") && css.includes("linear-gradient(270deg"));

console.log("animation:");
check("the sidebar slides the drawer, not the track", css.includes("animation:dsh-mobile-rail-slide-in"));
check("neither slide leaves a transform behind (no fill mode)",
	!/animation:dsh-mobile-(?:rail|pane)-slide-in[^}]*both/.test(css), "no `both`/`forwards`");
check("animates regardless of the OS motion setting",
	!css.includes("prefers-reduced-motion"), "no reduced-motion block, on purpose");
check("records why that override exists", source.includes("deliberately do NOT honour"));
check("and how to reverse it", source.includes("Restoring `@media (prefers-reduced-motion: reduce){...}`"));

console.log("nothing left over from the earlier attempts:");
check("no reveal attribute in CSS", !css.includes("data-rail-revealed"));
check("no 56px strip restored", !css.includes("56px"));
check("no edge overlay in CSS", !css.includes("::before"));
check("no reveal state in the bundle", !source.includes("data-rail-revealed"));
check("no hold timer left behind", !source.includes("HOLD_MS"));
// The bundle is a browser module: it may not touch the filesystem at all, which is
// what keeps every fix inside this plugin instead of in a patched node_modules.
check("touches no filesystem (so nothing outside this plugin can be patched)",
	!source.includes("writeFileSync") && !source.includes("readFileSync") && !source.includes('require("fs")'),
	"no fs API in the bundle");

console.log("gesture wiring:");
const disposers = effects.map((e) => e.fn());
const capture = (type) => listeners.some((l) => l.type === type && l.capture === true);
check("listens for pointerdown in capture", capture("pointerdown"));
check("listens for pointermove in capture", capture("pointermove"));
check("listens for pointerup in capture", capture("pointerup"));
check("listens for pointercancel in capture", capture("pointercancel"));
check("listens for click in capture", capture("click"));
check("does not listen for touchstart (would block scrolling)", !listeners.some((l) => l.type === "touchstart"));
check("reports a missing control instead of failing silently", source.includes("console.warn"));
check("owns the gesture", source.includes("event.stopPropagation()") && source.includes("event.preventDefault()"));
check("leaves the press cancellable, so a scroll still wins", source.includes("do NOT preventDefault"));
// Regression: an earlier revision coalesced its re-mark through requestAnimationFrame,
// and a background tab never runs rAF callbacks -- so in a freshly created tab the
// plugin marked nothing and left the pane at its packaged default, silently.
check("never defers work to requestAnimationFrame (background tabs skip it)",
	!/requestAnimationFrame\s*\(/.test(source), "only a comment mentions it");
check("settles on a timer instead", source.includes("window.setTimeout(() => {") && source.includes("const retry = window.setInterval"));
check("and clears that retry on unload", source.includes("window.clearInterval(retry)"));

// The app's own click handling, modelled as a listener that runs after ours
// (React's root listener is a descendant, so anything we stop never arrives).
documentStub.addEventListener("click", () => { appClicks += 1; }, false);

console.log("gesture behaviour -- a tap opens, on either edge:");
const EDGE = exported.EDGES[0];
const PANE = exported.EDGES[1];
const press = (x, y, id = 1) => dispatch("pointerdown", { clientX: x, clientY: y, pointerId: id });
const move = (x, y, id = 1) => dispatch("pointermove", { clientX: x, clientY: y, pointerId: id });
const release = (x, y, id = 1) => dispatch("pointerup", { clientX: x, clientY: y, pointerId: id });
const cancel = (id = 1) => dispatch("pointercancel", { pointerId: id });
const glowOf = (edge) => body.find((el) => el.className === "dsh-mobile-glow" && el.getAttribute("data-edge") === edge.side);
const heldOn = (edge) => glowOf(edge)?.hasAttribute("data-held") === true;
const litOn = (edge) => glowOf(edge)?.hasAttribute("data-lit") === true;
const RIGHT = 419 - 10;

frameOpen = false;
paneOpen = false;
activations = 0;
appClicks = 0;
press(10, 10);
check("a press on the left band highlights without opening", heldOn(EDGE) === true && frameOpen === false);
release(10, 10);
check("the release opens the sidebar (top-left corner regression)", frameOpen === true);
check("the sidebar toggle was activated once", activations === 1, `activations ${activations}`);
check("its click reached the app", appClicks === 1, `app clicks ${appClicks}`);
check("the flash fires on the click", litOn(EDGE) === true);
check("the highlight is released with the finger", heldOn(EDGE) === false);
dispatch("click", { clientX: 10, clientY: 10 });
check("the compatibility click at the same spot is swallowed", appClicks === 1, `app clicks ${appClicks}`);

// Close the sidebar, then do the same on the right edge, for the browser pane.
// The flashes of one tap outlive it (FLASH_MS), so they are cleared before asking
// whether the *next* tap flashed anything -- otherwise this measures the past.
frameOpen = true;
glowOf(EDGE)?.removeAttribute("data-lit");
press(300, 400);
check("a tap beside the open sidebar closes it at once", frameOpen === false);
check("and that tap does not flash the left band", litOn(EDGE) === false);

activations = 0;
glowOf(PANE)?.removeAttribute("data-lit");
press(RIGHT, 10);
check("a press on the right band highlights the right edge",
	heldOn(PANE) === true && heldOn(EDGE) === false);
check("and does not open the pane yet", paneOpen === false);
release(RIGHT, 10);
check("the release opens the browser pane", paneOpen === true);
check("and it flashes the right band, not the left", litOn(PANE) === true && litOn(EDGE) === false);
check("the pane toggle was activated once", activations === 1, `activations ${activations}`);

// With the pane open, a tap beside it closes it; the right band must stay dark
// because the pane covers it.
glowOf(PANE)?.removeAttribute("data-lit");
press(5, 400);
check("a tap beside the open pane closes it", paneOpen === false);
check("and does not arm the right band", heldOn(PANE) === false);
check("and does not flash it either", litOn(PANE) === false);

console.log("\n...and these do not open anything:");
paneOpen = false;
frameOpen = false;
press(RIGHT, 400);
move(RIGHT, 400 - 0);
release(419 - 10, 400 - 70);
check("a scroll starting on the right band does not open the pane", paneOpen === false,
	"travelled 70px, so it was not a tap");
press(RIGHT, 400);
cancel();
check("a cancelled press puts the highlight out", heldOn(PANE) === false && paneOpen === false);
press(200, 400);
move(RIGHT, 400);
check("wandering into the right band highlights it", heldOn(PANE) === true);
release(RIGHT, 400);
check("but a finger that merely passed through cannot open the pane", paneOpen === false);

console.log("desktop safety:");
globalThis.window.innerWidth = 1280;
frameOpen = false;
paneOpen = false;
activations = 0;
press(4, 400);
release(4, 400);
check("the left band is inert at 1280px", frameOpen === false && activations === 0);
press(1270, 400);
release(1270, 400);
check("the right band is inert at 1280px", paneOpen === false && activations === 0);
globalThis.window.innerWidth = 419;

console.log("standing down under the keyboard:");
/** A focused element that counts as typing, shaped the way the page sees one. */
const textField = (tag, extra = {}) => ({
	tagName: tag,
	isContentEditable: false,
	getAttribute: (n) => (n === "type" ? null : null),
	closest: () => null,
	...extra,
});
/** The keyboard is up: the visual viewport shrinks while the layout viewport does not. */
const keyboardUp = (up) => {
	viewport.height = up ? 1024 - 346 : 1024;
	viewport.offsetTop = 0;
	viewport.emit("resize");
};

// Focus alone must NOT stand the bands down: the app focuses the composer as soon as a
// session loads (measured on the phone: `activeIsComposer: true` with the visual
// viewport still at its full height), and standing down then would cost a tap.
frameOpen = false;
paneOpen = false;
activations = 0;
keyboardUp(false);
documentStub.activeElement = textField("DIV", { isContentEditable: true });
press(10, 400);
release(10, 400);
check("a focused composer with NO keyboard leaves the bands working",
	frameOpen === true && activations === 1);
press(300, 400);

// Now with the keyboard up, both bands must stand down.
keyboardUp(true);
documentStub.activeElement = textField("DIV", { isContentEditable: true });
frameOpen = false;
activations = 0;
const underKeyboard = press(10, 400);
check("the tap is NOT swallowed: the app must receive it to blur the field",
	underKeyboard.propagationStopped === false && underKeyboard.defaultPrevented === false);
check("the left band does not highlight under the keyboard", heldOn(EDGE) === false);
release(10, 400);
check("and tapping it does not open the sidebar", frameOpen === false && activations === 0);

activations = 0;
const rightUnderKeyboard = press(RIGHT, 400);
check("the right band is inert too",
	rightUnderKeyboard.propagationStopped === false && heldOn(PANE) === false);
release(RIGHT, 400);
check("and does not open the pane", paneOpen === false && activations === 0);

// The real composer is a Lexical contenteditable div:
//   <div contentEditable role="textbox" aria-multiline data-composer-input>
// (ComposerContentEditable in @deepseek-ai/dsh-client-ui-conversation.) These three
// cases mirror the predicate's inputs exactly.
documentStub.activeElement = textField("DIV", { isContentEditable: true });
activations = 0;
release(press(10, 400), 10, 400);
check("the composer's editable div counts as typing", frameOpen === false && activations === 0);

documentStub.activeElement = textField("DIV", {
	// A focused wrapper that sits inside the app's own composer host.
	closest: (sel) => (sel.includes("data-composer-input") ? {} : null),
});
activations = 0;
release(press(10, 400), 10, 400);
check("so does anything inside [data-composer-input]", frameOpen === false && activations === 0);

// A session-less composer renders the same role but is NOT editable, and an inert
// field holding focus must not disable the bands.
documentStub.activeElement = textField("DIV", {
	getAttribute: (n) => (n === "role" ? "textbox" : null),
	closest: (sel) => (sel.includes('contenteditable="true"') ? null : {}),
});
activations = 0;
press(10, 400);
release(10, 400);
check("an inert role=textbox is not typing, so the bands still work",
	frameOpen === true && activations === 1);

// A focused checkbox is not typing either.
documentStub.activeElement = textField("INPUT", { getAttribute: (n) => (n === "type" ? "checkbox" : null) });
frameOpen = true;
activations = 0;
press(300, 400);
check("a focused checkbox is not typing, so the bands still work", frameOpen === false);

// Once focus leaves, the bands come back.
documentStub.activeElement = null;
frameOpen = true;
activations = 0;
press(300, 400);
check("a tap beside the open drawer closes it again once typing has stopped", frameOpen === false);
activations = 0;
press(10, 400);
release(10, 400);
check("and the left band opens it again", frameOpen === true && activations === 1);
// Close it before testing the right band: with a panel already open, a tap anywhere
// beside it closes that panel first, which is a deliberate priority -- leaving the
// drawer open here would have measured that rule instead of the band.
press(300, 400);
check("closed again for the right-band test", frameOpen === false);
paneOpen = false;
const beforeRight = activations;
press(RIGHT, 400);
release(RIGHT, 400);
check("the right band opens the pane again", paneOpen === true && activations === beforeRight + 1);
press(5, 400);
check("and a tap beside the pane closes it again", paneOpen === false);

console.log("the keyboard, on a platform that does not resize the layout viewport:");
// iPadOS with the keyboard up: the layout viewport is untouched (innerHeight), the
// visual viewport is shorter by the keyboard, and a text field has focus.
documentStub.activeElement = textField("DIV", { isContentEditable: true });
viewport.height = 1024 - 346;
viewport.offsetTop = 0;
viewport.emit("resize");
const root = documentStub.documentElement;
check("a keyboard-sized shrink with a focused field pins the shell",
	root.hasAttribute("data-dsh-keyboard") === true);
check("the shell is told exactly how tall the visible area is",
	root.style.props["--dsh-keyboard-height"] === "678px", String(root.style.props["--dsh-keyboard-height"]));
check("and where it starts", root.style.props["--dsh-keyboard-top"] === "0px", String(root.style.props["--dsh-keyboard-top"]));

// Safari pans the visual viewport to reveal a field; the layout viewport does not move.
viewport.height = 678;
viewport.offsetTop = 40;
viewport.emit("scroll");
check("Safari's own panning is compensated for",
	root.style.props["--dsh-keyboard-top"] === "40px", String(root.style.props["--dsh-keyboard-top"]));

// The keyboard goes away.
viewport.height = 1024;
viewport.offsetTop = 0;
viewport.emit("resize");
check("and the shell is released when it does",
	root.hasAttribute("data-dsh-keyboard") === false &&
		root.style.props["--dsh-keyboard-height"] === undefined &&
		root.style.props["--dsh-keyboard-top"] === undefined);

// A pinch zoom shrinks the visual viewport exactly like a keyboard does.
viewport.height = 600;
viewport.scale = 2;
viewport.emit("resize");
check("a pinch zoom is not mistaken for a keyboard", root.hasAttribute("data-dsh-keyboard") === false);
viewport.scale = 1;

// Safari's own toolbars move the visual viewport by tens of pixels, not hundreds.
viewport.height = 1024 - 60;
viewport.emit("resize");
check("a toolbar-sized change is not mistaken for a keyboard",
	root.hasAttribute("data-dsh-keyboard") === false);

// No text field focused: whatever shrank the viewport, this is not our business.
viewport.height = 1024 - 346;
documentStub.activeElement = null;
viewport.emit("resize");
check("without a focused text field nothing is pinned", root.hasAttribute("data-dsh-keyboard") === false);

// Android and desktop resize the layout viewport, so there is nothing to compensate.
documentStub.activeElement = textField("TEXTAREA");
viewport.height = 1024 - 346;
globalThis.window.innerHeight = 1024 - 346;
viewport.emit("resize");
check("where the layout viewport does shrink, the plugin stays out of the way",
	root.hasAttribute("data-dsh-keyboard") === false, "covered is 0");
globalThis.window.innerHeight = 1024;

// A focused checkbox is still not typing.
documentStub.activeElement = textField("INPUT", { getAttribute: (n) => (n === "type" ? "checkbox" : null) });
viewport.height = 1024 - 346;
viewport.emit("resize");
check("and a focused checkbox does not pin it either", root.hasAttribute("data-dsh-keyboard") === false);
documentStub.activeElement = null;
viewport.height = 1024;

console.log("unloading:");
for (const dispose of disposers) if (typeof dispose === "function") dispose();
check("leaves no glow behind on unload", body.filter((el) => el.className === "dsh-mobile-glow").length === 0);
check("stops listening on unload",
	!capture("pointerdown") && !capture("pointermove") && !capture("pointerup") &&
		!capture("pointercancel") && !capture("click"));
await sleep(50);

console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;

