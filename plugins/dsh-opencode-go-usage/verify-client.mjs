/**
 * Structural self-check for the client bundle.
 *
 * The real rendering needs a browser, but this catches the failures that
 * actually bite: syntax errors, a wrong bundle envelope, a missing export, and
 * a mis-wired slot registration. It stubs `window.__ModuleLoader__`, `require`,
 * and a minimal DOM. Run:
 *   node .dsh/profiles/web/plugins/dsh-opencode-go-usage/verify-client.mjs
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
globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value; } } };

const source = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
const react = await import("react");
const requireStub = (specifier) => {
	if (specifier === "react") return react;
	throw new Error(`unexpected require(${JSON.stringify(specifier)}) — the bundle should only need React`);
};

// Evaluate the bundle exactly as the browser would.
new Function("window", "require", source)(globalThis.window, requireStub);

console.log("bundle envelope:");
check("registered with __ModuleLoader__", registration !== undefined);
check("declares its own id", registration?.id === "dsh-opencode-go-usage", String(registration?.id));

const exported = registration.factory(requireStub);
console.log("exports:");
check("exports apply", typeof exported.apply === "function");
check("exports inject", Array.isArray(exported.inject), JSON.stringify(exported.inject));
check("injects the slots service", exported.inject?.includes("slots"));
check("exports the component", typeof exported.GoUsagePill === "function");

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
check("uses its own cell id", registerCall?.spec?.id === "opencode-go-usage", String(registerCall?.spec?.id));
check("orders after shipped entries", typeof registerCall?.spec?.order === "number", String(registerCall?.spec?.order));
check("registers the pill component", registerCall?.component === exported.GoUsagePill);

console.log("style injection:");
check("added one plugin style tag", styleTags.length === 1, `${styleTags.length} tag(s)`);
check("tagged for hmr cleanup", styleTags[0]?.dataset?.plugin === "dsh-opencode-go-usage");
check("scopes its rules", String(styleTags[0]?.textContent).includes(".dsh-go-usage-button"));
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

console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
