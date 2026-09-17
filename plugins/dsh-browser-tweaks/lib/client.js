/**
 * Hide the browser pane's "My Chrome" mode button, leaving Headless + Plugin —
 * and keep the pane attached to the shortcut Chrome instead of squatting its
 * profile with a Chrome of its own.
 *
 * PROFILE-LOCK COLLISION (why the second half exists). Every GUI page load
 * opens the pane's `/browser-pane/stream`, whose `startScreencast()` calls
 * `sharedPage()` → `ensureBrowser()` — and the shipped runtime boots in own
 * mode (the constructor only ever picks own or stealth; no config key
 * selects connect). That launches a headless Chrome with
 * `--user-data-dir` set to our override, which takes the profile lock, so the
 * user's shortcut Chrome (`--remote-debugging-port=9222` on the SAME dir) can
 * never start and the pane stays blank. Restarts do not help: the first page
 * load re-squats.
 *
 * CONNECT GUARD. There is no config route to a connect-default, so this half
 * is client work: on install it POSTs `/browser-pane/mode {mode:"connect"}`
 * at once (bundle evaluation runs before the pane's own EventSource connects,
 * so the launch usually never starts), and it keeps its own EventSource on
 * the pane stream — every "state" event whose mode is not "connect" triggers
 * another post. That covers a host restart with the page still open (fresh
 * runtime, mode back to own) and any other drift. `switchMode` closes an
 * owned browser and kills a stealth child before attaching, so each post both
 * stops a squatter and attaches to the shortcut Chrome; when that Chrome is
 * not running the server broadcasts its own "launch the shortcut" error state
 * instead of launching anything. No repost loop: after a post the mode IS
 * "connect" (even on failure), so the guard stays quiet.
 *
 * Honest limitation: while the guard runs, clicking Headless/Plugin is pulled
 * back to connect — an own/stealth launch on this directory always collides
 * with the shortcut, so there is no working state to preserve there. If the
 * shortcut was started after the page loaded, reload the page: the stream
 * reconnect re-attaches to it.
 *
 * (My Chrome half: the shipped pane renders its mode toggle as three
 * unconditional ModeButtons — Headless, Plugin, My Chrome. No config key governs
 * that toggle's visibility, so removing one button is DOM work by necessity;
 * the stealth profile directory, by contrast, is a config override in
 * cordis.patch.yml.)
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
		const VERSION = 2;

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

		// ---- connect guard: only the shortcut Chrome owns the profile --------

		/** Shipped mode-switch route: switchMode closes/kills before attaching. */
		const MODE_PATH = "/browser-pane/mode";

		/** Shipped SSE stream, broadcasting {mode} on every state event. */
		const STREAM_PATH = "/browser-pane/stream";

		/** The only mode that never launches a Chrome of its own. */
		const CONNECT_MODE = "connect";

		/** Connect posts issued (diagnostics; the guard posts at most on drift). */
		let connectPosts = 0;

		/**
		 * Ask the pane to attach to the shortcut Chrome.
		 *
		 * The server's switchMode stops any owned/stealth browser first, so a
		 * post both evicts a squatter and attaches; when the shortcut Chrome
		 * is down the server answers with its "launch the shortcut" error
		 * state instead of launching. Fire-and-forget: a failed post simply
		 * leaves the next state event to trigger a retry.
		 */
		function postConnect() {
			if (typeof fetch !== "function") return;
			connectPosts += 1;
			fetch(MODE_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode: CONNECT_MODE }),
			}).catch(() => {});
		}

		/**
		 * Handle one pane "state" event: anything but connect means a squatter
		 * is launching (or launched) — pull it back.
		 * @returns true when a post was issued.
		 */
		function notePaneState(payload) {
			if (payload === null || payload === undefined || typeof payload.mode !== "string") return false;
			if (payload.mode === CONNECT_MODE) return false;
			postConnect();
			return true;
		}

		/** Install the immediate post plus the stream watch; returns the disposer. */
		function installGuard() {
			postConnect();
			if (typeof EventSource === "undefined") return () => {};
			const source = new EventSource(STREAM_PATH);
			const onState = (event) => {
				let payload = null;
				try {
					payload = JSON.parse(event?.data ?? "null");
				} catch {
					return;
				}
				notePaneState(payload);
			};
			const onError = () => {};
			source.addEventListener("state", onState);
			source.addEventListener("error", onError);
			return () => {
				source.removeEventListener("state", onState);
				source.removeEventListener("error", onError);
				source.close();
			};
		}

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
					/** Connect-guard diagnostics. */
					get guard() {
						return { posts: connectPosts };
					},
					/** Re-run the connect post on demand (diagnostics). */
					reconnect: postConnect,
				};
			}
			ctx.effect(() => install(), "dsh-browser-tweaks: hide My Chrome");
			ctx.effect(() => installGuard(), "dsh-browser-tweaks: keep pane on shortcut Chrome");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.MY_CHROME_LABEL = MY_CHROME_LABEL;
		exports.HIDE_ATTRIBUTE = HIDE_ATTRIBUTE;
		exports.sweep = sweep;
		exports.MODE_PATH = MODE_PATH;
		exports.STREAM_PATH = STREAM_PATH;
		exports.CONNECT_MODE = CONNECT_MODE;
		exports.postConnect = postConnect;
		exports.notePaneState = notePaneState;
		return module.exports;
	},
});
