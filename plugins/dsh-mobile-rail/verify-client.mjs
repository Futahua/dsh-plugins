/**
 * Structural and behavioural self-check for the mobile-rail client bundle.
 *
 * Three things this must prove, because each was wrong at some point:
 *
 *  1. The injected CSS keys off the real hook the layout publishes
 *     (`data-sidebar-collapsed`), is gated to a narrow viewport, and contains
 *     none of the old CSS-reveal machinery.
 *  2. The toggle finder actually finds the product's toggle. The first attempt
 *     guessed at the finder, missed, and left the sidebar unreachable; here the
 *     exported finder runs against a stub DOM carrying the measured labels.
 *  3. The gesture logic behaves. The swallow guard added to stop a synthesised
 *     click from hitting the drawer also swallowed the toggle's OWN activation
 *     for a tap in the top-left corner, because `click()` dispatches at (0,0) —
 *     within SAME_TAP_PX of such a tap. That case is exercised here, so it
 *     cannot come back unnoticed.
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

// --- a DOM small enough to reason about, rich enough to run the gesture ------
const listeners = [];
let appClicks = 0;
let activations = 0;
let frameOpen = false;

const dispatch = (type, init = {}) => {
	const event = { clientX: 0, clientY: 0, pointerType: "touch", button: 0, ...init };
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

const button = (label) => ({ getAttribute: (n) => (n === "aria-label" ? label : null), label });

/** The product's toggle: it swaps its label with the state, and clicking it toggles. */
const toggleButton = {
	getAttribute(n) {
		if (n !== "aria-label") return null;
		return frameOpen ? "Collapse sidebar" : "Open sidebar";
	},
	label: "Open sidebar",
	click() {
		activations += 1;
		frameOpen = !frameOpen;
		dispatch("click", { clientX: 0, clientY: 0, target: this });
	},
};

/** One column stub; `collapsed` decides the geometry the plugin reads. */
const columnStub = (width) => ({ getBoundingClientRect: () => ({ width, right: width }), children: [] });
const frameStub = {
	className: "pI_x6G_frame dsh-mobile-rail-frame",
	classList: { contains: (c) => c === "dsh-mobile-rail-frame" },
	children: [],
	hasAttribute: (name) => name === "data-sidebar-collapsed" && !frameOpen,
	get firstElementChild() {
		return columnStub(frameOpen ? 280 : 0);
	},
	querySelectorAll: () => [],
};

const sidebarSlot = {
	querySelectorAll: (selector) =>
		selector === "button[aria-label]" ? [toggleButton, ...OTHER_LABELS.map(button)] : [],
};
const styleTags = [];

/** Elements injected into `body`, which is where the glow is mounted. */
const body = [];
const makeElement = (tag) => {
	const el = {
		tagName: String(tag).toUpperCase(),
		className: "",
		attrs: {},
		parentNode: null,
		setAttribute(n, v) { this.attrs[n] = v === undefined ? "" : String(v); },
		getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; },
		removeAttribute(n) { delete this.attrs[n]; },
		hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); },
	};
	return el;
};
const documentStub = {
	querySelector: (selector) => {
		if (selector === '[data-slot="sidebar"]') return sidebarSlot;
		if (selector === ".dsh-mobile-rail-frame") return frameStub;
		if (selector === ".dsh-mobile-rail-glow") return body.find((el) => el.className === "dsh-mobile-rail-glow") ?? null;
		return styleTags.find((t) => `style[data-plugin-css="${t.dataset.pluginCss}"]` === selector) ?? null;
	},
	querySelectorAll: (selector) =>
		selector === "button[aria-label]" ? [toggleButton, ...OTHER_LABELS.map(button)] : [],
	createElement: (tag) => {
		const el = makeElement(tag);
		// Style tags carry dataset + textContent; the glow carries neither.
		if (tag === "style") {
			el.dataset = {};
			el.textContent = "";
		}
		return el;
	},
	body: {
		appendChild: (el) => {
			el.parentNode = documentStub.body;
			body.push(el);
			return el;
		},
		removeChild: (el) => {
			const at = body.indexOf(el);
			if (at >= 0) body.splice(at, 1);
			el.parentNode = null;
			return el;
		},
	},
	head: { appendChild: (tag) => styleTags.push(tag) },
	addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture: capture === true }),
	removeEventListener: (type, fn, capture) =>
		listeners.splice(listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === (capture === true)), 1),
	documentElement: {},
};
globalThis.document = documentStub;
globalThis.window = {
	innerWidth: 419,
	__ModuleLoader__: { load: (value) => { globalThis.__registration = value; } },
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
	addEventListener: () => {},
	removeEventListener: () => {},
};
globalThis.MutationObserver = class {
	observe() {}
	disconnect() {}
};
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

