/**
 * OpenCode Go usage for the DSH Web GUI.
 *
 * Two surfaces, one bundle:
 *
 * 1. A **progress ring** in the `conversation.input.right` seat, beside the
 *    context meter. The ring shows the 5-hour window, the shortest limit and so
 *    the one most likely to bite first.
 * 2. A **nested-window panel** on click: the three Go allowances drawn as bars
 *    whose length encodes the time span of each window and whose fill encodes
 *    how much of it is used.
 *
 * The two encodings are deliberately separate. Length is *time*, fill is
 * *usage*, so the reader sees where each window sits in the hierarchy rather
 * than three unrelated percentages.
 *
 * HONESTY NOTE ON "NESTING": the limits nest (5-hour is 20% of the monthly
 * allowance, weekly is 50%), but the *time spans do not*. Measured on this
 * account, the weekly window began four days BEFORE the monthly billing period,
 * because the weekly window resets on a fixed weekday boundary while the monthly
 * cycle follows the subscription date. Drawing the week literally inside the
 * month would therefore be false. The bars are drawn as a nested hierarchy of
 * allowance, labelled as such, and the caption says so.
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

		/** Percentage at or above which the reading is a warning. */
		const WARN_AT = 70;
		/** Percentage at or above which the reading is critical. */
		const HOT_AT = 90;

		/** Ring geometry, matched to the context meter's 14px viewBox. */
		const RING_SIZE = 16;
		const RING_STROKE = 2;
		const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
		const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

		/**
		 * Bar width per window, as a percentage of the panel's track.
		 *
		 * These express the allowance hierarchy, not elapsed time: the monthly
		 * allowance is the whole plan, the weekly is half of it, the 5-hour is a
		 * fifth. Using the true time fractions instead would give the 5-hour
		 * window 0.7% of the width — a sliver too small to read or tap.
		 */
		const WIDTHS = { monthly: 100, weekly: 52, rolling: 24 };

		/**
		 * Minimum visible arc, as a fraction of the ring.
		 *
		 * A 4% reading is a 1.76px arc on this geometry — present but impossible to
		 * see, which reads as "no data". Any non-zero reading is drawn at least
		 * this large so the ring always shows *something*; zero stays exactly zero,
		 * so an idle window is never overstated.
		 */
		const MIN_ARC = 0.08;
		/** Same idea for the bar fill, in px, so a small reading is still visible. */
		const MIN_FILL_PX = 3;

		const css = [
			".dsh-go-usage{display:inline-flex;align-items:center;position:relative;font:inherit}",
			".dsh-go-usage-button{display:inline-flex;align-items:center;justify-content:center;padding:2px;",
			"border:none;border-radius:999px;cursor:pointer;background:none;color:inherit;line-height:0}",
			".dsh-go-usage-button:hover{background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.16))}",
			".dsh-go-usage-button:focus-visible{outline:2px solid currentColor;outline-offset:2px}",
			".dsh-go-usage-track{stroke:var(--dsw-alias-border-secondary,rgba(127,127,127,.35))}",
			".dsh-go-usage-arc{stroke:currentColor;transition:stroke-dashoffset .4s ease}",
			".dsh-go-usage-button[data-level=warn]{color:var(--dsw-alias-state-warn-label,#c98a00)}",
			".dsh-go-usage-button[data-level=hot]{color:var(--dsw-alias-state-error-primary,#e05252)}",
			// The pill sits wherever the composer row places it (measured at x≈115 on
			// a 419px phone), and that position is not ours to assume. `left:50%` is
			// relative to the PILL's own box, so centring it there pushed the panel
			// off screen by 45px. The panel is therefore positioned in pixels by
			// `placePanel` below, which clamps it to the viewport; these defaults
			// apply only until that runs.
			".dsh-go-usage-panel{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);",
			"z-index:60;box-sizing:border-box;width:min(78vw,320px);max-width:calc(100vw - 24px);",
			"padding:10px 12px 8px;border-radius:10px;font-size:13px;line-height:1.45;text-align:left;",
			"background:var(--dsw-alias-bg-elevated,#1f1f1f);color:var(--dsw-alias-label-primary,#eee);",
			"border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.3));",
			"box-shadow:0 6px 24px rgba(0,0,0,.28)}",
			".dsh-go-usage-title{font-weight:600;margin-bottom:8px}",
			".dsh-go-usage-row{margin-bottom:8px}",
			".dsh-go-usage-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;white-space:nowrap}",
			".dsh-go-usage-head b{font-weight:600;font-variant-numeric:tabular-nums}",
			".dsh-go-usage-reset{opacity:.6;font-size:11px}",
			// The bar is the nested element: its width is the window's share of the
			// allowance, and the inner fill is the consumed part of it.
			".dsh-go-usage-bar{position:relative;height:8px;margin-top:4px;border-radius:999px;overflow:hidden;",
			"background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.2))}",
			".dsh-go-usage-fill{height:100%;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,#5a7fb8);",
			"transition:width .4s ease}",
			".dsh-go-usage-row[data-level=warn] .dsh-go-usage-fill{background:var(--dsw-alias-state-warn-primary,#c98a00)}",
			".dsh-go-usage-row[data-level=hot] .dsh-go-usage-fill{background:var(--dsw-alias-state-error-primary,#e05252)}",
			".dsh-go-usage-amount{opacity:.75;font-size:11px}",
			".dsh-go-usage-caption{margin-top:2px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.2));",
			"opacity:.6;font-size:11px;line-height:1.35}",
			".dsh-go-usage-note{margin-top:6px;opacity:.75;font-size:11px}",
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

		function level(percent) {
			if (typeof percent !== "number") return "ok";
			if (percent >= HOT_AT) return "hot";
			if (percent >= WARN_AT) return "warn";
			return "ok";
		}

		/**
		 * The ring. `percent` is how much of the 5-hour allowance is spent, so the
		 * arc grows with consumption; the track shows the remainder.
		 */
		function UsageRing({ percent, level: ringLevel, label }) {
			const clamped = typeof percent === "number" ? Math.max(0, Math.min(100, percent)) : 0;
			// Enforce a visible minimum, but never invent usage from nothing.
			const fraction = clamped === 0 ? 0 : Math.max(MIN_ARC, clamped / 100);
			const dash = fraction * RING_CIRCUMFERENCE;
			return react.createElement(
				"svg",
				{
					className: "dsh-go-usage-ring",
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
		 * One window row: the bar's width is the window's share of the allowance,
		 * its fill is what has been consumed.
		 */
		function WindowRow({ window: w }) {
			const percent = typeof w.percent === "number" ? w.percent : 0;
			return react.createElement(
				"div",
				{ className: "dsh-go-usage-row", "data-level": level(w.percent) },
				react.createElement(
					"div",
					{ className: "dsh-go-usage-head" },
					react.createElement("span", null, w.label),
					react.createElement(
						"span",
						null,
						react.createElement("b", null, `${Math.round(percent)}%`),
						w.resetsAt ? react.createElement("span", { className: "dsh-go-usage-reset" }, ` · ${untilReset(w.resetsAt)}`) : null,
					),
				),
				react.createElement(
					"div",
					{ className: "dsh-go-usage-bar", style: { width: `${WIDTHS[w.key] ?? 100}%` } },
					react.createElement("div", {
						className: "dsh-go-usage-fill",
						// A non-zero reading keeps a visible sliver; zero stays zero.
						style:
							percent === 0
								? { width: "0" }
								: { width: `max(${MIN_FILL_PX}px, ${Math.min(100, percent)}%)` },
					}),
				),
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
		 * `position:absolute` resolves against the wrapper, so the panel's
		 * coordinates are converted from viewport space using the wrapper's own
		 * rect, and the CSS centring transform is dropped once we position it.
		 * @param wrap - the `.dsh-go-usage` wrapper element.
		 * @param panel - the open panel element.
		 */
		function placePanel(wrap, panel) {
			if (!wrap || !panel || typeof window === "undefined") return;
			wrap.style.position = "relative";
			const wrapRect = wrap.getBoundingClientRect();
			const panelWidth = panel.getBoundingClientRect().width;
			panel.style.transform = "none";
			panel.style.left = `${panelLeft(wrapRect, panelWidth, window.innerWidth)}px`;
		}

		/** The pill: a ring plus the reading, replaced by a sparse dot if unknown. */
		function GoUsagePill() {
			const [state, setState] = react.useState({ status: "loading" });
			const [open, setOpen] = react.useState(false);
			const wrapRef = react.useRef(null);
			const panelRef = react.useRef(null);

			// Clamp the panel into view once it is laid out, and again on resize or
			// rotation.
			react.useEffect(() => {
				if (!open) return undefined;
				const place = () => placePanel(wrapRef.current, panelRef.current);
				place();
				window.addEventListener("resize", place);
				return () => window.removeEventListener("resize", place);
			}, [open]);

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
			const rolling = windows.find((w) => w.key === "rolling");
			const reading = rolling?.percent;

			const rows = ["monthly", "weekly", "rolling"]
				.map((key) => windows.find((w) => w.key === key))
				.filter(Boolean)
				.map((w) => react.createElement(WindowRow, { key: w.key, window: w }));

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
						level: level(reading),
						label: reading === undefined ? "OpenCode Go usage unknown" : `5-hour allowance ${Math.round(reading)} percent used`,
					}),
				),
				open
					? react.createElement(
							"div",
							{ className: "dsh-go-usage-panel", ref: panelRef, role: "dialog", "aria-label": "OpenCode Go usage" },
							react.createElement("div", { className: "dsh-go-usage-title" }, "OpenCode Go allowance"),
							rows.length > 0 ? rows : react.createElement("div", null, "No reading available"),
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
		exports.WindowRow = WindowRow;
		exports.panelLeft = panelLeft;
		exports.WIDTHS = WIDTHS;
		exports.MIN_ARC = MIN_ARC;
		return module.exports;
	},
});
