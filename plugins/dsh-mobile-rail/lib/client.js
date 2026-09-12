/**
 * Reclaim the phone's left edge, and open the real sidebar instead of a strip.
 *
 * On a narrow viewport the layout collapses the sidebar to a permanent 56px rail
 * (`dsh-client-ui-layout/lib/client.js:37` — `sidebar === 0` still yields 56px,
 * and the frame writes it as an inline `gridTemplateColumns`), which costs ~13%
 * of a phone's usable width and never goes away.
 *
 * This plugin hides that rail, and replaces it with a tap target:
 *
 *   - tap the left edge  → the FULL sidebar opens
 *   - tap anywhere else  → it closes again
 *
 * The important part is HOW the sidebar opens. The plugin does not fake a strip
 * with CSS and it does not touch layout state directly; it clicks the product's
 * own sidebar toggle. That sets the layout's own `narrowExpanded`, so the
 * sidebar opens at its native width with the product's own animation and its own
 * squeeze of the centre column. The plugin's CSS stops applying the moment
 * `data-sidebar-collapsed` clears, so there is no second source of truth.
 *
 * Narrow-viewport CSS cannot use `grid-template-columns` to hide the rail: on a
 * live phone a matching `!important` rule was confirmed by the browser's own
 * matched-styles API to be winning the cascade, and the track still computed to
 * 56px — a freshly injected identical sheet had no effect either. Collapsing the
 * sidebar COLUMN works, and `width:0;overflow:hidden` is used rather than
 * `display:none` because removing a grid child outright collapsed the centre
 * column as well.
 *
 * Bundle format: `window.__ModuleLoader__.load({id, factory})` exporting
 * `apply` and `inject`.
 */
