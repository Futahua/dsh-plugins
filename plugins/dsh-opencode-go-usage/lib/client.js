/**
 * OpenCode Go usage for the DSH Web GUI.
 *
 * A **progress ring** in the `conversation.input.right` seat, beside the context
 * meter, and a **nested allowance bar** on click.
 *
 * The ring shows the 5-hour window — the shortest limit, so the one most likely
 * to bite first — and wears that window's colour.
 *
 * The bar is ONE continuous track carrying three overlapping allowance windows:
 *
 *     Monthly  ━━━━━━━━━[━━ Weekly ━[5h]━━━]━━━━━━━━━
 *
 * Width encodes each window's share of the monthly allowance ($60 / $30 / $12 =
 * 100% / 50% / 20%), and each is centred inside its parent so the containment
 * reads at a glance. Height encodes usage: every window is filled from its own
 * left edge by its own percentage, over a dimmed version of its own colour.
 *
 * This is NOT a stacked progress bar. The windows are separate limits that
 * occupy overlapping spans of one scale, and the nested outlines are what make
 * that legible in a single row.
 *
 * HONESTY NOTE ON POSITION: the *allowances* nest, but the *time spans do not*.
 * Measured on a live account, the weekly window began four days BEFORE the
 * monthly billing period, because the weekly window resets on a fixed weekday
 * boundary while the monthly cycle follows the subscription date. The centring
 * here therefore expresses the allowance hierarchy, not elapsed time; nothing
 * here claims the current week sits inside the current month.
 *
 * Bundle format: `window.__ModuleLoader__.load({id, factory})` exporting `apply`
 * and `inject`.
 */
