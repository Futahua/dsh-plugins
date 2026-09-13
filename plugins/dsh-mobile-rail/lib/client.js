/**
 * Give a touch device its screen back: two invisible bands, two real panels, and a
 * shell that stays above the keyboard.
 *
 * The two halves are independent and fail independently:
 *
 *   1. EDGES (a phone). Both the sidebar rail and the browser-agent pane are replaced
 *      by invisible edge bands that open the real panels.
 *   2. KEYBOARD (an iPad or iPhone). iPadOS and iOS shrink only the *visual* viewport
 *      for the on-screen keyboard, so a shell sized in percentages ends up with its
 *      composer behind the keyboard. While a text field has focus the shell is pinned
 *      to the visual viewport instead. Android and desktop already resize the layout
 *      viewport, so this half does nothing there.
 *
 * Left edge — the sidebar drawer, which the product collapses to a permanent 56px
 * rail on a narrow viewport (`dsh-client-ui-layout` writes an inline
 * `gridTemplateColumns`, so the track cannot be overridden; sizing the column can).
 *
 * Right edge — the live browser pane from `@try-works/dsh-browser-agent`, which is
 * built as a desktop side panel: a 520px column that reserves its width by setting
 * `body.margin-right`. On a 419px phone that leaves the GUI **0px** wide, which is
 * what made the app look hung, and its collapsed state is a 34px full-height strip.
 *
 * Both edges get the same treatment here: nothing visible while closed, an
 * invisible band you can press (the band highlights under the finger), and a click
 * that flashes the band and slides the real panel in.
 *
 * While a text field has focus both bands stand down completely, because the tap
 * that leaves the keyboard is a tap on those same bands: it has to reach the app to
 * blur the field, so nothing is claimed, not even `stopPropagation`.
 *
 * This plugin owns the whole of that behaviour, which is deliberate: an earlier
 * revision patched the browser-agent package inside `node_modules` instead, and
 * every one of those patches would have been erased by the next `npm install`.
 * Nothing outside this directory is modified now.
 *
 * Measured on the phone rather than assumed:
 *   - the sidebar toggle is `[data-slot="sidebar"] button[aria-label="Open sidebar"]`,
 *     relabelled `Collapse sidebar` when open (a different button, not a relabel);
 *   - the pane toggle is `aria-label="Expand browser pane"` / `"Collapse browser pane"`;
 *   - the pane publishes `data-dsh-browser-pane="collapsed" | "expanded"`;
 *   - the centre column paints no background, so blanking it reveals the frame's.
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
		 * Below this width the phone behaviour applies. Chosen above the 768px
		 * breakpoint the right panel uses so the two switch together, and below the
		 * 1024px sidebar auto-collapse so tablets keep their normal rails.
		 */
		const NARROW_MAX_PX = 768;

		/** Width of an edge band: about 6mm at the phone's 3.6 device-pixel ratio. */
		const EDGE_PX = 24;

		/**
		 * Width of the glow, twice the band so the light has somewhere to fall off.
		 *
		 * The app is monochrome — it exposes no accent colour to match (checked: no
		 * blue custom properties, no coloured links) — so this is a chosen blue that
		 * reads on the `#151517` base, not a borrowed token.
		 */
		const GLOW_PX = 48;

		/** How long the flash stays at full brightness before it starts fading. */
		const FLASH_MS = 130;

		/**
		 * Movement (px) that turns a press into a drag.
		 *
		 * A press that travels further than this never activates, so a brush past the
		 * edge or a scroll that clips it cannot open anything.
		 */
		const TAP_SLOP_PX = 12;

		/** How long a click synthesised from a handled gesture stays swallowed. */
		const SWALLOW_MS = 700;

		/** Pointer travel (px) within which a click counts as that same gesture. */
		const SAME_TAP_PX = 16;

		/** The slide-in duration, shared with the stylesheet so the two cannot drift. */
		const RAIL_MS = 240;

		/**
		 * How much the visual viewport must shrink before it is treated as a keyboard.
		 *
		 * A software keyboard is a few hundred pixels; Safari's own collapsing toolbars
		 * are tens. 120px sits between the two with room on both sides — the smallest
		 * phone keyboard is ~216px, and the largest toolbar change measured is ~60px.
		 */
		const MIN_KEYBOARD_PX = 120;

		/**
		 * Zoom tolerance for the keyboard check.
		 *
		 * `visualViewport.scale` is 1 with no zoom, and floating-point noise can make it
		 * 1.0000001. A pinch zoom shrinks the visual viewport exactly like a keyboard
		 * does, and pinning the shell mid-zoom would be actively wrong.
		 */
		const SCALE_TOLERANCE = 1.01;

		/** The root attribute and custom properties the keyboard fix owns. */
		const KEYBOARD_FLAG = "data-dsh-keyboard";
		const KEYBOARD_HEIGHT_VAR = "--dsh-keyboard-height";
		const KEYBOARD_TOP_VAR = "--dsh-keyboard-top";

		/**
		 * Input types that are not text entry.
		 *
		 * A focused checkbox is not typing, and the bands must keep working around one.
		 */
		const NON_TEXT_INPUTS = new Set([
			"button", "checkbox", "color", "file", "hidden", "image",
			"radio", "range", "reset", "submit",
		]);

		/**
		 * The two edges, as data.
		 *
		 * Everything else in this file is one implementation driven by these.
		 */
		const EDGES = [
			{
				id: "sidebar",
				side: "left",
				/** Both labels the product swaps between. */
				label: /^(open|collapse|close|expand|show|hide)\s+sidebar$/i,
				/**
				 * Is the drawer absent?
				 *
				 * `data-sidebar-collapsed` is published exactly while the 56px rail is
				 * in effect, which is the only state in which the band means anything.
				 */
				closed: (frame) => frame === null || frame.hasAttribute("data-sidebar-collapsed"),
			},
			{
				id: "browser pane",
				side: "right",
				/** The pane's own toggle, named for what it will do next. */
				label: /^(expand|collapse)\s+browser pane$/i,
				/** The pane renders nothing at all while collapsed. */
				closed: () => document.querySelector('[data-dsh-browser-pane="expanded"]') === null,
			},
		];

		const SIDEBAR = EDGES[0];
		const PANE = EDGES[1];

		/** Shared gesture state. */
		let handled;
		let programmatic = false;
		let flashTimer;
		/** pointerId -> { x0, y0, x, y, armed }, for every pointer currently down. */
		const active = new Map();
		/** Edges already warned about, so a miss is reported once, not per tap. */
		const reported = new Set();
		/** The glow element per edge, created on demand. */
		const glows = new Map();

		const isNarrow = () => window.innerWidth <= NARROW_MAX_PX;

		/* ------------------------------------------------------------------ frame */

		/**
		 * The frame element, identified WITHOUT a hashed class name.
		 *
		 * `pI_x6G_frame` is build-generated and would break on any rebuild, so the
		 * frame is addressed by structure instead: it is the element that is a grid
		 * and carries the layout's own `data-*` state.
		 */
		const FRAME_CLASS = "dsh-mobile-rail-frame";

		/**
		 * Mark the frame so the stylesheet can address it stably.
		 *
		 * Runs on demand rather than once, because React can re-mount the frame — a
		 * marker applied at plugin load can vanish with it.
		 */
		function markFrames() {
			if (typeof document === "undefined") return [];
			const marked = [];
			for (const el of document.querySelectorAll("[data-sidebar-collapsed], [data-rightbar-collapsed]")) {
				if (getComputedStyle(el).display !== "grid") continue;
				if (!el.classList.contains(FRAME_CLASS)) el.classList.add(FRAME_CLASS);
				marked.push(el);
			}
			return marked;
		}

		/** The live frame element, re-marked if React replaced it. */
		function frame() {
			if (typeof document === "undefined") return null;
			if (document.querySelector(`.${FRAME_CLASS}`) === null) markFrames();
			return document.querySelector(`.${FRAME_CLASS}`);
		}

		/* ------------------------------------------------------------------- glow */

		/**
		 * The glow element for one edge.
		 *
		 * Injected into `body` rather than the frame on purpose: the frame is a grid,
		 * so a new child would become a grid item and could disturb the tracks this
		 * plugin is careful not to fight. `position:fixed` escapes the layout, and the
		 * stylesheet gives it `pointer-events:none` so it can never swallow a tap.
		 *
		 * It holds two layers — the held highlight and the release flash — because a
		 * band is a button and those two states have to be able to overlap.
		 */
		function ensureGlow(edge) {
			if (typeof document === "undefined") return null;
			const existing = glows.get(edge);
			if (existing !== undefined && existing.parentNode) return existing;
			if (document.body === null || document.body === undefined) return null;
			const glow = document.createElement("div");
			glow.className = "dsh-mobile-glow";
			glow.setAttribute("data-edge", edge.side);
			for (const layer of ["dsh-mobile-glow-hold", "dsh-mobile-glow-flash"]) {
				const el = document.createElement("div");
				el.className = layer;
				glow.appendChild(el);
			}
			document.body.appendChild(glow);
			glows.set(edge, glow);
			return glow;
		}

		/** Highlight exactly one edge, or none. */
		function hold(edge) {
			for (const each of EDGES) {
				const glow = ensureGlow(each);
				if (glow === null) continue;
				if (each === edge) glow.setAttribute("data-held", "");
				else glow.removeAttribute("data-held");
			}
		}

		/** Flash one edge: instant on, then fading on its own. */
		function flash(edge) {
			const glow = ensureGlow(edge);
			if (glow === null) return;
			glow.setAttribute("data-lit", "");
			window.clearTimeout(flashTimer);
			flashTimer = window.setTimeout(() => glow.removeAttribute("data-lit"), FLASH_MS);
		}

		/* --------------------------------------------------------------- geometry */

		/**
		 * Is this x inside the edge's band?
		 *
		 * The bands sit at opposite ends of the viewport, so a point can only ever be
		 * in one of them.
		 */
		function bandHit(edge, x) {
			if (edge === SIDEBAR) return x <= EDGE_PX;
			return x >= window.innerWidth - EDGE_PX;
		}

		/**
		 * Is the user typing?
		 *
		 * On a phone the on-screen keyboard is up whenever a text field holds focus, and
		 * the natural way to leave it is to tap the empty band beside the composer. That
		 * tap has to reach the app -- blurring the field is what dismisses the keyboard --
		 * so while a text field is focused both bands stand down completely: no
		 * highlight, no activation, and no `stopPropagation` to swallow the tap.
		 *
		 * Read per gesture rather than tracked with focus listeners: the answer is only
		 * ever wanted at the moment a finger lands, and a listener can be missed (the
		 * field can lose focus without a blur event reaching this document).
		 */
		function isTyping() {
			if (typeof document === "undefined") return false;
			const el = document.activeElement;
			if (el === null || el === undefined || el === document.body) return false;
			if (el.tagName === "TEXTAREA") return true;
			if (el.tagName === "INPUT") {
				return !NON_TEXT_INPUTS.has((el.getAttribute("type") ?? "text").toLowerCase());
			}
			// The composer is a Lexical contenteditable div rather than a textarea --
			// `<div contentEditable role="textbox" aria-multiline data-composer-input>`,
			// from `ComposerContentEditable` in @deepseek-ai/dsh-client-ui-conversation.
			// `isContentEditable` is the authority, because it is true only while the
			// editor is actually editable; the app's own `data-composer-input` flag then
			// names the element outright. Deliberately NOT a bare `[role="textbox"]`
			// match: a session-less composer renders the same DOM inert, and an inert
			// composer holding focus must not disable the bands.
			if (el.isContentEditable === true) return true;
			return typeof el.closest === "function" &&
				el.closest('[data-composer-input][contenteditable="true"], [role="textbox"][contenteditable="true"]') !== null;
		}

		/**
		 * The tallest layout viewport seen while no text field had focus.
		 *
		 * Android resizes the LAYOUT viewport for the keyboard — unlike iOS — so the only
		 * way to tell "the keyboard took 300px" from "the phone is in landscape" is to
		 * remember what the viewport measured before the keyboard appeared. Seeded at
		 * install, when a keyboard cannot be up (showing one needs a user gesture), and
		 * refreshed whenever the window resizes and nothing is focused.
		 */
		let viewportBaseline = null;

		/** Remember the keyboard-free viewport height. */
		function rememberViewport() {
			if (viewportBaseline === null || !isTyping()) viewportBaseline = Math.round(window.innerHeight);
		}

		/**
		 * Is the on-screen keyboard covering part of the window?
		 *
		 * Both signals are checked because platforms differ, and the measurement that
		 * settled it came from the phone this was built for: with the software keyboard
		 * up, that Android Chrome reported `innerHeight 747` and
		 * `visualViewport.height 413` — the visual viewport shrinking, exactly as iOS
		 * does. The layout-viewport signal covers the other configuration
		 * (`interactive-widget=resizes-content`, where both shrink together and the gap
		 * is zero), and the baseline covers a layout shrink that arrives before any
		 * comparable measurement.
		 */
		function keyboardUp() {
			const vv = window.visualViewport ?? null;
			if (vv !== null && window.innerHeight - vv.height >= MIN_KEYBOARD_PX) return true;
			return viewportBaseline !== null && viewportBaseline - window.innerHeight >= MIN_KEYBOARD_PX;
		}

		/**
		 * Should the edge bands stand down?
		 *
		 * Only while a text field is focused AND the keyboard is really up, because the
		 * tap that leaves the keyboard is a tap on a band. Focus alone is not enough: the
		 * app focuses the composer as soon as a session loads — measured, with the visual
		 * viewport still at its full 747px — and standing down then would cost a tap for
		 * nothing.
		 */
		function keyboardCovering() {
			return isTyping() && keyboardUp();
		}

		/**
		 * Selector for anything the user can actually press.
		 *
		 * A band exists to claim *empty* edge space. When a real control sits in that
		 * space the control wins — and two do: the right sidebar's toggle lives in the
		 * top-right corner, and the composer's own buttons sit at the bottom of the same
		 * edges. Deferring to the app costs one `closest` call at press time and needs no
		 * list of labels to keep up to date, which is what makes it survive a rename.
		 */
		const INTERACTIVE = [
			"button",
			"a[href]",
			"input",
			"select",
			"textarea",
			"summary",
			"label",
			'[role="button"]',
			'[role="link"]',
			'[role="tab"]',
			'[role="menuitem"]',
			'[contenteditable="true"]',
		].join(",");

		/**
		 * Is this gesture landing on something the app owns?
		 *
		 * Read from the event's own target, which the browser has already hit-tested: the
		 * glow elements are `pointer-events:none`, so they can never be it.
		 *
		 * @param event the gesture.
		 * @returns whether a control is under it.
		 */
		function onControl(event) {
			const target = event.target;
			if (target === null || target === undefined) return false;
			if (typeof target.closest !== "function") return false;
			return target.closest(INTERACTIVE) !== null;
		}

		/**
		 * Should this band respond at all?
		 *
		 * Only while its own panel is closed, and never under the keyboard.
		 */
		function bandLive(edge) {
			if (!isNarrow() || keyboardCovering()) return false;
			return edge.closed(frame());
		}

		/**
		 * The x that separates an open panel from the rest of the screen, or null.
		 *
		 * For the sidebar this is the column that actually carries the width: the
		 * `[data-slot="sidebar"]` wrapper is `display:contents` and measures 0x0 in
		 * every state, so measuring it instead reports 0 and looks like a broken
		 * plugin. For the pane it is the panel's own left edge.
		 */
		function openBoundary(edge, el) {
			if (edge === SIDEBAR) {
				if (edge.closed(el)) return null;
				const column = el.firstElementChild;
				if (column === null) return null;
				const rect = column.getBoundingClientRect();
				return rect.width > 0 ? rect.right : null;
			}
			const panel = document.querySelector('[data-dsh-browser-pane="expanded"]');
			if (panel === null) return null;
			const rect = panel.getBoundingClientRect();
			return rect.width > 0 ? rect.left : null;
		}

		/** Is this x beyond an open panel, i.e. a tap meant to dismiss it? */
		function isOutside(edge, x, boundary) {
			return edge === SIDEBAR ? x > boundary : x < boundary;
		}

		/**
		 * The product's own control for this edge.
		 *
		 * Matched by accessible name. A hidden control is deliberately accepted:
		 * `click()` does not hit-test, and both of these are hidden exactly when this
		 * plugin needs them — the sidebar toggle is `visibility:hidden` behind the
		 * hidden rail, and the pane's collapsed rail is `display:none` on a phone.
		 */
		function findToggle(edge) {
			if (typeof document === "undefined") return null;
			const scope = edge === SIDEBAR ? document.querySelector('[data-slot="sidebar"]') : null;
			for (const root of [scope, document]) {
				if (root === null || root === undefined) continue;
				for (const button of root.querySelectorAll("button[aria-label]")) {
					if (edge.label.test(button.getAttribute("aria-label") ?? "")) return button;
				}
			}
			return null;
		}

		/* ------------------------------------------------------------------ drive */

		/**
		 * Drive the product's own control for an edge.
		 *
		 * @param edge which edge.
		 * @param options.lit flash the band (true for a tap on the band itself).
		 * @param options.event the gesture to own, when there is one.
		 * @returns whether a control was found.
		 */
		function drive(edge, { lit = false, event = null } = {}) {
			const toggle = findToggle(edge);
			if (toggle === null) {
				// Never fail silently: silence is what made an earlier attempt look like
				// it worked while the sidebar was unreachable.
				if (!reported.has(edge.id)) {
					reported.add(edge.id);
					console.warn(
						`[dsh-mobile-rail] no "${edge.id}" control found; that edge band does nothing. ` +
							`Expected a button matching ${edge.label}.`,
					);
				}
				return false;
			}
			if (event !== null) {
				// Own the gesture: the app must not also see this tap.
				event.preventDefault();
				event.stopPropagation();
				handled = { x: event.clientX, y: event.clientY, until: Date.now() + SWALLOW_MS };
				if (lit) flash(edge);
			}
			// `click()` dispatches a MouseEvent at (0,0), which is within SAME_TAP_PX of a
			// tap in a top corner -- the guard below would then cancel the control's own
			// click, and the panel would refuse to open from the spot a thumb reaches
			// most easily. Hence the flag.
			programmatic = true;
			try {
				toggle.click();
			} finally {
				programmatic = false;
			}
			return true;
		}

		/* --------------------------------------------------------------- gestures */

		/**
		 * Both edges, from capture listeners rather than injected overlay elements.
		 *
		 * An overlay was the obvious design and was rejected on purpose: a
		 * `position:fixed` element needs a z-index high enough to beat the app, has to
		 * be kept in sync with both panels' state, and is one more thing React can tear
		 * out from under us. Capture-phase listeners read the real attributes at the
		 * moment of the gesture, so they cannot drift.
		 *
		 * A band is treated as a button, which means separating three things:
		 *   - the **highlight** follows any finger inside a band, however it got there,
		 *     so a thumb brushing past lights it up;
		 *   - the **flash** belongs to the click;
		 *   - **opening** happens on release, and only for a press that started inside
		 *     the band and never travelled — so a brush, a scroll that clips the edge,
		 *     or a drag never opens anything.
		 */
		function installEdgeTaps() {
			if (typeof document === "undefined" || typeof window === "undefined") return () => {};

			/** Light the band under any pointer that is inside one. */
			const syncHeld = () => {
				let lit = null;
				for (const at of active.values()) {
					for (const edge of EDGES) {
						if (bandHit(edge, at.x) && bandLive(edge)) lit = edge;
					}
				}
				hold(lit);
			};

			const onPointerDown = (event) => {
				if (!isNarrow()) return;
				// Only the primary button ever opens or closes a panel.
				if (event.pointerType === "mouse" && event.button !== 0) return;
				// Under the keyboard: the tap belongs to the app. Return before anything is
				// claimed -- not even `stopPropagation` -- so the field blurs and the
				// keyboard goes.
				if (keyboardCovering()) return;
				const el = frame();

				// 1. Something is open and this tap is beside it: close it, at once. A
				// control under the tap does not change this — that tap is aimed at the
				// panel, which floats over whatever sits beneath it.
				for (const edge of EDGES) {
					const boundary = openBoundary(edge, el);
					if (boundary === null || !isOutside(edge, event.clientX, boundary)) continue;
					event.stopPropagation();
					drive(edge, { event });
					return;
				}

				// 2. Everything is closed: a press inside a band is a press on a button —
				// unless a real control is under it. The right sidebar's toggle sits in the
				// top-right corner and the composer's buttons line the bottom of both edges,
				// and those belong to the app. Such a press is tracked like any other, so it
				// can still light a band by wandering into one, but starting on a control can
				// never open a panel.
				if (!onControl(event)) {
					for (const edge of EDGES) {
						if (!bandHit(edge, event.clientX) || !bandLive(edge)) continue;
						active.set(event.pointerId, {
							x0: event.clientX,
							y0: event.clientY,
							x: event.clientX,
							y: event.clientY,
							armed: true,
						});
						syncHeld();
						// Own the press, but do NOT preventDefault: the browser still needs to be
						// free to decide that this is a scroll, which is what cancels a press that
						// started on a band and then travelled.
						event.stopPropagation();
						return;
					}
				}

				// 3. Anywhere else: still tracked, so a finger that wanders into a band
				// lights it up without being able to open anything.
				active.set(event.pointerId, {
					x0: event.clientX,
					y0: event.clientY,
					x: event.clientX,
					y: event.clientY,
					armed: false,
				});
			};

			const onPointerMove = (event) => {
				const at = active.get(event.pointerId);
				if (at === undefined) return;
				at.x = event.clientX;
				at.y = event.clientY;
				syncHeld();
			};

			/**
			 * Release: a tap opens the panel, anything else only puts the highlight out.
			 *
			 * The movement test is what keeps a brush from opening anything. It is
			 * measured from where the press landed, so a thumb sweeping across the edge
			 * mid-scroll disarms itself.
			 */
			const onPointerUp = (event) => {
				const at = active.get(event.pointerId);
				active.delete(event.pointerId);
				syncHeld();
				if (at === undefined || at.armed !== true) return;
				if (Math.abs(event.clientX - at.x0) > TAP_SLOP_PX) return;
				if (Math.abs(event.clientY - at.y0) > TAP_SLOP_PX) return;
				// The panel may have opened by other means during the press.
				const edge = EDGES.find((each) => bandHit(each, at.x0)) ?? null;
				if (edge === null || !bandLive(edge)) return;
				drive(edge, { lit: true, event });
			};

			/** The browser took the gesture for a scroll: highlight out, nothing armed. */
			const onPointerCancel = (event) => {
				active.delete(event.pointerId);
				syncHeld();
			};

			/**
			 * Swallow the click a press synthesises after the activation.
			 *
			 * Cancelling `pointerup` already suppresses the compatibility click for a
			 * touch pointer; for a mouse it does not, and that click would land on
			 * whatever the just-opened panel happens to show under the cursor.
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
			document.addEventListener("pointermove", onPointerMove, true);
			document.addEventListener("pointerup", onPointerUp, true);
			document.addEventListener("pointercancel", onPointerCancel, true);
			document.addEventListener("click", onClickCapture, true);
			return () => {
				document.removeEventListener("pointerdown", onPointerDown, true);
				document.removeEventListener("pointermove", onPointerMove, true);
				document.removeEventListener("pointerup", onPointerUp, true);
				document.removeEventListener("pointercancel", onPointerCancel, true);
				document.removeEventListener("click", onClickCapture, true);
				window.clearTimeout(flashTimer);
				active.clear();
				// Leave nothing behind on unload or hot reload.
				for (const glow of glows.values()) {
					if (glow.parentNode) glow.parentNode.removeChild(glow);
				}
				glows.clear();
			};
		}

		/* ------------------------------------------------------------- frame watch */

		/**
		 * Keep the frame marked, and settle the browser pane's packaged default.
		 *
		 * The class the stylesheet targets can disappear when the layout re-mounts, so
		 * a `MutationObserver` on the document re-applies it: `childList` + `subtree`
		 * catches replacement without observing every attribute in the tree.
		 *
		 * The same pass handles the pane's initial state. `@try-works/dsh-browser-agent`
		 * defaults to `collapsed = false` on every load, on every device, and does not
		 * persist the choice — so a phone would open a full-screen pane every time. The
		 * stylesheet hides the pane while `data-dsh-pane-boot` is set (so there is no
		 * flash of it) and this collapses it once, through the pane's own control, then
		 * clears the flag. Later opens — including the agent opening the pane to show
		 * its browsing — are left alone.
		 */
		function installFrameWatch() {
			if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
			markFrames();

			const booting = isNarrow();
			let decided = !booting;
			let bootTimer;
			const settlePane = () => {
				if (decided) return;
				if (document.querySelector('[data-dsh-browser-pane="expanded"]') === null) return;
				decided = true;
				window.clearTimeout(bootTimer);
				document.documentElement.removeAttribute("data-dsh-pane-boot");
				drive(PANE, {});
			};
			if (booting) {
				document.documentElement.setAttribute("data-dsh-pane-boot", "");
				// A pane that never mounts must not leave the flag (and the hidden panel)
				// behind forever.
				bootTimer = window.setTimeout(() => {
					decided = true;
					document.documentElement.removeAttribute("data-dsh-pane-boot");
				}, 4000);
			}

			let queued = false;
			/** Mark the frame and settle the pane's packaged default. */
			const settle = () => {
				markFrames();
				settlePane();
			};
			/**
			 * Coalesce, then settle — with `setTimeout`, deliberately NOT
			 * `requestAnimationFrame`.
			 *
			 * A background tab does not run rAF callbacks at all, and a newly created
			 * tab on Android Chrome *is* a background tab until the user looks at it.
			 * With rAF here, the first settle ran before the layout had mounted, every
			 * later one never ran, and the plugin silently did nothing: the frame was
			 * never marked and the pane stayed at its packaged default. Measured, after
			 * a reload in a background tab: `marked: 0`, `pane: "expanded"`.
			 */
			const queueSettle = () => {
				if (queued) return;
				queued = true;
				window.setTimeout(() => {
					queued = false;
					settle();
				}, 0);
			};
			const observer = new MutationObserver(queueSettle);
			observer.observe(document.documentElement, { childList: true, subtree: true });
			settle();
			// A bounded retry as well: the frame and the pane both mount asynchronously,
			// so the first settle can easily land before either exists, and a throttled
			// tab may not deliver the mutations that would trigger another.
			let tries = 0;
			const retry = window.setInterval(() => {
				settle();
				tries += 1;
				if (tries >= 24) window.clearInterval(retry);
			}, 250);
			return () => {
				observer.disconnect();
				window.clearInterval(retry);
				window.clearTimeout(bootTimer);
				document.documentElement.removeAttribute("data-dsh-pane-boot");
			};
		}

		/* ------------------------------------------------------------ keyboard inset */

		/**
		 * Pin the shell to the visual viewport while a keyboard covers part of it.
		 *
		 * This is the iPad and iPhone fix, and it is inert everywhere else: Android and
		 * desktop resize the layout viewport for the keyboard, so the shell already ends
		 * where the keyboard begins and the shrink test below never fires. A device with
		 * a hardware keyboard attached fires nothing either.
		 *
		 * It reuses `isTyping()` from the edge bands, which is the same question — is a
		 * text field focused — because "the viewport is short" alone is not enough: the
		 * visual viewport also shrinks for zoom and for Safari's toolbars.
		 *
		 * Runs on every event rather than on a timer: iOS fires `resize` throughout the
		 * keyboard's own animation, so following the events moves the shell with the
		 * keyboard instead of snapping it into place afterwards.
		 */
		function installKeyboardInset() {
			if (typeof document === "undefined" || typeof window === "undefined") return () => {};
			const vv = window.visualViewport;
			// No visual viewport: the layout viewport is all this browser has, and the
			// problem cannot be fixed from the page anyway.
			if (vv === null || vv === undefined) return () => {};

			const root = document.documentElement;
			const style = root.style;
			let pinned = false;

			const update = () => {
				// The baseline has to be current before the keyboard test below, and the
				// window resize that a keyboard causes is exactly when it must NOT move.
				rememberViewport();
				const covered = Math.round(window.innerHeight - vv.height);
				const wanted = isTyping() &&
					(vv.scale ?? 1) <= SCALE_TOLERANCE &&
					covered >= MIN_KEYBOARD_PX;
				if (wanted) {
					// Refreshed on every event: Safari animates the keyboard in, and pans the
					// visual viewport as it goes.
					style.setProperty(KEYBOARD_HEIGHT_VAR, `${Math.round(vv.height)}px`);
					style.setProperty(KEYBOARD_TOP_VAR, `${Math.round(vv.offsetTop)}px`);
				}
				if (wanted === pinned) return;
				pinned = wanted;
				if (wanted) {
					root.setAttribute(KEYBOARD_FLAG, "");
				} else {
					root.removeAttribute(KEYBOARD_FLAG);
					style.removeProperty(KEYBOARD_HEIGHT_VAR);
					style.removeProperty(KEYBOARD_TOP_VAR);
				}
			};

			vv.addEventListener("resize", update);
			vv.addEventListener("scroll", update);
			window.addEventListener("resize", update);
			window.addEventListener("orientationchange", update);
			// Focus can change without either viewport moving (a tap between two fields),
			// and focus is what decides whether this applies at all.
			document.addEventListener("focusin", update);
			document.addEventListener("focusout", update);
			update();

			return () => {
				vv.removeEventListener("resize", update);
				vv.removeEventListener("scroll", update);
				window.removeEventListener("resize", update);
				window.removeEventListener("orientationchange", update);
				document.removeEventListener("focusin", update);
				document.removeEventListener("focusout", update);
				root.removeAttribute(KEYBOARD_FLAG);
				style.removeProperty(KEYBOARD_HEIGHT_VAR);
				style.removeProperty(KEYBOARD_TOP_VAR);
			};
		}

		/* -------------------------------------------------------------------- css */

		const css = [
			// The drawers slide in, each from its own side. A grid track changes in a
			// single commit, so there is nothing to transition -- the movement has to be
			// a transform on the panel itself. No fill mode: a transform left behind
			// would make the panel a containing block for anything fixed inside it.
			"@keyframes dsh-mobile-rail-slide-in{from{transform:translateX(-100%)}to{transform:translateX(0)}}",
			"@keyframes dsh-mobile-pane-slide-in{from{transform:translateX(100%)}to{transform:translateX(0)}}",
			// Visual only. A band has no element of its own -- the gesture is read from
			// capture listeners -- so this is what the finger's feedback is drawn on.
			// `pointer-events:none` keeps it out of hit-testing completely, so it can
			// never swallow a tap.
			`.dsh-mobile-glow{position:fixed;top:0;bottom:0;width:${GLOW_PX}px;pointer-events:none}`,
			// The left glow sits above the drawer column and the resize handle (11) but
			// below the overlay layer (20) that holds dialogs. The right glow has to clear
			// the browser pane itself, which ships at z-index 400 -- otherwise the pane
			// would hide the very feedback that says the tap landed.
			'.dsh-mobile-glow[data-edge="left"]{left:0;z-index:15}',
			'.dsh-mobile-glow[data-edge="right"]{right:0;z-index:450}',
			".dsh-mobile-glow>div{position:absolute;inset:0;opacity:0}",
			// The highlight: a steady wash that appears almost at once, the way a
			// button's pressed state does.
			'.dsh-mobile-glow[data-edge="left"]>.dsh-mobile-glow-hold{background:linear-gradient(90deg,rgba(88,150,255,.42),rgba(88,150,255,.16) 45%,rgba(88,150,255,0));transition:opacity 70ms linear}',
			'.dsh-mobile-glow[data-edge="right"]>.dsh-mobile-glow-hold{background:linear-gradient(270deg,rgba(88,150,255,.42),rgba(88,150,255,.16) 45%,rgba(88,150,255,0));transition:opacity 70ms linear}',
			".dsh-mobile-glow[data-held]>.dsh-mobile-glow-hold{opacity:1}",
			// The flash: brighter, instant, then gone. Zero duration on the way in, so
			// only its decay is animated -- the reverse would read as a fade, not a click.
			'.dsh-mobile-glow[data-edge="left"]>.dsh-mobile-glow-flash{background:linear-gradient(90deg,rgba(150,196,255,.85),rgba(88,150,255,.32) 45%,rgba(88,150,255,0));transition:opacity 220ms ease-out}',
			'.dsh-mobile-glow[data-edge="right"]>.dsh-mobile-glow-flash{background:linear-gradient(270deg,rgba(150,196,255,.85),rgba(88,150,255,.32) 45%,rgba(88,150,255,0));transition:opacity 220ms ease-out}',
			".dsh-mobile-glow[data-lit]>.dsh-mobile-glow-flash{opacity:1;transition-duration:0s}",
			`@media (max-width: ${NARROW_MAX_PX}px){`,
			// --- left edge: the sidebar ------------------------------------------------
			// Hide the rail itself. `hidden` rather than `none` keeps it in flow so the
			// centre keeps the correct track.
			`.${FRAME_CLASS}[data-sidebar-collapsed] > :first-of-type{`,
			"width:0!important;min-width:0!important;overflow:hidden!important;visibility:hidden!important;border-right:none!important}",
			// Ask for the track too: harmless where it is ignored, and it removes a 1px
			// sliver where the browser does honour it.
			`.${FRAME_CLASS}[data-sidebar-collapsed]{`,
			"grid-template-columns:0px minmax(0,1fr) 0px!important}",
			// Expanded on a phone, the product keeps laying the conversation out in
			// whatever is left of the row — measured 139px beside the 280px drawer, which
			// renders the header, the tab strip, the messages and the composer as an
			// unreadable sandwich. Blank that strip instead: the centre column paints no
			// background of its own, so hiding its content reveals the frame's own base
			// colour. `:nth-child(2)` is the centre column: the frame's children are
			// sidebar, centre, rightbar, overlay layer, handle.
			`.${FRAME_CLASS}:not([data-sidebar-collapsed]) > :nth-child(2) > *{`,
			"visibility:hidden!important}",
			`.${FRAME_CLASS}:not([data-sidebar-collapsed]) > :first-of-type{`,
			`animation:dsh-mobile-rail-slide-in ${RAIL_MS}ms cubic-bezier(.22,.72,.24,1)}`,
			// --- right edge: the browser pane ------------------------------------------
			// The packaged collapsed rail is a 34px full-height column that also reserves
			// its width out of the page. This plugin replaces it with the invisible band.
			'[data-dsh-browser-pane="collapsed"]{display:none!important}',
			// The pane takes its space out of the page by setting `body.margin-right` to
			// its own width. On a phone that is fatal: 520px of margin on a 419px viewport
			// leaves the GUI 0px wide, which reads as a hung app. Here the pane floats over
			// the GUI instead and reserves nothing.
			"body{margin-right:0!important}",
			// ...and it can never be wider than the screen either.
			'[data-dsh-browser-pane="expanded"]{',
			`max-width:calc(100vw - 18px)!important;animation:dsh-mobile-pane-slide-in ${RAIL_MS}ms cubic-bezier(.22,.72,.24,1)}`,
			// While the packaged default is being settled (see installFrameWatch) the pane
			// is hidden, so a phone never flashes a full-screen panel on load.
			'html[data-dsh-pane-boot] [data-dsh-browser-pane="expanded"]{display:none!important}',
			// --- the composer's controls, on one row ------------------------------------
			// Measured at 419px: the controls row is 377px wide and its two groups are
			// 124 + 281 = 405px plus the gap, so it WRAPS -- the commands/attach/access
			// group on one line, the model chip and send button on the next.
			//
			// The commands button goes first: it duplicates what typing "/" already does,
			// and it is the widest thing in the left group. That leaves
			// 84 + 281 = 365px, which fits the 377px row with room to spare.
			`[data-slot="conversation.composer"] button[aria-label="Commands"]{display:none!important}`,
			// The row itself, addressed by what it CONTAINS -- a row holding the commands
			// button two levels down -- rather than by the hashed class name the build
			// generates or by a position in the tree.
			`[data-slot="conversation.composer.bar"] div:has(> div > button[aria-label="Commands"]){`,
			"flex-wrap:nowrap!important;gap:8px!important}",
			// Nowrap alone would push the send button off the edge the moment the model name
			// is longer than usual, so one of the two groups has to give — and measured, the
			// wrong one did: the LEFT group is `flex: 0 1 auto` and shrank from 84px to
			// 72.7px, so its fixed-size icons spilled out and the access-mode button ended
			// 3px inside the usage ring — while the right group is `flex: 0 0 auto` and
			// could not shrink at all.
			//
			// So: pin the icons, and let the chip absorb the difference. `min-width:0` is
			// what lets each link in the chip's chain shrink below its content; without it
			// the chip keeps its full 163px and nothing moves.
			`[data-slot="conversation.composer.bar"] div:has(> div > button[aria-label="Commands"]) > *:first-child{flex-shrink:0}`,
			`[data-slot="conversation.composer.bar"] div:has(> div > button[aria-label="Commands"]) > *:last-child{flex-shrink:1;min-width:0}`,
			// `!important` is deliberate and load-bearing here: the app marks the trailing
			// group's children `flex-shrink: 0`, so measured, the group shrank to 269px while
			// its children kept their sizes and the 12px deficit was paid out of the gap
			// between the chip and the context ring, which closed to 0. Letting the chip's
			// container shrink is what actually makes the chip truncate.
			`[data-slot="conversation.input.model"] > div{flex-shrink:1!important;min-width:0!important;overflow:hidden}`,
			`[data-slot="conversation.input.model"] button{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis}`,
			`[data-slot="conversation.input.model"] button > *{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
			"}",
			// --- the keyboard, on the platforms that do not make room for it ------------
			// Deliberately NOT inside the media query above: this is the iPad's problem,
			// and an iPad is wider than 768px.
			//
			// The shell sizes itself with `html,body,#root{height:100%}`, and a percentage
			// resolves against the LAYOUT viewport. Android and desktop resize that
			// viewport for the keyboard, so their composer rises on its own. iPadOS and
			// iOS resize only the VISUAL viewport (`visualViewport.height`), leaving the
			// shell full height with the composer behind the keyboard -- and Safari pans
			// the visual viewport to reveal the field only sometimes, which is the
			// unpredictable behaviour this replaces.
			//
			// Pinned, the shell ends exactly where the keyboard begins: the conversation
			// takes the remaining space and the composer sits on top of the keyboard.
			// `top` compensates for Safari's own panning, which moves what is visible
			// without moving the layout viewport.
			`html[${KEYBOARD_FLAG}] #root{`,
			`position:fixed;top:var(${KEYBOARD_TOP_VAR},0px);left:0;right:0;height:var(${KEYBOARD_HEIGHT_VAR},100%)}`,
			// NOTE: these effects deliberately do NOT honour `prefers-reduced-motion`, and
			// that is a measured decision rather than an oversight. On the phone this was
			// built for, Android's `animator_duration_scale`,
			// `transition_animation_scale` and `window_animation_scale` are all `0.0`, so
			// Chrome reports `prefers-reduced-motion: reduce` — a speed preference set in
			// Developer options, not a statement about motion sensitivity — and honouring
			// it meant the animation that was explicitly asked for could never be seen.
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
		 * Build marker, so a live page can be checked against the source.
		 *
		 * HMR was already mistaken once for a broken fix after a screenshot predated the
		 * swap; a version on the window makes "is the new bundle running?" a measurement
		 * instead of an assumption.
		 */
		const VERSION = 17;

		const inject = [];

		function apply(ctx) {
			ensureStyles();
			// Seed the keyboard-free viewport baseline, so the Android keyboard test works
			// from the very first tap rather than waiting for a resize.
			rememberViewport();
			if (typeof window !== "undefined") {
				window.__dshMobileRail = {
					version: VERSION,
					edgePx: EDGE_PX,
					edges: EDGES.map((e) => e.side),
					minKeyboardPx: MIN_KEYBOARD_PX,
					/** Is the shell pinned above the keyboard right now? */
					get keyboardPinned() {
						return document.documentElement.hasAttribute(KEYBOARD_FLAG);
					},
					/**
					 * Why the bands are standing down, if they are.
					 *
					 * A band that ignores a tap has several possible reasons and no visible
					 * symptom; read this rather than guessing which one it is.
					 */
					get gates() {
						return {
							typing: isTyping(),
							keyboardUp: keyboardUp(),
							covering: keyboardCovering(),
							baseline: viewportBaseline,
							innerHeight: window.innerHeight,
							visualHeight: window.visualViewport ? Math.round(window.visualViewport.height) : null,
							narrow: isNarrow(),
							sidebarCollapsed: SIDEBAR.closed(frame()),
							paneCollapsed: PANE.closed(frame()),
						};
					},
				};
			}
			ctx.effect(() => installFrameWatch(), "dsh-mobile-rail: frame watch");
			ctx.effect(() => installEdgeTaps(), "dsh-mobile-rail: edge taps");
			ctx.effect(() => installKeyboardInset(), "dsh-mobile-rail: keyboard inset");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.markFrames = markFrames;
		exports.findToggle = findToggle;
		exports.EDGES = EDGES;
		return module.exports;
	},
});