window.__ModuleLoader__.load({
	id: "dsh-mobile-rail",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * Below this width the rail hides and the tap target is active. Chosen
		 * above the 768px breakpoint the right panel uses
		 * (`ui-sidebar-right/lib/client.js:916`) so the two mobile behaviours
		 * switch together, and well below the 1024px auto-collapse so tablets and
		 * desktops keep the normal rail.
		 */
		const NARROW_MAX_PX = 768;

		/** Grab zone for the tap that opens the sidebar, in px from the left edge. */
		const EDGE_PX = 28;

		/**
		 * The frame element, identified WITHOUT a hashed class name.
		 *
		 * `pI_x6G_frame` is build-generated and would break on any rebuild, so the
		 * frame is found by the product's own state attributes and marked by us.
		 */
		const FRAME = ".dsh-mobile-rail-frame";

		/** The stable hook the sidebar renders under — not a hashed class. */
		const SIDEBAR = '[data-slot="sidebar"]';

		/**
		 * Mark the frame so the stylesheet can address it stably.
		 *
		 * Runs on demand rather than once, because React can re-mount the frame and
		 * a marker applied at load can vanish with it.
		 * @returns the marked frames.
		 */
		function markFrames() {
			if (typeof document === "undefined") return [];
			const marked = [];
			for (const el of document.querySelectorAll("[data-sidebar-collapsed], [data-rightbar-collapsed]")) {
				if (getComputedStyle(el).display !== "grid") continue;
				if (!el.classList.contains("dsh-mobile-rail-frame")) el.classList.add("dsh-mobile-rail-frame");
				marked.push(el);
			}
			return marked;
		}

		const css = [
			`@media (max-width: ${NARROW_MAX_PX}px){`,
			// Hide the rail. `hidden` rather than `none` keeps the column in flow so
			// the centre keeps the correct track.
			`.dsh-mobile-rail-frame[data-sidebar-collapsed] > :first-of-type{`,
			"width:0!important;min-width:0!important;overflow:hidden!important;visibility:hidden!important;border-right:none!important}",
			// Ask for the track too: harmless where ignored, and it removes a 1px
			// sliver where the browser does honour it.
			`.dsh-mobile-rail-frame[data-sidebar-collapsed]{`,
			"grid-template-columns:0px minmax(0,1fr) 0px!important}",
			// The tap target that opens the sidebar, above the conversation so the
			// press is caught rather than falling through.
			`.dsh-mobile-rail-frame[data-sidebar-collapsed]::before{`,
			'content:"";position:absolute;top:0;bottom:0;left:0;width:28px;z-index:15}',
			"}",
		].join("");

		/** Inject once; the hmr reload path deletes `<style data-plugin>` tags. */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			const tagId = "dsh-mobile-rail/rail.css";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-mobile-rail";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/**
		 * Find the product's sidebar toggle.
		 *
		 * A control that reports `aria-expanded` is the toggle by definition, so it
		 * wins. Failing that, a name that says so. If neither is present this
		 * returns undefined and the caller does nothing — clicking a guess inside
		 * the sidebar could fire "new session", which is far worse than an inert
		 * edge.
		 * @returns the toggle button, or undefined when it cannot be identified.
		 */
		function sidebarToggle() {
			if (typeof document === "undefined") return undefined;
			const sidebar = document.querySelector(SIDEBAR);
			if (sidebar === null) return undefined;
			const buttons = [...sidebar.querySelectorAll("button")];
			const byState = buttons.find((b) => b.hasAttribute("aria-expanded"));
			if (byState !== undefined) return byState;
			return buttons.find((b) =>
				/expand|collapse|sidebar|toggle|menu/i.test(
					`${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""}`,
				),
			);
		}

		/** True while the rail is collapsed, i.e. while this plugin's CSS applies. */
		function isCollapsed() {
			if (typeof document === "undefined") return false;
			return document.querySelector(FRAME)?.hasAttribute("data-sidebar-collapsed") ?? false;
		}

		/** Ask the product to toggle its own sidebar. */
		function toggleSidebar() {
			const button = sidebarToggle();
			if (button === undefined) return false;
			button.click();
			return true;
		}

		/**
		 * Edge tap opens the sidebar; a press outside it closes it.
		 *
		 * `pointerdown` rather than `click`, so the response is immediate and works
		 * the same for a finger and a mouse. Nothing is hidden or revealed by CSS
		 * here: both gestures delegate to the product's toggle.
		 */
		function installSidebarToggle() {
			if (typeof document === "undefined" || typeof window === "undefined") return () => {};
			const isNarrow = () => window.innerWidth <= NARROW_MAX_PX;

			const onPointerDown = (event) => {
				if (!isNarrow()) return;
				markFrames();

				if (isCollapsed()) {
					// Only the left edge opens it, so a tap in the conversation is
					// never swallowed.
					if (event.clientX <= EDGE_PX) toggleSidebar();
					return;
				}

				// The sidebar is open: a press outside it closes it. Presses inside
				// are left alone so its own controls keep working.
				const sidebar = document.querySelector(SIDEBAR);
				const target = event.target;
				if (sidebar !== null && target instanceof Node && sidebar.contains(target)) return;
				toggleSidebar();
			};

			document.addEventListener("pointerdown", onPointerDown, true);
			window.addEventListener("resize", markFrames);
			return () => {
				document.removeEventListener("pointerdown", onPointerDown, true);
				window.removeEventListener("resize", markFrames);
			};
		}

		/**
		 * Keep the frame marked despite React re-mounts.
		 *
		 * `childList` + `subtree` catches a replaced frame without observing every
		 * attribute in the tree.
		 */
		function installFrameMarker() {
			if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
			markFrames();
			let queued = false;
			const observer = new MutationObserver(() => {
				if (queued) return;
				queued = true;
				requestAnimationFrame(() => {
					queued = false;
					markFrames();
				});
			});
			observer.observe(document.documentElement, { childList: true, subtree: true });
			return () => observer.disconnect();
		}

		const inject = [];

		function apply(ctx) {
			ensureStyles();
			ctx.effect(() => installFrameMarker(), "dsh-mobile-rail: frame marker");
			ctx.effect(() => installSidebarToggle(), "dsh-mobile-rail: edge toggle");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.markFrames = markFrames;
		exports.sidebarToggle = sidebarToggle;
		exports.EDGE_PX = EDGE_PX;
		return module.exports;
	},
});