window.__ModuleLoader__.load({
	id: "dsh-opencode-go-usage",
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
		const SEAT_ID = "opencode-go-usage";

		/** Percentage at or above which a reading is a warning. */
		const WARN_AT = 70;
		/** Percentage at or above which a reading is critical. */
		const HOT_AT = 90;

		/**
		 * One colour per window, so any segment is identifiable on sight.
		 *
		 * Sage / blue / pink follow the sketch these were designed from. The 5-hour
		 * colour is also the ring's, since the ring reports that same window.
		 */
		const COLORS = {
			monthly: "#8b9a6b",
			weekly: "#5b83d6",
			rolling: "#e79aa6",
		};
		/** The window the pill's ring reports. */
		const RING_WINDOW = "rolling";

		/**
		 * Each window's share of the monthly allowance, as a percentage of the
		 * track. The real Go ratios for a $60 model are $30 / $60 and $12 / $60.
		 */
		const SHARES = { monthly: 100, weekly: 50, rolling: 20 };

		/**
		 * Vertical bands, so overlapping windows stay distinguishable.
		 *
		 * The monthly bar is the full height; each nested window is inset a little
		 * further so its parent's edges remain visible behind it.
		 */
		const BANDS = {
			monthly: { top: 0, bottom: 0, z: 1 },
			weekly: { top: 2, bottom: 2, z: 2 },
			rolling: { top: 4, bottom: 4, z: 3 },
		};

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
		/** Same idea for a bar fill, in px. */
		const MIN_FILL_PX = 3;

		const css = [
			".dsh-go-usage{display:inline-flex;align-items:center;position:relative;font:inherit}",
			".dsh-go-usage-button{display:inline-flex;align-items:center;justify-content:center;padding:2px;",
			"border:none;border-radius:999px;cursor:pointer;background:none;color:inherit;line-height:0}",
			".dsh-go-usage-button:hover{background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.16))}",
			".dsh-go-usage-button:focus-visible{outline:2px solid currentColor;outline-offset:2px}",
			".dsh-go-usage-track{stroke:var(--dsw-alias-border-secondary,rgba(127,127,127,.35))}",
			// The arc carries the 5-hour colour, escalating at the thresholds.
			`.dsh-go-usage-arc{stroke:${COLORS.rolling};transition:stroke-dashoffset .4s ease}`,
			`.dsh-go-usage-button[data-level=warn] .dsh-go-usage-arc{stroke:var(--dsw-alias-state-warn-primary,#c98a00)}`,
			`.dsh-go-usage-button[data-level=hot] .dsh-go-usage-arc{stroke:var(--dsw-alias-state-error-primary,#e05252)}`,
			// The panel is positioned in pixels by `placePanel` once laid out; these
			// defaults only apply until that runs.
			".dsh-go-usage-panel{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);",
			"z-index:60;box-sizing:border-box;width:min(78vw,320px);max-width:calc(100vw - 24px);",
			"padding:10px 12px 8px;border-radius:10px;font-size:13px;line-height:1.45;text-align:left;",
			"background:var(--dsw-alias-bg-elevated,#1f1f1f);color:var(--dsw-alias-label-primary,#eee);",
			"border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.3));",
			"box-shadow:0 6px 24px rgba(0,0,0,.28)}",
			".dsh-go-usage-title{font-weight:600;margin-bottom:8px}",
			// One track, three overlapping windows.
			".dsh-go-usage-stack{position:relative;height:18px;margin-bottom:8px}",
			".dsh-go-usage-seg{position:absolute;border-radius:999px;overflow:hidden}",
			".dsh-go-usage-segfill{height:100%;border-radius:999px;transition:width .4s ease}",
			// Legend: one swatch and value per window, so the bar stays unlabelled.
			".dsh-go-usage-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px}",
			".dsh-go-usage-key{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}",
			".dsh-go-usage-swatch{width:8px;height:8px;border-radius:2px;flex:none}",
			".dsh-go-usage-val{font-variant-numeric:tabular-nums;font-weight:600}",
			".dsh-go-usage-reset{opacity:.6;font-size:11px}",
			".dsh-go-usage-note{margin-top:8px;opacity:.75;font-size:11px}",
		].join("");

		/** Inject once; the hmr reload path removes `<style data-plugin>` tags. */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			const tagId = "dsh-opencode-go-usage/usage.css";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-opencode-go-usage";
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

		/** `#rrggbb` at a given alpha, for the dimmed unfilled background. */
		function tint(hex, alpha) {
			const n = Number.parseInt(hex.slice(1), 16);
			return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
		}

		/**
		 * One window's segment: centred in the track at its allowance share, filled
		 * from its own left edge by its own percentage.
		 */
		function Segment({ window: w }) {
			const share = SHARES[w.key] ?? 100;
			const band = BANDS[w.key] ?? BANDS.monthly;
			const percent = typeof w.percent === "number" ? w.percent : 0;
			const colour = COLORS[w.key] ?? COLORS.monthly;
			// Centre this window inside the track, so nesting is symmetric.
			const left = (100 - share) / 2;
			return react.createElement(
				"div",
				{
					className: "dsh-go-usage-seg",
					title: `${w.label}: ${Math.round(percent)}%`,
					style: {
						left: `${left}%`,
						width: `${share}%`,
						top: band.top,
						bottom: band.bottom,
						zIndex: band.z,
						background: tint(colour, 0.22),
						// A ring keeps an inner window readable against its parent.
						boxShadow: `inset 0 0 0 1px ${tint(colour, 0.85)}`,
					},
				},
				react.createElement("div", {
					className: "dsh-go-usage-segfill",
					style:
						percent === 0
							? { width: "0", background: colour }
							: { width: `max(${MIN_FILL_PX}px, ${Math.min(100, percent)}%)`, background: colour },
				}),
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
					className: "dsh-go-usage-track",
					cx: RING_SIZE / 2,
					cy: RING_SIZE / 2,
					r: RING_RADIUS,
					fill: "none",
					strokeWidth: RING_STROKE,
				}),
				react.createElement("circle", {
					className: "dsh-go-usage-arc",
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
		 * @param wrapRect - the wrapper's viewport rect.
		 * @param panelWidth - laid-out panel width in px.
		 * @param viewport - viewport width in px.
		 * @param margin - minimum gap to keep from either edge.
		 * @returns the `left` value in px, relative to the wrapper.
		 */
		function panelLeft(wrapRect, panelWidth, viewport, margin = 12) {
			const pillCentre = wrapRect.left + wrapRect.width / 2;
			const wanted = pillCentre - panelWidth / 2;
			const clamped = Math.max(margin, Math.min(wanted, viewport - panelWidth - margin));
			return Math.round(clamped - wrapRect.left);
		}

		/**
		 * Place the open panel so it stays inside the viewport.
		 *
		 * `position:absolute` resolves against the wrapper, so coordinates are
		 * converted from viewport space, and the CSS centring transform is dropped.
		 */
		function placePanel(wrap, panel) {
			if (!wrap || !panel || typeof window === "undefined") return;
			wrap.style.position = "relative";
			const wrapRect = wrap.getBoundingClientRect();
			const panelWidth = panel.getBoundingClientRect().width;
			panel.style.transform = "none";
			panel.style.left = `${panelLeft(wrapRect, panelWidth, window.innerWidth)}px`;
		}

		function GoUsagePill() {
			const [state, setState] = react.useState({ status: "loading" });
			const [open, setOpen] = react.useState(false);
			const wrapRef = react.useRef(null);
			const panelRef = react.useRef(null);

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
			react.useEffect(() => {
				if (!open) return undefined;
				const place = () => placePanel(wrapRef.current, panelRef.current);
				place();
				window.addEventListener("resize", place);
				return () => window.removeEventListener("resize", place);
			}, [open]);

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
			const ringWindow = windows.find((w) => w.key === RING_WINDOW);
			const reading = ringWindow?.percent;

			// Draw longest first so the nested windows paint over it.
			const order = ["monthly", "weekly", "rolling"];
			const segments = order
				.map((key) => windows.find((w) => w.key === key))
				.filter(Boolean)
				.map((w) => react.createElement(Segment, { key: w.key, window: w }));

			const legend = order
				.map((key) => windows.find((w) => w.key === key))
				.filter(Boolean)
				.map((w) =>
					react.createElement(
						"span",
						{ className: "dsh-go-usage-key", key: w.key },
						react.createElement("span", { className: "dsh-go-usage-swatch", style: { background: COLORS[w.key] } }),
						`${w.label} `,
						react.createElement("span", { className: "dsh-go-usage-val" }, `${Math.round(w.percent ?? 0)}%`),
						w.resetsAt ? react.createElement("span", { className: "dsh-go-usage-reset" }, ` · ${untilReset(w.resetsAt)}`) : null,
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
				{ className: "dsh-go-usage", ref: wrapRef, onPointerDown: (event) => event.stopPropagation() },
				react.createElement(
					"button",
					{
						type: "button",
						className: "dsh-go-usage-button",
						"data-level": level(reading),
						"aria-haspopup": "dialog",
						"aria-expanded": open,
						title: reading === undefined ? "OpenCode Go usage" : `OpenCode Go · 5-hour ${Math.round(reading)}%`,
						onClick: () => setOpen((value) => !value),
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
							{ className: "dsh-go-usage-panel", ref: panelRef, role: "dialog", "aria-label": "OpenCode Go usage" },
							react.createElement("div", { className: "dsh-go-usage-title" }, "OpenCode Go allowance"),
							segments.length > 0
								? react.createElement("div", { className: "dsh-go-usage-stack" }, segments)
								: react.createElement("div", null, "No reading available"),
							react.createElement("div", { className: "dsh-go-usage-legend" }, legend),
							note ? react.createElement("div", { className: "dsh-go-usage-note" }, note) : null,
						)
					: null,
			);
		}

		const inject = ["slots"];

		function apply(ctx) {
			ensureStyles();
			ctx.slots.inject("conversation.input.right", () =>
				ctx.slots.register({ name: "conversation.input.right", id: SEAT_ID, order: 100 }, GoUsagePill),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.GoUsagePill = GoUsagePill;
		exports.UsageRing = UsageRing;
		exports.Segment = Segment;
		exports.panelLeft = panelLeft;
		exports.SHARES = SHARES;
		exports.COLORS = COLORS;
		exports.MIN_ARC = MIN_ARC;
		return module.exports;
	},
});
