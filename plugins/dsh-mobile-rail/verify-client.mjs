/**
 * Structural self-check for the mobile-rail client bundle.
 *
 * Verifies the bundle envelope, the exports, the effect registration, and — the
 * part that matters most — that the injected CSS keys off the real hook the
 * layout publishes (`data-sidebar-collapsed`, `ui-layout/lib/client.js:281`)
 * and is gated to a narrow viewport. Run:
 *   node .dsh/profiles/web/plugins/dsh-mobile-rail/verify-client.mjs
 */
import { readFileSync } from "node:fs";

let failures = 0;
const check = (label, condition, detail = "") => {
	if (!condition) failures += 1;
	console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

const styleTags = [];
const listeners = new Map();
globalThis.document = {
	querySelector: (selector) => styleTags.find((t) => `style[data-plugin-css="${t.dataset.pluginCss}"]` === selector) ?? null,
	createElement: () => ({ dataset: {}, textContent: "" }),
	head: { appendChild: (tag) => styleTags.push(tag) },
	addEventListener: (type, fn) => listeners.set(type, fn),
	removeEventListener: (type) => listeners.delete(type),
	querySelectorAll: () => [],
};
globalThis.window = {
	innerWidth: 390,
	__ModuleLoader__: { load: (value) => { globalThis.__registration = value; } },
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
	addEventListener: (type, fn) => listeners.set(type, fn),
	removeEventListener: (type) => listeners.delete(type),
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

console.log("effect registration:");
const effects = [];
exported.apply({ effect: (fn, label) => effects.push({ fn, label }) });
check("registers both effects", effects.length === 2, String(effects.length));
check("labels every effect", effects.every((e) => typeof e.label === "string"));

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
check("provides a touch reveal", css.includes("[data-rail-revealed]"));
check("restores width on reveal", css.includes("width:56px!important"));
check("installs a touchstart listener on run", (() => {
	for (const e of effects) e.fn();
	return listeners.has("touchstart");
})(), "touchstart");

console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
