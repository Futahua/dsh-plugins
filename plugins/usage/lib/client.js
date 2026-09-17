/**
 * OpenCode Go usage for the DSH Web GUI.
 *
 * A **progress ring** in the `conversation.input.right` seat, beside the context
 * meter, and a **usage-anchored allowance chart** on click.
 *
 * The ring shows the 5-hour window — the shortest limit, so the one most likely
 * to bite first — and wears that window's colour.
 *
 * The chart is three rows on one shared quota scale, where the scale is the
 * monthly allowance: the track in every row represents $60, so a window's bar
 * width is its allowance as a fraction of that ($30 = 50%, $12 = 20%).
 *
 * Each window is POSITIONED BY ITS OWN USAGE, not by its allowance:
 *
 *     windowWidth = allowance / monthlyAllowance
 *     usedWidth   = windowWidth * usage%
 *     windowLeft  = anchor − usedWidth
 *
 * Every used portion ENDS at the same anchor — the "now" line on the quota scale —
 * so the solid part of each bar is what has been consumed and the lighter part is
 * what remains. Because the anchor is shared, the boundary lines up vertically
 * across the three rows, and the bars slide horizontally as usage changes: burn a
 * window faster and it grows leftward.
 *
 * This is a QUOTA scale, not a timeline, and it makes no claim that the current
 * week sits inside the current month. (Measured on a live account, the weekly
 * window began four days BEFORE the monthly billing period, because the weekly
 * resets on a fixed weekday boundary while the monthly cycle follows the
 * subscription date. That is why the scale is allowances rather than elapsed
 * time — but it is not a reason to centre anything, which an earlier revision of
 * this file wrongly concluded.)
 *
 * TRUNCATION: a window whose reading would reach past either end of the track is
 * clipped rather than rescaled, so the monthly scale always means exactly $60 and
 * never silently re-bases. Clipped edges are squared off so a truncated bar is
 * distinguishable from a complete one.
 *
 * Bundle format: `window.__ModuleLoader__.load({id, factory})` exporting `apply`
 * and `inject`.
 */