// The finder runs against the measured labels BEFORE apply(), so a finder that
// only works once some other state exists cannot pass.
console.log("toggle finder (the part that broke the first attempt):");
const found = exported.findToggle();
check("finds a sidebar toggle", found !== null && found !== undefined);
check("found the real toggle, not another control", found?.label === "Open sidebar", String(found?.label));
check("ignores non-toggle buttons", !OTHER_LABELS.includes(found?.label), String(found?.label));

console.log("effect registration:");
const effects = [];
exported.apply({ effect: (fn, label) => effects.push({ fn, label }) });
check("registers both effects", effects.length === 2, String(effects.length));
check("labels every effect", effects.every((e) => typeof e.label === "string"));
check("publishes a build marker", globalThis.window.__dshMobileRail?.version === 6,
	JSON.stringify(globalThis.window.__dshMobileRail));

// apply() injects the stylesheet, so inspect it only after apply has run.
console.log("CSS injected:");
check("exactly one style tag", styleTags.length === 1, `${styleTags.length}`);
const css = String(styleTags[0]?.textContent ?? "");
check("tagged for hmr cleanup", styleTags[0]?.dataset?.plugin === "dsh-mobile-rail");
check("scoped to a narrow viewport", css.includes("@media (max-width: 768px)"));
check("keys off the real layout hook", css.includes("[data-sidebar-collapsed]"));
check("targets a stable frame class", css.includes(".dsh-mobile-rail-frame"));
check("does NOT depend on a hashed class", !css.includes("pI_x6G"));
check("collapses the sidebar column", css.includes("width:0!important"));
check("avoids display:none (it collapsed the centre)", !css.includes("display:none"));
check("blanks the squeezed centre column", css.includes(":not([data-sidebar-collapsed]) > :nth-child(2) > *"));
// The blanking rule must not invent a colour; the glow below legitimately has one,
// so this is checked against that exact rule rather than the whole sheet.
check("the blanking rule paints no colour of its own (the app's background shows)",
	css.includes("opacity:0!important;pointer-events:none!important}"), "rule text carries no background");
check("the blanked content cannot be clicked through", css.includes("pointer-events:none!important"));

console.log("animation:");
check("defines both slide keyframes",
	css.includes("@keyframes dsh-mobile-rail-slide-in") && css.includes("@keyframes dsh-mobile-rail-slide-out"));
check("slides the drawer rather than the track",
	css.includes("animation:dsh-mobile-rail-slide-in") && css.includes("animation:dsh-mobile-rail-slide-out"));
check("neither slide leaves a transform behind (no fill mode)",
	!/animation:dsh-mobile-rail-slide-(?:in|out)[^}]*both/.test(css), "no `both`/`forwards`");
check("shares one duration between the CSS and the hold-open timer",
	source.includes("const RAIL_MS = 240") && source.includes("slide-out ${RAIL_MS}ms") &&
		css.includes("slide-out 240ms"),
	"the sheet is built from the constant the timer uses");
check("the glow is blue", css.includes("rgba(88,150,255"));
check("the glow fades rather than snapping", css.includes("transition:opacity 200ms ease-out"));
check("the glow cannot swallow a tap", css.includes("pointer-events:none"));
check("the glow sits above the drawer but below dialogs",
	css.includes("z-index:15"), "overlay layer is 20");

