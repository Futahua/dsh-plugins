/**
 * Colour the Web GUI's code, diff statistics, reasoning indicator and tool rows.
 *
 * Eight independent behaviours, each anchored on a data attribute the product
 * publishes rather than on a CSS-module hash:
 *
 *   1. INLINE CODE. A boxed inline-code span (`` `like this` ``) renders in the
 *      shipped build with the box background and the surrounding text colour:
 *      `--dsw-alias-markdown-inline-code` behind, inherited `label-primary` in
 *      front. The shipped markdown stylesheet defines that element as
 *      `:not(pre) > code`, so the same structural selector here repaints exactly
 *      that set — the fenced-block `<code>` (a child of `<pre>`, inside
 *      `[data-code-block-content]`) is never touched.
 *
 *   2. THE `+N -M` STATISTIC. The collapsed one-line row of an edit/write tool
 *      call ends with a single `<span>` whose entire content is ONE text node,
 *      built as the template string `` `+${added} -${removed}` ``. CSS cannot
 *      colour substrings of one text node, so each half is moved into its own
 *      element: `+N` yellow, `-M` blue. The shipped text node is deliberately
 *      LEFT IN THE DOM (React holds a direct reference to it and updates it on
 *      re-render, and swapping it for our own markup would leave React writing
 *      into a detached node and the visible number frozen) — it is rendered at
 *      zero font-size instead, and our two spans are the only visible parts.
 *
 *   3. THE "FILES CHANGED" PANEL. The end-of-turn produced-files row lists
 *      paths with no line counts at all. Per-file `+N -M` is summed from the
 *      edit/write tool rows OF THE SAME TURN (`data-chat-turn` is on both the
 *      tool-call flow items and the turn-tail flow item that holds the panel)
 *      and written beside each file name, coloured with the same two colours.
 *
 *   4. REASONING ("THINKING") RENDERS SAGE. Two places show the agent's
 *      reasoning and both are painted the same muted grey-green:
 *        - the chat view's reasoning disclosure, which the product marks with
 *          `data-variant="think"` (icon + "Think" label + one-line preview, and
 *          the full reasoning text once expanded);
 *        - the trajectory pane's record detail, whose "Thinking" toggle and
 *          quoted reasoning body live inside `[data-summary-scroll-region]`.
 *      No sage token exists in the design system (`--dsw-alias-state-success-*`
 *      is a saturated green, not a sage), so the value is defined here. See the
 *      SAGE block below for why it is two values and not one.
 *
 *   5. THE `write` TOOL ROW READS "Created" IN YELLOW. Its shipped glyph is the
 *      same pen as `edit` and its shipped label is `tool.title.write` ("Write").
 *      The glyph is redrawn as a document-with-plus in the icon set's own
 *      geometry, and the label text node is rewritten in place. The label
 *      cannot be fixed at the locale layer: `ctx.locale.register` throws when a
 *      namespace already has a dictionary for a locale, and the conversation
 *      package owns `tool.title.write`, so there is no supported override — see
 *      the note above `markWriteRows`.
 *
 *   6. THREE ROWS LOSE THEIR WORD. Reasoning ("Think"), `edit` ("Edit") and
 *      `read` ("Read") each keep their own content and lose the label — the row
 *      is the control (`expandOnRowClick`), so no affordance depends on it. The
 *      reasoning row keeps its preview and body, both sage; `edit` keeps the pen,
 *      which is now unambiguously ITS action; `read` keeps its file name.
 *
 *   7. THE `read` ROW WEARS AN EYE, IN BLUE. The shipped icon set has no eye
 *      glyph, so one is drawn in the set's own 16x16 filled-contour idiom (see
 *      `EYE_PATH`) and painted `--dsw-alias-link`, the blue inline code already
 *      uses.
 *
 *   8. CREATED vs EDITED. `write` and `edit` ship the same pen and the same shape
 *      of label, which made two different actions read as one. `write` CREATES a
 *      file, so its row says "Created", wears a document-with-plus, and is yellow
 *      end to end — including the file NAME, because "Created" is a claim about
 *      that file. It also shows `+N` ALONE: a file created from scratch has
 *      nothing removed, so a `-0` would be noise. `edit` shows both halves as
 *      before. Injected context (`data-context-*`) is blue, for the same reason
 *      inline code is.
 *
 * React re-renders every one of these nodes, so a one-shot rewrite is clobbered.
 * A MutationObserver re-applies all three; every step is written to be
 * idempotent, so the observer's own mutations settle in one extra pass instead
 * of looping.
 *
 * Bundle format: `window.__ModuleLoader__.load({id, factory})` exporting
 * `apply` and `inject`.
 */
