/**
 * Reclaim the phone's left edge: auto-hide the collapsed sidebar rail.
 *
 * On a narrow viewport the layout collapses the sidebar to a permanent 56px rail
 * (`dsh-client-ui-layout/lib/client.js:37` — `sidebar === 0` still yields 56px,
 * and the frame writes it as an inline `gridTemplateColumns`), which costs ~13%
 * of a phone's usable width and never goes away.
 *
 * The width is an inline style, so it cannot be overridden by class names or
 * CSS variables — but the frame exposes `data-sidebar-collapsed` (layout:281),
 * set exactly when the 56px rail is in effect. That is the hook:
 *
 *   - hide the rail track (`grid-template-columns: 0px …`) on narrow frames;
 *   - reveal it on demand while the user's pointer/finger hovers the left edge;
 *   - leave the expanded sidebar and all wide viewports completely untouched.
 *
 * Nothing is shadowed, replaced, or removed: this only adds CSS gated on a
 * breakpoint and a data attribute the product already publishes.
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
		 * Below this width the rail hides. Chosen above the 768px breakpoint the
		 * right panel uses (`ui-sidebar-right/lib/client.js:916`) so the two
		 * mobile behaviours switch together, and well below the 1024px
		 * auto-collapse so tablets and desktops keep the normal rail.
		 */
		const NARROW_MAX_PX = 768;

		/**
		 * The frame element, identified WITHOUT a hashed class name.
		 *
		 * `pI_x6G_frame` is build-generated and would break on any rebuild, so the
		 * frame is addressed by structure instead: it is the element that is a
		 * grid, carries the layout's own `data-*` state, and is not our own markup.
		 * (`:has()` is avoided for older mobile Safari.)
		 */
		const FRAME = '.dsh-mobile-rail-frame';

		/**
		 * Mark the frame so the stylesheet can address it stably.
		 *
		 * Runs on demand rather than once, because React can re-mount the frame —
		 * a marker applied at plugin load can vanish with it.
		 * @returns the marked frames.
		 */
		function markFrames() {
			if (typeof document === "undefined") return [];
			const marked = [];
			for (const el of document.querySelectorAll('[data-sidebar-collapsed], [data-rightbar-collapsed]')) {
				if (getComputedStyle(el).display !== "grid") continue;
				if (!el.classList.contains("dsh-mobile-rail-frame")) el.classList.add("dsh-mobile-rail-frame");
				marked.push(el);
			}
			return marked;
		}

		/**
		 * Narrow-viewport rules.
		 *
		 * IMPORTANT: `grid-template-columns` cannot be overridden here. On a live
		 * phone, a matching `!important` rule was confirmed by the browser's own
		 * matched-styles API to be winning the cascade, and yet the track still
		 * computed to 56px; a freshly injected identical sheet had no effect
		 * either. Collapsing the sidebar COLUMN works, so that is what these rules
		 * do — and `width:0;overflow:hidden` is used rather than `display:none`,
		 * because removing a grid child outright made the centre column collapse
		 * as well.
		 */
		const css = [
			`@media (max-width: ${NARROW_MAX_PX}px){`,
			// Hide the rail itself. `hidden` rather than `none` keeps it in flow so
			// the centre keeps the correct track.
			`.dsh-mobile-rail-frame[data-sidebar-collapsed]:not([data-rail-revealed]) > :first-of-type{`,
			"width:0!important;min-width:0!important;overflow:hidden!important;visibility:hidden!important;border-right:none!important}",
			// Ask for the track too: harmless where it is ignored, and it removes a
			// 1px sliver where the browser does honour it.
			`.dsh-mobile-rail-frame[data-sidebar-collapsed]:not([data-rail-revealed]){`,
			"grid-template-columns:0px minmax(0,1fr) 0px!important}",
			// A slim edge target that reopens the rail, narrow enough not to steal
			// taps from the conversation underneath.
			`.dsh-mobile-rail-frame[data-sidebar-collapsed]:not([data-rail-revealed])::before{`,
			'content:"";position:absolute;top:0;bottom:0;left:0;width:28px;z-index:15}',
			// While the rail is open, the same overlay covers it, so the pointer
			// stays "on" the rail and a drag does not fall through to the
			// conversation underneath.
			`.dsh-mobile-rail-frame[data-sidebar-collapsed][data-rail-revealed]::before{`,
			'content:"";position:absolute;top:0;bottom:0;left:0;width:80px;z-index:15}',
			// The rail itself must sit above that overlay to stay tappable.
			`.dsh-mobile-rail-frame[data-sidebar-collapsed][data-rail-revealed] > :first-of-type{`,
			"position:relative;z-index:16}",
			// Revealed: rail back in flow, at its normal width.
			`.dsh-mobile-rail-frame[data-sidebar-collapsed][data-rail-revealed] > :first-of-type{`,
			"width:56px!important;min-width:56px!important;overflow:visible!important;visibility:visible!important;",
			"border-right:.5px solid var(--dsw-alias-border-l3)!important}",
			`.dsh-mobile-rail-frame[data-sidebar-collapsed][data-rail-revealed]{`,
			"grid-template-columns:56px minmax(0,1fr) 0px!important}",
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
		 * Touch devices have no hover, so the CSS reveal cannot fire. Mark the
		 * frame on a touch near the left edge and hide it again on a timer.
		 *
		 * The timer is the important part: an earlier version hid the rail on
		 * every `touchend`, so lifting the finger at the end of the opening swipe
		 * collapsed it instantly.
		 */
		function installTouchReveal() {
			if (typeof document === "undefined" || typeof window === "undefined") return () => {};
			const isNarrow = () => window.innerWidth <= NARROW_MAX_PX;
			/** Frames currently showing the collapsed rail. */
			const frames = () => document.querySelectorAll("[data-sidebar-collapsed]");
			/**
			 * How long the rail stays open after the finger leaves.
			 *
			 * There is deliberately no timeout while a finger is DOWN: a timer
			 * that fires under a resting finger made the rail snap shut mid-
			 * gesture, which is what made it feel like a spring. `HOLD_MS` only
			 * starts once the finger lifts or leaves the rail.
			 */
			const HOLD_MS = 4000;
			/** Horizontal travel (px) that marks a dismissal swipe rather than a tap. */
			const DISMISS_PX = 90;
			/** Rail width in px; the reveal band follows the rail as it opens. */
			const RAIL_PX = 56;
			/** Grab zone on the closed edge. */
			const EDGE_PX = 28;
			let holdTimer;
			let tracked;
			/** True while a finger is down somewhere over the rail or its edge. */
			let engaged = false;

			const cancelTimer = () => {
				window.clearTimeout(holdTimer);
				holdTimer = undefined;
			};
			/** Begin the countdown that will close the rail. */
			const armTimer = () => {
				cancelTimer();
				holdTimer = window.setTimeout(hide, HOLD_MS);
			};
			const hide = () => {
				cancelTimer();
				tracked = undefined;
				engaged = false;
				for (const frame of frames()) frame.removeAttribute("data-rail-revealed");
			};
			const show = () => {
				for (const frame of frames()) frame.setAttribute("data-rail-revealed", "");
				cancelTimer();
			};

			/**
			 * Is this x inside the interactive band?
			 *
			 * The band grows with the rail: 28px while closed, but the full rail
			 * width once open, so a finger that swiped in stays "on" the rail and
			 * the hold is not cancelled by the rail opening under it.
			 */
			const inBand = (x, open) => x <= (open ? RAIL_PX + 24 : EDGE_PX);

			const onTouchStart = (event) => {
				if (!isNarrow()) return;
				// Re-mark first: a React re-mount can drop the class the rules use.
				markFrames();
				const touch = event.touches?.[0];
				const open = [...frames()].some((f) => f.hasAttribute("data-rail-revealed"));
				if (touch === undefined || !inBand(touch.clientX, open)) {
					// A touch elsewhere means the rail is no longer wanted.
					if (open) hide();
					return;
				}
				tracked = { x: touch.clientX };
				engaged = true;
				show();
			};

			const onTouchMove = (event) => {
				if (tracked === undefined) return;
				const touch = event.touches?.[0];
				if (touch === undefined) return;
				// Swiping right, away from the edge, dismisses the rail.
				if (touch.clientX - tracked.x > DISMISS_PX) {
					hide();
					return;
				}
				// Keep the rail open while the finger stays in the band. This also
				// handles a stationary hold, whose only traffic is touchmove.
				const open = [...frames()].some((f) => f.hasAttribute("data-rail-revealed"));
				if (!inBand(touch.clientX, open)) {
					// Drifted out of the band: fall back to the timer.
					engaged = false;
					armTimer();
					return;
				}
				engaged = true;
				show();
			};

			/**
			 * Lifting the finger starts the countdown rather than closing
			 * immediately, so a control inside the rail can still be tapped.
			 */
			const onTouchEnd = () => {
				tracked = undefined;
				if (!engaged) return;
				engaged = false;
				armTimer();
			};

			document.addEventListener("touchstart", onTouchStart, { passive: true });
			document.addEventListener("touchmove", onTouchMove, { passive: true });
			document.addEventListener("touchend", onTouchEnd, { passive: true });
			document.addEventListener("touchcancel", hide, { passive: true });
			window.addEventListener("blur", hide);
			// A resize can change which rules apply, so re-hide rather than leave a
			// stale reveal attribute behind.
			window.addEventListener("resize", hide);
			return () => {
				document.removeEventListener("touchstart", onTouchStart);
				document.removeEventListener("touchmove", onTouchMove);
				document.removeEventListener("touchend", onTouchEnd);
				document.removeEventListener("touchcancel", hide);
				window.removeEventListener("blur", hide);
				window.removeEventListener("resize", hide);
				hide();
			};
		}

		/**
		 * Keep the frame marked despite React re-mounts.
		 *
		 * The class the stylesheet targets can disappear when the layout
		 * re-mounts, so this watches for the frame and re-applies it. A
		 * `MutationObserver` on the document body is the least invasive way to
		 * do that: `childList` + `subtree` catches replacement without observing
		 * every attribute in the tree.
		 */
		function installFrameMarker() {
			if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
			markFrames();
			let queued = false;
			const observer = new MutationObserver(() => {
				if (queued) return;
				queued = true;
				// Coalesce: React can mutate many nodes in one commit.
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
			ctx.effect(() => installTouchReveal(), "dsh-mobile-rail: edge reveal");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.markFrames = markFrames;
		return module.exports;
	},
});
