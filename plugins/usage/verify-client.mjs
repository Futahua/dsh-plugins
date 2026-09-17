/**
 * Structural self-check for the client bundle.
 *
 * The real rendering needs a browser, but this catches the failures that
 * actually bite: syntax errors, a wrong bundle envelope, a missing export, and
 * a mis-wired slot registration. It stubs `window.__ModuleLoader__`, `require`,
 * a minimal DOM, and a minimal React, so it runs with no dependencies installed:
 *
 *   node plugins/usage/verify-client.mjs
 *
 * It also locks the `usage` rename (bundle/cell/style/package/patch identity,
 * with the host route deliberately unchanged) and the provider readout
 * (`resolveProvider` / `providerLine` / menu-cache learning, including the
 * guarantee that the shipped model pill seat is only ever read).
 *
 * The React stub is intentionally tiny: this never renders, it only evaluates
 * the bundle and inspects what it registered. `createElement` returns a plain
 * descriptor and the hooks are inert, which is enough for the module body to run
 * and for `apply` to be exercised.
 */
import { readFileSync } from "node:fs";

let failures = 0;
const check = (label, condition, detail = "") => {
	if (!condition) failures += 1;
	console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

// --- minimal DOM so the style injection path runs -----------------------------
const styleTags = [];
globalThis.document = {
	querySelector: (selector) => styleTags.find((t) => `style[data-plugin-css="${t.dataset.pluginCss}"]` === selector) ?? null,
	createElement: () => ({ dataset: {}, textContent: "" }),
	head: { appendChild: (tag) => styleTags.push(tag) },
	addEventListener: () => {},
	removeEventListener: () => {},
};

// --- capture the module registration ------------------------------------------
let registration;
globalThis.window = {
	innerWidth: 419,
	__ModuleLoader__: { load: (value) => { registration = value; } },
};

/** Minimal React surface: element descriptors plus inert hooks. */
const reactStub = {
	createElement: (type, props, ...children) => ({ type, props, children }),
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useEffect: () => {},
	useRef: (initial) => ({ current: initial ?? null }),
	Fragment: Symbol("Fragment"),
};
const requireStub = (specifier) => {
	if (specifier === "react") return reactStub;
	throw new Error(`unexpected require(${JSON.stringify(specifier)}) — the bundle should only need React`);
};

// Evaluate the bundle exactly as the browser would.
const source = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
new Function("window", "require", source)(globalThis.window, requireStub);

console.log("bundle envelope:");
check("registered with __ModuleLoader__", registration !== undefined);
check("declares its own id", registration?.id === "usage", String(registration?.id));

const exported = registration.factory(requireStub);
console.log("exports:");
check("exports apply", typeof exported.apply === "function");
check("exports inject", Array.isArray(exported.inject), JSON.stringify(exported.inject));
check("injects the slots service", exported.inject?.includes("slots"));
check("exports the component", typeof exported.UsagePill === "function");

console.log("slot registration:");
const registrations = [];
const ctx = {
	slots: {
		inject: (key, cb) => {
			registrations.push({ phase: "inject", key });
			cb();
		},
		register: (spec, component) => {
			registrations.push({ phase: "register", spec, component });
		},
	},
};
exported.apply(ctx);

const injectCall = registrations.find((r) => r.phase === "inject");
const registerCall = registrations.find((r) => r.phase === "register");
check("waits for the seat declaration", injectCall?.key === "conversation.input.right", String(injectCall?.key));
check("registers into that seat", registerCall?.spec?.name === "conversation.input.right");
check("uses its own cell id", registerCall?.spec?.id === "usage", String(registerCall?.spec?.id));
check("orders after shipped entries", typeof registerCall?.spec?.order === "number", String(registerCall?.spec?.order));
check("registers the pill component", registerCall?.component === exported.UsagePill);

console.log("style injection:");
check("added one plugin style tag", styleTags.length === 1, `${styleTags.length} tag(s)`);
check("tagged for hmr cleanup", styleTags[0]?.dataset?.plugin === "usage");
check("scopes its rules", String(styleTags[0]?.textContent).includes(".dsh-usage-button"));
check("no floating caption (removed by request)", !String(styleTags[0]?.textContent).includes("roll independently"));

console.log("panel placement (pure helper):");
// `panelLeft` returns a WRAPPER-relative offset, so the viewport check has to add
// the wrapper's own left edge back. These are the numbers measured on the
// device: pill at x=105 in a 419px viewport with a 320px panel.
const V = 419, W = 320, M = 12;
const placementCases = [
  ["measured phone: pill at x=105", { left: 105, width: 20 }, V],
  ["pill hard against the left edge", { left: 0, width: 20 }, V],
  ["pill hard against the right edge", { left: 399, width: 20 }, V],
  ["wider phone (480px)", { left: 220, width: 20 }, 480],
  ["narrow phone (360px)", { left: 100, width: 20 }, 360],
];
for (const [label, wrapRect, viewport] of placementCases) {
  const rel = exported.panelLeft(wrapRect, W, viewport);
  const viewportLeft = rel + wrapRect.left;
  const fits = viewportLeft >= M - 0.5 && viewportLeft + W <= viewport - M + 0.5;
  check(label, fits, `viewport x=${viewportLeft}..${viewportLeft + W} of ${viewport}`);
}

console.log("quota-scale layout:");
// Widths are allowances ($30 / $60, $12 / $60); positions come from usage.
const byKeyFrom = (m, w, r) => ({
	monthly: { key: "monthly", label: "Monthly", percent: m },
	weekly: { key: "weekly", label: "Weekly", percent: w },
	rolling: { key: "rolling", label: "5-hour", percent: r },
});
const geo = (m, w, r) => Object.fromEntries(exported.layout(byKeyFrom(m, w, r)).map((g) => [g.key, g]));

check("monthly spans the whole track", (() => {
	const g = geo(24, 48, 7).monthly;
	return Math.abs(g.left) < 0.01 && Math.abs(g.width - 100) < 0.01;
})(), "left 0, width 100");

// The shared boundary is the whole point: every used portion must END at the
// same anchor, which is what lines the three rows up vertically.
check("all used portions end at the shared anchor", (() => {
	const g = geo(24, 48, 7);
	const anchor = exported.anchorPosition(byKeyFrom(24, 48, 7));
	return Object.values(g).every((e) => Math.abs(e.left + (e.fillPct / 100) * e.width - anchor) < 0.01);
})(), "monthly 24, weekly 48, 5-hour 7");

// Position must respond to USAGE, not allowance alone. This is the difference
// between this design and the symmetric nesting it replaced.
check("bars slide as usage changes", (() => {
	const low = geo(24, 10, 7).weekly;
	const high = geo(24, 80, 7).weekly;
	return Math.abs(low.left - high.left) > 5;
})(), "weekly moves with its own usage");
check("heavier usage sits further left", (() => {
	return geo(24, 80, 7).weekly.left < geo(24, 10, 7).weekly.left;
})(), "left = anchor − usedWidth");

console.log("truncation (clipped, never rescaled):");
// Which edge can overflow is not obvious, so both cases are spelled out:
//   left  overflow when used > anchor            (a heavy child, light month)
//   right overflow when remaining > 100 − anchor (a light child, heavy month)
const overLeft = geo(5, 100, 0).weekly;
check("a bar past the LEFT edge is clipped", overLeft.clippedLeft === true, `monthly 5, weekly 100 → left ${overLeft.left.toFixed(1)}`);
const overRight = geo(90, 5, 0).weekly;
check("a bar past the RIGHT edge is clipped", overRight.clippedRight === true, `monthly 90, weekly 5 → right ${(overRight.left + overRight.width).toFixed(1)}`);
check(
	"a clipped bar stays inside the track",
	overLeft.left >= 0 && overLeft.left + overLeft.width <= 100.01 && overRight.left + overRight.width <= 100.01,
);
// The scale must NOT re-base: monthly keeps its width even when a child clips.
check("the monthly scale does not re-base", (() => {
	return Math.abs(geo(90, 5, 0).monthly.width - 100) < 0.01;
})(), "monthly stays 100% wide while weekly is clipped");
check("an unclipped reading reports no clipping", (() => {
	const g = geo(24, 48, 7);
	return Object.values(g).every((e) => e.clippedLeft === false && e.clippedRight === false);
})());
check("monthly is never clipped", (() => {
	const g = geo(100, 100, 100).monthly;
	return g.clippedLeft === false && g.clippedRight === false;
})());
check("no window ever escapes the track", (() => {
	for (const [m, w, r] of [[0, 0, 0], [100, 100, 100], [5, 100, 0], [90, 5, 0], [50, 50, 50]]) {
		for (const g of Object.values(geo(m, w, r))) {
			if (g.left < -0.01 || g.left + g.width > 100.01) return false;
		}
	}
	return true;
})(), "across five extreme readings");

console.log("usage identity (rename dsh-opencode-go-usage -> usage):");
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
check("package renamed to usage", pkg?.name === "usage", String(pkg?.name));
const patch = readFileSync(new URL("./cordis.patch.yml", import.meta.url), "utf8");
check("patch row id is usage", /id:\s*usage\s*\n/u.test(patch));
check("patch row name is usage", /name:\s*usage\s*\n/u.test(patch));
check("no old bundle name left in the patch", !patch.includes("dsh-opencode-go-usage"));
check("no old bundle id left in the bundle", !source.includes("dsh-opencode-go-usage"));
check("style tag uses the usage tag id", styleTags[0]?.dataset?.pluginCss === "usage/usage.css", String(styleTags[0]?.dataset?.pluginCss));
const host = readFileSync(new URL("./index.js", import.meta.url), "utf8");
check("host module tag renamed", host.includes("@module usage") && !host.includes("dsh-opencode-go-usage"));
const routeOf = (text) => /\/api\/[a-z-]+\.status/u.exec(text)?.[0];
check("host route kept working (not renamed)", routeOf(host) === "/api/opencode-go-usage.status", String(routeOf(host)));
check("client polls the same route the host serves", routeOf(source) === routeOf(host), `${routeOf(source)} vs ${routeOf(host)}`);
check("registers nothing into the model seat", !registrations.some((r) => r.phase === "register" && /model/u.test(r.spec?.name ?? "")), "conversation.input.model is read-only");
check("single slot registration, into the usage seat only", source.split("slots.register").length - 1 === 1);

console.log("provider readout:");
check(
	"exports the provider resolvers",
	["resolveProvider", "clearProviderCache", "learnFromMenu", "learnFromOptionClick", "providerLine", "PILL_SEAT"].every(
		(key) => exported[key] !== undefined,
	),
);
check(
	"reads (never owns) the model pill seat",
	typeof exported.PILL_SEAT === "string" && exported.PILL_SEAT.includes("conversation.input.model"),
	String(exported.PILL_SEAT),
);
const rp = exported.resolveProvider;
check("provider/model label names the provider", rp("opencode-go/grok-4.6") === "opencode-go");
check("unique opencode-go model resolves menu-free", rp("grok-4.6") === "opencode-go");
check("unique display name resolves (case-insensitive)", rp("Grok 4.6") === "opencode-go");
check("openai-codex model resolves", rp("gpt-5.4") === "openai-codex");
check("meta model resolves", rp("muse-spark-1.3") === "meta");
check("ambiguous id falls back to menu (null)", rp("muse-spark-1.3-contributor") === null);
check("ambiguous display name falls back too", rp("Muse Spark 1.3 Contributor") === null);
check("unknown model stays unknown", rp("some-future-model-xyz") === undefined);

const pl = exported.providerLine;
const byKey = (rollingPct) => ({ rolling: { key: "rolling", label: "5-hour", percent: rollingPct } });
check("metered provider shows live remaining", pl("opencode-go", byKey(32)) === "opencode-go · 68% left", pl("opencode-go", byKey(32)));
check("metered provider with no reading yet", pl("opencode-go", {}) === "opencode-go");
check("meta reads free", pl("meta", byKey(32)) === "meta · free");
check("openai-codex reads free", pl("openai-codex", byKey(32)) === "openai-codex · free");
check("unknown provider reads free", pl("some-future-provider", byKey(32)) === "some-future-provider · free");
check("ambiguous fallback reads bare free", pl(null, byKey(32)) === "free");
check("missing pill reads bare free", pl(undefined, byKey(32)) === "free");

// Menu-cache learning: an ambiguous name resolves only once the open model
// menu names its provider section — the same pattern the pill uses at runtime
// (checked menuitemradio's group, minus the trigger's own select id).
const realDocument = globalThis.document;
const fakeTrigger = {
	getAttribute: (name) => (name === "aria-controls" ? "testselect-menu" : name === "title" ? "Muse Spark 1.3 Contributor" : null),
	textContent: "Muse Spark 1.3 Contributor",
};
const fakeSection = (provider) => ({
	getAttribute: (name) => (name === "aria-labelledby" ? `testselect-${provider}` : null),
});
const fakeOption = (provider) => ({
	getAttribute: (name) => (name === "aria-checked" ? "true" : name === "title" ? "Muse Spark 1.3 Contributor" : null),
	textContent: "Muse Spark 1.3 Contributor",
	closest: () => fakeSection(provider),
});
globalThis.document = {
	...realDocument,
	querySelector: (selector) =>
		selector === exported.PILL_SEAT ? { querySelector: () => fakeTrigger } : realDocument.querySelector(selector),
	querySelectorAll: () => [fakeOption("meta")],
};
check("open menu teaches the ambiguous provider", exported.learnFromMenu(fakeTrigger) === true);
check("taught name now resolves to the menu provider", exported.resolveProvider("Muse Spark 1.3 Contributor") === "meta");
exported.clearProviderCache();
check("clearing forgets the taught provider", exported.resolveProvider("Muse Spark 1.3 Contributor") === null);

const clickSection = fakeSection("openai-codex");
const clickOption = {
	getAttribute: (name) => (name === "title" ? "GPT-5.6 Luna" : null),
	textContent: "GPT-5.6 Luna",
	closest: (selector) => (String(selector).includes("menuitemradio") ? clickOption : clickSection),
};
globalThis.document = {
	...realDocument,
	querySelector: (selector) =>
		selector === exported.PILL_SEAT ? { querySelector: () => fakeTrigger } : realDocument.querySelector(selector),
	querySelectorAll: () => [],
};
check(
	"clicking a menu option teaches immediately",
	exported.learnFromOptionClick({ target: { closest: (selector) => (String(selector).includes("menuitemradio") ? clickOption : null) } }) === true,
);
check("clicked name resolves to its section provider", exported.resolveProvider("GPT-5.6 Luna") === "openai-codex");
exported.clearProviderCache();
globalThis.document = realDocument;

console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