window.__ModuleLoader__.load({
	id: "dsh-code-colors",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * Build marker.
		 *
		 * HMR was already mistaken once for a broken fix in this workspace after a
		 * screenshot predated the bundle swap; a version on the window makes "is the
		 * new build running?" a measurement rather than an assumption.
		 *
		 * 1 = the three colour changes. 2 = + the sage reasoning indicator and the
		 * `write` row's document-with-plus glyph and "Created" label.
		 * 3 = + labels stripped from reasoning/edit/read, the eye glyph on `read`,
		 * blue injected-context rows, and the write/edit split (a created file is
		 * yellow end to end and shows only its `+N`).
		 * 4 = + separator dots removed, `read` and context file names blue, the
		 * `grep` word stripped, and the collapsed-thought strip on an expanded
		 * reasoning body.
		 * 5 = + the separator's GAP kept (the dot is unpainted, not hidden), the
		 * `write` word gone rather than rewritten, and row content pushed brighter
		 * than its title.
		 * 6 = + chrome white dimmed 40% (the assistant's prose excepted), the
		 * Like/Dislike pair and the usage button gone, and the tail clock showing
		 * its elapsed time outright and opening the usage dialog.
		 * 7 = + dimming raised to 60% and the user's own messages excepted too, the
		 * clock glyph replaced by the elapsed time it labelled, and the composer
		 * placeholder suppressed.
		 * 8 = + the composer INPUT excepted as well, the clock showing the bare
		 * duration instead of the sentence around it, that control released from its
		 * icon-sized width, and the second (element-based) placeholder hidden.
		 * 9 = + the reasoning renders in italic, code and links excepted.
		 * 10 = + the end-of-turn file list and the elapsed time render pink.
		 * 11 = + created files yellow in that list, and the closing message of each
		 * turn renders lavender.
		 * 12 = + a long file name in a tool row reads as its last two segments behind
		 * a leading ellipsis, instead of its root and a trailing one.
		 * 13 = + that name is FITTED to the row's width rather than fixed at two
		 * segments, and a finished turn's work folds away behind a strip.
		 * 14 = + the strip carries a visible count instead of being a bare hairline,
		 * and it exists on narrow viewports too — a touch user could fold the work and
		 * had no way to open it again.
		 * 15 = + the created row keeps the shipped pen in yellow, bold takes the
		 * contrasting colour inside each kind of message, and the dim is scoped to the
		 * work so nothing outside it is dimmed at all.
		 * 16 = + a failed process row reads red and loses its status dot, and the
		 * turn tally keys on a tool row's full path so a width-fitted name cannot
		 * split one file into several.
		 * 17 = + the failed row keeps its terminal icon: the app swaps the glyph for
		 * the dot when a command fails, so the icon is restored as a clone beside
		 * the hidden dot.
		 * 18 = + injected-context rows fold with the work instead of sitting beside
		 * the closing message once the turn settles.
		 * 19 = + the "Files changed" word goes, the chips stay: the panel's label
		 * repeats what the file list already shows.
		 * 20 = + presented-file cards go: the deliverable blocks in the turn tail
		 * repeat the file list above them, so the row is hidden and the tail keeps
		 * everything else.
		 * 21 = + holding a row to fold it no longer selects its text on touch: the
		 * native long-press menu is suppressed while the press is down, and any
		 * selection the hold created is cleared when the fold fires.
		 * 22 = + any failed tool row reads red and loses its dot, not just failed
		 * processes: a failed edit sat grey beside red commands for the same
		 * verdict. Markers follow (no yellow "created" on what never happened).
		 * 23 = + the closing lavender muted: same hue, a third of the saturation.
		 * 24 = + the fenced-code Copy button is an icon, and a tick once copied:
		 * the word was the widest thing in the block header, and on a phone it
		 * crowded the language tag out.
		 */
		const VERSION = 24;

		/**
		 * How long mutations are coalesced before one reconciliation pass.
		 *
		 * `setTimeout`, not `requestAnimationFrame`: a background tab never runs rAF,
		 * and a plugin that silently does nothing until you look at it is the failure
		 * mode this workspace already paid for once (see dsh-mobile-rail).
		 */
		const FLUSH_MS = 60;

		/** The statistic exactly as the shipped template string renders it. */
		const STAT_RE = /^\+(\d+)\s+-(\d+)$/u;

		/** Marks a span whose text node has been split into two coloured halves. */
		const SPLIT_ATTR = "data-dsh-cc-split";

		/** Marks one half of a split statistic (or of a panel count). */
		const PART_ATTR = "data-dsh-cc-part";

		/** Marks the count element this plugin adds inside a produced-file chip. */
		const COUNT_ATTR = "data-dsh-cc-count";

		/** Tool rows whose one-line summary carries the statistic. */
		const TOOL_SELECTOR = '[data-tool="edit"],[data-tool="write"]';

		/** The collapsed one-line row inside a tool row. */
		const DISCLOSURE_ROW = '[data-disclosure-row="true"]';

		/** The produced-files chip row inside the end-of-turn "Files changed" panel. */
		const PRODUCED_ROW = "[data-produced-files-row]";

		/** One turn's tail; the panel lives here and names its turn. */
		const TURN_TAIL = '[data-chat-flow-kind="turn-tail"]';

		// ---- the reasoning indicator (change 4)

		/**
		 * The chat view's reasoning disclosure.
		 *
		 * `data-variant` is the product's own published discriminator for a
		 * disclosure row's kind — the same attribute that carries `write`/`edit`
		 * on tool rows — and `think` is the literal the chat package passes for
		 * `ReasoningRow`. It is not a class name and carries no build hash.
		 */
		const THINK_ROW = '[data-variant="think"]';

		/**
		 * The trajectory pane's overview preview.
		 *
		 * `data-summary-scroll-region` is emitted by the trajectory package on the
		 * scrollable preview that wraps a record's rendered content, and the
		 * record's reasoning quote is the only element inside it that owns a
		 * `button[aria-expanded]`.
		 */
		const SUMMARY_REGION = "[data-summary-scroll-region]";

		/** Marks an element that must render sage. The value names its role. */
		const THINK_ATTR = "data-dsh-cc-think";

		// ---- the write tool row (change 5)

		/** Marks the `write` row's glyph and label, both of which render yellow. */
		const WRITE_ATTR = "data-dsh-cc-write";

		/**
		 * Hides an element entirely.
		 *
		 * Used to strip the WORD from a row that still needs its row: a reasoning
		 * row keeps its preview and body, an `edit` row keeps its pen and file
		 * name, a `read` row keeps its eye and file name. The disclosure stays
		 * clickable because `expandOnRowClick` makes the ROW the control, not the
		 * label — so removing the label removes words, not affordance.
		 */
		const HIDE_ATTR = "data-dsh-cc-hide";

		/** Marks the `read` row's glyph, which renders blue like inline code. */
		const READ_ATTR = "data-dsh-cc-read";

		/** Marks the file NAME of a created file, which renders yellow with its glyph. */
		const CREATED_NAME_ATTR = "data-dsh-cc-created-name";

		/**
		 * Unpaints a separator dot WITHOUT collapsing its box.
		 *
		 * `display:none` was wrong here and visibly so: the dot carries the spacing
		 * between a row's title and its content as MARGIN, so hiding the element
		 * took the gap with it and jammed the two together. Clearing only the
		 * background removes the dot and leaves the 2px box and its 8px margins
		 * exactly where the product put them, so the gap is the shipped gap.
		 */
		const DOT_ATTR = "data-dsh-cc-dot";

		/**
		 * A PROCESS ROW WHOSE COMMAND FAILED — a non-zero exit, or a terminating
		 * signal.
		 *
		 * Both halves are the app's own: `data-variant="bash"` is the terminal card's
		 * hook (it is what the shipped `terminalFailed` predicate is applied to), and
		 * `data-state="error"` is the verdict the app already reached and already
		 * paints its own status pill with. Nothing here re-derives failure from the
		 * output text, so a command that failed in a way the app did not recognise
		 * stays exactly as the app left it.
		 */
		const BASH_ERROR = '[data-variant="bash"][data-state="error"]';

		/**
		 * ANY TOOL ROW THAT FAILED — processes, edits, reads, all of them.
		 *
		 * The red rule started life scoped to process rows (`BASH_ERROR`), and a
		 * failed `edit` row then sat grey with its dot while failed commands went
		 * red beside it: same verdict from the app, two treatments. Failure is
		 * failure whichever tool reports it, so the colour and the dot go by the
		 * app's own `data-state` on any tool row. `BASH_ERROR` survives for the
		 * icon-restore below it, which is genuinely process-specific.
		 */
		const TOOL_ERROR = '[data-tool][data-state="error"]';

		/**
		 * The design system's error red — the colour the app's own failed pill
		 * already uses. Read from the token rather than pinned, so the light theme
		 * gets the light theme's red; the literal is the dark value and only applies
		 * if the token is ever missing.
		 */
		const ERROR_COLOR = "var(--dsw-alias-state-error-primary,#f25a5a)";

		/** Marks the terminal icon this plugin restores into a failed process row. */
		const BASH_ICON_ATTR = "data-dsh-cc-bash-icon";

		/** Marks a fenced-code copy button, whose word becomes an icon. */
		const COPY_ATTR = "data-dsh-cc-copy";

		/** Marks the icon this plugin puts inside a copy button, and its state. */
		const COPY_ICON_ATTR = "data-dsh-cc-copy-icon";

		/**
		 * How long the tick shows after a copy.
		 *
		 * The product's own "Copied" word lasts 1000ms; the tick mirrors it with a
		 * breath of margin, so the two never disagree about when copying ended.
		 */
		const COPY_TICK_MS = 1100;

		/**
		 * The row's CONTENT — the file name, the command, the summary — renders
		 * brighter; its TITLE renders dimmer.
		 *
		 * The shipped row does the opposite: the title is full-strength label text
		 * and the content is `label-tertiary`, so the eye lands on the tool's NAME
		 * and skips the thing the tool actually did. These two markers swap that
		 * emphasis. They are declared FIRST in the stylesheet on purpose — every
		 * more specific colour below (the sage reasoning body, the blue read name,
		 * the yellow created name) is meant to win over them.
		 */
		const BRIGHT_ATTR = "data-dsh-cc-bright";
		const DIM_ATTR = "data-dsh-cc-dim";

		/** Marks an injected-context row's text, which renders blue like inline code. */
		const CTX_ATTR = "data-dsh-cc-ctx";

		/** The invisible collapse strip this plugin adds to an expanded reasoning body. */
		const COLLAPSE_ATTR = "data-dsh-cc-collapse";

		/**
		 * How far an expanded body's left edge must sit from the window's left edge
		 * before the collapse strip is installed, in px.
		 *
		 * This is the guard that keeps the strip out of the mobile rail's way. The
		 * strip hugs the LEFT edge of the reasoning body; in the desktop layout the
		 * conversation column is inset well clear of the window edge, but on a
		 * narrow viewport that column starts close to it — which is exactly where
		 * dsh-mobile-rail puts its own left-edge affordance. Rather than fight it
		 * for the same pixels, the strip simply is not installed where the two
		 * would overlap, and the thought is collapsed by the row as it always was.
		 */
		const COLLAPSE_MIN_INSET = 24;

		// ---- chrome contrast, and the turn tail (change 7)

		/**
		 * How far the chrome's white is pushed toward the page background.
		 *
		 * 40%, as asked. The token is not merely darkened: it is MIXED toward
		 * whatever the background currently is, so the reduction is a reduction in
		 * CONTRAST and behaves the same on the light theme as on the dark one —
		 * darkening a near-black light-theme token would have made it darker and
		 * therefore MORE contrasty, which is the opposite of the request.
		 */
		const WHITE_REDUCTION = 0.6;

		/**
		 * The two speakers, whose prose is never dimmed.
		 *
		 * Kept as named constants because the bold rule below addresses them, not
		 * because they need an exemption any more: the dim is scoped to the work, so
		 * nothing outside it is dimmed in the first place.
		 */
		const ASSISTANT_STEP = '[data-chat-flow-kind="assistant-step"]';
		const USER_STEP = '[data-chat-flow-kind="user"]';

		/**
		 * The work: what a turn DID, and the only thing whose text is dimmed.
		 *
		 * Tool rows are dimmed so the eye passes over them and lands on the prose —
		 * which is the whole reason the dim exists. Everything the work is not —
		 * messages, chrome, the side pane, the composer — keeps full contrast.
		 */
		const WORK_SELECTOR = '[data-chat-flow-kind="tool-call"],[data-chat-flow-kind="turn-process"]';

		/**
		 * Marks an element that renders pink: the end-of-turn file list, and the
		 * elapsed-time control in the turn tail.
		 */
		const PINK_ATTR = "data-dsh-cc-pink";

		/**
		 * Marks the assistant's CLOSING message for a turn, which renders lavender.
		 *
		 * Not every assistant step: the ones before it are working notes and tool
		 * chatter, and the one that answers the turn is the one worth setting apart.
		 */
		const LAVENDER_ATTR = "data-dsh-cc-lavender";

		// ---- folding a finished turn's work (change 9)

		/** Marks one flow item the fold is currently hiding. */
		const FOLD_ATTR = "data-dsh-cc-folded";

		/** Marks the strip that stands in for the folded work and toggles it. */
		const FOLD_STRIP_ATTR = "data-dsh-cc-fold-strip";

		/**
		 * How long a press must be held before it counts as a fold gesture.
		 *
		 * 500ms is the platform convention for a long press and is deliberately
		 * longer than a tap: this listener sits on top of rows that are themselves
		 * clickable, and a shorter threshold would fold the work while someone was
		 * simply opening a tool row.
		 */
		const FOLD_HOLD_MS = 500;

		/**
		 * Per-turn fold state, keyed by turn id: `"folded"` or `"opened"`.
		 *
		 * THIS MAP IS THE WHOLE REASON THE FEATURE DOES NOT FIGHT THE USER. The
		 * reconcile pass runs continuously, so "fold every finished turn" would snap
		 * the work shut again the instant someone reopened it. A turn is folded ONCE,
		 * on the pass that first sees it finished; after that the map remembers what
		 * the person chose and reconciliation only re-applies it.
		 */
		const foldState = new Map();

		/**
		 * Marks the turn-tail clock, which becomes the elapsed-time control.
		 */
		const TIME_ATTR = "data-dsh-cc-time";

		/**
		 * The duration inside an already-rendered run-time label — `2m 29s`, `1h 2m`.
		 *
		 * The label arrives as a whole SENTENCE from a locale string ("Ran for
		 * 2m 29s"), and the control now sits where an icon sat, so the sentence has
		 * to become the measurement alone. It is found by SHAPE rather than by
		 * deleting the English prefix, because the prefix is translated and a
		 * string-replace would quietly stop working in another locale instead of
		 * failing where it could be seen.
		 */
		const DURATION_RE = /\d+\s*[hms](?:\s*\d+\s*[hms])*/iu;

		/**
		 * Parse `#rgb`, `#rrggbb` or `rgb()/rgba()` into `[r,g,b]`, or null.
		 *
		 * The tokens arrive in whichever form the shell happens to publish — the
		 * measured ones here are hex (`#f9fafb`) while the computed colours are
		 * `rgb()` — so both are accepted rather than assuming one.
		 */
		function parseColor(value) {
			const text = value.trim();
			const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(text);
			if (hex !== null) {
				const digits = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
				return [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16));
			}
			const rgb = /^rgba?\(([^)]+)\)$/iu.exec(text);
			if (rgb !== null) {
				const parts = rgb[1].split(/[\s,/]+/u).filter((p) => p !== "").slice(0, 3).map(Number);
				return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? parts : null;
			}
			return null;
		}

		/** `fg` moved `amount` of the way toward `bg`, as an `rgb()` string. */
		function mixToward(fg, bg, amount) {
			const a = parseColor(fg);
			const b = parseColor(bg);
			if (a === null || b === null) return null;
			return "rgb(" + a.map((v, i) => Math.round(v * (1 - amount) + b[i] * amount)).join(",") + ")";
		}

		// ---- the `write` tool row (change 5)
		//
		// There was a hand-drawn document-with-plus glyph here, invented because the
		// shipped set has no such icon. It is GONE: the created row keeps the shipped
		// PEN and is told apart from `edit` by colour and by the file name, so the
		// plugin no longer ships an icon the design system does not.

		/**
		 * An eye, drawn in the same idiom as {@link DOC_PLUS_PATH}.
		 *
		 * The shipped icon set has no eye glyph at all (checked exhaustively:
		 * `IconThinkOutline`, `IconEditOutline`, `IconPlusOutline`,
		 * `IconCodeOutline`, `IconProjectAddOutline` and the rest, nothing
		 * eye-shaped), so this is drawn rather than borrowed.
		 *
		 * Three contours in the set's own 16x16 filled-currentColor geometry:
		 *
		 *   - lens outer   (1.1,8)..(14.9,8), control height 4.0 from the axis
		 *   - lens inner   the same lens inset by 1.34 (the stroke width used by
		 *                  `DOC_PLUS_PATH` and by the shipped glyphs' ring)
		 *   - pupil        a solid disc r 1.6 at the centre
		 *
		 * `fill-rule="evenodd"` again carries the whole design: a point in the
		 * lens ring is enclosed once (filled), a point between the pupil and the
		 * inner lens twice (hole), and a point in the pupil three times (filled)
		 * — which is exactly an outlined lens with a solid pupil, from three
		 * subpaths and no strokes. The pupil's radius is chosen to stay inside
		 * the inner lens, so the two never cross and the parity stays as counted.
		 */
		const EYE_PATH = [
			"M1.1 8 C3.5 4 12.5 4 14.9 8 C12.5 12 3.5 12 1.1 8 Z",
			"M2.9 8 C4.7 5.2 11.3 5.2 13.1 8 C11.3 10.8 4.7 10.8 2.9 8 Z",
			"M6.4 8 A1.6 1.6 0 1 1 9.6 8 A1.6 1.6 0 1 1 6.4 8 Z",
		].join(" ");

		// ------------------------------------------------------------------
		// Stylesheet
		// ------------------------------------------------------------------

		const css = [
			// (0) TITLE vs CONTENT CONTRAST — declared first so that every more
			// specific colour below overrides it. The content is pushed to full
			// strength and the title dropped back, which is the opposite of what the
			// shipped row does; see BRIGHT_ATTR.
			"[" + BRIGHT_ATTR + "]{color:var(--dsw-alias-label-primary)!important}",
			"[" + DIM_ATTR + "]{color:var(--dsw-alias-label-tertiary)!important}",

			// The separator dot is UNPAINTED, not hidden: its box and margins carry
			// the gap between title and content, so `display:none` would take the gap
			// with it. See DOT_ATTR.
			"[" + DOT_ATTR + "]{background:transparent!important}",

			// A FAILED ROW READS RED.
			//
			// The shipped failure signal is a 10px dot, plus a status pill that only
			// exists once the row is open — so the one row on screen that a reader
			// actually needs to stop at is also the one easiest to walk past. The row
			// itself takes the error colour instead.
			//
			// The three label tokens are redefined on the row rather than each
			// element being repainted one by one, because the row's text is coloured
			// through them: its title, its command, its output lines and the "Failed"
			// label all resolve to one of the three, so redefining them here reaches
			// every part of the row at once and stays correct if the app re-renders
			// it. The plain `color` is the belt to that braces: it catches anything
			// drawing on an inherited colour rather than a token.
			TOOL_ERROR + "{color:" + ERROR_COLOR + "!important;--dsw-alias-label-primary:" + ERROR_COLOR + "!important;--dsw-alias-label-secondary:" + ERROR_COLOR + "!important;--dsw-alias-label-tertiary:" + ERROR_COLOR + "!important}",

			// ...AND LOSES ITS DOT. The dot said the same thing, more quietly, and
			// once the row reads red it is a second mark for a single fact. Only the
			// failed row's dot goes: on every other row it is the ordinary resting
			// indicator, and removing it there would take away status rather than
			// duplicate it. Scoped to the disclosure row's LEADING slot — its first
			// child, the same anchor `rowIcon` uses — so a same-shaped element
			// anywhere else in the row (an expanded body, a future badge) is never
			// touched. Matched by the app's own hooks — `aria-hidden` (it is
			// decorative) plus a `data-state` (it reports one) — because the shipped
			// class carries a build hash and cannot be relied on.
			TOOL_ERROR + " " + DISCLOSURE_ROW + " > :first-child [aria-hidden=\"true\"][data-state]{display:none!important}",

			// ...INCLUDING ITS GLYPH AND NAME. A failed `write` still wears the
			// yellow pen and a failed `read` the blue eye, and those markers name
			// the action, not the outcome — but the row's claim is "this failed",
			// and a yellow "created" on something that was never created is the
			// wrong claim. This outranks those rules by specificity (two attributes
			// beat one), not by order, so it holds wherever they are declared. The
			// `+N -M` halves are deliberately NOT here: they count lines, and their
			// yellow/blue is a legend, not a verdict.
			TOOL_ERROR + " [" + WRITE_ATTR + "]," + TOOL_ERROR + " [" + READ_ATTR + "]," + TOOL_ERROR + " [" + CREATED_NAME_ATTR + "]{color:" + ERROR_COLOR + "!important}",

			// (1) Boxed inline code. The shipped rule sets no colour at all, so this
			// is an inherit-override; `!important` is here so a future shipped rule
			// that does set a colour cannot silently win. Scoped by the same
			// structure the shipped stylesheet uses, so fenced blocks are excluded.
			":not(pre) > code{color:var(--dsw-alias-link)!important}",

			// (1b) The fenced-code Copy button is an icon, 28px square. The word was
			// the widest thing in the block header. The shipped text node is LEFT
			// IN PLACE at zero size — React rewrites it on every copy toggle, and
			// swapping it out would leave React writing into a detached node (the
			// same trap as the split statistic). The accessible name survives
			// because zero size is not removal: readers still hear Copy/Copied.
			"[" + COPY_ATTR + "]{display:inline-flex!important;align-items:center;justify-content:center;width:28px;height:28px;padding:0!important;font-size:0!important;line-height:0}",
			"[" + COPY_ICON_ATTR + "]{display:block;width:14px;height:14px}",

			// (2) The split statistic. The container is zeroed so the shipped text
			// node it still holds is invisible and takes no width; the two halves
			// carry the real size back, measured from the element before it was
			// zeroed (the `--dsh-cc-stat-size` custom property, set inline).
			"[" + SPLIT_ATTR + '="1"]{font-size:0!important}',
			"[" + SPLIT_ATTR + '="1"] > [' + PART_ATTR + "]{font-size:var(--dsh-cc-stat-size,11px)!important}",

			// The two colours. Deliberately not green/red: "+N" yellow, "-M" blue.
			"[" + PART_ATTR + '="add"]{color:var(--dsw-alias-state-warn-primary)!important}',
			"[" + PART_ATTR + '="del"]{color:var(--dsw-alias-link)!important}',

			// (3) The counts added to the "Files changed" panel.
			"[" + COUNT_ATTR + "]{font-family:var(--ds-font-family-code);font-size:11px;font-weight:400;white-space:nowrap}",

			// The shipped chip row is `flex-wrap: nowrap; overflow: hidden` and its
			// overflow is decided by CONTAINER-QUERY width bands tuned to the shipped
			// chip widths, not by measured content. Adding a statistic to every chip
			// makes that budget overflow, which would clip chips rather than reveal
			// them, so the row is allowed to wrap and its chips are always shown;
			// the "+N files" counters are suppressed except the one that reports
			// files beyond the six the app renders at all.
			PRODUCED_ROW + "{flex-wrap:wrap!important;overflow:visible!important}",
			PRODUCED_ROW + " > button[title]{display:inline-flex!important}",
			PRODUCED_ROW + " > [data-shown]{display:none!important}",
			PRODUCED_ROW + ' > [data-shown="6"]{display:inline!important}',

			// (4) SAGE. The design system ships no sage: the only greens are
			// `--dsw-alias-state-success-*`, a saturated #22c55e that reads as
			// "passed", not as "thinking". So the value is defined here, as one
			// hue at two lightnesses.
			//
			// WHY TWO VALUES. A single hex cannot be legible on both themes, and
			// that is arithmetic rather than taste: on this build `--dsw-alias-bg-base`
			// is #151517 in dark and #fff in light, and AA body text needs a
			// relative luminance of at least 0.2056 against the first and at most
			// 0.1833 against the second. Those intervals do not overlap, so no
			// single colour satisfies both. Both values are HSL(89deg), the sage
			// hue; only lightness moves (61% dark, 37.6% light), which is exactly
			// how the shipped tokens behave — `--dsw-alias-link` is #679efe in dark
			// and #4176e6 in light, one hue at two lightnesses.
			//
			//   #9caf88 on #151517 -> 7.8:1   (the sage this change named)
			//   #61734d on #ffffff -> 5.2:1
			//
			// The light value is the base and the dark one an override, so a build
			// that drops the theme attribute falls back to the value that is legible
			// on the default surface rather than to an invisible one.
			":root{--dsh-cc-sage:#61734d}",
			"html[data-ds-dark-theme],body[data-ds-dark-theme]{--dsh-cc-sage:#9caf88}",

			// PINK, for the end-of-turn file list and the elapsed time. Same reason
			// as sage: no pink exists in the design system, so one is defined here,
			// as one hue at two lightnesses so it stays legible on both themes.
			//   #f472b6 on #151517 -> 7.3:1
			//   #db2777 on #ffffff -> 4.9:1
			":root{--dsh-cc-pink:#db2777}",
			"html[data-ds-dark-theme],body[data-ds-dark-theme]{--dsh-cc-pink:#f472b6}",
			"[" + PINK_ATTR + "]{color:var(--dsh-cc-pink)!important}",

			// LAVENDER, for the message that actually answers a turn. Muted on
			// purpose: this is the colour the eye rests on longest, and the vivid
			// violet shouted over everything it sat beside.
			//   #b6afd1 on #151517 -> 8.7:1
			//   #7665a8 on #ffffff -> 5.0:1
			":root{--dsh-cc-lavender:#7665a8}",
			"html[data-ds-dark-theme],body[data-ds-dark-theme]{--dsh-cc-lavender:#b6afd1}",
			"[" + LAVENDER_ATTR + "]{color:var(--dsh-cc-lavender)!important}",
			// RE-ASSERTED PER ELEMENT, and the first version was not — which is why the
			// closing message measured as lavender on its wrapper while every paragraph
			// and heading inside it rendered plain white. The closing message is
			// MARKDOWN: its `p`, `h2`, `li` wrappers each set their own colour, so a
			// colour on the container is overridden by every block inside it. This is
			// the same trap the sage colour fell into, and it was measured the same
			// careless way both times — by reading the wrapper instead of the text.
			// Code and links keep their own colours and are excluded — and so is
			// anything inside a reasoning row. The closing step CONTAINS that turn's
			// thinking, and this rule's specificity beat the sage rule, so the thought
			// that produced the answer turned lavender along with it. The reasoning is
			// sage by its own rule; lavender belongs to the prose.
			// `:not([THINK])` as well as `:not([THINK] *)`: the marked element itself
			// CARRIES the attribute rather than descending from it, so a descendant test
			// alone left the preview and the body still lavender.
			"[" + LAVENDER_ATTR + "] :not(pre,code,a):not(code *,a *):not([" + THINK_ATTR + "]):not([" + THINK_ATTR + "] *){color:var(--dsh-cc-lavender)!important}",

			// BOLD TAKES THE OTHER COLOUR, so emphasis reads by contrast rather than by
			// weight alone: lavender inside the white dialogues, and full white inside a
			// lavender closing message. Applied by `markBold` through inline important
			// declarations — see there for why a rule here could not win.

			// (14) THE FOLDED WORK. The items themselves are hidden; the strip stands in
			// for them and is the only thing left to click.
			"[" + FOLD_ATTR + "]{display:none!important}",

			// The strip has to be FINDABLE, which the first version was not: it was a
			// 2px hairline at 45% opacity with no text, and the only report it produced
			// was the question "where expand?". It now carries a visible label and a
			// rule at readable contrast, and it is the affordance on EVERY width — a
			// strip that vanished under 700px left touch users with a way to fold the
			// work and no way to open it again.
			"[" + FOLD_STRIP_ATTR + "]{display:flex!important;align-items:center;gap:10px;width:100%;height:22px;margin:0;padding:0;border:0;background:transparent;cursor:pointer;user-select:none;-webkit-touch-callout:none}",
			"[" + FOLD_STRIP_ATTR + "]::before,[" + FOLD_STRIP_ATTR + "]::after{content:'';flex:auto;height:1px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 45%,transparent)}",
			"[" + FOLD_STRIP_ATTR + "]:hover::before,[" + FOLD_STRIP_ATTR + "]:hover::after{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 85%,transparent)}",
			"[" + FOLD_STRIP_ATTR + "] > span{flex:none;font-size:11px;line-height:16px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}",
			"[" + FOLD_STRIP_ATTR + "]:hover > span{color:var(--dsw-alias-label-primary)}",
			"[" + FOLD_STRIP_ATTR + "]:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}",
			// On a narrow viewport the strip is INSET rather than removed. Its left end
			// is the one place it could sit under dsh-mobile-rail's edge affordance, and
			// indenting it keeps the two from competing for those pixels without taking
			// the control away.
			"@media (max-width:700px){[" + FOLD_STRIP_ATTR + "]{padding-left:28px;box-sizing:border-box}}",

			"[" + THINK_ATTR + "]{color:var(--dsh-cc-sage)!important}",

			// The trajectory quote draws a 2px rule down its left edge and no text
			// colour of its own; the rule is part of the indicator, so it moves too.
			"[" + THINK_ATTR + '="quote"]{border-left-color:var(--dsh-cc-sage)!important}',

			// The trajectory pane's toggle keeps its chevron but loses its word.
			// `font-size:0` collapses the text run while the `<svg>` keeps its own
			// width/height attributes, so the control survives intact and stays
			// clickable — wrapping React's text node to hide it would be a bigger
			// intrusion for the same result.
			"[" + THINK_ATTR + '="toggle"]{font-size:0!important}',

			// (13) THE REASONING READS AS A THOUGHT: italic, in the chat row's
			// one-line preview, in its expanded body, and in the trajectory pane's
			// quoted reasoning. Code and links are excluded — a slanted fenced block
			// is a rendering fault rather than emphasis, and links already carry
			// their own colour. The selector is the same shape the sage rule above
			// uses, for the same reason: the body is markdown, and its wrappers set
			// their own styles, so the declaration is re-asserted per element.
			"[" + THINK_ATTR + '="summary"]{font-style:italic!important}',
			"[" + THINK_ATTR + '="body"]{font-style:italic!important}',
			"[" + THINK_ATTR + '="body"] :not(pre,code,a):not(code *,a *){font-style:italic!important}',
			"[" + THINK_ATTR + '="quote"] :not(pre,code,a):not(code *,a *){font-style:italic!important}',

			// …and code and links are put BACK to upright inside the body. The
			// `:not()` above only declines to ADD italic; `font-style` inherits, so
			// the italic body would have slanted every fenced block inside it anyway.
			// A reset is required, not merely a narrower selector.
			"[" + THINK_ATTR + '="body"] pre,[' + THINK_ATTR + '="body"] code,[' + THINK_ATTR + '="body"] a{font-style:normal!important}',

			// The trajectory's reasoning body is MARKDOWN: its wrappers paint
			// themselves `label-primary` and would win over an inherited colour, so
			// the sage is re-asserted per element. Code and links are excluded —
			// they own their colours (inline code is this plugin's blue, links the
			// link token) and a sage fenced block would be a regression, not a
			// recolour. `:not(code *,a *)` is Selectors-4 and fine here: the shell
			// is a current Chrome, and the browser tools drive that same one.
			"[" + THINK_ATTR + '="quote"] :not(pre,code,a):not(code *,a *){color:var(--dsh-cc-sage)!important}',

			// (5) THE `write` ROW. The same warn token the `+N` statistic already
			// uses, so "created" and "added lines" read as the same family. Applied
			// to the glyph and the label only: the file link and the `+N -M`
			// statistic keep the colours they already have.
			"[" + WRITE_ATTR + "]{color:var(--dsw-alias-state-warn-primary)!important}",

			// (6) STRIPPED LABELS. Three rows lose their word and keep their own
			// content: reasoning ("Think"), `edit` ("Edit"), and `read` ("Read").
			// `display:none` rather than an emptied text node, so a re-render or a
			// locale switch cannot briefly resurrect the word.
			"[" + HIDE_ATTR + "]{display:none!important}",

			// (7) THE `read` ROW'S EYE. Blue — the same `--dsw-alias-link` inline
			// code already uses, so "code" and "read the code" read as one family.
			"[" + READ_ATTR + "]{color:var(--dsw-alias-link)!important}",

			// A created file is yellow END TO END. The label and glyph already
			// were; the file NAME joins them, because "Created" is a claim about
			// that file rather than about the row it sits in.
			"[" + CREATED_NAME_ATTR + "]{color:var(--dsw-alias-state-warn-primary)!important}",

			// (8) INJECTED CONTEXT. The runtime-context and skill-catalog rows the
			// product marks with `data-context-source`. Blue for the same reason
			// inline code is: it is quoted material, not the user speaking.
			"[" + CTX_ATTR + "]{color:var(--dsw-alias-link)!important}",

			// (9) THE COLLAPSE STRIP. An expanded reasoning body carries a
			// transparent strip down its left edge; clicking it collapses the
			// thought, the way a thread's rail does. It is a real <button> rather
			// than a pseudo-element so it is focusable and answerable to the
			// keyboard, and it carries no text, so the hover tint is its only
			// visible state — which is the point: it should be invisible until
			// wanted. The body is made a containing block for it; `position:
			// relative` here changes no geometry, only what `absolute` resolves
			// against.
			"[" + THINK_ATTR + '="body"]{position:relative}',
			"[" + COLLAPSE_ATTR + "]{position:absolute;left:0;top:0;bottom:0;width:14px;margin:0;padding:0;border:0;background:transparent;cursor:pointer;z-index:1}",
			"[" + COLLAPSE_ATTR + "]:hover{background:color-mix(in srgb,var(--dsw-alias-label-caption) 18%,transparent)}",

			// (10) THE TURN TAIL. The clock's own label is forced visible, so the
			// elapsed time reads without a hover or a click.
			"[" + TIME_ATTR + "] span{display:inline!important}",
			// …and the row that holds it is un-hidden, because the product fades the
			// whole action row to `opacity:0` on every settled turn but the newest
			// (`[data-actions-reveal=hover]`), which would hide the clock along with
			// it. The element is matched on the LOCAL segment of its CSS-module
			// class rather than the whole name: `xzv4MW_actions` has a build-hashed
			// prefix, but `_actions` comes from the module's own source and is the
			// part that survives a rebuild. It is scoped to a turn tail so nothing
			// else can match it.
			"[data-turn-tail] [class*='_actions']{opacity:1!important}",

			// (11) THE CLOCK GLYPH GOES, THE TIME STAYS. The elapsed time takes the
			// icon's place at the head of the control, so the thing you read and the
			// thing you click are the same thing. The `<svg>` is hidden rather than
			// removed: React owns it, and detaching a node it still renders into is
			// how a control ends up frozen.
			"[" + TIME_ATTR + "] svg{display:none!important}",

			// The control is sized for an ICON by the product (the tail's action
			// buttons are a fixed 28px square), so with the glyph gone the time text
			// was clipped to its first character. The button is released to size
			// itself from its content, and the label is stopped from ellipsing.
			"[" + TIME_ATTR + "]{width:auto!important;max-width:none!important}",
			"[" + TIME_ATTR + "] span{white-space:nowrap!important;overflow:visible!important;text-overflow:clip!important;max-width:none!important}",

			// (12) THE COMPOSER'S PLACEHOLDER. The product draws it as a `::before`
			// on the empty input element, fed by the element's own `data-placeholder`
			// attribute — so it is suppressed at the pseudo-element rather than by
			// editing the attribute, which React would simply write back.
			"[data-placeholder]::before{content:none!important}",
		].join("");

		/**
		 * The chrome-contrast rules, recomputed from the CURRENT tokens.
		 *
		 * Custom properties resolve at use time, so a stylesheet CANNOT capture the
		 * original white in a variable and then override the token that variable
		 * came from: the variable would resolve to the override, and the "restored"
		 * colour inside the assistant's prose would come back as the dim one. The
		 * literal has to be read out in JS before the override exists. That also
		 * means the baked values go stale on a theme switch, which is why the
		 * caller rewrites the tag whenever the text changes.
		 */
		function contrastCss() {
			// Read from `body`, not `documentElement`: the token is defined on the
			// themed BODY in this shell, so reading it from `<html>` returns an empty
			// string — which would make `mixToward` return null, the whole rule
			// silently vanish, and the change look applied while doing nothing at all.
			const computed = getComputedStyle(document.body);
			const hi = computed.getPropertyValue("--dsw-alias-label-primary").trim();
			const bg = computed.getPropertyValue("--dsw-alias-bg-base").trim();
			const dim = mixToward(hi, bg, WHITE_REDUCTION);
			if (dim === null || hi === "") return "";
			return (
				// THE DIM IS SCOPED TO THE WORK, and nothing else is dimmed at all.
				//
				// It used to be the other way round — dim the whole page, then re-assert
				// full white inside a list of exempt places — and that list kept growing
				// because it kept being wrong: the assistant's prose, the user's own
				// messages, the composer, the side pane, each found dimmed and each
				// needing a new exception. Scoping the dim to the work inverts the
				// default: anything not explicitly work stays at full contrast, so a
				// surface nobody thought about cannot come out wrong.
				WORK_SELECTOR + "{--dsw-alias-label-primary:" + dim + "!important}"
			);
		}

		/** The theme signature the baked colours were read under. */
		let bakedTheme = null;
		/** The contrast rules currently baked into the stylesheet. */
		let bakedOverrides = "";

		/** Both places this shell marks the active theme. */
		function themeKey() {
			return [
				document.documentElement.getAttribute("data-ds-dark-theme") ?? "",
				document.body === null ? "" : (document.body.getAttribute("data-ds-dark-theme") ?? ""),
			].join("|");
		}

		/** Inject once, then keep in step with the active theme. */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			const tagId = "dsh-code-colors/colors.css";
			let tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]");
			if (tag === null) {
				tag = document.createElement("style");
				tag.dataset.plugin = "dsh-code-colors";
				tag.dataset.pluginCss = tagId;
				tag.textContent = css;
				document.head.appendChild(tag);
			}
			const theme = themeKey();
			if (theme !== bakedTheme) {
				// THE READ MUST HAPPEN WITH OUR OVERRIDE OUT OF THE DOCUMENT. Reading
				// the token while our own `!important` rule is live returns the value we
				// wrote last pass, so every pass would dim the already-dimmed value and
				// the colour would march into the background — which is exactly what a
				// first attempt here did. Stripping the tag first makes the read the
				// shell's own value, and re-baking only when the theme actually changes
				// keeps it from oscillating.
				tag.textContent = css;
				const baked = contrastCss();
				if (baked === "") {
					// The shell's tokens are not on the page yet: a fresh load runs this
					// before the design system has landed, so the read comes back empty.
					// NOTHING IS RECORDED, and that is the point — leaving `bakedTheme`
					// unset is what makes the next pass try again. Caching a failed read
					// as if it were a result left the dimming silently absent for the
					// whole life of the page, which is precisely what it did until a
					// reload in the harness exposed it.
					return;
				}
				bakedOverrides = baked;
				bakedTheme = theme;
			}
			const full = css + bakedOverrides;
			if (tag.textContent !== full) tag.textContent = full;
		}

		// ------------------------------------------------------------------
		// The statistic
		// ------------------------------------------------------------------

		/**
		 * The collapsed one-line row of a tool call, or the tool row itself when the
		 * disclosure wrapper is absent.
		 */
		function summaryRow(tool) {
			return tool.querySelector(DISCLOSURE_ROW) ?? tool;
		}

		/**
		 * The element holding this tool row's `+N -M` statistic.
		 *
		 * Found by SHAPE, not by class: a `<span>` that reads as the statistic,
		 * preferred as a direct child of the collapsed row (the shipped position —
		 * it is that row's last element child) and accepted from deeper inside only
		 * as a fallback.
		 *
		 * A span this plugin has already split is still a candidate — it keeps the
		 * shipped text node, so it still reads as the statistic — and that is what
		 * lets a re-render be noticed (and lets the turn tally find the number)
		 * instead of the element dropping out of every later pass.
		 */
		function findStat(tool) {
			const row = summaryRow(tool);
			let fallback = null;
			for (const span of row.querySelectorAll("span")) {
				// A leaf span, or one of ours that has been split. Anything else is
				// markup, not the statistic.
				if (span.children.length !== 0 && span.getAttribute(SPLIT_ATTR) !== "1") continue;
				if (statValue(span) === null) continue;
				if (span.parentElement === row) return span;
				if (fallback === null) fallback = span;
			}
			return fallback;
		}

		/**
		 * The statistic's current value.
		 *
		 * Read from the shipped text node while it is there — that is the copy React
		 * keeps updating — and from our own halves when it is not.
		 */
		function statValue(stat) {
			for (const node of stat.childNodes) {
				if (node.nodeType !== 3) continue;
				const text = (node.nodeValue ?? "").trim();
				if (STAT_RE.test(text)) return text;
			}
			const parts = partsOf(stat);
			if (parts !== null) return "+" + parts.add.replace(/^\+/u, "") + " " + parts.del;
			return null;
		}

		/**
		 * This element's halves: `add` always, `del` as `""` when the element
		 * deliberately carries no removal half — a created file shows only its
		 * `+N`, not a meaningless `-0`. Null means it has not been split at all.
		 */
		function partsOf(host) {
			const add = host.querySelector(":scope > [" + PART_ATTR + '="add"]');
			const del = host.querySelector(":scope > [" + PART_ATTR + '="del"]');
			if (add === null) return null;
			return { add: add.textContent ?? "", del: del === null ? "" : (del.textContent ?? "").trim() };
		}

		/** One `<span data-dsh-cc-part>` holding `text`. */
		function part(kind, text) {
			const span = document.createElement("span");
			span.setAttribute(PART_ATTR, kind);
			span.textContent = text;
			return span;
		}

		/**
		 * Split a statistic host into two coloured halves, or refresh an existing
		 * split. Idempotent: a host already showing the right two halves is left
		 * completely alone, which is what stops the observer from looping.
		 */
		function splitStat(host, addOnly = false) {
			const value = statValue(host);
			if (value === null) return false;
			const match = STAT_RE.exec(value);
			if (match === null) return false;
			const wantAdd = "+" + match[1];
			// A CREATED file has nothing removed, so the `-M` half is dropped
			// rather than rendered as a meaningless `-0`. This is presentational
			// only: the shipped text node still carries both numbers, so
			// `statValue` and the turn tally are unaffected.
			const wantDel = addOnly ? null : "-" + match[2];

			const have = partsOf(host);
			if (host.getAttribute(SPLIT_ATTR) === "1" && have !== null && have.add === wantAdd && have.del === (wantDel ?? "")) {
				return false;
			}

			// Measure before zeroing. The cached value is reused on re-splits, when
			// the element is already at `font-size: 0` and would measure as such.
			if (!host.dataset.dshCcSize) host.dataset.dshCcSize = window.getComputedStyle(host).fontSize;
			host.style.setProperty("--dsh-cc-stat-size", host.dataset.dshCcSize);

			// The shipped text node stays exactly where React left it; only our own
			// previous halves are replaced.
			let raw = null;
			for (const node of host.childNodes) {
				if (node.nodeType === 3 && STAT_RE.test((node.nodeValue ?? "").trim())) {
					raw = node;
					break;
				}
			}
			for (const child of [...host.children]) {
				if (child.hasAttribute(PART_ATTR)) child.remove();
			}
			const add = part("add", wantAdd);
			// The shipped text is `+7 -7`: the separator belongs to the second half,
			// so the two halves read as one run when the first is yellow and the
			// second blue.
			const halves = wantDel === null ? [add] : [add, part("del", " " + wantDel)];
			if (raw === null) {
				host.append(...halves);
			} else {
				let anchor = raw;
				for (const node of halves) {
					host.insertBefore(node, anchor.nextSibling);
					anchor = node;
				}
			}
			host.setAttribute(SPLIT_ATTR, "1");
			return true;
		}

		/** Split every statistic currently in the document. */
		function splitAllStats() {
			let changed = 0;
			for (const tool of document.querySelectorAll(TOOL_SELECTOR)) {
				const stat = findStat(tool);
				// `write` creates, so it shows additions only; `edit` shows both.
				if (stat !== null && splitStat(stat, isCreation(tool))) changed += 1;
			}
			return changed;
		}

		/**
		 * Whether this tool row CREATED its file rather than editing an existing one.
		 *
		 * That is the whole distinction the two tools carry: the `write` tool
		 * produces a file from scratch, the `edit` tool changes one that already
		 * exists. The product publishes the tool name as `data-tool`, so this is
		 * a fact about the row rather than a guess about its content.
		 */
		function isCreation(tool) {
			return tool.getAttribute("data-tool") === "write";
		}

		// ------------------------------------------------------------------
		// The "Files changed" panel
		// ------------------------------------------------------------------

		/**
		 * A comparable spelling of a path.
		 *
		 * The panel publishes absolute Windows paths in a chip's `title`; the tool
		 * rows publish workspace-relative ones as their link text. Both are folded
		 * to `\` separators and lower case so the two can be compared.
		 */
		function foldPath(value) {
			return value.replaceAll("/", "\\").replace(/\\+/gu, "\\").replace(/^\.[\\]/u, "").toLowerCase();
		}

		/** The file a tool row names, as the link text of its collapsed row. */
		function toolFile(tool) {
			const row = summaryRow(tool);
			const button = row.querySelector("button");
			if (button !== null) {
				// THE FULL PATH IS PREFERRED over the rendered text. This name is fitted
				// to the row's width, so the same file prints differently in a wide row
				// and a narrow one — and keying the turn's tally on the printed form gave
				// one file several keys, made its basename look ambiguous, and made the
				// panel drop its count entirely. `dshCcFull` is what the row actually
				// refers to, whatever it is currently showing.
				const full = button.dataset.dshCcFull;
				if (full !== undefined && full.trim() !== "") return full.trim();
				if ((button.textContent ?? "").trim() !== "") return button.textContent.trim();
			}
			// Fallback: the element immediately before the statistic, when it is not a
			// button in this build.
			const stat = findStat(tool);
			const previous = stat === null ? null : stat.previousElementSibling;
			const text = previous === null ? "" : (previous.textContent ?? "").trim();
			return text === "" ? null : text;
		}

		/**
		 * Per-file line counts for one turn, summed over that turn's successful
		 * edit/write tool rows.
		 *
		 * Success is the app's own definition (`data-state="ok"`): the produced-files
		 * panel is built from the arguments of successful mutations only, so a failed
		 * edit contributes no lines and must not contribute a count either.
		 *
		 * The map is keyed by folded path; a value is `{ add, del }`.
		 */
		function turnTally(turn) {
			const tally = new Map();
			if (!/^\d+$/u.test(turn)) return tally;
			for (const call of document.querySelectorAll('[data-chat-flow-kind="tool-call"][data-chat-turn="' + turn + '"]')) {
				for (const tool of call.querySelectorAll(TOOL_SELECTOR)) {
					if (tool.getAttribute("data-state") !== "ok") continue;
					const stat = findStat(tool);
					const file = toolFile(tool);
					if (stat === null || file === null) continue;
					const value = statValue(stat);
					const match = value === null ? null : STAT_RE.exec(value);
					if (match === null) continue;
					const key = foldPath(file);
					const entry = tally.get(key) ?? { add: 0, del: 0, base: foldPath(file.split(/[\\/]/u).pop() ?? file) };
					entry.add += Number(match[1]);
					entry.del += Number(match[2]);
					tally.set(key, entry);
				}
			}
			return tally;
		}

		/**
		 * The tally entry for one panel chip, or null when this turn's tool rows do
		 * not account for it.
		 *
		 * Exact-ish match on the relative suffix first (the tool row's path is a
		 * suffix of the chip's absolute one), then the basename — and only when that
		 * basename is unique among the turn's edits, because attributing one file's
		 * lines to another is worse than showing nothing.
		 */
		function tallyFor(tally, absolutePath) {
			const wanted = foldPath(absolutePath);
			const exact = tally.get(wanted);
			if (exact !== undefined) return exact;
			for (const [key, entry] of tally) {
				if (wanted === key || wanted.endsWith("\\" + key)) return entry;
			}
			const base = foldPath(absolutePath.split(/[\\/]/u).pop() ?? absolutePath);
			let hit = null;
			for (const entry of tally.values()) {
				if (entry.base !== base) continue;
				if (hit !== null) return null;
				hit = entry;
			}
			return hit;
		}

		/**
		 * Show `entry` beside a chip's file name, or nothing when there is no entry.
		 *
		 * The holder element is created only when there is something to show and
		 * removed when there is not, because the chip is a flex box with a `gap`: an
		 * empty holder would still be a flex item and would still add its gap.
		 */
		function paintChip(chip, entry) {
			let holder = null;
			for (const child of chip.children) {
				if (child.hasAttribute(COUNT_ATTR)) holder = child;
			}
			if (entry === null) {
				if (holder === null) return false;
				holder.remove();
				return true;
			}
			if (holder === null) {
				holder = document.createElement("span");
				holder.setAttribute(COUNT_ATTR, "1");
				chip.append(holder);
			}
			const wantAdd = "+" + entry.add;
			// A file with nothing removed — every file this turn created — shows its
			// additions alone, exactly as its own tool row does.
			const wantDel = entry.del === 0 ? "" : "-" + entry.del;
			const have = partsOf(holder);
			if (have !== null && have.add === wantAdd && have.del === wantDel) return false;
			holder.replaceChildren(...(wantDel === "" ? [part("add", wantAdd)] : [part("add", wantAdd), part("del", " " + wantDel)]));
			return true;
		}

		/** Write per-file line counts into every "Files changed" panel on screen. */
		function paintPanels() {
			let changed = 0;
			for (const tail of document.querySelectorAll(TURN_TAIL)) {
				const row = tail.querySelector(PRODUCED_ROW);
				if (row === null) continue;
				const turn = tail.getAttribute("data-chat-turn");
				const tally = turn === null ? null : turnTally(turn);
				// THE "FILES CHANGED" WORD GOES, the chips stay. The panel reads as a
				// label span beside the chip lane, and the label repeats what the file
				// list underneath already says. Found by SHAPE — a leaflike span with
				// text, a direct child of the panel — never by its words, so every
				// locale's label goes and the chips (buttons, one level deeper) are
				// never candidates.
				const root = row.parentElement?.parentElement ?? null;
				if (root !== null) {
					for (const el of root.children) {
						if (el.tagName !== "SPAN" || el.children.length !== 0) continue;
						if ((el.textContent ?? "").trim() === "") continue;
						if (tag(el, HIDE_ATTR, "produced-label")) changed += 1;
					}
				}
				for (const chip of row.querySelectorAll("button[title]")) {
					const path = chip.getAttribute("title") ?? "";
					const entry = tally === null || path === "" ? null : tallyFor(tally, path);
					// THE FILE-TYPE GLYPH GOES. For a code file it draws `</>`, and it was
					// the loudest thing in a row that is meant to be read at a glance —
					// the file name already says what the file is. Removed by tag rather
					// than by class: the shipped class is `P4kPIW_fileIcon` with a build
					// hash in front of it, and the chip's first `<svg>` is the same
					// element without naming any part of that.
					const glyph = chip.querySelector("svg");
					if (glyph !== null && tag(glyph, HIDE_ATTR, "file-icon")) changed += 1;
					if (paintChip(chip, entry)) changed += 1;
					// A CREATED file is yellow and an EDITED one pink, so the two kinds
					// of change stay distinguishable in the summary as well as in the
					// tool rows. A file the tally cannot account for stays pink — the
					// default — rather than being guessed into the created group.
					const created = entry !== null && entry.del === 0;
					if (created) {
						if (chip.getAttribute(PINK_ATTR) !== null) {
							chip.removeAttribute(PINK_ATTR);
							changed += 1;
						}
						if (tag(chip, CREATED_NAME_ATTR, "name")) changed += 1;
					} else {
						if (chip.getAttribute(CREATED_NAME_ATTR) !== null) {
							chip.removeAttribute(CREATED_NAME_ATTR);
							changed += 1;
						}
						if (tag(chip, PINK_ATTR, "file")) changed += 1;
					}
				}
			}
			return changed;
		}

		/**
		 * Hide the presented-file cards in the turn tail.
		 *
		 * The tail already lists what changed (the file chips with their counts);
		 * the deliverable cards below repeat the same files as large blocks with
		 * Open buttons. The row goes, the tail keeps everything else — the chips,
		 * the usage, the clock. Matched on the shipped `data-presented-files-row`,
		 * which names the row rather than its hashed class.
		 */
		function markPresentedFiles() {
			let changed = 0;
			for (const row of document.querySelectorAll("[data-presented-files-row]")) {
				if (tag(row, HIDE_ATTR, "presented")) changed += 1;
			}
			return changed;
		}

		// ------------------------------------------------------------------
		// The reasoning indicator (change 4)
		// ------------------------------------------------------------------

		/**
		 * Mark an element for a colour rule, reporting whether the marker changed.
		 *
		 * The markers are the plugin's own attributes, never a class: the CSS that
		 * consumes them therefore cannot be broken by a build renaming anything,
		 * and a verification script can assert on the same attribute the colour
		 * rule uses instead of on a computed value alone.
		 */
		function tag(el, attr, value) {
			if (el === null || el === undefined) return false;
			if (el.getAttribute(attr) === value) return false;
			el.setAttribute(attr, value);
			return true;
		}

		/**
		 * The disclosure row's leading GLYPH, or null.
		 *
		 * Anchored on position inside the disclosure row rather than on a class:
		 * the leading slot is the row's first element child, the chevron is the
		 * last `<svg>` inside it, and the variant glyph is the first `<svg>` in the
		 * row that is not that chevron. Measured on the live page: collapsed rows
		 * render `[icon][chevron]`, and an EXPANDED row renders the chevron alone
		 * (`_iconIdle_*` is the idle-state glyph and is dropped while open), which
		 * is why "the first svg" is not by itself the icon.
		 */
		function rowIcon(row) {
			const leading = row.firstElementChild;
			const inLeading = leading === null ? [] : [...leading.querySelectorAll("svg")];
			const chevron = inLeading.length === 0 ? null : inLeading[inLeading.length - 1];
			for (const svg of row.querySelectorAll("svg")) {
				if (svg !== chevron) return svg;
			}
			return null;
		}

		/**
		 * The disclosure row's TITLE element, or null.
		 *
		 * The shipped `DisclosureRow` renders `[leading][title][content…]`, so the
		 * title is the first element child after the leading slot that holds bare
		 * text: no element children, not a control, not the separator (which is
		 * `aria-hidden` and empty), and not the `+N -M` statistic. No class is read.
		 */
		function rowLabel(row) {
			for (const el of row.children) {
				if (el === row.firstElementChild) continue;
				if (el.tagName === "BUTTON" || el.tagName === "A") continue;
				if (el.getAttribute("aria-hidden") === "true") continue;
				if (el.children.length !== 0) continue;
				const text = (el.textContent ?? "").trim();
				if (text === "" || STAT_RE.test(text)) continue;
				return el;
			}
			return null;
		}

		/**
		 * The element after the title that carries the row's one-line preview.
		 *
		 * Same shape rule as {@link rowLabel}: the first element after the title
		 * that is not a control, not `aria-hidden`, and not the statistic. On a
		 * reasoning row that is the summary span holding the collapsed preview.
		 */
		function rowPreview(row, label) {
			let after = label === null;
			for (const el of row.children) {
				if (el === label) {
					after = true;
					continue;
				}
				if (!after) continue;
				if (el.tagName === "BUTTON" || el.tagName === "A") continue;
				if (el.getAttribute("aria-hidden") === "true") continue;
				if (STAT_RE.test((el.textContent ?? "").trim())) continue;
				return el;
			}
			return null;
		}

		/**
		 * The expanded body of a disclosure row, or null.
		 *
		 * `DisclosureRow` renders the disclosure's `children` as a SIBLING of the
		 * row, inside the same wrapper, and only while open — so the body is
		 * whatever else that wrapper holds.
		 */
		function rowBody(row) {
			const holder = row.parentElement;
			if (holder === null) return null;
			for (const el of holder.children) {
				if (el !== row) return el;
			}
			return null;
		}

		/** Paint every reasoning disclosure on screen sage. Idempotent. */
		function markThinking() {
			let changed = 0;
			for (const root of document.querySelectorAll(THINK_ROW)) {
				const row = root.querySelector(DISCLOSURE_ROW) ?? root;
				const label = rowLabel(row);
				// The word and the glyph are REMOVED, not recoloured: what is left
				// of the row is the reasoning itself, in sage. The disclosure stays
				// operable because `expandOnRowClick` makes the row the control, so
				// nothing depends on the label surviving. The label element is only
				// hidden, not detached, so `rowPreview` can still be told where the
				// title was.
				if (tag(rowIcon(row), HIDE_ATTR, "reasoning")) changed += 1;
				if (tag(label, HIDE_ATTR, "reasoning")) changed += 1;
				if (tag(rowPreview(row, label), THINK_ATTR, "summary")) changed += 1;
				const body = rowBody(row);
				if (tag(body, THINK_ATTR, "body")) changed += 1;
				if (ensureCollapseStrip(row, body)) changed += 1;
			}
			return changed;
		}

		/**
		 * Install the invisible collapse strip inside an expanded reasoning body.
		 *
		 * Only an EXPANDED row has a body at all, so the strip is inherently an
		 * expanded-only affordance — which is what was asked for. Idempotent: a
		 * body that already carries its strip is left untouched, so the observer
		 * settles instead of looping.
		 *
		 * The strip is only measured for when it does not already exist, so the
		 * layout read happens once per expanded body rather than on every pass.
		 */
		function ensureCollapseStrip(row, body) {
			if (body === null) return false;
			if (body.querySelector(":scope > [" + COLLAPSE_ATTR + "]") !== null) return false;
			// The mobile-rail guard. See COLLAPSE_MIN_INSET: where the body's left
			// edge is close to the window edge, that ground belongs to the mobile
			// rail and the strip is simply not placed.
			if (body.getBoundingClientRect().left < COLLAPSE_MIN_INSET) return false;
			const strip = document.createElement("button");
			strip.type = "button";
			strip.setAttribute(COLLAPSE_ATTR, "1");
			strip.setAttribute("aria-label", "Collapse reasoning");
			strip.addEventListener("click", (event) => {
				// The body is a SIBLING of the row, so this click would not reach the
				// row's own handler anyway; stopping it keeps that true even if the
				// product ever nests them.
				event.stopPropagation();
				row.click();
			});
			body.insertBefore(strip, body.firstChild);
			return true;
		}

		/**
		 * Paint the trajectory pane's reasoning quote sage.
		 *
		 * The quote is not a tool row and carries no `data-variant`, so it is found
		 * structurally inside `[data-summary-scroll-region]`: it is the element that
		 * owns the region's one disclosure button. The extra shape guard — a button
		 * with exactly one element child, an `<svg>`, and a short text run — exists
		 * because that region also holds "Preview", "Request Timing" and request
		 * links; it is what keeps a future disclosure control in the same pane from
		 * being painted as reasoning.
		 */
		function markTrajectory() {
			let changed = 0;
			for (const region of document.querySelectorAll(SUMMARY_REGION)) {
				for (const button of region.querySelectorAll("button[aria-expanded]")) {
					if (button.children.length !== 1) continue;
					if (button.children[0].tagName.toLowerCase() !== "svg") continue;
					const text = (button.textContent ?? "").trim();
					if (text === "" || text.length > 40) continue;
					const quote = button.parentElement;
					if (quote === null || quote === region) continue;
					if (tag(quote, THINK_ATTR, "quote")) changed += 1;
					if (tag(button, THINK_ATTR, "toggle")) changed += 1;
				}
			}
			return changed;
		}

		// ------------------------------------------------------------------
		// The `write` tool row (change 5)
		// ------------------------------------------------------------------

		/**
		 * Redraw the row's glyph as a document-with-plus, in place.
		 *
		 * The shipped `<svg>` and its `<path>` are React's own nodes and are LEFT
		 * where React put them: the path's `d` is rewritten rather than a second
		 * glyph being added and the shipped one hidden. React writes a DOM
		 * attribute only when the corresponding PROP changes, and this icon is
		 * `<IconEditOutline16 size={14}/>` at every render — the same `d` every
		 * time — so the rewrite is not clobbered by a re-render, and if the element
		 * is ever re-created the `d` check below notices and reapplies it.
		 *
		 * Idempotent by comparing `d`, not by trusting the marker: a re-created
		 * `<path>` under a still-marked `<svg>` must be caught.
		 */
		function redrawGlyph(svg, pathData, markerAttr) {
			if (svg === null) return false;
			const paths = [...svg.querySelectorAll("path")];
			const first = paths[0] ?? null;
			if (first === null || first.getAttribute("d") !== pathData) {
				// One contour set, so any extra shipped path is dropped rather than
				// left to draw the old glyph's leftovers behind the new one.
				for (const extra of paths.slice(1)) extra.remove();
				const path = first ?? document.createElementNS(svg.namespaceURI, "path");
				for (const name of ["stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "transform"]) {
					path.removeAttribute(name);
				}
				path.setAttribute("d", pathData);
				path.setAttribute("fill", "currentColor");
				path.setAttribute("fill-rule", "evenodd");
				if (first === null) svg.append(path);
			}
			return tag(svg, markerAttr, "icon");
		}

		/**
		 * Strip the word from a `write` row.
		 *
		 * The word is now GONE rather than rewritten: the glyph and the file name
		 * carry the meaning, and a word repeating what the yellow already says was
		 * one word too many. Hiding is also far cheaper than rewriting — it needs no
		 * assumption about React leaving the text node alone.
		 */
		function hideRowLabel(label, role) {
			return tag(label, HIDE_ATTR, role);
		}

		/** Redraw and recolour every `write` tool row. Idempotent. */
		function markWriteRows() {
			let changed = 0;
			for (const tool of document.querySelectorAll('[data-tool="write"]')) {
				const row = summaryRow(tool);
				// THE SHIPPED PEN, untouched, only recoloured. An earlier version redrew
				// it as a document-with-plus; that is gone. A created row and an edited
				// row now share a glyph and are told apart by COLOUR and by the file
				// name, so the two actions still read differently without inventing an
				// icon the shipped set does not contain.
				if (tag(rowIcon(row), WRITE_ATTR, "icon")) changed += 1;
				if (hideRowLabel(rowLabel(row), "write")) changed += 1;
				// A created file is yellow END TO END: the pen above, and the file's own
				// name, because "created" is a claim about that file.
				if (tag(row.querySelector("button"), CREATED_NAME_ATTR, "name")) changed += 1;
			}
			return changed;
		}

		// ------------------------------------------------------------------
		// The `edit` and `read` rows, and injected context (change 6)
		// ------------------------------------------------------------------

		/**
		 * Strip the word from every `edit` row, keeping its pen and its file name.
		 *
		 * `edit` and `write` ship the SAME glyph and the same shape of label, which
		 * is exactly what made them read as one action. Separating them is the
		 * point of this change: the pen belongs to `edit` (changing a file that
		 * already exists), while `write` takes the document-with-plus and the word
		 * "Created" (producing one that did not). So `edit` keeps its glyph and
		 * loses only the word.
		 */
		function markEditRows() {
			let changed = 0;
			for (const tool of document.querySelectorAll('[data-tool="edit"]')) {
				if (tag(rowLabel(summaryRow(tool)), HIDE_ATTR, "edit")) changed += 1;
			}
			return changed;
		}

		/**
		 * Give every `read` row an eye, in blue, and strip its word.
		 *
		 * The glyph is redrawn in place by the same mechanism the `write` row uses,
		 * so a re-created `<path>` is caught by comparing `d` rather than by
		 * trusting the marker.
		 */
		function markReadRows() {
			let changed = 0;
			for (const tool of document.querySelectorAll('[data-tool="read"]')) {
				const row = summaryRow(tool);
				if (redrawGlyph(rowIcon(row), EYE_PATH, READ_ATTR)) changed += 1;
				if (tag(rowLabel(row), HIDE_ATTR, "read")) changed += 1;
				// The file being read is named in blue as well as marked with the
				// eye, so the row reads as one blue statement about one file rather
				// than a blue glyph next to ordinary text.
				if (tag(row.querySelector("button"), READ_ATTR, "name")) changed += 1;
			}
			return changed;
		}

		// ------------------------------------------------------------------
		// The fenced-code copy button (change 24)
		// ------------------------------------------------------------------

		/**
		 * The copy glyph: two overlapping rounded squares, front shut and back
		 * open where the front covers it.
		 *
		 * 14x14 stroked currentColor like the chevrons, not the filled 16x16 idiom
		 * of the tool-row glyphs: this button lives in the markdown header, a
		 * different icon family.
		 */
		const COPY_PATHS = [
			"M4.8 6.2 A1.7 1.7 0 0 1 6.5 4.5 H10.7 A1.7 1.7 0 0 1 12.4 6.2 V10.4 A1.7 1.7 0 0 1 10.7 12.1 H6.5 A1.7 1.7 0 0 1 4.8 10.4 Z",
			"M9.4 4.3 V2.9 A1.4 1.4 0 0 0 8 1.5 H2.9 A1.4 1.4 0 0 0 1.5 2.9 V8 A1.4 1.4 0 0 0 2.9 9.4 H4.2",
		];

		/** The tick: one stroke, same pen. */
		const TICK_PATH = "M2.6 7.4 L5.9 10.7 L11.4 3.6";

		/** Buttons currently showing the tick. By element, so a re-created button
		 * starts unticked without anyone having to say so. */
		const copyTicking = new WeakSet();
		const copyTimers = new WeakMap();

		/** Build the button's icon for `state` ("copy" or "tick"). */
		function copyIcon(state) {
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "14");
			svg.setAttribute("height", "14");
			svg.setAttribute("viewBox", "0 0 14 14");
			svg.setAttribute("fill", "none");
			svg.setAttribute("stroke", "currentColor");
			svg.setAttribute("stroke-width", "1.5");
			svg.setAttribute("stroke-linecap", "round");
			svg.setAttribute("stroke-linejoin", "round");
			svg.setAttribute("aria-hidden", "true");
			svg.setAttribute(COPY_ICON_ATTR, state);
			for (const d of state === "tick" ? [TICK_PATH] : COPY_PATHS) {
				const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
				path.setAttribute("d", d);
				svg.append(path);
			}
			return svg;
		}

		/**
		 * Give every fenced-code copy button its icon. Idempotent.
		 *
		 * Only APPENDED to, never rewritten: the shipped text child is React's
		 * node and it is swapped on every copy toggle, so anything that touches
		 * it breaks the toggle. Our icon is the only child we own; a render that
		 * drops it is noticed by the missing marker and repaired on the next pass
		 * (the observer fires on the render's own mutations).
		 */
		function markCopyButtons() {
			let changed = 0;
			for (const btn of document.querySelectorAll("[data-code-block-banner] button")) {
				const want = copyTicking.has(btn) ? "tick" : "copy";
				const icon = btn.querySelector(":scope > [" + COPY_ICON_ATTR + "]");
				if (icon !== null && icon.getAttribute(COPY_ICON_ATTR) === want) {
					if (tag(btn, COPY_ATTR, "1")) changed += 1;
					continue;
				}
				if (icon !== null) icon.remove();
				btn.append(copyIcon(want));
				if (tag(btn, COPY_ATTR, "1")) changed += 1;
				changed += 1;
			}
			return changed;
		}

		/**
		 * Show the tick when a copy button is pressed, then put the icon back.
		 *
		 * The product's own copy still runs — this listener never prevents
		 * anything, it only decorates. Delegated from the document because code
		 * blocks mount and unmount with virtualisation; a per-button listener
		 * would be re-bound constantly.
		 */
		function installCopyTick() {
			const onClick = (event) => {
				const target = event.target instanceof Element ? event.target : null;
				const btn = target === null ? null : target.closest("[data-code-block-banner] button");
				if (btn === null) return;
				copyTicking.add(btn);
				const pending = copyTimers.get(btn);
				if (pending !== undefined) window.clearTimeout(pending);
				copyTimers.set(btn, window.setTimeout(() => {
					copyTimers.delete(btn);
					copyTicking.delete(btn);
					schedule();
				}, COPY_TICK_MS));
				schedule();
			};
			document.addEventListener("click", onClick);
			return () => document.removeEventListener("click", onClick);
		}

		/**
		 * Strip the word from every `grep` row, keeping its magnifying glass.
		 *
		 * The glyph is already the right one — a glass held over text is what
		 * searching looks like — so only the word goes, exactly as with `read` and
		 * `edit`. Nothing about the colour was asked to change, so nothing does.
		 */
		function markGrepRows() {
			let changed = 0;
			for (const tool of document.querySelectorAll('[data-tool="grep"]')) {
				if (tag(rowLabel(summaryRow(tool)), HIDE_ATTR, "grep")) changed += 1;
			}
			return changed;
		}

		/**
		 * Keep the icon on a failed process row.
		 *
		 * The app swaps the terminal glyph for the status dot when a command fails:
		 * a failed row's idle slot holds the dot and no `<svg>` at all. Hiding the
		 * dot (the rule above) is what was asked for, but on its own it leaves the
		 * slot empty and the row reads as if it lost its icon. So the glyph is put
		 * back as a clone of a HEALTHY row's icon, sitting beside the hidden dot —
		 * the dot stays in the DOM (React holds it and hiding is cheaper than
		 * detaching), and the clone carries a marker so a later pass sees it is
		 * already there.
		 *
		 * The source is found live rather than pinned because the shipped path data
		 * is content, not a contract: cloning whatever healthy icon is on screen
		 * tracks the design system for free. If no healthy process row is mounted
		 * the row simply waits — the next mutation schedules another pass, which
		 * retries. The clone's paths all fill `currentColor`, so it takes the row's
		 * red with no rule of its own.
		 */
		function bashSourceIcon() {
			for (const tool of document.querySelectorAll('[data-variant="bash"]:not([data-state="error"])')) {
				const icon = rowIcon(summaryRow(tool));
				if (icon !== null && icon.getAttribute(BASH_ICON_ATTR) === null) return icon;
			}
			return null;
		}

		function markBashErrorRows() {
			let changed = 0;
			let source = null;
			let lookedUp = false;
			for (const tool of document.querySelectorAll(BASH_ERROR)) {
				const idle = summaryRow(tool).firstElementChild?.firstElementChild ?? null;
				if (idle === null) continue;
				if (idle.querySelector(":scope > [" + BASH_ICON_ATTR + "]") !== null) continue;
				if (!lookedUp) {
					source = bashSourceIcon();
					lookedUp = true;
				}
				if (source === null) continue;
				const clone = source.cloneNode(true);
				clone.setAttribute(BASH_ICON_ATTR, "1");
				idle.append(clone);
				changed += 1;
			}
			return changed;
		}

		/**
		 * Remove the separator dots between a row's label and its content.
		 *
		 * These are the product's own separator spans: an empty
		 * `<span aria-hidden="true">`, rendered as a 2x2 dot, emitted by the
		 * disclosure row between the title and whatever follows it. They are found
		 * structurally — empty, `aria-hidden`, no element children, a DIRECT child
		 * of a disclosure row — because the class that draws them is a build hash.
		 * The `aria-hidden` and emptiness checks together are what keep this from
		 * touching a control or a glyph.
		 */
		function markSeparators() {
			let changed = 0;
			for (const row of document.querySelectorAll(DISCLOSURE_ROW)) {
				for (const el of row.children) {
					if (el.tagName !== "SPAN") continue;
					if (el.getAttribute("aria-hidden") !== "true") continue;
					if (el.children.length !== 0 || (el.textContent ?? "") !== "") continue;
					if (tag(el, DOT_ATTR, "1")) changed += 1;
				}
			}
			return changed;
		}

		/**
		 * Paint injected context blue.
		 *
		 * The product renders these through its `ContextInjectionRow`, and the only
		 * stable markers it publishes are on the row's CONTENT rather than on the
		 * row: `data-context-source` on the source label, `data-context-summary` on
		 * the one-line preview, and `data-context-injection-body` on the expanded
		 * body. The row element itself carries only a hashed class, so the content
		 * elements are addressed directly and the row never needs naming.
		 *
		 * Blue for the same reason inline code is blue: this is quoted material —
		 * the harness talking, or a skill catalog — not the user speaking.
		 */
		function markContextRows() {
			let changed = 0;
			for (const el of document.querySelectorAll("[data-context-source],[data-context-summary],[data-context-files],[data-context-injection-body]")) {
				if (tag(el, CTX_ATTR, "1")) changed += 1;
			}
			return changed;
		}

		/**
		 * Push each row's CONTENT brighter than its TITLE.
		 *
		 * The shipped emphasis is backwards for reading a transcript: the title
		 * ("pwsh", "Tool call") is full-strength label text and the content that
		 * says what actually happened is `label-tertiary`, so the eye stops on the
		 * tool's name and skips the work. This swaps the two.
		 *
		 * The file link is a `<button>`, and `rowPreview` deliberately skips
		 * controls, so it is tagged separately — it is the content of every row that
		 * names a file.
		 */
		function markContrast() {
			let changed = 0;
			for (const row of document.querySelectorAll(DISCLOSURE_ROW)) {
				const label = rowLabel(row);
				if (label === null) continue;
				if (tag(label, DIM_ATTR, "1")) changed += 1;
				if (tag(rowPreview(row, label), BRIGHT_ATTR, "1")) changed += 1;
			}
			for (const tool of document.querySelectorAll("[data-tool]")) {
				if (tag(summaryRow(tool).querySelector("button"), BRIGHT_ATTR, "link")) changed += 1;
			}
			return changed;
		}

		// ------------------------------------------------------------------
		// The turn tail (change 7)
		// ------------------------------------------------------------------

		/**
		 * Make the tail's clock the elapsed-time control, and drop what it replaces.
		 *
		 * Four things happen, and the third is the one that needed care:
		 *
		 *   1. The Like/Dislike pair is hidden.
		 *   2. The separate usage button is hidden — but KEPT IN THE DOM, because a
		 *      hidden element still receives `.click()`, and that is the only way to
		 *      open its dialog from outside React.
		 *   3. The clock's label is forced visible, and a CAPTURE-phase listener on
		 *      the clock swallows the click and forwards it to the usage button —
		 *      so the usage dialog opens and the clock's own time dialog never does.
		 *      Capture matters: React delegates its handlers at the root, so a
		 *      listener in the capture phase reaches the event first and
		 *      `stopImmediatePropagation` keeps it from ever reaching that root.
		 *   4. The usage button is re-resolved at click time rather than closed over,
		 *      because a re-render replaces the node and a captured reference would
		 *      quietly become a detached element that does nothing.
		 *
		 * The two dialog triggers are told apart by ORDER — the product renders the
		 * usage panel before the time panel, and both are `aria-haspopup="dialog"`
		 * with no accessible name. A tail with fewer than two is left entirely alone
		 * rather than guessed at, so a turn reporting no usage keeps its working
		 * clock instead of losing its click to nothing.
		 */
		function markTurnTail() {
			let changed = 0;
			for (const tail of document.querySelectorAll("[data-turn-tail]")) {
				for (const button of tail.querySelectorAll('button[aria-label="Good response"],button[aria-label="Bad response"]')) {
					if (tag(button, HIDE_ATTR, "feedback")) changed += 1;
				}
				const dialogs = [...tail.querySelectorAll('button[aria-haspopup="dialog"]')];
				if (dialogs.length < 2) continue;
				if (tag(dialogs[dialogs.length - 2], HIDE_ATTR, "usage")) changed += 1;
				const clock = dialogs[dialogs.length - 1];
				if (tag(clock, TIME_ATTR, "1")) changed += 1;
				// Show the measurement, not a sentence about it.
				const label = clock.querySelector("span");
				if (label !== null) {
					// The elapsed time is pink, matching the file list's names.
					if (tag(label, PINK_ATTR, "time")) changed += 1;
					const full = (label.textContent ?? "").trim();
					const found = DURATION_RE.exec(full);
					const want = found === null ? full : found[0].trim();
					if (want !== "" && want !== full) {
						const node = [...label.childNodes].find((n) => n.nodeType === 3);
						if (node === undefined) label.textContent = want;
						else node.nodeValue = want;
						changed += 1;
					}
				}
				if (clock.dataset.dshCcWired === "1") continue;
				clock.dataset.dshCcWired = "1";
				clock.addEventListener(
					"click",
					(event) => {
						event.preventDefault();
						event.stopImmediatePropagation();
						const live = [...tail.querySelectorAll('button[aria-haspopup="dialog"]')];
						const usage = live[live.length - 2];
						if (usage !== undefined) usage.click();
					},
					true,
				);
				changed += 1;
			}
			return changed;
		}

		// ------------------------------------------------------------------
		// The composer (change 7)
		// ------------------------------------------------------------------

		/**
		 * Hide the composer's placeholder WITHOUT touching its attribute.
		 *
		 * The product draws this placeholder twice, and only one of them is a
		 * pseudo-element: there is a `::before` fed by the input's own
		 * `data-placeholder`, AND a real sibling element holding the same string as
		 * ordinary text. Suppressing the pseudo-element alone left the text on
		 * screen, which is exactly what happened on the first attempt here.
		 *
		 * The element is found by comparing its text against the attribute the
		 * product itself publishes, so nothing depends on a hashed class or on the
		 * placeholder's language.
		 */
		function markComposerPlaceholder() {
			let changed = 0;
			for (const input of document.querySelectorAll("[data-placeholder]")) {
				const want = (input.getAttribute("data-placeholder") ?? "").trim();
				const holder = input.parentElement;
				if (holder === null || want === "") continue;
				for (const el of holder.children) {
					if (el === input) continue;
					if (el.children.length !== 0) continue;
					if ((el.textContent ?? "").trim() !== want) continue;
					if (tag(el, HIDE_ATTR, "placeholder")) changed += 1;
				}
			}
			return changed;
		}

		/**
		 * Bold text takes the OTHER colour.
		 *
		 * Lavender inside the white dialogues, full white inside a lavender closing
		 * message, so emphasis reads by contrast rather than by weight alone.
		 *
		 * DONE IN JS RATHER THAN CSS, and that is not a preference. The per-element
		 * lavender rule has to out-specify markdown's own block rules, which leaves it
		 * at `(0,3,3)` — and a plain `[lavender] strong` rule is `(0,1,1)`, so it lost
		 * and bold stayed lavender on lavender. Matching that specificity in CSS means
		 * repeating the whole `:not()` chain for every case; an inline declaration
		 * marked important outranks every author rule whatever its specificity, so the
		 * outcome is the same on every row instead of depending on a selector sum.
		 */
		function markBold() {
			const root = getComputedStyle(document.body);
			const white = root.getPropertyValue("--dsw-alias-label-primary").trim();
			const lavender = root.getPropertyValue("--dsh-cc-lavender").trim();
			if (white === "" || lavender === "") return 0;
			let changed = 0;
			for (const message of document.querySelectorAll(ASSISTANT_STEP + "," + USER_STEP)) {
				const closing = message.closest("[" + LAVENDER_ATTR + "]") !== null;
				const want = closing ? white : lavender;
				for (const bold of message.querySelectorAll("strong,b")) {
					// The reasoning keeps its own colour, as everywhere else.
					if (bold.closest("[" + THINK_ATTR + "]") !== null) continue;
					if (bold.style.getPropertyValue("color") === want && bold.style.getPropertyPriority("color") === "important") continue;
					bold.style.setProperty("color", want, "important");
					changed += 1;
				}
			}
			return changed;
		}

		// ------------------------------------------------------------------
		// The closing message (change 8)
		// ------------------------------------------------------------------

		/**
		 * Mark the assistant's CLOSING message for each turn, which renders lavender.
		 *
		 * A turn's steps and its tail share `data-chat-turn`, so the closing message
		 * is the LAST `assistant-step` of that turn — the one the tail follows. Only
		 * that one is tagged: the steps before it are working notes and tool chatter,
		 * and leaving them alone is what makes the closing message read as the answer
		 * rather than as one more paragraph.
		 */
		function markFinalAnswer() {
			let changed = 0;
			for (const tail of document.querySelectorAll("[data-turn-tail]")) {
				const turn = tail.getAttribute("data-turn-tail");
				if (turn === null) continue;
				const steps = document.querySelectorAll(
					'[data-chat-flow-kind="assistant-step"][data-chat-turn="' + turn + '"]',
				);
				const last = steps[steps.length - 1];
				if (last === undefined) continue;
				if (tag(last, LAVENDER_ATTR, "answer")) changed += 1;
			}
			return changed;
		}

		// ------------------------------------------------------------------
		// How a file name reads (change 10)
		// ------------------------------------------------------------------

		/** A shared 2D context, used only to measure text without touching layout. */
		let measureCtx = null;

		/** The rendered width of `text` in `font`, via canvas rather than the DOM. */
		function textWidth(text, font) {
			if (measureCtx === null) measureCtx = document.createElement("canvas").getContext("2d");
			measureCtx.font = font;
			return measureCtx.measureText(text).width;
		}

		/**
		 * The longest TAIL of a path that fits `budget`, behind a leading ellipsis.
		 *
		 * NOT a fixed depth. The row's link grows to fill its line, so a wide window
		 * has room for more of the path than a narrow one, and hard-coding "two
		 * segments" would throw that room away. The whole tail is tried first, then
		 * progressively shorter ones, and the first that fits wins — so the name uses
		 * the line it is actually given.
		 *
		 * Returns null when the full path already fits (nothing to do) or when the
		 * path is too shallow to shorten meaningfully.
		 */
		function fitPath(full, budget, measure) {
			const parts = full.split(/[\\/]/u).filter((p) => p !== "");
			if (parts.length <= 2) return null;
			for (let take = parts.length; take >= 1; take -= 1) {
				const tail = parts.slice(-take).join("/");
				if (take === parts.length) {
					if (measure(tail) <= budget) return null;
					continue;
				}
				const text = ".../" + tail;
				if (measure(text) <= budget) return text;
			}
			return ".../" + parts[parts.length - 1];
		}

		/**
		 * Show as much of the END of a path as the row has room for.
		 *
		 * The row's link is a nowrap element with a trailing ellipsis, so a deep path
		 * renders as its ROOT and then the ellipsis — `C:\Users\admin\AppData\…` —
		 * naming the one part that identifies nothing about the change. This rewrites
		 * the text to the longest tail that fits, so the row says which FILE changed.
		 *
		 * THE FULL PATH IS REMEMBERED ON THE ELEMENT the first time it is seen. Once
		 * the text has been shortened the full path is no longer in the DOM, and a
		 * pass that only had the short form could never grow it back when the window
		 * widens — it would ratchet permanently shorter.
		 *
		 * Rewritten IN PLACE, like the other text the product owns: React compares the
		 * string it wants against the string it last rendered, finds them equal, and
		 * skips the write — so the short form survives a re-render, and is re-applied
		 * if the path underneath ever actually changes.
		 */
		function markFileNames() {
			let changed = 0;
			for (const tool of document.querySelectorAll("[data-tool]")) {
				const link = summaryRow(tool).querySelector("button");
				if (link === null) continue;
				const current = (link.textContent ?? "").trim();
				if (link.dataset.dshCcFull === undefined) {
					if (current === "") continue;
					link.dataset.dshCcFull = current;
				}
				const style = getComputedStyle(link);
				const budget = link.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
				if (!(budget > 0)) continue;
				const font = style.font === "" ? `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}` : style.font;
				const want = fitPath(link.dataset.dshCcFull, budget, (text) => textWidth(text, font)) ?? current;
				if (want === current) continue;
				const node = [...link.childNodes].find((n) => n.nodeType === 3);
				if (node === undefined) link.textContent = want;
				else node.nodeValue = want;
				changed += 1;
			}
			return changed;
		}

		// ------------------------------------------------------------------
		// Folding a finished turn's work (change 9)
		// ------------------------------------------------------------------

		/**
		 * The flow kinds that are WORK, and therefore foldable.
		 *
		 * THIS LIST IS THE WHOLE SAFETY OF THE FEATURE. The first version folded
		 * "everything in the turn except the closing assistant step", which sounds
		 * equivalent and is not: the USER's own messages and the turn's TAIL are flow
		 * items carrying the same `data-chat-turn`, so that version hid the person's
		 * own bubbles and the end-of-turn separator with its buttons and elapsed time
		 * — the entire visible transcript, in exchange for showing an answer. The fold
		 * is allowed to hide what the turn DID, never who said what or how it ended.
		 *
		 * Injected context (`context`) folds with the work: it is harness chatter
		 * about what the turn ran on, and once the turn settles it reads as part of
		 * the closing message if left beside it.
		 */
		const WORK_KINDS = new Set(["tool-call", "turn-process", "assistant-step", "context"]);

		/**
		 * The flow items of one turn that count as WORK — everything it did before it
		 * answered.
		 *
		 * The closing message is excluded, because it is the thing the fold exists to
		 * reveal. Everything outside {@link WORK_KINDS} is left alone.
		 *
		 * Thinking that sits INSIDE the closing step is folded as well. It is work
		 * wherever it lives, and leaving it would strand a thought above the answer it
		 * produced.
		 */
		function turnWork(turn) {
			const items = [...document.querySelectorAll('[data-chat-flow-kind][data-chat-turn="' + turn + '"]')].filter((el) =>
				WORK_KINDS.has(el.getAttribute("data-chat-flow-kind")),
			);
			const steps = items.filter((el) => el.getAttribute("data-chat-flow-kind") === "assistant-step");
			const closing = steps[steps.length - 1] ?? null;
			return {
				closing,
				work: items.filter((el) => el !== closing),
				thoughts: closing === null ? [] : [...closing.querySelectorAll('[data-variant="think"]')],
			};
		}

		/** Hide or show one turn's work, and keep its strip in step. Idempotent. */
		function applyFold(turn, folded) {
			const { work, thoughts } = turnWork(turn);
			const all = [...work, ...thoughts];
			if (all.length === 0) return 0;
			let changed = 0;
			for (const el of all) {
				if (folded) {
					if (tag(el, FOLD_ATTR, "1")) changed += 1;
				} else if (el.getAttribute(FOLD_ATTR) !== null) {
					el.removeAttribute(FOLD_ATTR);
					changed += 1;
				}
			}
			changed += folded ? ensureFoldStrip(turn, all[0], all.length) : removeFoldStrip(turn);
			return changed;
		}

		/** Every strip belonging to `turn`, wherever React has re-created its parent. */
		function stripsOf(turn) {
			return [...document.querySelectorAll("[" + FOLD_STRIP_ATTR + '="' + turn + '"]')];
		}

		/** Drop a turn's strip, reporting whether any existed. */
		function removeFoldStrip(turn) {
			const strips = stripsOf(turn);
			for (const strip of strips) strip.remove();
			return strips.length;
		}

		/**
		 * How long the turn took, as the tail already renders it.
		 *
		 * Read from the tail's own clock label rather than recomputed from turn times:
		 * the product owns that formatting, and a second formatter here would sooner or
		 * later disagree with the one printed a few lines below it.
		 */
		function turnDuration(turn) {
			const tail = document.querySelector('[data-turn-tail="' + turn + '"]');
			if (tail === null) return null;
			const clock = tail.querySelector("[" + PINK_ATTR + '="time"]');
			const text = clock === null ? "" : (clock.textContent ?? "").trim();
			return text === "" ? null : text;
		}

		/**
		 * The strip's label, and the element that carries the time.
		 *
		 * "Worked for 3m 11s", with the duration in the same pink the tail's clock uses.
		 * When the turn has no clock to read — a tail that rendered without its usage
		 * and time panels has no duration anywhere in the DOM — the label is just
		 * "Worked" rather than a sentence about a missing number.
		 */
		function stripLabel(turn) {
			const label = document.createElement("span");
			const duration = turnDuration(turn);
			if (duration === null) {
				label.append("Worked");
				return label;
			}
			label.append("Worked for ");
			const time = document.createElement("span");
			time.setAttribute(PINK_ATTR, "1");
			time.textContent = duration;
			label.append(time);
			return label;
		}

		/** The plain text the strip should be showing, for comparison. */
		function desiredStripText(turn) {
			const duration = turnDuration(turn);
			return duration === null ? "Worked" : "Worked for " + duration;
		}

		/**
		 * Put a turn's strip immediately before the work it stands in for.
		 *
		 * The strip is the DESKTOP half of the toggle — the mobile half is the hold
		 * gesture, because a narrow viewport gives that left edge to the rail. See the
		 * stylesheet, which removes the strip under 700px rather than shrinking it.
		 */
		function ensureFoldStrip(turn, anchor, hidden) {
			void hidden;
			const parent = anchor === null || anchor === undefined ? null : anchor.parentElement;
			if (parent === null) return 0;
			const existing = stripsOf(turn)[0] ?? null;
			if (existing !== null) {
				// Rebuilt rather than patched: the duration lands when the tail's clock is
				// marked, which can be after the strip was created, and the label changes
				// SHAPE at that point — from "Worked" to "Worked for <time>". Comparing
				// the whole text catches both that and a plain change of duration.
				if ((existing.textContent ?? "").trim() !== desiredStripText(turn)) {
					existing.replaceChildren(stripLabel(turn));
					return 1;
				}
				return 0;
			}
			const strip = document.createElement("button");
			strip.type = "button";
			strip.setAttribute(FOLD_STRIP_ATTR, turn);
			strip.setAttribute("aria-label", "Show what this turn did before it answered");
			strip.append(stripLabel(turn));
			strip.addEventListener("click", (event) => {
				event.stopPropagation();
				foldState.set(turn, "opened");
				// The next pass re-applies the remembered state and clears the rest.
				schedule();
			});
			parent.insertBefore(strip, anchor);
			return 1;
		}

		/**
		 * Fold every finished turn that has not been folded yet, and re-apply what the
		 * person chose for the rest.
		 *
		 * "Finished" is read from turn ORDER, not from the tail alone. Reading only the
		 * tail was wrong and measurably so: the conversation virtualises, so an older
		 * finished turn can have no tail in the DOM at all, and its work was left
		 * standing while the turns around it folded. Document order is chronological,
		 * so every turn except the newest is finished, and the newest is finished
		 * exactly when its tail has rendered — which is also what keeps a turn that is
		 * still producing output open.
		 */
		function markFolds() {
			const ordered = [];
			for (const el of document.querySelectorAll("[data-chat-turn]")) {
				const turn = el.getAttribute("data-chat-turn");
				if (turn !== null && !ordered.includes(turn)) ordered.push(turn);
			}
			if (ordered.length === 0) return 0;
			const tailed = new Set(
				[...document.querySelectorAll("[data-turn-tail]")].map((t) => t.getAttribute("data-turn-tail")),
			);
			const newest = ordered[ordered.length - 1];
			let changed = 0;
			for (const turn of ordered) {
				if (turn === newest && !tailed.has(turn)) continue;
				if (!foldState.has(turn)) foldState.set(turn, "folded");
				changed += applyFold(turn, foldState.get(turn) === "folded");
			}
			return changed;
		}

		/**
		 * Holding a tool or thought row folds its turn's work away.
		 *
		 * Delegated from the document rather than bound per row: the conversation
		 * virtualises its rows, so a listener per row would be re-bound constantly. The
		 * press is cancelled by release or by any scroll-away, and a press that fired
		 * swallows the click it would otherwise produce — otherwise folding a row would
		 * also open it, which is the opposite of what the gesture means.
		 */
		function installFoldGesture() {
			let timer = null;
			let fired = false;
			// A touch press that is still down on a foldable row, and the pointer
			// that owns it. While set, the row is unselectable and the native
			// long-press menu is suppressed: on touch the 500ms hold below IS the
			// OS text-selection gesture, so without this the fold fires and the row
			// comes up selected with the callout open. Scoped to touch only — a
			// mouse right-click must keep its menu.
			let pressRow = null;
			let pressId = null;
			let savedSelect = "";
			let savedCallout = "";
			const unarm = () => {
				if (pressRow !== null) {
					pressRow.style.userSelect = savedSelect;
					pressRow.style.webkitTouchCallout = savedCallout;
					pressRow = null;
					pressId = null;
				}
			};
			const start = (event) => {
				const target = event.target instanceof Element ? event.target : null;
				const row = target === null ? null : target.closest("[data-tool],[data-variant='think']");
				if (row === null) return;
				if (event.pointerType === "touch") {
					unarm();
					pressRow = row;
					pressId = event.pointerId;
					savedSelect = row.style.userSelect;
					savedCallout = row.style.webkitTouchCallout;
					row.style.userSelect = "none";
					row.style.webkitTouchCallout = "none";
				}
				fired = false;
				timer = window.setTimeout(() => {
					timer = null;
					const holder = row.closest("[data-chat-turn]");
					if (holder === null) return;
					fired = true;
					foldState.set(holder.getAttribute("data-chat-turn"), "folded");
					markFolds();
					// Whatever the hold selected on its way down goes: the gesture
					// meant "fold", so a fresh selection is its leftover, not the
					// person's intent.
					const sel = document.getSelection();
					if (sel !== null) sel.removeAllRanges();
				}, FOLD_HOLD_MS);
			};
			const cancel = (event) => {
				if (event !== undefined && event.pointerId !== undefined && event.pointerId !== pressId && pressId !== null) return;
				if (timer === null && pressRow === null) return;
				if (timer !== null) {
					window.clearTimeout(timer);
					timer = null;
				}
				unarm();
			};
			const swallow = (event) => {
				if (!fired) return;
				fired = false;
				event.preventDefault();
				event.stopPropagation();
			};
			// The long-press callout is a separate event from the click, so the
			// swallow above never sees it. Suppressed while a touch press is down
			// on a foldable row (or just fired one) — a tap never produces this
			// event, so taps are unaffected, and mouse right-clicks never arm the
			// press above, so their menu survives.
			const swallowMenu = (event) => {
				if (pressRow === null && !fired) return;
				event.preventDefault();
				event.stopPropagation();
			};
			document.addEventListener("pointerdown", start, true);
			document.addEventListener("pointerup", cancel, true);
			document.addEventListener("pointercancel", cancel, true);
			document.addEventListener("scroll", cancel, true);
			document.addEventListener("click", swallow, true);
			document.addEventListener("contextmenu", swallowMenu, true);
			return () => {
				cancel();
				document.removeEventListener("pointerdown", start, true);
				document.removeEventListener("pointerup", cancel, true);
				document.removeEventListener("pointercancel", cancel, true);
				document.removeEventListener("scroll", cancel, true);
				document.removeEventListener("click", swallow, true);
				document.removeEventListener("contextmenu", swallowMenu, true);
			};
		}

		// ------------------------------------------------------------------
		// Wiring
		// ------------------------------------------------------------------

		/** One reconciliation pass over the whole document. */
		function reconcile() {
			if (typeof document === "undefined" || document.body === null) return 0;
			// Re-derived every pass so a theme switch re-bakes the contrast values.
			ensureStyles();
			return splitAllStats() + paintPanels() + markThinking() + markTrajectory() + markWriteRows() + markEditRows() + markReadRows() + markGrepRows() + markSeparators() + markContextRows() + markContrast() + markTurnTail() + markComposerPlaceholder() + markFinalAnswer() + markFileNames() + markFolds() + markBold() + markBashErrorRows() + markPresentedFiles() + markCopyButtons();
		}

		let scheduled = null;

		/** Coalesce a burst of mutations into one pass. */
		function schedule() {
			if (scheduled !== null) return;
			scheduled = window.setTimeout(() => {
				scheduled = null;
				reconcile();
			}, FLUSH_MS);
		}

		/**
		 * Watch the document and keep the three behaviours applied.
		 *
		 * `characterData` matters as much as `childList`: the shipped statistic is a
		 * text node React rewrites in place, so a re-render can change the number
		 * without adding or removing a single element.
		 */
		function install() {
			reconcile();
			const observer = new MutationObserver(schedule);
			observer.observe(document.body, { childList: true, subtree: true, characterData: true });
			return () => {
				observer.disconnect();
				if (scheduled !== null) {
					window.clearTimeout(scheduled);
					scheduled = null;
				}
			};
		}

		const inject = [];

		function apply(ctx) {
			ensureStyles();
			if (typeof window !== "undefined") {
				window.__dshCodeColors = {
					version: VERSION,
					/** Run a pass now, and report what it changed. */
					scan: () => reconcile(),
					/** What a pass would find, without changing anything. */
					report: () => {
						const stats = [...document.querySelectorAll(TOOL_SELECTOR)].map((tool) => {
							const stat = findStat(tool);
							return {
								tool: tool.dataset.tool,
								state: tool.dataset.state,
								file: toolFile(tool),
								raw: stat === null ? null : statValue(stat),
								split: stat === null ? null : stat.getAttribute(SPLIT_ATTR) === "1",
							};
						});
						const panels = [...document.querySelectorAll(TURN_TAIL)].map((tail) => {
							const row = tail.querySelector(PRODUCED_ROW);
							return {
								turn: tail.getAttribute("data-chat-turn"),
								chips: row === null ? 0 : row.querySelectorAll("button[title]").length,
								counts: row === null ? [] : [...row.querySelectorAll("[" + COUNT_ATTR + "]")].map((h) => h.textContent),
							};
						});
						const sage = getComputedStyle(document.body).getPropertyValue("--dsh-cc-sage").trim();
						const thinking = [...document.querySelectorAll("[" + THINK_ATTR + "]")].map((el) => ({
							role: el.getAttribute(THINK_ATTR),
							text: (el.textContent ?? "").trim().slice(0, 40),
							color: getComputedStyle(el).color,
							sage,
						}));
						const writes = [...document.querySelectorAll('[data-tool="write"]')].map((tool) => {
							const row = summaryRow(tool);
							const label = rowLabel(row);
							const icon = rowIcon(row);
							return {
								state: tool.dataset.state,
								label: label === null ? null : (label.textContent ?? "").trim(),
								labelHidden: label !== null && getComputedStyle(label).display === "none",
								labelColor: label === null ? null : getComputedStyle(label).color,
								nameColor: (() => {
									const name = row.querySelector("button");
									return name === null ? null : getComputedStyle(name).color;
								})(),
								iconMarked: icon !== null && icon.getAttribute(WRITE_ATTR) === "icon",
								iconColor: icon === null ? null : getComputedStyle(icon).color,
								iconPath: icon === null ? null : (icon.querySelector("path")?.getAttribute("d") ?? "").slice(0, 24),
							};
						});
						return {
							version: VERSION,
							inlineCode: document.querySelectorAll(":not(pre) > code").length,
							stats,
							panels,
							sage,
							thinking,
							writes,
						};
					},
				};
			}
			// A document-wide observer plus one initial pass, plus the fold gesture,
			// which is a document-level listener and unwinds with the same effect.
			ctx.effect(() => install(), "dsh-code-colors: dom watch");
			ctx.effect(() => installFoldGesture(), "dsh-code-colors: fold gesture");
			ctx.effect(() => installCopyTick(), "dsh-code-colors: copy tick");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.VERSION = VERSION;
		exports.STAT_RE = STAT_RE;
		exports.foldPath = foldPath;
		exports.tallyFor = tallyFor;
		exports.findStat = findStat;
		exports.statValue = statValue;
		exports.splitStat = splitStat;
		exports.markThinking = markThinking;
		exports.markTrajectory = markTrajectory;
		exports.markWriteRows = markWriteRows;
		exports.markEditRows = markEditRows;
		exports.markReadRows = markReadRows;
		exports.markGrepRows = markGrepRows;
		exports.markSeparators = markSeparators;
		exports.markContextRows = markContextRows;
		exports.ensureCollapseStrip = ensureCollapseStrip;
		exports.isCreation = isCreation;
		exports.rowIcon = rowIcon;
		exports.rowLabel = rowLabel;
		exports.EYE_PATH = EYE_PATH;
		exports.redrawGlyph = redrawGlyph;
		exports.markBold = markBold;
		exports.markContrast = markContrast;
		exports.markTurnTail = markTurnTail;
		exports.markComposerPlaceholder = markComposerPlaceholder;
		exports.markFinalAnswer = markFinalAnswer;
		exports.markFileNames = markFileNames;
		exports.fitPath = fitPath;
		exports.markFolds = markFolds;
		exports.turnWork = turnWork;
		return module.exports;
	},
});
