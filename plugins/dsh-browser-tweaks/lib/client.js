/**
 * Hide the browser pane's "My Chrome" mode button, leaving Headless + Plugin.
 *
 * The shipped pane (`@try-works/dsh-browser-agent` lib/client.js) renders its
 * mode toggle as three unconditional ModeButtons — Headless (`mode: "own"`),
 * Plugin (`mode: "stealth"`), "My Chrome" (`mode: "connect"`). No config key governs that toggle's
 * visibility, so removing one button is DOM work by necessity; the stealth
 * profile directory, by contrast, is a config override in cordis.patch.yml.
 *
 * Identification is deliberately narrow: a `<button>` whose whole text is
 * exactly "My Chrome" *and* which sits inside `[data-dsh-browser-pane]`. The
 * other two buttons never match, and a same-named button anywhere else in the
 * app is left alone. Hiding is `display:none` on the button itself, so the
 * flex row simply closes the gap — no layout rules, no restyling of the
 * survivors, nothing to break when the pane re-renders.
 *
 * Survival across collapse/expand and re-renders comes from a
 * MutationObserver on the document root: every DOM change re-runs the sweep,
 * so a button React recreates is hidden again before anyone can press it. No
 * polling, no `requestAnimationFrame` (background tabs never run rAF
 * callbacks), no timers at all. Unload disconnects the observer and restores
 * every button this plugin hid, so disabling the bundle leaves no trace.
 *
 * Bundle format: `window.__ModuleLoader__.load({id, factory})` exporting
 * `apply` and `inject`. Plain script, no imports, no Node APIs — it runs in
 * the page, where neither exists.
 */
window.__ModuleLoader__.load({
	id: "dsh-browser-tweaks",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** Bundle version, published on the marker for diagnostics. */
		const VERSION = 1;

		/** Exact text of the shipped third ModeButton (lib/client.js). */
		const MY_CHROME_LABEL = "My Chrome";

		/** Attribute marking buttons this plugin hid (so unload restores them). */
		const HIDE_ATTRIBUTE = "data-dsh-browser-tweaks-hidden";

		/** Every button hidden and not yet restored. */
		const hidden = new Set();

		/**
		 * True for the shipped "My Chrome" mode button and nothing else.
		 *
		 * The text match must be exact — "My Chrome Settings", if such a button
		 * ever existed, must not vanish — and the pane scope keeps an
		 * unrelated same-named control elsewhere in the app untouched.
		 */
		function isMyChromeButton(el) {
			if (el === null || el === undefined) return false;
			if (el.tagName !== "BUTTON") return false;
			const text = typeof el.textContent === "string" ? el.textContent.trim() : "";
			if (text !== MY_CHROME_LABEL) return false;
			if (typeof el.closest === "function" && el.closest("[data-dsh-browser-pane]") === null) return false;
			return true;
		}

		/** Hide one button, idempotently. */
		function hide(el) {
			if (hidden.has(el)) return;
			hidden.add(el);
			if (el.style !== undefined && el.style !== null) el.style.display = "none";
			if (typeof el.setAttribute === "function") el.setAttribute(HIDE_ATTRIBUTE, "true");
		}

		/** Restore one button hidden earlier. */
		function restore(el) {
			if (!hidden.has(el)) return;
			hidden.delete(el);
			if (el.style !== undefined && el.style !== null) el.style.display = "";
			if (typeof el.removeAttribute === "function") el.removeAttribute(HIDE_ATTRIBUTE);
		}

		/**
		 * Hide every "My Chrome" button currently in the document.
		 *
		 * @returns the number hidden by this call (including already-hidden).
		 */
		function sweep() {
			if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return 0;
			// Forget buttons a re-render already discarded: `isConnected` is false
			// for a detached node (and undefined only where the DOM has none,
			// where nothing is ever pruned). Without this the set — and the
			// `hiddenCount` diagnostic — would grow by one per toggle render.
			for (const el of Array.from(hidden)) {
				if (el !== null && el !== undefined && el.isConnected === false) hidden.delete(el);
			}
			let count = 0;
			const buttons = document.querySelectorAll("button");
			for (const el of buttons) {
				if (!isMyChromeButton(el)) continue;
				hide(el);
				count += 1;
			}
			return count;
		}

		/** Install the sweep plus the observer; returns the disposer. */
		function install() {
			sweep();
			if (typeof MutationObserver === "undefined") return () => {};
			const observer = new MutationObserver(() => { sweep(); });
			const root =
				typeof document !== "undefined" && document.documentElement !== undefined && document.documentElement !== null
					? document.documentElement
					: typeof document !== "undefined"
						? document.body
						: null;
			if (root !== null && typeof observer.observe === "function") {
				observer.observe(root, { childList: true, subtree: true });
			}
			return () => {
				observer.disconnect();
				for (const el of Array.from(hidden)) restore(el);
			};
		}

		const inject = [];

		function apply(ctx) {
			if (typeof window !== "undefined") {
				window.__dshBrowserTweaks = {
					version: VERSION,
					label: MY_CHROME_LABEL,
					/** Buttons currently kept hidden. */
					get hiddenCount() {
						return hidden.size;
					},
					/** Re-run the sweep on demand (diagnostics). */
					resweep: sweep,
				};
			}
			ctx.effect(() => install(), "dsh-browser-tweaks: hide My Chrome");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.MY_CHROME_LABEL = MY_CHROME_LABEL;
		exports.HIDE_ATTRIBUTE = HIDE_ATTRIBUTE;
		exports.sweep = sweep;
		return module.exports;
	},
});
