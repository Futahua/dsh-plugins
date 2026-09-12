/**
 * Reclaim the phone's left edge, then open the REAL sidebar from it.
 *
 * On a narrow viewport the product collapses the sidebar to a permanent 56px
 * rail (`dsh-client-ui-layout` — `sidebar === 0` still yields 56px, written as
 * an inline `gridTemplateColumns`), which costs ~13% of a phone's usable width
 * and never goes away.
 *
 * Two behaviours, both measured on a Galaxy Note 10+ over ADB/CDP rather than
 * inferred:
 *
 *  1. HIDE the rail. The width is an inline style, so class names and CSS
 *     variables cannot override it — but the frame publishes
 *     `data-sidebar-collapsed` exactly when the 56px rail is in effect, and
 *     collapsing the sidebar COLUMN works where overriding the track does not.
 *
 *  2. OPEN the real sidebar from a left-edge tap. The product's own toggle is
 *     the only thing that knows how to open it: measured identity is
 *     `[data-slot="sidebar"] button[aria-label="Open sidebar"]`, and the label
 *     becomes "Collapse sidebar" once open (the button is swapped, not relabelled
 *     in place). While the rail is hidden that button computes
 *     `visibility:hidden`, so no finger can ever hit-test it — but
 *     `HTMLButtonElement.click()` skips hit-testing entirely and the product's
 *     React handler runs normally. Driving the product's own control is what
 *     makes the full 280px sidebar appear; faking it in CSS produced a strip
 *     that vanished the sidebar instead.
 *
 *  3. COLLAPSE on an outside tap. The product does NOT do this: measured, a real
 *     touch at (300,700) with the sidebar open at 280px left it open. So that
 *     gesture is implemented here.
 *
 *  4. BLANK what is left. With the drawer open the product still lays the
 *     conversation out in the remaining 139px of a 419px viewport, where it is an
 *     unreadable sandwich of squeezed controls. That strip is covered by fading its
 *     content out — the app's own background shows through, so no colour is invented.
 *
 *  5. ANIMATE it. The band glows blue as the finger lands, the drawer slides in and
 *     back out again, and the cover fades with it, so a tap that rearranges the
 *     whole screen has a beginning and an end. All of it runs regardless of
 *     `prefers-reduced-motion`, deliberately — see the note at the end of the sheet.
 *
 * Nothing is shadowed, replaced, or removed from the product.
 *
 * Known trade-off: a scroll gesture that STARTS inside the 24px edge band also
 * opens the sidebar, because a tap cannot be distinguished from a drag until the
 * finger moves and the open has to feel immediate. Same as an iOS edge swipe.
 *
 * Failure mode, stated honestly: if the product renames the toggle label the
 * edge tap does nothing. It will not hide the sidebar — the rail stays hidden
 * and nothing else changes — and the miss is reported once to the console rather
 * than failing silently, which is how the previous attempt shipped broken.
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
		 * Width of the left-edge tap band.
		 *
		 * At the phone's 3.6 device-pixel ratio this is about 6mm — a comfortable
		 * thumb target — and it is the only width taken from the app, since the
		 * rail it replaces was 56px.
		 */
		const EDGE_PX = 24;

		/**
		 * The product's sidebar toggle, matched by accessible name.
		 *
		 * Measured labels are "Open sidebar" (rail hidden) and "Collapse sidebar"
		 * (sidebar open). The pattern accepts the synonyms the product might
		 * switch to, and is anchored so it cannot match "Search sessions" or the
		 * Settings button, which carries `aria-haspopup="dialog"` and a different
		 * name.
		 */
		const TOGGLE_LABEL = /^(open|collapse|close|expand|show|hide)\s+sidebar$/i;

		/** How long a click synthesised from a handled tap stays swallowed. */
		const SWALLOW_MS = 700;

		/** Pointer travel (px) within which a click counts as that same tap. */
		const SAME_TAP_PX = 16;

		/** How long the tap band stays lit before fading out again. */
		const GLOW_MS = 320;

		/**
		 * The drawer's travel time, in and out.
		 *
		 * Shared between the stylesheet animation and the timer that holds the drawer
		 * open long enough to slide out of, so the two cannot drift apart.
		 */
		const RAIL_MS = 240;

		/** How long the squeezed remainder takes to fade away, and to come back. */
		const COVER_MS = 200;

		/**
		 * Width of the glow, twice the tap band so the light has somewhere to fall
		 * off. The app itself is monochrome -- it exposes no accent colour to match
		 * (checked: no blue custom properties, no coloured links) -- so this is a
		 * chosen blue that reads on the `#151517` base, not a borrowed token.
		 */
		const GLOW_PX = 48;

		/**
		 * Root custom property holding the drawer's last known width.
		 *
		 * Set on `documentElement` rather than the frame because the frame's inline
		 * `style` is managed by React. It exists because the closing animation needs
		 * the width the drawer *had*: by the time the collapsed attribute is observed
		 * the width has already computed to 0, and a hard-coded 280px would snap on any
		 * drawer the user has resized.
		 */
		const WIDTH_VAR = "--dsh-rail-w";

		/**
		 * The frame element, identified WITHOUT a hashed class name.
		 *
		 * `pI_x6G_frame` is build-generated and would break on any rebuild, so the
		 * frame is addressed by structure instead: it is the element that is a
		 * grid, carries the layout's own `data-*` state, and is not our own markup.
		 * (`:has()` is avoided for older mobile Safari.)
		 */
		const FRAME = ".dsh-mobile-rail-frame";

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
			for (const el of document.querySelectorAll("[data-sidebar-collapsed], [data-rightbar-collapsed]")) {
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
			// The drawer slides, both ways. The grid track changes in a single commit,
			// so the movement has to be a transform on the column itself. No fill mode:
			// a transform left behind would make the column a containing block for
			// anything fixed-position inside it.
			"@keyframes dsh-mobile-rail-slide-in{from{transform:translateX(-100%)}to{transform:translateX(0)}}",
			"@keyframes dsh-mobile-rail-slide-out{from{transform:translateX(0)}to{transform:translateX(-100%)}}",
			// Visual only. The tap band has no element of its own -- the gesture is read
			// from a capture listener -- so this is what the finger's feedback is drawn
			// on. `pointer-events:none` keeps it out of hit-testing completely, so it can
			// never swallow a tap; z-index 15 puts it above the drawer column and the
			// resize handle (11) but below the overlay layer (20) that holds dialogs.
			".dsh-mobile-rail-glow{",
			`position:fixed;left:0;top:0;bottom:0;width:${GLOW_PX}px;pointer-events:none;z-index:15;`,
			"opacity:0;transition:opacity 200ms ease-out;",
			"background:linear-gradient(90deg,rgba(88,150,255,.55),rgba(88,150,255,.20) 40%,rgba(88,150,255,0))}",
			".dsh-mobile-rail-glow[data-lit]{opacity:1}",
			`@media (max-width: ${NARROW_MAX_PX}px){`,
			// Hide the rail itself. `hidden` rather than `none` keeps it in flow so
			// the centre keeps the correct track.
			`.dsh-mobile-rail-frame[data-sidebar-collapsed] > :first-of-type{`,
			"width:0!important;min-width:0!important;overflow:hidden!important;visibility:hidden!important;border-right:none!important}",
			// Ask for the track too: harmless where it is ignored, and it removes a
			// 1px sliver where the browser does honour it.
			`.dsh-mobile-rail-frame[data-sidebar-collapsed]{`,
			"grid-template-columns:0px minmax(0,1fr) 0px!important}",
			// Closing: hold the drawer at its old width and visible for exactly one
			// animation, or there is nothing left to slide out of -- the rule above
			// would have collapsed it to 0px in the same commit. Two attribute
			// selectors outrank the one above, so this wins with `!important` on both
			// sides. `z-index:16` keeps it over the centre column, which is already
			// back to full width underneath.
			`.dsh-mobile-rail-frame[data-sidebar-collapsed][data-rail-closing] > :first-of-type{`,
			`width:var(${WIDTH_VAR},280px)!important;min-width:var(${WIDTH_VAR},280px)!important;`,
			"overflow:visible!important;visibility:visible!important;position:relative;z-index:16;",
			`animation:dsh-mobile-rail-slide-out ${RAIL_MS}ms cubic-bezier(.4,0,.6,1)}`,
			// The cover fades rather than snapping. The transition is declared on a rule
			// that ALWAYS matches: a transition written only on the state being left
			// disappears along with that state, and the change snaps instead of fading.
			`.dsh-mobile-rail-frame > :nth-child(2) > *{transition:opacity ${COVER_MS}ms ease-out}`,
			// Blanked: `pointer-events:none` so the invisible conversation cannot be
			// scrolled or clicked through the cover.
			`.dsh-mobile-rail-frame:not([data-sidebar-collapsed]) > :nth-child(2) > *{`,
			"opacity:0!important;pointer-events:none!important}",
			// Slide the drawer in as it opens.
			`.dsh-mobile-rail-frame:not([data-sidebar-collapsed]) > :first-of-type{`,
			`animation:dsh-mobile-rail-slide-in ${RAIL_MS}ms cubic-bezier(.22,.72,.24,1)}`,
			"}",
			// NOTE: these effects deliberately do NOT honour
			// `prefers-reduced-motion`, and that is a measured decision rather than an
			// oversight. On the phone this was built for, Android's
			// `animator_duration_scale`, `transition_animation_scale` and
			// `window_animation_scale` are all `0.0`, so Chrome reports
			// `prefers-reduced-motion: reduce` -- a speed preference set in Developer
			// options, not a statement about motion sensitivity -- and honouring it
			// meant the animation that was explicitly asked for could never be seen.
			// Restoring `@media (prefers-reduced-motion: reduce){...}` with
			// `animation:none` and `transition:none` is all it takes to reverse this.
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
		 * The live frame element, or null.
		 *
		 * Re-marked on every read: a tap handler that trusts a class applied at
		 * load time stops working the first time React re-mounts the frame.
		 * @returns {Element|null} the frame.
		 */
		function frame() {
			if (typeof document === "undefined") return null;
			if (document.querySelector(FRAME) === null) markFrames();
			return document.querySelector(FRAME);
		}

		/**
		 * The product's own sidebar toggle.
		 *
		 * Searched for by accessible name inside the sidebar slot first, because
		 * the slot is where it was measured to live; the document-wide pass only
		 * covers a future move of the control. A hidden button is deliberately
		 * accepted: `click()` does not hit-test, and when the rail is hidden the
		 * toggle is always hidden.
		 * @returns {HTMLButtonElement|null} the toggle.
		 */
		function findToggle() {
			if (typeof document === "undefined") return null;
			const roots = [document.querySelector('[data-slot="sidebar"]'), document];
			for (const root of roots) {
				if (root === null || root === undefined) continue;
				for (const button of root.querySelectorAll("button[aria-label]")) {
					const label = button.getAttribute("aria-label") ?? "";
					if (TOGGLE_LABEL.test(label)) return button;
				}
			}
			return null;
		}

		/**
		 * The element the tap band's glow is drawn on.
		 *
		 * Injected into `body` rather than the frame on purpose: the frame is a grid,
		 * so a new child would become a grid item and could disturb the tracks that
		 * this plugin is careful not to fight. `position:fixed` escapes the layout
		 * entirely, and the stylesheet gives it `pointer-events:none` so it can never
		 * swallow a tap.
		 * @returns {Element|null} the glow element.
		 */
		function ensureGlow() {
			if (typeof document === "undefined") return null;
			const existing = document.querySelector(".dsh-mobile-rail-glow");
			if (existing !== null) return existing;
			if (document.body === null || document.body === undefined) return null;
			const glow = document.createElement("div");
			glow.className = "dsh-mobile-rail-glow";
			document.body.appendChild(glow);
			return glow;
		}

		/**
		 * Edge tap and outside tap, driven from a capture listener rather than an
		 * injected overlay element.
		 *
		 * An overlay was the obvious design and was rejected on purpose: a
		 * `position:fixed` element needs a z-index high enough to beat the app, has
		 * to be kept in sync with the frame's state, and is one more thing React
		 * can tear out from under us. A capture-phase `pointerdown` reads the
		 * frame's real attributes at the moment of the tap, so it cannot drift —
		 * and `stopPropagation` keeps the tap from reaching the app underneath.
		 */
		function installEdgeTaps() {
			if (typeof document === "undefined" || typeof window === "undefined") return () => {};
			const isNarrow = () => window.innerWidth <= NARROW_MAX_PX;
			/** Coordinates and deadline of the tap we already handled. */
			let handled;
			/** True only while we are dispatching the toggle's own activation. */
			let programmatic = false;
			let reported = false;
			let glowTimer;

			/**
			 * Light the band, then let it fade out on its own.
			 *
			 * Called only when a tap is actually acted on, so the glow never promises
			 * something that did not happen.
			 */
			const lightGlow = () => {
				const glow = ensureGlow();
				if (glow === null) return;
				glow.setAttribute("data-lit", "");
				window.clearTimeout(glowTimer);
				glowTimer = window.setTimeout(() => glow.removeAttribute("data-lit"), GLOW_MS);
			};

			/**
			 * The x of the sidebar's right edge, or null when it is not showing.
			 *
			 * The sidebar slot itself has `display:contents`, so its own rect is
			 * 0x0 even while the sidebar is open; the column that actually carries
			 * the width is the frame's first grid child.
			 */
			const openEdge = (el) => {
				if (el.hasAttribute("data-sidebar-collapsed")) return null;
				const column = el.firstElementChild;
				if (column === null) return null;
				const rect = column.getBoundingClientRect();
				return rect.width > 0 ? rect.right : null;
			};

			const onPointerDown = (event) => {
				if (!isNarrow()) return;
				// Only the primary button ever opens or closes a sidebar.
				if (event.pointerType === "mouse" && event.button !== 0) return;
				const el = frame();
				if (el === null) return;
				const edge = openEdge(el);
				// Rail hidden means this can only be the band opening the drawer, which
				// is the gesture the glow belongs to; with the drawer already open the
				// tap lands on the blanked remainder and closes it instead.
				const opening = edge === null;
				const wanted = opening
					? event.clientX <= EDGE_PX
					: event.clientX > edge;
				if (!wanted) return;
				const toggle = findToggle();
				if (toggle === null) {
					// Never fail silently: silence is what made the last attempt
					// look like it worked while the sidebar was unreachable.
					if (!reported) {
						reported = true;
						console.warn(
							"[dsh-mobile-rail] no sidebar toggle found; edge tap does nothing. " +
								"Expected a button labelled \"Open sidebar\" in [data-slot=\"sidebar\"].",
						);
					}
					return;
				}
				// Own the gesture: the app must not also see this tap.
				event.preventDefault();
				event.stopPropagation();
				handled = { x: event.clientX, y: event.clientY, until: Date.now() + SWALLOW_MS };
				// Feedback first, so the band lights the instant the finger lands.
				if (opening) lightGlow();
				// ...except the activation we are about to synthesise. `click()`
				// dispatches a MouseEvent at (0,0), which is within SAME_TAP_PX of a
				// tap in the top-left corner -- the guard below would then cancel the
				// toggle's own click and the drawer would refuse to open from the one
				// spot a thumb reaches most easily.
				programmatic = true;
				try {
					toggle.click();
				} finally {
					programmatic = false;
				}
			};

			/**
			 * Swallow the click that a mouse press synthesises after `pointerdown`.
			 *
			 * For a touch pointer, cancelling `pointerdown` already suppresses the
			 * compatibility click; for a mouse it does not, and that click would
			 * land on whatever the just-opened sidebar happens to show under the
			 * cursor — the edge of the session list, typically.
			 */
			const onClickCapture = (event) => {
				if (programmatic) return;
				if (handled === undefined) return;
				if (Date.now() > handled.until) {
					handled = undefined;
					return;
				}
				if (Math.abs(event.clientX - handled.x) > SAME_TAP_PX) return;
				if (Math.abs(event.clientY - handled.y) > SAME_TAP_PX) return;
				handled = undefined;
				event.preventDefault();
				event.stopPropagation();
			};

			document.addEventListener("pointerdown", onPointerDown, true);
			document.addEventListener("click", onClickCapture, true);
			return () => {
				document.removeEventListener("pointerdown", onPointerDown, true);
				document.removeEventListener("click", onClickCapture, true);
				window.clearTimeout(glowTimer);
				// Leave nothing behind on unload or hot reload.
				const glow = document.querySelector(".dsh-mobile-rail-glow");
				if (glow !== null && glow.parentNode) glow.parentNode.removeChild(glow);
			};
		}

		/**
		 * Remember the drawer's width while it is open.
		 *
		 * The closing animation needs the width the drawer *had*: by the time the
		 * collapsed attribute can be observed, the stylesheet has already computed it
		 * to 0, and measuring then would always yield nothing.
		 * @param el the frame.
		 */
		function rememberWidth(el) {
			if (typeof document === "undefined") return;
			const column = el.firstElementChild;
			if (column === null) return;
			const width = Math.round(column.getBoundingClientRect().width);
			if (width > 0) document.documentElement.style.setProperty(WIDTH_VAR, `${width}px`);
		}

		/**
		 * Keep the frame marked, and give a closing drawer something to slide out of.
		 *
		 * The class the stylesheet targets can disappear when the layout re-mounts, so
		 * this watches for the frame and re-applies it. A `MutationObserver` on the
		 * document body is the least invasive way to do that: `childList` + `subtree`
		 * catches replacement without observing every attribute in the tree.
		 *
		 * The same pass watches the frame's own `data-sidebar-collapsed`, because
		 * closing needs one extra step: the collapsed rules hide the drawer in the same
		 * commit that the attribute appears, so without holding it open for the length
		 * of the animation there would be nothing to slide out.
		 */
		function installFrameWatch() {
			if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
			markFrames();

			/** The frame whose collapsed state is being watched. */
			let watched = null;
			let collapseObserver = null;
			let closingTimer;
			/** The frame currently held open for its closing animation. */
			let closingOn = null;

			/** Watch one frame's collapsed state, moving on when React replaces it. */
			const watchCollapse = (el) => {
				if (el === watched) return;
				collapseObserver?.disconnect();
				watched = el;
				if (el === null) return;
				collapseObserver = new MutationObserver(() => {
					if (el.hasAttribute("data-sidebar-collapsed")) {
						// Closing. Hold it open for exactly one animation.
						el.setAttribute("data-rail-closing", "");
						closingOn = el;
						window.clearTimeout(closingTimer);
						closingTimer = window.setTimeout(() => {
							el.removeAttribute("data-rail-closing");
							if (closingOn === el) closingOn = null;
						}, RAIL_MS);
					} else {
						// Opening again: cancel any hold, and record the width to come back to.
						window.clearTimeout(closingTimer);
						el.removeAttribute("data-rail-closing");
						closingOn = null;
						rememberWidth(el);
					}
				});
				collapseObserver.observe(el, { attributes: true, attributeFilter: ["data-sidebar-collapsed"] });
			};

			let queued = false;
			const observer = new MutationObserver(() => {
				if (queued) return;
				queued = true;
				// Coalesce: React can mutate many nodes in one commit.
				requestAnimationFrame(() => {
					queued = false;
					markFrames();
					const el = frame();
					watchCollapse(el);
					// An install that lands while the drawer is already open still needs a
					// width to close with.
					if (el !== null && !el.hasAttribute("data-sidebar-collapsed")) rememberWidth(el);
				});
			});
			observer.observe(document.documentElement, { childList: true, subtree: true });
			watchCollapse(frame());
			return () => {
				observer.disconnect();
				collapseObserver?.disconnect();
				window.clearTimeout(closingTimer);
				closingOn?.removeAttribute("data-rail-closing");
			};
		}

		/**
		 * Build marker, so a live page can be checked against the source.
		 *
		 * HMR was already mistaken once for a broken fix after a screenshot
		 * predated the swap; a version on the window makes "is the new bundle
		 * running?" a measurement instead of an assumption. Bumped whenever the
		 * behaviour changes, so a stale bundle is detectable rather than plausible.
		 */
		const VERSION = 6;

		const inject = [];

		function apply(ctx) {
			ensureStyles();
			if (typeof window !== "undefined") window.__dshMobileRail = { version: VERSION, edgePx: EDGE_PX };
			ctx.effect(() => installFrameWatch(), "dsh-mobile-rail: frame watch");
			ctx.effect(() => installEdgeTaps(), "dsh-mobile-rail: edge taps");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.markFrames = markFrames;
		exports.findToggle = findToggle;
		return module.exports;
	},
});
