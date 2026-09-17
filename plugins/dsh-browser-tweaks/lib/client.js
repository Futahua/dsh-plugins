/**
 * Hide the browser pane's "My Chrome" mode button, leaving Headless + Plugin —
 * and badge the composer model pill with its provider and usage.
 *
 * (My Chrome half: see below. The pill badge is the second half.)
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
 * callbacks), no timers at all for this half. Unload disconnects the observer
 * and restores every button this plugin hid, so disabling the bundle leaves
 * no trace.
 *
 * PILL BADGE. The composer model pill is the shipped
 * `conversation.input.model` seat (ModelSelect): its trigger button shows the
 * model display name, which is React-owned — so the badge is a `<span>`
 * APPENDED beside the pill content inside the pill element, and the pill's
 * own text node is never rewritten.
 *
 * The provider is read, never assumed:
 *   1. a `provider/model` fallback label names it directly;
 *   2. the open model menu names it exactly (the checked menuitemradio's
 *      provider section, minus the trigger's own select id), and a clicked
 *      menu option teaches it immediately — both are cached per model name;
 *   3. model names unique to one provider (from the installed catalogs plus
 *      settings.yaml) resolve without the menu;
 *   4. names shared by several providers ("Muse Spark 1.3 Contributor" is both
 *      meta and opencode-go; "GPT-5.6 Luna" is both codex and opencode-go)
 *      show the safe fallback "free" until the menu has been opened once and
 *      the true provider is known.
 *
 * Only opencode-go is metered, through the sibling plugin's
 * `/api/opencode-go-usage.status` (same shape its client reads: `windows[]`
 * with `percent` used; the badge shows what is LEFT of the 5-hour rolling
 * window, polled every 60s like the sibling). meta and openai-codex have no
 * usage API, so those show "free" — the user's words.
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

		// ---- provider badge for the composer model pill -----------------------

		/** Seat id of the shipped pill (ModelSelect). */
		const PILL_SEAT = '[data-slot="conversation.input.model"]';

		/** Attribute marking the badge span this plugin appended. */
		const BADGE_ATTRIBUTE = "data-dsh-browser-tweaks-provider";

		/** Sibling plugin's cached reading: same path and shape its client uses. */
		const STATUS_PATH = "/api/opencode-go-usage.status";

		/** Poll period while an opencode-go model is active; the host caches. */
		const POLL_MS = 60000;

		/** The 5-hour window the usage ring reports; the badge shows its remainder. */
		const USAGE_WINDOW = "rolling";

		/** Provider ids this profile configures (settings.yaml llm-pi-ai). */
		const KNOWN_PROVIDERS = ["opencode-go", "openai-codex", "meta"];

		/**
		 * Model ids and display names unique to one provider (lowercased).
		 *
		 * Sources, all read off disk: the installed pi-ai catalogs
		 * (`@earendil-works/pi-ai` provider data for `openai-codex` and
		 * `opencode-go`), the `deepseek-v4.1-flash` gap entry
		 * (`dsh-opencode-go-session` CATALOG_GAPS, "DeepSeek V4.1 Flash"), and
		 * the settings.yaml `meta.models` declarations. Names shared by
		 * several providers live in AMBIGUOUS_NAMES instead — never here.
		 */
		const UNIQUE_TO_PROVIDER = {
			// opencode-go (metered)
			"minimax-m3": "opencode-go",
			"qwen3.8-flash": "opencode-go",
			"deepseek-v4-flash": "opencode-go",
			"deepseek-v4-flash-vision-exp": "opencode-go",
			"deepseek-v4-pro": "opencode-go",
			"glm-5.1": "opencode-go",
			"glm-5.2": "opencode-go",
			"glm-5.3": "opencode-go",
			"glm-5.3-flash": "opencode-go",
			"hy3": "opencode-go",
			"hy4-preview": "opencode-go",
			"kimi-k2.6": "opencode-go",
			"kimi-k2.7-code": "opencode-go",
			"kimi-k3": "opencode-go",
			"longcat-2.0": "opencode-go",
			"mimo-v2.5": "opencode-go",
			"mimo-v2.5-pro": "opencode-go",
			"minimax-m2.7": "opencode-go",
			"omen-alpha": "opencode-go",
			"qwen3.6-plus": "opencode-go",
			"qwen3.7-max": "opencode-go",
			"qwen3.7-plus": "opencode-go",
			"qwen3.8-max": "opencode-go",
			"grok-4.6": "opencode-go",
			"deepseek-v4.1-flash": "opencode-go",
			"qwen3.8 flash": "opencode-go",
			"deepseek v4 flash": "opencode-go",
			"deepseek v4 flash vision exp": "opencode-go",
			"deepseek v4 pro (new)": "opencode-go",
			"glm-5.3-flash (2x usage)": "opencode-go",
			"hy4 preview": "opencode-go",
			"kimi k2.6": "opencode-go",
			"kimi k2.7 code": "opencode-go",
			"kimi k3": "opencode-go",
			"mimo v2.5": "opencode-go",
			"mimo v2.5 pro": "opencode-go",
			"omen alpha": "opencode-go",
			"qwen3.6 plus": "opencode-go",
			"qwen3.7 max": "opencode-go",
			"qwen3.7 plus": "opencode-go",
			"qwen3.8 max": "opencode-go",
			"grok 4.6": "opencode-go",
			"deepseek v4.1 flash": "opencode-go",
			// openai-codex (no usage API: free)
			"gpt-5.3-codex-spark": "openai-codex",
			"gpt-5.4": "openai-codex",
			"gpt-5.4-mini": "openai-codex",
			"gpt-5.5": "openai-codex",
			"gpt-5.6-terra": "openai-codex",
			"gpt-5.6-sol": "openai-codex",
			"gpt-6-astra": "openai-codex",
			"gpt-5.3 codex spark": "openai-codex",
			"gpt-5.4 mini": "openai-codex",
			"gpt-5.6 terra": "openai-codex",
			"gpt-5.6 sol": "openai-codex",
			"gpt-6 astra": "openai-codex",
			// meta (no usage API: free)
			"muse-spark-1.3": "meta",
			"muse-spark-1.2": "meta",
			"muse-spark-1.1": "meta",
			"muse spark 1.3": "meta",
			"muse spark 1.2": "meta",
			"muse spark 1.1": "meta",
		};

		/**
		 * Model ids and display names served by MORE THAN ONE provider
		 * (lowercased): "Muse Spark 1.3 Contributor" is both meta and
		 * opencode-go, "GPT-5.6 Luna" both codex and opencode-go. These resolve
		 * only through the menu (or its cache) — never by name.
		 */
		const AMBIGUOUS_NAMES = [
			"muse-spark-1.3-contributor",
			"muse-spark-1.2-contributor",
			"gpt-5.6-luna",
			"muse spark 1.3 contributor",
			"muse spark 1.2 contributor",
			"gpt-5.6 luna",
		];

		/** The pill trigger's "model · effort" separator (shipped ModelSelect). */
		const EFFORT_SEPARATOR = " · ";

		/** Model name (lowercased) to provider id, learned from the open menu. */
		const menuCache = new Map();

		/** The usage reading: idle until an opencode-go model needs it. */
		const usage = { status: "idle", remaining: null };

		/** Usage poll timer, running only while an opencode-go model is active. */
		let pollTimer = null;

		/** The pill trigger the badge is currently attached to (if any). */
		let badgedTrigger = null;

		/**
		 * Resolve the active provider for a pill label.
		 *
		 * @param label - the pill's model text with any effort suffix stripped.
		 * @returns the provider id, null for ambiguous-until-menu (safe "free"
		 *   fallback), or undefined when the label names no known model at all
		 *   (loading/placeholder text: no badge).
		 */
		function resolveProvider(label) {
			const key = label.toLowerCase();
			const slash = key.indexOf("/");
			if (slash > 0 && KNOWN_PROVIDERS.indexOf(key.slice(0, slash)) !== -1) {
				return key.slice(0, slash);
			}
			if (menuCache.has(key)) return menuCache.get(key);
			if (Object.prototype.hasOwnProperty.call(UNIQUE_TO_PROVIDER, key)) return UNIQUE_TO_PROVIDER[key];
			if (AMBIGUOUS_NAMES.indexOf(key) !== -1) return null;
			return undefined;
		}

		/** Badge text for a resolved provider (null = ambiguous fallback). */
		function badgeText(provider) {
			if (provider === "opencode-go") {
				if (usage.status === "ready" && typeof usage.remaining === "number") {
					return `opencode-go · ${usage.remaining}% left`;
				}
				if (usage.status === "loading") return "opencode-go · …";
				return "opencode-go";
			}
			if (provider === null || provider === undefined) return "free";
			return `${provider} · free`;
		}

		/** The pill's model text: the trigger's title, else its visible text. */
		function pillLabel(trigger) {
			const raw =
				(typeof trigger.getAttribute === "function" && trigger.getAttribute("title")) ||
				(typeof trigger.textContent === "string" ? trigger.textContent : "");
			const at = raw.indexOf(EFFORT_SEPARATOR);
			return (at === -1 ? raw : raw.slice(0, at)).trim();
		}

		/** Find the pill trigger button, if the seat has rendered one. */
		function pillTrigger() {
			if (typeof document === "undefined" || typeof document.querySelector !== "function") return null;
			const seat = document.querySelector(PILL_SEAT);
			if (seat === null || seat === undefined || typeof seat.querySelector !== "function") return null;
			return seat.querySelector('button[aria-haspopup="menu"]') || seat.querySelector("button");
		}

		/** Our badge span inside a trigger, if appended. */
		function badgeIn(trigger) {
			if (trigger === null || trigger === undefined || typeof trigger.querySelector !== "function") return null;
			return trigger.querySelector(`[${BADGE_ATTRIBUTE}]`);
		}

		/** Append (or reuse) the badge span inside the trigger; never touches text. */
		function ensureBadge(trigger) {
			const existing = badgeIn(trigger);
			if (existing !== null && existing !== undefined) return existing;
			const badge = document.createElement("span");
			badge.setAttribute(BADGE_ATTRIBUTE, "true");
			badge.style.fontSize = "11px";
			badge.style.opacity = ".75";
			badge.style.marginLeft = "6px";
			badge.style.whiteSpace = "nowrap";
			badge.style.flexShrink = "0";
			trigger.appendChild(badge);
			return badge;
		}

		/** Remove our badge from a trigger, if present. */
		function removeBadge(trigger) {
			const badge = badgeIn(trigger);
			if (badge !== null && badge !== undefined && typeof badge.remove === "function") badge.remove();
			else if (badge !== null && badge !== undefined && badge.parentNode === trigger) {
				trigger.removeChild(badge);
			}
		}

		/**
		 * Learn the provider from the open model menu, if it is open.
		 *
		 * The menu is a portal: each provider group is
		 * `<section role="group" aria-labelledby="<selectId>-<providerId>">`
		 * and the current model is the one `menuitemradio` with
		 * `aria-checked="true"`. The trigger's `aria-controls` is
		 * `<selectId>-menu`, which recovers the select id exactly — so the
		 * provider id needs no guessing, even with dashes in it.
		 *
		 * @returns true when a provider was learned (badge may need repainting).
		 */
		function learnFromMenu(trigger) {
			if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return false;
			const controls =
				typeof trigger.getAttribute === "function" ? trigger.getAttribute("aria-controls") : null;
			if (typeof controls !== "string" || controls.slice(-5) !== "-menu") return false;
			const selectId = controls.slice(0, -5);
			let learned = false;
			const options = document.querySelectorAll('button[role="menuitemradio"]');
			for (const option of options) {
				if (typeof option.getAttribute !== "function") continue;
				if (option.getAttribute("aria-checked") !== "true") continue;
				const section =
					typeof option.closest === "function" ? option.closest('section[role="group"]') : null;
				if (section === null || section === undefined) continue;
				const labelledBy =
					typeof section.getAttribute === "function" ? section.getAttribute("aria-labelledby") : null;
				if (typeof labelledBy !== "string" || labelledBy.indexOf(`${selectId}-`) !== 0) continue;
				const provider = labelledBy.slice(selectId.length + 1);
				if (KNOWN_PROVIDERS.indexOf(provider) === -1) continue;
				const name =
					typeof option.getAttribute("title") === "string" && option.getAttribute("title") !== ""
						? option.getAttribute("title")
						: typeof option.textContent === "string"
							? option.textContent.trim()
							: "";
				if (name !== "") {
					if (menuCache.get(name.toLowerCase()) !== provider) learned = true;
					menuCache.set(name.toLowerCase(), provider);
				}
			}
			return learned;
		}

		/** Fetch the sibling plugin's cached reading; repaint the badge after. */
		function refreshUsage() {
			if (typeof fetch !== "function") {
				usage.status = "error";
				paintBadge();
				return;
			}
			usage.status = "loading";
			paintBadge();
			fetch(STATUS_PATH, { headers: { accept: "application/json" } }).then(
				(response) => {
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					return response.json();
				},
			).then(
				(data) => {
					const windows = Array.isArray(data?.windows) ? data.windows : [];
					const rolling = windows.find((w) => w?.key === USAGE_WINDOW);
					if (typeof rolling?.percent === "number") {
						usage.status = "ready";
						usage.remaining = Math.max(0, 100 - Math.round(rolling.percent));
					} else {
						usage.status = "error";
					}
					paintBadge();
				},
				() => {
					usage.status = "error";
					paintBadge();
				},
			);
		}

		/** Run the usage poll only while an opencode-go model is active. */
		function ensurePolling(provider) {
			const need = provider === "opencode-go";
			if (!need) {
				if (pollTimer !== null) {
					if (pollTimer !== -1 && typeof clearInterval === "function") clearInterval(pollTimer);
					pollTimer = null;
				}
				return;
			}
			if (pollTimer !== null) return;
			// Arm the timer BEFORE the first fetch: refreshUsage repaints
			// synchronously, and that repaint re-enters here — with the timer
			// still null that would recurse forever. -1 marks "fetch once,
			// no timer" where setInterval does not exist.
			if (typeof setInterval === "function") pollTimer = setInterval(refreshUsage, POLL_MS);
			else pollTimer = -1;
			refreshUsage();
		}

		/** Re-resolve the pill and repaint (or remove) the badge. Idempotent. */
		function paintBadge() {
			if (typeof document === "undefined") return;
			const trigger = pillTrigger();
			if (trigger !== badgedTrigger && badgedTrigger !== null) {
				removeBadge(badgedTrigger);
				badgedTrigger = null;
			}
			if (trigger === null || trigger === undefined) return;
			learnFromMenu(trigger);
			const provider = resolveProvider(pillLabel(trigger));
			if (provider === undefined) {
				removeBadge(trigger);
				badgedTrigger = null;
				ensurePolling(undefined);
				return;
			}
			const badge = ensureBadge(trigger);
			badgedTrigger = trigger;
			const text = badgeText(provider);
			if (badge.textContent !== text) badge.textContent = text;
			ensurePolling(provider);
		}

		/** A clicked menu option teaches its provider immediately. */
		function onBadgeClick(event) {
			const target = event?.target;
			if (target === null || target === undefined || typeof target.closest !== "function") return;
			const option = target.closest('button[role="menuitemradio"]');
			if (option === null || option === undefined) return;
			const section = typeof option.closest === "function" ? option.closest('section[role="group"]') : null;
			if (section === null || section === undefined || typeof section.getAttribute !== "function") return;
			const labelledBy = section.getAttribute("aria-labelledby");
			const trigger = pillTrigger();
			const controls =
				trigger !== null && trigger !== undefined && typeof trigger.getAttribute === "function"
					? trigger.getAttribute("aria-controls")
					: null;
			if (typeof labelledBy !== "string" || typeof controls !== "string" || controls.slice(-5) !== "-menu") {
				return;
			}
			const selectId = controls.slice(0, -5);
			if (labelledBy.indexOf(`${selectId}-`) !== 0) return;
			const provider = labelledBy.slice(selectId.length + 1);
			if (KNOWN_PROVIDERS.indexOf(provider) === -1) return;
			const name =
				typeof option.getAttribute === "function" && typeof option.getAttribute("title") === "string" &&
					option.getAttribute("title") !== ""
					? option.getAttribute("title")
					: typeof option.textContent === "string"
						? option.textContent.trim()
						: "";
			if (name === "") return;
			menuCache.set(name.toLowerCase(), provider);
			paintBadge();
		}

		/** Install the badge sweep plus menu learning; returns the disposer. */
		function installBadge() {
			paintBadge();
			if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
				const observer = new MutationObserver(() => {
					paintBadge();
				});
				const root =
					document.documentElement !== undefined && document.documentElement !== null
						? document.documentElement
						: document.body;
				if (root !== null && root !== undefined && typeof observer.observe === "function") {
					observer.observe(root, { childList: true, subtree: true });
				}
				installBadge.observer = observer;
			}
			if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
				document.addEventListener("click", onBadgeClick);
			}
			return () => {
				if (installBadge.observer !== undefined && installBadge.observer !== null) {
					installBadge.observer.disconnect();
					installBadge.observer = null;
				}
				if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
					document.removeEventListener("click", onBadgeClick);
				}
				if (pollTimer !== null) {
					if (pollTimer !== -1 && typeof clearInterval === "function") clearInterval(pollTimer);
					pollTimer = null;
				}
				if (badgedTrigger !== null) {
					removeBadge(badgedTrigger);
					badgedTrigger = null;
				}
				menuCache.clear();
				usage.status = "idle";
				usage.remaining = null;
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
					/** Current badge state (diagnostics). */
					get badge() {
						return {
							provider: badgedTrigger === null ? null : resolveProvider(pillLabel(badgedTrigger)),
							text:
								badgedTrigger === null || typeof badgedTrigger.querySelector !== "function"
									? null
									: (badgedTrigger.querySelector(`[${BADGE_ATTRIBUTE}]`) ?? {}).textContent ?? null,
							cached: menuCache.size,
							usage: usage.status,
						};
					},
					/** Re-run the badge paint on demand (diagnostics). */
					repaintBadge: paintBadge,
				};
			}
			ctx.effect(() => install(), "dsh-browser-tweaks: hide My Chrome");
			ctx.effect(() => installBadge(), "dsh-browser-tweaks: provider badge");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.MY_CHROME_LABEL = MY_CHROME_LABEL;
		exports.HIDE_ATTRIBUTE = HIDE_ATTRIBUTE;
		exports.sweep = sweep;
		exports.BADGE_ATTRIBUTE = BADGE_ATTRIBUTE;
		exports.STATUS_PATH = STATUS_PATH;
		exports.USAGE_WINDOW = USAGE_WINDOW;
		exports.resolveProvider = resolveProvider;
		exports.badgeText = badgeText;
		exports.paintBadge = paintBadge;
		return module.exports;
	},
});