window.__ModuleLoader__.load({
	id: "usage",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// React arrives through the seat's props kit, so this bundle needs the
		// module table only for the primitive hooks.
		const react = require("react");

		/** Host route that serves the cached reading. */
		const STATUS_PATH = "/api/opencode-go-usage.status";
		/** Poll period while mounted; the host caches for 30s, so this is cheap. */
		const POLL_MS = 60_000;
		/** Seat id; an own id means a fresh cell beside shipped entries. */
		const SEAT_ID = "usage";

		/** Percentage at or above which a reading is a warning. */
		const WARN_AT = 70;
		/** Percentage at or above which a reading is critical. */
		const HOT_AT = 90;

		/**
		 * One colour per window, so any bar is identifiable on sight.
		 *
		 * The 5-hour colour is also the ring's, since the ring reports that window.
		 */
		const COLORS = {
			monthly: "#8b9a6b",
			weekly: "#5b83d6",
			rolling: "#e79aa6",
		};
		/** The window the pill's ring reports. */
		const RING_WINDOW = "rolling";

		/**
		 * Each window's allowance as a percentage of the monthly one. The real Go
		 * ratios for a $60 model are $30 / $60 and $12 / $60.
		 */
		const SHARES = { monthly: 100, weekly: 50, rolling: 20 };

		/** Render order, longest allowance first. */
		const ORDER = ["monthly", "weekly", "rolling"];

		/** Ring geometry, sized to sit beside the context meter. */
		const RING_SIZE = 16;
		const RING_STROKE = 2;
		const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
		const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

		/**
		 * Minimum visible arc, as a fraction of the ring.
		 *
		 * A 4% reading is a 1.76px arc on this geometry — present but impossible to
		 * see, which reads as "no data". Any non-zero reading is drawn at least this
		 * large; zero stays exactly zero, so an idle window is never overstated.
		 */
		const MIN_ARC = 0.08;

		/**
		 * Place the three windows on the shared quota scale.
		 *
		 * The track is the monthly allowance, so `left`/`width` are in track %.
		 * Positions come from usage, and a window that would overrun either end is
		 * truncated to the track rather than rescaled, which keeps the scale meaning
		 * a fixed $60.
		 *
		 * @param byKey - the reading for each window key, if present.
		 * @returns one entry per window: `{ key, left, width, fillPct, clippedLeft, clippedRight }`.
		 */
		function layout(byKey) {
			const pct = (key) => {
				const value = byKey[key]?.percent;
				return typeof value === "number" ? Math.max(0, Math.min(100, value)) : 0;
			};
			// The anchor is the monthly window's own usage boundary: its bar spans the
			// whole track, so the point its used portion reaches is the shared line.
			const anchor = (SHARES.monthly * pct("monthly")) / 100;

			return ORDER.filter((key) => byKey[key] !== undefined).map((key) => {
				const width = SHARES[key];
				const used = (width * pct(key)) / 100;
				const rawLeft = anchor - used;
				const rawRight = rawLeft + width;
				// Truncate to the track.
				const left = Math.max(0, rawLeft);
				const right = Math.min(100, rawRight);
				const drawn = Math.max(0, right - left);
				// The used portion runs from the bar's left edge to the anchor, clipped
				// by the same bounds.
				const usedDrawn = Math.max(0, Math.min(right, anchor) - left);
				return {
					key,
					left,
					width: drawn,
					fillPct: drawn === 0 ? 0 : (usedDrawn / drawn) * 100,
					clippedLeft: rawLeft < 0,
					clippedRight: rawRight > 100,
				};
			});
		}

		/**
		 * Where the shared anchor lands on the track, in %.
		 *
		 * Every used portion ends here, so one line per row at this position reads
		 * as a single boundary across the chart.
		 * @param byKey - the reading for each window key.
		 * @returns the anchor position in track %.
		 */
		function anchorPosition(byKey) {
			const value = byKey.monthly?.percent;
			const pct = typeof value === "number" ? Math.max(0, Math.min(100, value)) : 0;
			return (SHARES.monthly * pct) / 100;
		}

		const css = [
			".dsh-usage{display:inline-flex;align-items:center;position:relative;font:inherit}",
			".dsh-usage-button{display:inline-flex;align-items:center;justify-content:center;padding:2px;",
			"border:none;border-radius:999px;cursor:pointer;background:none;color:inherit;line-height:0}",
			".dsh-usage-button:hover{background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.16))}",
			".dsh-usage-button:focus-visible{outline:2px solid currentColor;outline-offset:2px}",
			".dsh-usage-track-ring{stroke:var(--dsw-alias-border-secondary,rgba(127,127,127,.35))}",
			// The arc carries the 5-hour colour, escalating at the thresholds.
			`.dsh-usage-arc{stroke:${COLORS.rolling};transition:stroke-dashoffset .4s ease}`,
			`.dsh-usage-button[data-level=warn] .dsh-usage-arc{stroke:var(--dsw-alias-state-warn-primary,#c98a00)}`,
			`.dsh-usage-button[data-level=hot] .dsh-usage-arc{stroke:var(--dsw-alias-state-error-primary,#e05252)}`,
			// The panel is positioned in pixels by `placePanel` once laid out; these
			// defaults only apply until that runs.
			".dsh-usage-panel{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);",
			"z-index:60;box-sizing:border-box;width:min(78vw,320px);max-width:calc(100vw - 24px);",
			"padding:10px 12px 8px;border-radius:10px;font-size:13px;line-height:1.45;text-align:left;",
			"background:var(--dsw-alias-bg-elevated,#1f1f1f);color:var(--dsw-alias-label-primary,#eee);",
			"border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.3));",
			"box-shadow:0 6px 24px rgba(0,0,0,.28)}",
			".dsh-usage-title{font-weight:600;margin-bottom:8px}",
		// Who is driving this session, and what they have left. Only
		// opencode-go is metered (the windows below); every other provider —
		// or an ambiguous pill not yet disambiguated by the model menu —
		// reads "free".
		".dsh-usage-provider{font-size:12px;opacity:.8;margin:-4px 0 8px}",
			// The hover glance: swatches and numbers only, sized to its content.
			".dsh-usage-quick{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);",
			"z-index:60;box-sizing:border-box;max-width:calc(100vw - 24px);padding:7px 10px;border-radius:9px;",
			"display:flex;flex-direction:column;gap:5px;font-size:12px;line-height:1.3;text-align:left;",
			"background:var(--dsw-alias-bg-elevated,#1f1f1f);color:var(--dsw-alias-label-primary,#eee);",
			"border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.3));",
			"box-shadow:0 6px 24px rgba(0,0,0,.28);pointer-events:none}",
			".dsh-usage-quickrow{display:flex;align-items:center;gap:6px;white-space:nowrap}",
			".dsh-usage-swatch{width:8px;height:8px;border-radius:2px;flex:none}",
			".dsh-usage-quickval{margin-left:auto;padding-left:10px;font-weight:600;font-variant-numeric:tabular-nums}",
			// Three rows, each a full-width view of the same monthly scale.
			".dsh-usage-rows{display:flex;flex-direction:column;gap:7px}",
			".dsh-usage-row{display:flex;align-items:center;gap:8px}",
			".dsh-usage-label{flex:0 0 46px;font-size:12px;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			// Each row's track is the shared coordinate space, but it carries NO
			// background: a full-width grey bar in the weekly and 5-hour rows read as
			// clutter, and it was redundant anyway — the monthly row's own allowance
			// bar already spans the whole track and shows the scale.
			".dsh-usage-track{position:relative;flex:1 1 auto;height:10px}",
			".dsh-usage-seg{position:absolute;top:0;bottom:0;overflow:hidden;border-radius:999px;",
			"transition:left .4s ease,width .4s ease}",
			// A squared corner reads as "continues past here" rather than "ends here".
			".dsh-usage-seg[data-clipped-left]{border-top-left-radius:0;border-bottom-left-radius:0}",
			".dsh-usage-seg[data-clipped-right]{border-top-right-radius:0;border-bottom-right-radius:0}",
			".dsh-usage-segfill{height:100%;border-radius:inherit;transition:width .4s ease}",
			// The reference line every used portion ends on.
			".dsh-usage-anchor{position:absolute;top:-2px;bottom:-2px;width:1px;z-index:8;",
			"background:var(--dsw-alias-label-secondary,rgba(160,160,160,.75));pointer-events:none}",
			".dsh-usage-figs{flex:0 0 auto;min-width:74px;text-align:right;font-size:12px;",
			"font-variant-numeric:tabular-nums;white-space:nowrap}",
			".dsh-usage-val{font-weight:600}",
			".dsh-usage-reset{opacity:.6;font-size:11px}",
			".dsh-usage-note{margin-top:8px;opacity:.75;font-size:11px}",
		].join("");

		/** Inject once; the hmr reload path removes `<style data-plugin>` tags. */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			const tagId = "usage/usage.css";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "usage";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/** Compact relative time until a reset instant. */
		function untilReset(iso) {
			if (typeof iso !== "string") return "";
			const at = Date.parse(iso);
			if (Number.isNaN(at)) return "";
			const minutes = Math.max(0, Math.round((at - Date.now()) / 60_000));
			if (minutes < 60) return `${minutes}m`;
			const hours = Math.round(minutes / 60);
			if (hours < 48) return `${hours}h`;
			return `${Math.round(hours / 24)}d`;
		}

		/** Severity of one reading, for the escalating state colours. */
		function level(percent) {
			if (typeof percent !== "number") return "ok";
			if (percent >= HOT_AT) return "hot";
			if (percent >= WARN_AT) return "warn";
			return "ok";
		}

		/** `#rrggbb` at a given alpha, for the dimmed allowance background. */
		function tint(hex, alpha) {
			const n = Number.parseInt(hex.slice(1), 16);
			return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
		}

		/**
		 * One window's row: its allowance as a bar on the shared scale, with the
		 * consumed part solid and the remainder dimmed.
		 * @param geometry - one entry from `layout`.
		 * @param window - the reading for that window.
		 * @param anchor - shared anchor position, in track %.
		 */
		function UsageRow({ geometry, window: w, anchor }) {
			const colour = COLORS[w.key] ?? COLORS.monthly;
			const percent = typeof w.percent === "number" ? Math.round(w.percent) : 0;
			const reset = untilReset(w.resetsAt);
			return react.createElement(
				"div",
				{ className: "dsh-usage-row", "data-window": w.key },
				react.createElement("span", { className: "dsh-usage-label" }, w.label),
				react.createElement(
					"span",
					{ className: "dsh-usage-track" },
					react.createElement(
						"span",
						{
							className: "dsh-usage-seg",
							"data-clipped-left": geometry.clippedLeft ? "" : undefined,
							"data-clipped-right": geometry.clippedRight ? "" : undefined,
							style: {
								left: `${geometry.left}%`,
								width: `${geometry.width}%`,
								// The dimmed part is what remains of THIS window's allowance.
								background: tint(colour, 0.22),
								boxShadow: `inset 0 0 0 1px ${tint(colour, 0.7)}`,
							},
						},
						react.createElement("span", {
							className: "dsh-usage-segfill",
							style: {
								width: `${geometry.fillPct}%`,
								background: colour,
								display: "block",
							},
						}),
					),
					react.createElement("span", { className: "dsh-usage-anchor", style: { left: `${anchor}%` } }),
				),
				react.createElement(
					"span",
					{ className: "dsh-usage-figs" },
					react.createElement("span", { className: "dsh-usage-val" }, `${percent}%`),
					reset ? react.createElement("span", { className: "dsh-usage-reset" }, ` · ${reset}`) : null,
				),
			);
		}

		/** The ring, carrying the 5-hour reading and colour. */
		function UsageRing({ percent, label }) {
			const clamped = typeof percent === "number" ? Math.max(0, Math.min(100, percent)) : 0;
			// Enforce a visible minimum, but never invent usage from nothing.
			const fraction = clamped === 0 ? 0 : Math.max(MIN_ARC, clamped / 100);
			const dash = fraction * RING_CIRCUMFERENCE;
			return react.createElement(
				"svg",
				{
					width: RING_SIZE,
					height: RING_SIZE,
					viewBox: `0 0 ${RING_SIZE} ${RING_SIZE}`,
					role: "img",
					"aria-label": label,
				},
				react.createElement("circle", {
					className: "dsh-usage-track-ring",
					cx: RING_SIZE / 2,
					cy: RING_SIZE / 2,
					r: RING_RADIUS,
					fill: "none",
					strokeWidth: RING_STROKE,
				}),
				react.createElement("circle", {
					className: "dsh-usage-arc",
					cx: RING_SIZE / 2,
					cy: RING_SIZE / 2,
					r: RING_RADIUS,
					fill: "none",
					strokeWidth: RING_STROKE,
					strokeLinecap: "round",
					// Start at 12 o'clock and grow clockwise.
					transform: `rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`,
					strokeDasharray: `${dash} ${RING_CIRCUMFERENCE}`,
				}),
			);
		}

		/**
		 * Where to put the panel, in wrapper-relative pixels.
		 *
		 * Pure so it can be unit-tested without a browser. Preferred position is
		 * centred on the pill; if that would overflow either edge the panel slides
		 * until it fits, so it is never partly off screen.
		 */
		function panelLeft(wrapRect, panelWidth, viewport, margin = 12) {
			const pillCentre = wrapRect.left + wrapRect.width / 2;
			const wanted = pillCentre - panelWidth / 2;
			const clamped = Math.max(margin, Math.min(wanted, viewport - panelWidth - margin));
			return Math.round(clamped - wrapRect.left);
		}

		/** Place the open panel so it stays inside the viewport. */
		function placePanel(wrap, panel) {
			if (!wrap || !panel || typeof window === "undefined") return;
			wrap.style.position = "relative";
			const wrapRect = wrap.getBoundingClientRect();
			const panelWidth = panel.getBoundingClientRect().width;
			panel.style.transform = "none";
			panel.style.left = `${panelLeft(wrapRect, panelWidth, window.innerWidth)}px`;
		}

		/**
		 * Who is driving this session, read off the composer model pill —
		 * never assumed, and never touching that pill (it belongs to the
		 * shipped `conversation.input.model` seat; this plugin only reads its
		 * rendered text).
		 *
		 * Resolution order:
		 *   1. a `provider/model` fallback label names the provider directly;
		 *   2. the open model menu names it exactly (the checked menuitemradio's
		 *      provider section, minus the trigger's own select id), and a
		 *      clicked menu option teaches it immediately — cached per model;
		 *   3. model names unique to one provider (installed catalogs, the
		 *      session bundle's gap model, settings.yaml) resolve menu-free;
		 *   4. names shared by several providers resolve to null — the safe
		 *      "free" fallback — until the menu has been opened once.
		 *
		 * Only opencode-go is metered; meta, openai-codex, and anything
		 * unrecognized have no usage API. Pure except for the menu cache and
		 * DOM reads, so the resolvers unit-test without a browser.
		 */

		/** Seat id of the shipped model pill (ModelSelect). */
		const PILL_SEAT = '[data-slot="conversation.input.model"]';

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

		/**
		 * Resolve the active provider for a pill label.
		 * @param label - the pill's model text with any effort suffix stripped.
		 * @returns the provider id, null for ambiguous-until-menu (safe "free"
		 *   fallback), or undefined when the label names no known model at all.
		 */
		function resolveProvider(label) {
			const key = String(label ?? "").toLowerCase();
			const slash = key.indexOf("/");
			if (slash > 0 && KNOWN_PROVIDERS.indexOf(key.slice(0, slash)) !== -1) {
				return key.slice(0, slash);
			}
			if (menuCache.has(key)) return menuCache.get(key);
			if (Object.prototype.hasOwnProperty.call(UNIQUE_TO_PROVIDER, key)) return UNIQUE_TO_PROVIDER[key];
			if (AMBIGUOUS_NAMES.indexOf(key) !== -1) return null;
			return undefined;
		}

		/** Forget everything learned from the menu (diagnostics/tests). */
		function clearProviderCache() {
			menuCache.clear();
		}

		/** The pill's model text: the trigger's title, else its visible text. */
		function pillLabel(trigger) {
			const raw =
				(trigger !== null && trigger !== undefined && typeof trigger.getAttribute === "function" &&
					trigger.getAttribute("title")) ||
				(trigger !== null && trigger !== undefined && typeof trigger.textContent === "string"
					? trigger.textContent
					: "");
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

		/**
		 * Provider id for one menu section heading.
		 * @param labelledBy - the section's aria-labelledby value.
		 * @param selectId - the pill's select id (trigger aria-controls minus "-menu").
		 * @returns the provider id, or undefined when it names nothing known.
		 */
		function sectionProvider(labelledBy, selectId) {
			if (typeof labelledBy !== "string" || typeof selectId !== "string") return undefined;
			if (labelledBy.indexOf(`${selectId}-`) !== 0) return undefined;
			const provider = labelledBy.slice(selectId.length + 1);
			return KNOWN_PROVIDERS.indexOf(provider) !== -1 ? provider : undefined;
		}

		/**
		 * Learn the provider from the open model menu, if it is open.
		 *
		 * The menu is a portal: each provider group is
		 * `<section role="group" aria-labelledby="<selectId>-<providerId>">`
		 * and the current model is the one `menuitemradio` with
		 * `aria-checked="true"`. The trigger's `aria-controls` is
		 * `<selectId>-menu`, which recovers the select id exactly.
		 * @returns true when a provider was newly learned.
		 */
		function learnFromMenu(trigger) {
			if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return false;
			const controls =
				trigger !== null && trigger !== undefined && typeof trigger.getAttribute === "function"
					? trigger.getAttribute("aria-controls")
					: null;
			if (typeof controls !== "string" || controls.slice(-5) !== "-menu") return false;
			const selectId = controls.slice(0, -5);
			let learned = false;
			const options = document.querySelectorAll('button[role="menuitemradio"]');
			for (const option of options) {
				if (option === null || option === undefined || typeof option.getAttribute !== "function") continue;
				if (option.getAttribute("aria-checked") !== "true") continue;
				const section =
					typeof option.closest === "function" ? option.closest('section[role="group"]') : null;
				if (section === null || section === undefined || typeof section.getAttribute !== "function") continue;
				const provider = sectionProvider(section.getAttribute("aria-labelledby"), selectId);
				if (provider === undefined) continue;
				const name =
					typeof option.getAttribute("title") === "string" && option.getAttribute("title") !== ""
						? option.getAttribute("title")
						: typeof option.textContent === "string"
							? option.textContent.trim()
							: "";
				if (name !== "" && menuCache.get(name.toLowerCase()) !== provider) {
					menuCache.set(name.toLowerCase(), provider);
					learned = true;
				}
			}
			return learned;
		}

		/**
		 * A clicked menu option teaches its provider immediately.
		 * @returns true when a provider was newly learned.
		 */
		function learnFromOptionClick(event) {
			const target = event?.target;
			if (target === null || target === undefined || typeof target.closest !== "function") return false;
			const option = target.closest('button[role="menuitemradio"]');
			if (option === null || option === undefined || typeof option.getAttribute !== "function") return false;
			const section =
				typeof option.closest === "function" ? option.closest('section[role="group"]') : null;
			if (section === null || section === undefined || typeof section.getAttribute !== "function") return false;
			const trigger = pillTrigger();
			const controls =
				trigger !== null && trigger !== undefined && typeof trigger.getAttribute === "function"
					? trigger.getAttribute("aria-controls")
					: null;
			if (typeof controls !== "string" || controls.slice(-5) !== "-menu") return false;
			const provider = sectionProvider(section.getAttribute("aria-labelledby"), controls.slice(0, -5));
			if (provider === undefined) return false;
			const name =
				typeof option.getAttribute("title") === "string" && option.getAttribute("title") !== ""
					? option.getAttribute("title")
					: typeof option.textContent === "string"
						? option.textContent.trim()
						: "";
			if (name === "" || menuCache.get(name.toLowerCase()) === provider) return false;
			menuCache.set(name.toLowerCase(), provider);
			return true;
		}

		/** The provider driving this session right now (repaints callers). */
		function currentProvider() {
			const trigger = pillTrigger();
			if (trigger === null || trigger === undefined) return undefined;
			learnFromMenu(trigger);
			return resolveProvider(pillLabel(trigger));
		}

		/**
		 * React hook: the active provider id (null = ambiguous fallback,
		 * undefined = no recognizable pill), live across model switches, menu
		 * teachings, and usage polls (the readout shows what is left).
		 */
		function useActiveProvider(state) {
			const [provider, setProvider] = react.useState(() => currentProvider());
			react.useEffect(() => {
				const update = () => {
					const next = currentProvider();
					setProvider((prev) => (prev === next ? prev : next));
				};
				update();
				if (typeof MutationObserver === "undefined" || typeof document === "undefined") return undefined;
				const observer = new MutationObserver(update);
				if (document.documentElement !== undefined && document.documentElement !== null) {
					observer.observe(document.documentElement, { childList: true, subtree: true });
				}
				const onClick = (event) => {
					if (learnFromOptionClick(event)) update();
				};
				document.addEventListener("click", onClick);
				return () => {
					observer.disconnect();
					document.removeEventListener("click", onClick);
				};
			// Repaint on every usage poll too: the readout shows what is left.
			// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [state?.data?.fetchedAt, state?.status]);
			return provider;
		}

		/**
		 * The provider readout line for the popup.
		 * @param provider - active provider id (null/undefined = safe "free").
		 * @param byKey - usage windows by key, if loaded.
		 * @returns e.g. "opencode-go · 68% left", "meta · free", or "free".
		 */
		function providerLine(provider, byKey) {
			if (provider === "opencode-go") {
				const percent = byKey?.[RING_WINDOW]?.percent;
				if (typeof percent === "number") {
					return `opencode-go · ${Math.max(0, 100 - Math.round(percent))}% left`;
				}
				return "opencode-go";
			}
			if (provider === null || provider === undefined) return "free";
			return `${provider} · free`;
		}

		function UsagePill() {
			const [state, setState] = react.useState({ status: "loading" });
			const [open, setOpen] = react.useState(false);
			// Who is driving this session: repaints the provider row whenever
			// the model pill changes, the menu teaches a provider, or a usage
			// poll lands (the row shows what is left of the metered windows).
			const provider = useActiveProvider(state);
			// Hover glance: three swatches and their numbers, without the chart.
			const [hovered, setHovered] = react.useState(false);
			const wrapRef = react.useRef(null);
			const panelRef = react.useRef(null);
			const quickRef = react.useRef(null);

			react.useEffect(() => {
				let live = true;
				const load = async () => {
					try {
						const response = await fetch(STATUS_PATH, { headers: { accept: "application/json" } });
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						const data = await response.json();
						if (live) setState({ status: "ready", data });
					} catch (error) {
						if (live) setState({ status: "error", message: String(error?.message ?? error) });
					}
				};
				void load();
				const timer = setInterval(() => void load(), POLL_MS);
				return () => {
					live = false;
					clearInterval(timer);
				};
			}, []);

			// Clamp the panel into view once laid out, and again on resize/rotation.
			// The hover glance is positioned the same way so the two never disagree
			// about where the pill is.
			react.useEffect(() => {
				if (!open && !hovered) return undefined;
				const place = () => placePanel(wrapRef.current, panelRef.current ?? quickRef.current);
				place();
				window.addEventListener("resize", place);
				return () => window.removeEventListener("resize", place);
			}, [open, hovered]);

			// Same dismissal behaviour as the context meter.
			react.useEffect(() => {
				if (!open) return undefined;
				const close = () => setOpen(false);
				const onKey = (event) => {
					if (event.key === "Escape") close();
				};
				document.addEventListener("pointerdown", close);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("pointerdown", close);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);

			if (state.status === "loading") return null;

			const windows = state.status === "ready" ? state.data.windows : [];
			const byKey = Object.fromEntries(windows.map((w) => [w.key, w]));
			const geometry = layout(byKey);
			const anchor = anchorPosition(byKey);
			const ringWindow = byKey[RING_WINDOW];
			const reading = ringWindow?.percent;

			const rows = geometry.map((g) =>
				react.createElement(UsageRow, { key: g.key, geometry: g, window: byKey[g.key], anchor }),
			);

			// The hover glance: one swatch and one number per window, nothing else.
			// A quick read for a pointer, where the full chart would be too much.
			const quick = ORDER.map((key) => byKey[key])
				.filter(Boolean)
				.map((w) =>
					react.createElement(
						"span",
						{ className: "dsh-usage-quickrow", key: w.key },
						react.createElement("span", { className: "dsh-usage-swatch", style: { background: COLORS[w.key] } }),
						w.label,
						react.createElement("b", { className: "dsh-usage-quickval" }, `${Math.round(w.percent ?? 0)}%`),
					),
				);

			const note =
				state.status === "error"
					? `Unavailable: ${state.message}`
					: state.data?.stale
						? `Showing the last reading — ${state.data.error}`
						: undefined;

			return react.createElement(
				"div",
				{ className: "dsh-usage", ref: wrapRef, onPointerDown: (event) => event.stopPropagation() },
				react.createElement(
					"button",
					{
						type: "button",
						className: "dsh-usage-button",
						"data-level": level(reading),
						"aria-haspopup": "dialog",
						"aria-expanded": open,
						// No `title`: a native tooltip would fight the hover glance, and it
						// is useless on touch anyway. The ring carries an aria-label.
						onClick: () => setOpen((value) => !value),
						// Hover only where a pointer can actually hover; on touch, a tap
						// fires pointerenter too, which would flash the glance first.
						onPointerEnter: (event) => {
							if (event.pointerType === "mouse") setHovered(true);
						},
						onPointerLeave: () => setHovered(false),
					},
					react.createElement(UsageRing, {
						percent: reading,
						label:
							reading === undefined
								? "OpenCode Go usage unknown"
								: `5-hour allowance ${Math.round(reading)} percent used`,
					}),
				),
				open
					? react.createElement(
							"div",
							{ className: "dsh-usage-panel", ref: panelRef, role: "dialog", "aria-label": "OpenCode Go usage" },
							react.createElement("div", { className: "dsh-usage-title" }, "OpenCode Go allowance"),
							react.createElement(
								"div",
								{ className: "dsh-usage-provider" },
								providerLine(provider, byKey),
							),
							rows.length > 0
								? react.createElement("div", { className: "dsh-usage-rows" }, rows)
								: react.createElement("div", null, "No reading available"),
							note ? react.createElement("div", { className: "dsh-usage-note" }, note) : null,
						)
					: hovered && quick.length > 0
						? react.createElement(
								"div",
								{ className: "dsh-usage-quick", ref: quickRef, role: "tooltip" },
								quick,
							)
						: null,
			);
		}

		const inject = ["slots"];

		function apply(ctx) {
			ensureStyles();
			ctx.slots.inject("conversation.input.right", () =>
				ctx.slots.register({ name: "conversation.input.right", id: SEAT_ID, order: 100 }, UsagePill),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.UsagePill = UsagePill;
		exports.UsageRing = UsageRing;
		exports.UsageRow = UsageRow;
		exports.layout = layout;
		exports.anchorPosition = anchorPosition;
		exports.panelLeft = panelLeft;
		exports.resolveProvider = resolveProvider;
		exports.clearProviderCache = clearProviderCache;
		exports.learnFromMenu = learnFromMenu;
		exports.learnFromOptionClick = learnFromOptionClick;
		exports.providerLine = providerLine;
		exports.PILL_SEAT = PILL_SEAT;
		exports.SHARES = SHARES;
		exports.COLORS = COLORS;
		exports.MIN_ARC = MIN_ARC;
		return module.exports;
	},
});
