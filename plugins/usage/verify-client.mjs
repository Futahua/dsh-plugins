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

console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