console.log("the cover fades, both ways:");
check("fades instead of hiding", /:nth-child\(2\) > \*\{opacity:0!important/.test(css));
check("the transition lives on a rule that always matches",
	css.includes(":nth-child(2) > *{transition:opacity"),
	"a transition declared only on the leaving state disappears with it and snaps");
check("the fading rule is not the one gated on the drawer being open",
	!css.includes("not([data-sidebar-collapsed]) > :nth-child(2) > *{transition"));

console.log("closing holds the drawer open for one animation:");
check("the closing rule needs both attributes (so it outranks the collapse)",
	css.includes("[data-sidebar-collapsed][data-rail-closing] > :first-of-type"));
check("it restores the measured width", css.includes("width:var(--dsh-rail-w,280px)!important"));
check("it restores visibility", css.includes("visibility:visible!important"));
check("it keeps the drawer over the already-expanded centre", css.includes("position:relative;z-index:16"));
check("the width is remembered while open, not measured while closing",
	source.includes("function rememberWidth") && source.includes("rememberWidth(el)"));
check("the hold is released on a timer", source.includes("closingTimer = window.setTimeout"));
check("the hold is cleaned up on unload", source.includes("closingOn?.removeAttribute"));
check("watches the frame's collapsed attribute",
	source.includes('attributeFilter: ["data-sidebar-collapsed"]'));
// Deliberate, and measured: this phone reports prefers-reduced-motion because
// Android's animation scales are 0.0, which would have hidden the effect entirely.
check("animates regardless of the OS motion setting",
	!css.includes("prefers-reduced-motion"), "no reduced-motion block, on purpose");
check("records why that override exists", source.includes("deliberately do NOT honour"));
check("and how to reverse it", source.includes("Restoring `@media (prefers-reduced-motion: reduce){...}`"));

console.log("the old CSS reveal is gone:");
check("no reveal attribute in CSS", !css.includes("data-rail-revealed"));
check("no 56px strip restored", !css.includes("56px"));
check("no edge overlay in CSS", !css.includes("::before"));
check("no reveal state in the bundle", !source.includes("data-rail-revealed"));
check("no hold timer left behind", !source.includes("HOLD_MS"));

console.log("gesture wiring:");
// Keep the disposers: the loader calls them on unload and on hot reload, so what
// they clean up is worth checking rather than calling the effects a second time.
const disposers = effects.map((e) => e.fn());
const capture = (type) => listeners.some((l) => l.type === type && l.capture === true);
check("listens for pointerdown in capture", capture("pointerdown"));
check("listens for click in capture", capture("click"));
check("does not listen for touchstart (would block scrolling)", !listeners.some((l) => l.type === "touchstart"));
check("reports a missing toggle instead of failing silently", source.includes("console.warn"));
check("owns the gesture", source.includes("event.stopPropagation()") && source.includes("event.preventDefault()"));

// The app's own click handling, modelled as a listener that runs after ours
// (React's root listener is a descendant, so anything we stop never arrives).
documentStub.addEventListener("click", () => { appClicks += 1; }, false);

console.log("gesture behaviour (top-left corner is the regression):");
frameOpen = false;
activations = 0;
appClicks = 0;
dispatch("pointerdown", { clientX: 10, clientY: 10 });
check("edge tap in the top-left corner opens it", frameOpen === true);
check("the toggle's own activation was NOT swallowed", activations === 1, `activations ${activations}`);
check("the toggle's click reached the app", appClicks === 1, `app clicks ${appClicks}`);
dispatch("click", { clientX: 10, clientY: 10 });
check("the compatibility click at the same spot is swallowed", appClicks === 1, `app clicks ${appClicks}`);

frameOpen = false;
activations = 0;
appClicks = 0;
dispatch("pointerdown", { clientX: 10, clientY: 400 });
check("edge tap mid-screen opens it", frameOpen === true);
dispatch("click", { clientX: 10, clientY: 400 });
check("its compatibility click is swallowed", appClicks === 1, `app clicks ${appClicks}`);

frameOpen = false;
activations = 0;
dispatch("pointerdown", { clientX: 300, clientY: 400 });
check("a tap away from the edge does nothing", frameOpen === false && activations === 0);

frameOpen = true;
activations = 0;
dispatch("pointerdown", { clientX: 100, clientY: 400 });
check("a tap inside the open drawer does nothing", frameOpen === true && activations === 0);

activations = 0;
dispatch("pointerdown", { clientX: 350, clientY: 400 });
check("a tap beside the open drawer closes it", frameOpen === false && activations === 1);

console.log("the tap band's glow:");
const glows = () => body.filter((el) => el.className === "dsh-mobile-rail-glow");
check("is reused rather than re-added on every tap", glows().length === 1, `${body.length} element(s) in body`);
const glow = glows()[0];
check("is not mounted into the frame", glow?.parentNode === documentStub.body);

// Let the taps above finish glowing before testing what does and does not light it.
await sleep(500);
check("goes out on its own", glow?.hasAttribute("data-lit") === false);

frameOpen = false;
dispatch("pointerdown", { clientX: 10, clientY: 400 });
check("lights on the band tap", glow?.hasAttribute("data-lit") === true);

await sleep(500);
check("goes out again, and did not accumulate a second element",
	glow?.hasAttribute("data-lit") === false && glows().length === 1);

frameOpen = true;
dispatch("pointerdown", { clientX: 350, clientY: 400 });
check("a tap beside the open drawer leaves it dark", glow?.hasAttribute("data-lit") === false);

frameOpen = false;
dispatch("pointerdown", { clientX: 300, clientY: 400 });
check("a tap away from the edge leaves it dark", glow?.hasAttribute("data-lit") === false);

console.log("desktop safety:");
globalThis.window.innerWidth = 1280;
frameOpen = false;
activations = 0;
dispatch("pointerdown", { clientX: 4, clientY: 400 });
check("edge band inert at 1280px", frameOpen === false && activations === 0);

console.log("unloading:");
for (const dispose of disposers) if (typeof dispose === "function") dispose();
check("leaves no glow behind on unload", glows().length === 0);
check("stops listening on unload", !capture("pointerdown") && !capture("click"));

console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
