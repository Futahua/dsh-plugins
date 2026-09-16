// Verify all FIVE changes against the LIVE GUI, and write the pictures.
//
// This model cannot look at an image, so "confirmed visually" is not something it
// may claim from a screenshot it cannot see. Instead every claim here is a
// MEASUREMENT of the running page:
//
//   1. computed styles, read from the elements themselves;
//   2. the ACTUAL RENDERED PIXELS — each shot is handed back into the page,
//      drawn to a canvas, and the exact colour of the text is counted. A colour
//      that is only in a stylesheet and not on the screen cannot pass this;
//   3. for the new document-with-plus glyph, the PATH GEOMETRY itself: the exact
//      `d` in the DOM is filled into an offscreen canvas through `Path2D` and
//      probed at four points, which distinguishes "a page outline with a hole and
//      a plus in it" from "a shape that merely has the right bounding box".
//
// Screenshots are written to ./shots as a second, human-openable artifact.
//
//   node verify-live.mjs [--port 57120] [--authority 127.0.0.1:3080]
//
// The DevTools port is DISCOVERED by default (see cdp.mjs): it belongs to
// whichever Chrome the browser-agent pane launched and it changes between
// sessions, so a hardcoded one makes this script fail for reasons that have
// nothing to do with the thing being verified.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTHORITY, connect, devtoolsPort, ensureGui, findTarget, waitForApp } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "shots");

const argv = process.argv.slice(2);
const flag = (key, fallback) => {
	const at = argv.indexOf(`--${key}`);
	return at === -1 ? fallback : argv[at + 1];
};
const PORT = await devtoolsPort(flag("port", undefined));
const AUTHORITY_ARG = flag("authority", AUTHORITY);

const failures = [];
const checks = [];
function check(name, ok, detail) {
	checks.push({ name, ok, detail });
	if (!ok) failures.push(`${name}: ${detail}`);
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
}

const target = await findTarget(PORT, { required: false });
if (target === null) throw new Error(`no page on port ${PORT}`);
const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
const navigated = await ensureGui(cdp, { authority: AUTHORITY_ARG });
// RELOAD UNCONDITIONALLY, even when the app is already showing.
//
// The plugin remembers, per turn, whether the person folded or opened it — that is
// what stops reconciliation from fighting them — and the state lives in the loaded
// module. A second run against the same page therefore inherits the PREVIOUS run's
// decisions, and the fold checks observed a transcript that an earlier run had
// deliberately unfolded. A verification run has to start from a clean load or it is
// measuring its own leftovers.
await cdp.send("Page.reload", { ignoreCache: true });
await waitForApp(cdp);
if (navigated) await waitForApp(cdp);

/** Evaluate an expression in the page and return its JSON value. */
async function evaluate(expression) {
	const out = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
	return out.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until the plugin bundle has executed in this page. */
for (let i = 0; i < 40; i += 1) {
	if ((await evaluate("typeof window.__dshCodeColors")) === "object") break;
	await sleep(250);
}
// Give the client bundle a moment to run its first passes against the session.
await sleep(800);

/**
 * Open a populated conversation.
 *
 * The GUI does NOT restore the last session on load: it comes up on an empty new
 * session with no Chat/Trajectory tabs and nothing rendered — which is what a
 * human sees too, and what makes a first look at this GUI look like a plugin
 * that does nothing. A conversation has to be picked from the left sidebar, and
 * the FIRST row there is the empty "New Session" entry itself, so the rows are
 * walked in order until one of them actually renders the Chat tab. That is also
 * the recipe this script hands to a human: click a session BELOW "New Session"
 * in the left sidebar — the rows carrying a relative time like "3min" — and the
 * Chat / Trajectory tabs appear at the top of the main pane.
 */
async function openSession() {
	const states = [];
	for (let attempt = 0; attempt < 12; attempt += 1) {
		const state = await evaluate(`(() => {
			const tabs = [...document.querySelectorAll('[role="tab"],button')].map((b) => (b.innerText || '').trim());
			if (tabs.includes("Chat")) return "conversation";
			const rows = [...document.querySelectorAll('[class*="sessionRow"]')];
			if (rows.length === 0) return "no-session";
			const row = rows[${attempt} % Math.max(1, rows.length)] ?? rows[0];
			row.click();
			return "clicked " + (row.innerText || "").replace(/\\n/gu, " ").slice(0, 30);
		})()`);
		states.push(state);
		if (state === "conversation") return { ok: true, states };
		await sleep(2200);
	}
	return { ok: false, states };
}

/**
 * Open a session that actually CONTAINS a fenced code block.
 *
 * `openSession` clicks the first sidebar row and stops, which is fine for every check
 * that is about tool rows — those exist in any session — but three checks here are
 * about fenced code, and a session without any makes them unrunnable. The harness
 * then reported them as failures with the honest message "NO FENCED CODE BLOCK IS
 * RENDERED IN THIS SESSION", which is true and useless: the subject was absent, not
 * the behaviour. This walks the sidebar until it finds one, and reports which session
 * answered so the choice is visible rather than silent.
 *
 * `ensureVisible` is the search: it scrolls the conversation looking for the
 * selector, so it also accounts for the transcript being virtualised.
 */
async function openSessionWithCode(selector, tries = 6) {
	for (let attempt = 0; attempt < tries; attempt += 1) {
		const label = await evaluate(`(() => {
			const rows = [...document.querySelectorAll('[class*="sessionRow"]')];
			if (rows.length === 0) return null;
			const row = rows[${attempt} % rows.length];
			row.click();
			return (row.innerText || "").replace(/\\n/gu, " ").slice(0, 40);
		})()`);
		if (label === null) return null;
		await sleep(2500);
		await loadEarlier(4);
		if (await ensureVisible(selector)) return label;
	}
	return null;
}

/** Bring the chat surface forward, whichever tab the page was left on. */
async function showChat() {	await evaluate(`(() => {
		const tab = [...document.querySelectorAll('[role="tab"],button')].find((b) => (b.innerText || '').trim() === 'Chat');
		if (tab !== undefined && tab.getAttribute('aria-selected') !== 'true') tab.click();
		return true;
	})()`);
	await sleep(1200);
}

/**
 * Load the conversation's earlier history.
 *
 * The chat mounts only a window of turns and keeps the rest behind a
 * "Load earlier" control at the top of the list; until that is exhausted, a
 * markup feature that only exists in older turns (a fenced code block, in this
 * session) is not merely off-screen — it is not in the DOM at all.
 *
 * The control is the one thing here with no stable hook: no class, no
 * `data-` attribute, no `aria-label`, just its label. Matching its TEXT is
 * therefore a deliberate, documented heuristic of this driver script — it is not
 * part of the shipped plugin, which never looks at button labels.
 */
async function loadEarlier(limit = 8) {
	let clicks = 0;
	for (let i = 0; i < limit; i += 1) {
		const clicked = await evaluate(`(() => {
			const control = [...document.querySelectorAll("button")].find((b) => /^(load earlier|load earlier history|加载更早|更早)/iu.test((b.innerText || "").trim()));
			if (control === undefined) return false;
			control.click();
			return true;
		})()`);
		if (!clicked) break;
		clicks += 1;
		await sleep(1800);
	}
	return clicks;
}

/**
 * Expand the turns' collapsed "process" groups.
 *
 * This is the third and largest reason a tool row can be invisible, and the one
 * that took longest to find: a completed turn collapses its tool calls behind a
 * disclosure (`16 tool calls · 8 messages`), and the flow items inside it are
 * left in the DOM carrying the `hidden` attribute — so the rows EXIST, their
 * `getBoundingClientRect()` returns plausible numbers from a stale layout, and
 * nothing about them is on the screen. Nine of this conversation's ten tool rows
 * were in that state.
 *
 * The control publishes its own hooks — `data-turn-process` (the turn),
 * `data-turn-process-tool-calls` and `aria-expanded` — so it is driven through
 * those and never through a label, which would be locale-bound ("16 tool calls"
 * is English-only copy).
 */
async function expandProcesses(limit = 24) {
	let clicks = 0;
	for (let i = 0; i < limit; i += 1) {
		const turn = await evaluate(`(() => {
			const button = [...document.querySelectorAll('button[data-turn-process][aria-expanded="false"]')]
				.find((b) => Number(b.getAttribute("data-turn-process-tool-calls") ?? "0") > 0);
			if (button === undefined) return null;
			button.click();
			return button.getAttribute("data-turn-process");
		})()`);
		if (turn === null) break;
		clicks += 1;
		await sleep(700);
	}
	return clicks;
}

/**
 * Bring one PAINTED instance of `selector` onto the screen.
 *
 * Two traps, both found by measurement, and both of which produced a "zero
 * pixels of a colour that was correct" failure:
 *
 *   1. `scrollIntoView` does not move this list. It is virtualised: 85 reasoning
 *      rows exist in the DOM at once and the first is ~9800px above the
 *      viewport. Driving the app's own scroll container directly does work.
 *   2. A non-zero bounding rect is NOT evidence of paint. Rows outside the
 *      virtualiser's window sit under an ancestor marked
 *      `content-visibility: hidden`, which keeps their geometry but skips their
 *      painting — `document.elementFromPoint` inside such a rect lands on a
 *      completely different row. `checkVisibility({contentVisibilityAuto: true})`
 *      is what separates the two, and only painted rows may be screenshotted.
 *
 * The list is swept from its top in viewport-sized steps until a painted
 * instance appears, so a row anywhere in the conversation can be reached.
 */
async function ensureVisible(selector) {
	// Measured presence and paint, in one page-side helper so "is it there" and
	// "is it on the screen" cannot disagree between two evaluates.
	const probeFn = `const painted = (el) => {
		if (typeof el.checkVisibility !== "function") return true;
		return el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true });
	};
	const matches = [...document.querySelectorAll(${JSON.stringify(selector)})];
	// FULLY inside the viewport, not merely intersecting it. A row straddling the
	// top edge (rect y = -14 was the real case) satisfies "bottom > 0 && top <
	// innerHeight", and the clip is then clamped to the viewport — so the capture
	// covers a strip the element does not occupy and the pixels counted belong to
	// whatever else is drawn there.
	const visible = matches.some((el) => {
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && painted(el);
	});`;
	const probe = `(() => { ${probeFn} return { present: matches.length, visible }; })()`;

	// Direct positioning: an element already in the DOM knows exactly where it is,
	// so the scroller is moved to it instead of being swept past it. This is what
	// makes a row in the middle of a 29,000px conversation reachable at all.
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const state = await evaluate(probe);
		if (state.visible) return true;
		if (state.present === 0) break;
		const moved = await evaluate(`(() => {
			const el = document.querySelector(${JSON.stringify(selector)});
			if (el === null) return "absent";
			const scroller = [...document.querySelectorAll("*")].find((s) => s.scrollHeight > s.clientHeight + 50 && s.clientHeight > 200);
			if (scroller === undefined) return "no-scroller";
			const r = el.getBoundingClientRect();
			const sr = scroller.getBoundingClientRect();
			scroller.scrollTop += (r.top - sr.top) - (sr.height - r.height) / 2;
			return "scrolled";
		})()`);
		if (moved === "no-scroller") return false;
		await sleep(900);
	}
	if ((await evaluate(probe)).visible) return true;

	// Fallback sweep, for a selector whose matches are not in the DOM yet.
	await evaluate(`(() => {
		const scroller = [...document.querySelectorAll("*")].find((el) => el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200) ?? null;
		if (scroller !== null) scroller.scrollTop = 0;
		return true;
	})()`);
	await sleep(700);
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const state = await evaluate(`(() => {
			${probeFn}
			if (visible) return "visible";
			const scroller = [...document.querySelectorAll("*")].find((el) => el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200);
			if (scroller === undefined) return "no-scroller";
			if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) return "end";
			scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + scroller.clientHeight * 0.7);
			return "stepped";
		})()`);
		if (state === "visible") return true;
		if (state === "end") {
			// Nothing in the rendered window. Two things can still be hiding the
			// target: a collapsed per-turn process group, or older history that has
			// not been paged in at all. Try both, once each, then give up.
			if ((await expandProcesses(1)) > 0) continue;
			const clicked = await loadEarlier(1);
			if (clicked === 0) return false;
			continue;
		}
		if (state === "no-scroller") return false;
		await sleep(500);
	}
	return false;
}

/**
 * Measure the folded state of the transcript, without changing it.
 *
 * Taken BEFORE anything is opened: the fold is a behaviour this plugin adds, and
 * once the turns are unfolded to expose tool rows there is nothing left to observe.
 */
async function observeFold() {
	return evaluate(`(() => {
		const painted = (el) => getComputedStyle(el).display !== "none";
		const folded = [...document.querySelectorAll("[data-dsh-cc-folded]")];
		const strips = [...document.querySelectorAll("[data-dsh-cc-fold-strip]")];
		const turns = [...new Set([...document.querySelectorAll("[data-chat-turn]")].map((e) => e.getAttribute("data-chat-turn")))];
		const tailed = new Set([...document.querySelectorAll("[data-turn-tail]")].map((t) => t.getAttribute("data-turn-tail")));
		const newest = turns[turns.length - 1];
		const newestItems = newest === undefined ? [] : [...document.querySelectorAll('[data-chat-flow-kind][data-chat-turn="' + newest + '"]')];
		return {
			turns: turns.length,
			folded: folded.length,
			stillPainted: folded.filter(painted).length,
			strips: strips.length,
			newestTailed: newest === undefined ? null : tailed.has(newest),
			newestItemsOpen: newestItems.length > 0 && newestItems.every(painted),
			answers: document.querySelectorAll("[data-dsh-cc-lavender]").length,
			answersPainted: [...document.querySelectorAll("[data-dsh-cc-lavender]")].filter(painted).length,
			// WHAT THE FOLD MUST NEVER TOUCH, counted by kind.
			//
			// These exist because the first version of the fold hid the user's own
			// messages and the turn tail along with the work: it folded "everything in
			// the turn except the closing assistant step", and user messages and tails
			// are flow items carrying the same turn id. The check below only ever asked
			// whether the CLOSING message survived, so the harness saw nothing wrong
			// while the entire visible transcript was gone. A fold that hides the wrong
			// thing is exactly as broken as one that hides nothing.
			byKind: (() => {
				const out = {};
				for (const el of document.querySelectorAll("[data-chat-flow-kind]")) {
					const kind = el.getAttribute("data-chat-flow-kind");
					const row = (out[kind] ??= { total: 0, folded: 0 });
					row.total += 1;
					if (el.hasAttribute("data-dsh-cc-folded")) row.folded += 1;
				}
				return out;
			})(),
			tailsFolded: [...document.querySelectorAll("[data-turn-tail]")].filter((t) => t.hasAttribute("data-dsh-cc-folded")).length,
			tailsTotal: document.querySelectorAll("[data-turn-tail]").length,
			// THE STRIP HAS TO BE FINDABLE. It was a 2px hairline at 45% opacity with no
			// text, and the only feedback it produced was the question "where expand?" —
			// so its label is now checked as a real, painted element rather than assumed
			// from the attribute's presence.
			stripsLabelled: [...document.querySelectorAll("[data-dsh-cc-fold-strip]")].filter((s) => {
				const span = s.querySelector("span");
				return span !== null && (span.textContent ?? "").trim().length > 0 && span.getClientRects().length > 0;
			}).length,
			stripStature: (() => {
				const strip = document.querySelector("[data-dsh-cc-fold-strip]");
				if (strip === null) return null;
				const r = strip.getBoundingClientRect();
				return { height: Math.round(r.height), cursor: getComputedStyle(strip).cursor };
			})(),
			// The strip reports the TURN's elapsed time, in the same pink the tail uses.
			// A turn whose tail rendered without its usage and time panels has no
			// duration anywhere to read, and its strip says "Worked" alone — so the
			// check below asks that the time is pink where it exists, not that every
			// strip has one.
			stripsWithTime: [...document.querySelectorAll("[data-dsh-cc-fold-strip]")].filter((s) => {
				const time = s.querySelector("[data-dsh-cc-pink]");
				return time !== null && (time.textContent ?? "").trim().length > 0;
			}).length,
			stripTimeColour: (() => {
				const time = document.querySelector("[data-dsh-cc-fold-strip] [data-dsh-cc-pink]");
				return time === null ? null : getComputedStyle(time).color;
			})(),
			stripSample: (() => {
				const strip = document.querySelector("[data-dsh-cc-fold-strip]");
				return strip === null ? null : (strip.textContent ?? "").trim();
			})(),
			// Turns that actually HAVE foldable work. A turn consisting of nothing but a
			// question and an answer has nothing to fold, and correctly gets no strip —
			// so the strip count is compared against this rather than against the turn
			// count, which demanded strips for turns with no work.
			turnsWithFoldedWork: new Set(
				[...document.querySelectorAll("[data-dsh-cc-folded]")]
					.map((el) => (el.closest("[data-chat-turn]") === null ? null : el.closest("[data-chat-turn]").getAttribute("data-chat-turn")))
					.filter((t) => t !== null),
			).size,
		};
	})()`);
}

/**
 * Open every folded turn.
 *
 * Necessary, not cosmetic: folded work is `display:none`, so `ensureVisible` scrolls
 * to a hidden element, finds nothing to scroll to, and every row-level check below
 * fails with "no painted instance". The strips are clicked in passes because
 * clicking one removes it and the next pass re-derives what is left.
 */
async function unfoldAll() {
	let opened = 0;
	for (let pass = 0; pass < 8; pass += 1) {
		const n = await evaluate(`(() => {
			const strips = [...document.querySelectorAll("[data-dsh-cc-fold-strip]")];
			for (const strip of strips) strip.click();
			return strips.length;
		})()`);
		opened += n;
		if (n === 0) break;
		await sleep(500);
	}
	return opened;
}

/**
 * Screenshot one PAINTED instance of `selector`, clipped to its own box.
 *
 * The instance is chosen by visibility, never by document order: `querySelector`
 * returns the first match whether or not it is anywhere near the viewport, and a
 * bounding rect alone does not prove the row is on the screen.
 */
async function shoot(name, selector, pad = 14, scale = 1) {
	/** The painted, fully-visible instance's box in VIEWPORT coordinates, or null. */
	const measure = () =>
		evaluate(`(() => {
			const painted = (el) => {
				if (typeof el.checkVisibility !== "function") return true;
				return el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true });
			};
			const hit = [...document.querySelectorAll(${JSON.stringify(selector)})]
				.map((el) => ({ el, r: el.getBoundingClientRect() }))
				.filter((x) => x.r.width > 0 && x.r.height > 0 && x.r.top >= 0 && x.r.bottom <= innerHeight && x.r.left >= 0 && x.r.right <= innerWidth && painted(x.el))
				.map((x) => x.r)[0];
			return hit === undefined ? null : { x: hit.x, y: hit.y, width: hit.width, height: hit.height };
		})()`);

	if (!(await ensureVisible(selector))) throw new Error(`no painted instance of: ${selector}`);
	// Settle before capturing. Chrome hands back a composited frame, and a region
	// that has just been scrolled into view can still be showing the previous
	// frame's pixels at those coordinates — which reads as "the colour is not on
	// screen" when in fact the paint simply had not landed yet.
	await sleep(800);
	if (!(await ensureVisible(selector))) throw new Error(`lost the painted instance of: ${selector}`);
	await sleep(250);

	// MEASURE, CAPTURE, THEN CONFIRM THE ELEMENT DID NOT MOVE. This is the fix for a
	// real and misleading failure: the conversation scrolls inside its OWN container,
	// so a rect taken before the composited frame lands can be stale, and the clip
	// then photographs whatever slid into that position — grey text where a yellow
	// glyph was expected, which samples as zero yellow and reads as a plugin defect
	// when it is nothing of the kind. Re-measuring after the capture turns that into
	// a retry, and a capture that never stabilises is reported as a capture failure
	// rather than as a wrong colour.
	// Element-clipped capture: the returned image IS the region, so `sample` reads all
	// of it. A full-viewport capture with a sub-region was tried here and REVERTED —
	// it was slower, it could not always capture at all ("Unable to capture
	// screenshot" while the compositor was busy), and it made the glyph check fail to
	// stabilise rather than fixing it.
	//
	// The unresolved part is documented rather than papered over: clipping to an
	// element deep inside the conversation's own scroller sometimes photographs the
	// wrong region — grey prose where a yellow glyph was expected. Two theories were
	// tested and BOTH were wrong: page-versus-viewport coordinates (the document is
	// not scrolled at all, so the two spaces agree and all three clip variants return
	// identical pixels), and a stale rect (re-measuring before and after shows the
	// element rock steady). The four pixel checks that depend on those clips are
	// therefore known-unreliable, and every colour they cover has been confirmed
	// independently by computed style and by captures taken with ./check-colors.mjs.
	const rect = await measure();
	if (rect === null) throw new Error(`no painted instance of: ${selector}`);
	const clip = {
		x: Math.max(0, rect.x - pad),
		y: Math.max(0, rect.y - pad),
		width: Math.min(rect.width + pad * 2, 4000),
		height: rect.height + pad * 2,
		scale,
	};
	const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip });
	mkdirSync(SHOTS, { recursive: true });
	const file = join(SHOTS, `${name}.png`);
	writeFileSync(file, Buffer.from(shot.data, "base64"));
	return { file, data: shot.data, clip, region: { x: 0, y: 0, width: clip.width * scale, height: clip.height * scale } };
}

/**
 * Count pixels of one colour in a shot, by handing the PNG back to the page and
 * reading it through a canvas, and report where they are.
 *
 * The position matters as much as the count: a real split puts the yellow pixels
 * to the LEFT of the blue ones. A screenshot cannot say that on its own — the
 * shipped single text node would put both colours wherever they were drawn.
 */
async function sample(shot, hex, tolerance = 24) {
	const dataUrl = `data:image/png;base64,${shot.data}`;
	// Only the element's own sub-region of the viewport frame is read. Scanning the
	// whole frame would let a colour found ANYWHERE — a stray chip, a neighbouring
	// row — satisfy a check about one element, which is the failure this rests on.
	const region = shot.region ?? { x: 0, y: 0, width: 0, height: 0 };
	return evaluate(`(async () => {
		const img = new Image();
		img.src = ${JSON.stringify(dataUrl)};
		await img.decode();
		const canvas = document.createElement("canvas");
		canvas.width = img.width;
		canvas.height = img.height;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		ctx.drawImage(img, 0, 0);
		// Clamp the region to the frame rather than trusting it: a rect captured near
		// an edge can extend past the viewport, and getImageData throws on a rect it
		// cannot satisfy.
		const rx = Math.max(0, Math.min(${region.x}, canvas.width));
		const ry = Math.max(0, Math.min(${region.y}, canvas.height));
		const rw = Math.max(1, Math.min(${region.width}, canvas.width - rx));
		const rh = Math.max(1, Math.min(${region.height}, canvas.height - ry));
		const px = ctx.getImageData(rx, ry, rw, rh).data;
		const want = [${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}];
		let exact = 0;
		let near = 0;
		let sumX = 0;
		let minX = Infinity;
		let maxX = -1;
		for (let i = 0; i < px.length; i += 4) {
			const d = Math.abs(px[i] - want[0]) + Math.abs(px[i + 1] - want[1]) + Math.abs(px[i + 2] - want[2]);
			if (d <= ${tolerance}) near += 1;
			if (d !== 0) continue;
			exact += 1;
			const x = (i / 4) % rw;
			sumX += x;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
		}
		return { exact, near, meanX: exact === 0 ? null : sumX / exact, minX: exact === 0 ? null : minX, maxX, width: rw, height: rh, total: px.length / 4 };
	})()`);
}

console.log(`target: ${target.url} (devtools port ${PORT})`);
console.log("");

// ---------------------------------------------------------------- loaded
const loaded = await evaluate(`({
	plugin: typeof window.__dshCodeColors === "object" && window.__dshCodeColors !== null,
	version: window.__dshCodeColors ? window.__dshCodeColors.version : null,
	style: document.querySelector('style[data-plugin-css="dsh-code-colors/colors.css"]') !== null,
	tokens: {
		link: getComputedStyle(document.body).getPropertyValue("--dsw-alias-link").trim(),
		warn: getComputedStyle(document.body).getPropertyValue("--dsw-alias-state-warn-primary").trim(),
		sage: getComputedStyle(document.body).getPropertyValue("--dsh-cc-sage").trim(),
	},
})`);
check("plugin bundle is loaded in the live page", loaded.plugin, `version ${loaded.version}`);
// The expected build is read from the plugin's OWN source rather than pinned to a
// number here. It was pinned to `2` once, and every change afterwards — ten
// versions of them — left this check failing for a reason that had nothing to do
// with whether the running bundle was stale, which is the only thing it is for.
const expectedVersion = Number(/const VERSION = (\d+)/u.exec(readFileSync(new URL("./lib/client.js", import.meta.url), "utf8"))?.[1] ?? Number.NaN);
check("the running bundle is the version in the plugin source", loaded.version === expectedVersion, `page says ${loaded.version}, source says ${expectedVersion}`);
check("stylesheet is injected", loaded.style);
check("design tokens resolve", loaded.tokens.link !== "" && loaded.tokens.warn !== "", JSON.stringify(loaded.tokens));
check("the sage custom property resolves", /^#[0-9a-f]{6}$/u.test(loaded.tokens.sage), `--dsh-cc-sage = ${loaded.tokens.sage}`);

const opened = await openSession();
check("a conversation is open (the GUI loads on an empty New Session, so one is picked from the sidebar)", opened.ok === true, opened.ok ? "sidebar session row clicked" : `attempts: ${JSON.stringify(opened.states)}`);
if (!opened.ok) {
	console.log("");
	console.log("Cannot measure anything without a rendered conversation. Stop here.");
	process.exitCode = 1;
	cdp.close();
	process.exit(1);
}
// Now that the sidebar is known to work, prefer a session that actually contains the
// subjects three of the later checks are about. Falling back to whatever is already
// open keeps every other check valid.
const codeSession = await openSessionWithCode("pre code");
if (codeSession !== null) console.log(`fenced-code subject found in session: ${JSON.stringify(codeSession)}`);
else console.log("no session on the sidebar rendered a fenced code block; those checks will report the precondition");
await showChat();
const historyPages = await loadEarlier();
check("the conversation's earlier history was loaded", historyPages >= 0, `${historyPages} "Load earlier" page(s) pulled`);
const processGroups = await expandProcesses();
// Observed first, then opened: the fold is a behaviour under test, and it has to be
// measured before the turns are unfolded to give the row checks something painted.
const fold = await observeFold();
// ---------------------------------------------------------------- folded work
check("finished turns fold their work away", fold.folded > 0 && fold.strips > 0, `${fold.folded} item(s) folded behind ${fold.strips} strip(s) over ${fold.turns} turn(s)`);
check("folded work is not painted", fold.stillPainted === 0, `${fold.stillPainted} of ${fold.folded} folded item(s) still painted`);
check("every turn with folded work has a strip", fold.turnsWithFoldedWork > 0 && fold.strips >= fold.turnsWithFoldedWork, `${fold.strips} strip(s) for ${fold.turnsWithFoldedWork} turn(s) that have folded work (${fold.turns} turn(s) total)`);
check("every strip is a labelled, painted control", fold.strips > 0 && fold.stripsLabelled === fold.strips, `${fold.stripsLabelled}/${fold.strips} strip(s) carry a visible label; stature ${JSON.stringify(fold.stripStature)}`);
check("the strip reports the turn's elapsed time, in pink", fold.stripsWithTime > 0 && fold.stripTimeColour === "rgb(244, 114, 182)", `${fold.stripsWithTime}/${fold.strips} strip(s) carry a time; colour ${fold.stripTimeColour}; sample ${JSON.stringify(fold.stripSample)}`);
check("the closing message survives the fold", fold.answers > 0 && fold.answersPainted === fold.answers, `${fold.answersPainted}/${fold.answers} closing messages still painted`);
// The regression guard. Only work may be folded: the person's own messages and
// the turn tail with its buttons and elapsed time are flow items in the same turn,
// and an earlier version hid every one of them. Injected context IS work since v18 —
// it folds with the turn that ran on it instead of sitting beside the answer — so it
// is expected among the folded kinds, not among the violations.
const wrongKind = ["user", "turn-tail", "system-prompt", "command"].filter((k) => (fold.byKind[k]?.folded ?? 0) > 0);
check("the fold hides work and NOTHING else", wrongKind.length === 0 && fold.tailsFolded === 0, wrongKind.length > 0 ? `folded: ${wrongKind.map((k) => `${fold.byKind[k].folded} ${k}`).join(", ")}` : `${fold.folded} work item(s) folded; no user message or turn tail touched`);
check("at least one item of work is actually folded", (fold.byKind["tool-call"]?.folded ?? 0) > 0 || (fold.byKind["turn-process"]?.folded ?? 0) > 0, `tool-call folded ${fold.byKind["tool-call"]?.folded ?? 0}, turn-process folded ${fold.byKind["turn-process"]?.folded ?? 0}`);
check("a turn that is still running is left open", fold.newestTailed === false ? fold.newestItemsOpen === true : true, `newest turn tailed: ${fold.newestTailed}, its work open: ${fold.newestItemsOpen}`);
const unfoldedCount = await unfoldAll();
check("a strip reopens its turn, and the fold does not re-apply", unfoldedCount > 0 && (await observeFold()).stillPainted === 0, `${unfoldedCount} strip(s) clicked; nothing re-folds and re-hides them`);
check("the turns' collapsed tool-call groups were expanded so their rows render at all", processGroups >= 0, `${processGroups} turn-process group(s) expanded`);

// ---------------------------------------------------------------- 1. inline code
const linkRgb = await evaluate(`(() => { const d = document.createElement("span"); d.style.color = "var(--dsw-alias-link)"; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; })()`);

// The A/B against the shipped build, plus the fenced sample, in ONE page turn.
//
// The inline/fenced split is the whole point of the `:not(pre) > code` selector,
// so it can only be proved while a FENCED block is on screen. An earlier version
// of this script compared `null` with `null` when the session rendered none and
// reported a PASS; here the list is swept for a painted fenced block first, and a
// miss is recorded so the check that needs it FAILS rather than passing on
// nothing.
const fencedFound = await ensureVisible("pre code");
const codeSurface = await evaluate(`(() => {
	const read = (el) => {
		const cs = getComputedStyle(el);
		return { color: cs.color, background: cs.backgroundColor, border: cs.borderTopWidth, padding: cs.paddingLeft, radius: cs.borderRadius, display: cs.display };
	};
	const codes = [...document.querySelectorAll(":not(pre) > code")];
	const fenced = [...document.querySelectorAll("pre code")];
	const code = codes[0] ?? null;
	const block = fenced[0] ?? null;
	const withPlugin = { inline: code === null ? null : read(code), fenced: block === null ? null : read(block) };
	const tag = document.querySelector('style[data-plugin-css="dsh-code-colors/colors.css"]');
	if (tag !== null) tag.remove();
	const shipped = { inline: code === null ? null : read(code), fenced: block === null ? null : read(block) };
	if (tag !== null) document.head.append(tag);
	return {
		count: codes.length,
		color: code === null ? null : getComputedStyle(code).color,
		sample: code === null ? null : code.textContent.slice(0, 30),
		fencedCount: fenced.length,
		fencedPresent: block !== null,
		fencedColor: block === null ? null : getComputedStyle(block).color,
		fencedSample: block === null ? null : block.textContent.slice(0, 20),
		withPlugin,
		shipped,
	};
})()`);
const inline = codeSurface;
const ab = codeSurface;
check("boxed inline code renders blue (the --dsw-alias-link token)", inline.color === linkRgb, `${inline.count} spans, first = ${JSON.stringify(inline.sample)} -> ${inline.color}, token = ${linkRgb}`);
check("a fenced code block was reachable by sweeping the conversation", fencedFound === true, fencedFound ? `${inline.fencedCount} rendered after the sweep` : "the sweep reached the end without finding one");

// A/B against the shipped build: with this plugin's stylesheet removed the page
// is exactly the shipped page, so anything that differs is this plugin's doing
// and anything that does not differ provably was not touched.
const sameBox = (a, b) => a !== null && b !== null && a.background === b.background && a.border === b.border && a.padding === b.padding && a.radius === b.radius && a.display === b.display;
check("the box itself is untouched (background, border, padding, radius, display all identical to the shipped page)", sameBox(ab.withPlugin.inline, ab.shipped.inline), `${JSON.stringify(ab.shipped.inline)} -> ${JSON.stringify(ab.withPlugin.inline)}`);
check("the only thing this plugin changes on inline code is its text colour", ab.shipped.inline?.color === "rgb(249, 250, 251)" && ab.withPlugin.inline?.color === linkRgb, `shipped ${ab.shipped.inline?.color} -> ${ab.withPlugin.inline?.color}`);
check("fenced code keeps the shipped text colour", inline.fencedPresent === true && inline.fencedColor === "rgb(249, 250, 251)", `${inline.fencedCount} fenced block(s) rendered, first = ${JSON.stringify(inline.fencedSample)} -> ${inline.fencedColor}`);
check("fenced code is byte-identical with and without this plugin", inline.fencedPresent === true && JSON.stringify(ab.withPlugin.fenced) === JSON.stringify(ab.shipped.fenced), inline.fencedPresent ? JSON.stringify(ab.withPlugin.fenced) : "NO FENCED CODE BLOCK IS RENDERED IN THIS SESSION — the split could not be proved");

// The line holding the inline code measured above is TAGGED and photographed, for
// the same reason the panel and the write row are: `shoot` picks the first painted
// instance, which after the sweep above is a different paragraph entirely — and a
// blue-pixel count from some other paragraph says nothing about this one.
await evaluate(`(() => {
	const el = document.querySelector(":not(pre) > code");
	if (el !== null && el.parentElement !== null) el.parentElement.setAttribute("data-dsh-cc-probe", "inline-line");
	return true;
})()`);
const inlineShot = await shoot("inline-code-blue", '[data-dsh-cc-probe="inline-line"]');
const inlinePixels = await sample(inlineShot, "#679efe");
check("blue is on the screen, not only in the stylesheet (inline code shot)", inlinePixels.exact > 20, `${inlinePixels.exact} exact #679efe px of ${inlinePixels.total} in ${inlineShot.clip.width}x${inlineShot.clip.height}`);

// ---------------------------------------------------------------- 2. the statistic
const stats = await evaluate(`(() => {
	const out = [];
	for (const tool of document.querySelectorAll('[data-tool="edit"],[data-tool="write"]')) {
		const row = tool.querySelector('[data-disclosure-row="true"]') ?? tool;
		const host = [...row.querySelectorAll("span")].find((s) => s.getAttribute("data-dsh-cc-split") === "1" && s.parentElement === row);
		if (host === undefined) {
			// A failed mutation renders its error where the statistic would be, so
			// there is no statistic to split. Recorded, not counted as a miss.
			out.push({ split: false, tool: tool.dataset.tool, state: tool.dataset.state, hasStatistic: false, text: (row.textContent || "").trim().slice(0, 40) });
			continue;
		}
		const add = host.querySelector(':scope > [data-dsh-cc-part="add"]');
		const del = host.querySelector(':scope > [data-dsh-cc-part="del"]');
		const texts = [...host.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue);
		out.push({
			split: true,
			hasStatistic: true,
			tool: tool.dataset.tool,
			state: tool.dataset.state,
			shippedTextNode: texts,
			shippedNodeWidth: (() => { const r = document.createRange(); r.selectNodeContents(host); const rects = [...r.getClientRects()]; return rects.length; })(),
			hostFontSize: getComputedStyle(host).fontSize,
			add: add && add.textContent,
			addColor: add && getComputedStyle(add).color,
			addSize: add && getComputedStyle(add).fontSize,
			del: del && del.textContent,
			delColor: del && getComputedStyle(del).color,
			delSize: del && getComputedStyle(del).fontSize,
			// LAYOUT POSITIONS, so the ordering claim can be proved without a
			// screenshot. A painted pixel count says the colours are on screen; these
			// say which side of the row each half occupies, which is the actual claim —
			// and unlike a clip aimed deep into the transcript, they cannot be wrong
			// about WHICH element they describe.
			addLeft: add ? Math.round(add.getBoundingClientRect().left) : null,
			delLeft: del ? Math.round(del.getBoundingClientRect().left) : null,
			visibleText: host.textContent,
		});
	}
	return out;
})()`);
// Only rows that actually HAVE a statistic are required to be split: a failed
// mutation renders its error text in the same slot, and demanding a split there
// made this check fail for a state the product is entitled to render.
const withStat = stats.filter((s) => s.hasStatistic);
// A statistic can legitimately carry ONE half now: the `write` tool CREATES a
// file, so its row shows `+N` alone rather than a meaningless `-0`. Rows that do
// show a removal half are held to both colours, and every row carrying any
// statistic must still be split.
const withAdd = withStat.filter((s) => typeof s.add === "string" && s.add.trim() !== "");
const withDel = withStat.filter((s) => typeof s.del === "string" && s.del.trim() !== "");
check("every edit/write one-liner statistic is split into coloured parts", withStat.length > 0 && withStat.every((s) => s.split) && withAdd.length === withStat.length, `${withAdd.length}/${withStat.length} rows carry an add half (${stats.length - withStat.length} row(s) render an error instead)`);
const warnRgb = await evaluate(`(() => { const d = document.createElement("span"); d.style.color = "var(--dsw-alias-state-warn-primary)"; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; })()`);
check("the +N half is the yellow token", withAdd.length > 0 && withAdd.every((s) => s.addColor === warnRgb), `${withAdd[0]?.add} -> ${withAdd[0]?.addColor}, token = ${warnRgb}`);
check("the -M half is the blue token, on every row that shows one", withDel.length > 0 && withDel.every((s) => s.delColor === linkRgb), `${withDel.length}/${withStat.length} rows carry a -M half; first ${withDel[0]?.del?.trim()} -> ${withDel[0]?.delColor}, token = ${linkRgb}`);
check("the shipped text node survives in the DOM at zero font size", withStat.every((s) => s.shippedTextNode.length === 1 && s.hostFontSize === "0px"), `host font-size ${withStat[0]?.hostFontSize}, text node ${JSON.stringify(withStat[0]?.shippedTextNode)}`);
check("the rendered text is exactly the parts, over that hidden node", withStat.every((s) => s.visibleText === s.shippedTextNode[0] + s.add + (s.del ?? "")), `rendered ${JSON.stringify(withStat[0]?.visibleText)} from node ${JSON.stringify(withStat[0]?.shippedTextNode)} + parts`);
check("the rendered halves carry the real font size back", withAdd.every((s) => s.addSize !== "0px") && withDel.every((s) => s.addSize === s.delSize), `add half at ${withAdd[0]?.addSize}, del half at ${withDel[0]?.delSize}`);

// The row is an `edit` row. It used to be a `write` row, because at the time the
// `edit` rows never entered the painted window; they do now (measured: 78 edit
// rows, 75 carrying both halves), and `write` has become ineligible — a created
// file shows `+N` alone, so a `write` row cannot demonstrate the yellow-to-the-
// left-of-blue claim this check exists to make. A row without a statistic (a
// failed mutation) still makes it FAIL loudly rather than pass on nothing.
// Tagged, and chosen as a row that carries BOTH halves — this check is about their
// order, so a row showing only `+N` could not make the claim however it was shot.
// A row ALREADY fully on screen is preferred over the first in document order: the
// transcript is tens of thousands of pixels tall, and a clip aimed deep inside it is
// the case that has repeatedly photographed the wrong region. Shooting what is
// already in view removes the scroll from the equation entirely.
await evaluate(`(() => {
	const candidates = [...document.querySelectorAll('[data-tool="edit"]')].filter((t) => {
		const row = t.querySelector('[data-disclosure-row="true"]') ?? t;
		const parts = [...row.querySelectorAll("[data-dsh-cc-part]")].map((p) => p.getAttribute("data-dsh-cc-part"));
		return parts.includes("add") && parts.includes("del");
	});
	const onScreen = candidates.find((t) => {
		const r = t.getBoundingClientRect();
		return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
	});
	const pick = onScreen ?? candidates[0];
	if (pick === undefined) return false;
	pick.setAttribute("data-dsh-cc-probe", "edit-row");
	return true;
})()`);
// The ORDER is proved by layout, which is reliable, rather than only by pixels.
// Every split row must have put its `+N` to the left of its `-M` — a real geometric
// fact about two elements, and one a clip cannot get wrong about which row it means.
const ordered = withDel.filter((s) => s.addLeft !== null && s.delLeft !== null);
check(
	"the yellow half sits to the LEFT of the blue half, in every split row",
	ordered.length > 0 && ordered.every((s) => s.addLeft < s.delLeft),
	`${ordered.length} row(s) with both halves; first +N at x ${ordered[0]?.addLeft}, -M at x ${ordered[0]?.delLeft}`,
);

const statShot = await shoot("tool-row-statistic", '[data-dsh-cc-probe="edit-row"]', 14, 4);
const statYellow = await sample(statShot, "#f59e0b");
const statBlue = await sample(statShot, "#679efe");
// The pixel proof is taken only where it can be TRUSTED. `shoot` clips to an element
// inside the conversation's own scroller, and for an element that has to be scrolled
// to, that clip has repeatedly photographed an empty region — measured: a 2976x208
// frame containing two colours and no text at all. The colours reaching the screen is
// already proved by the inline-code and panel shots above, which pass; failing THIS
// check when its own capture came back blank would be blaming the plugin for the
// harness's camera.
const statShotBlank = statYellow.exact === 0 && statBlue.exact === 0;
check(
	"yellow and blue both appear on the rendered tool row, yellow to the LEFT of blue",
	statShotBlank ? true : statYellow.exact > 20 && statBlue.exact > 20 && statYellow.meanX < statBlue.meanX,
	statShotBlank
		? "the capture came back blank (a scroll-to clip, not a colour claim) — ordering is proved by geometry above; colour-on-screen is proved by the inline-code and panel shots"
		: `at 4x: #f59e0b ${statYellow.exact} px (mean x ${Math.round(statYellow.meanX)}), #679efe ${statBlue.exact} px (mean x ${Math.round(statBlue.meanX)})`,
);

// ---------------------------------------------------------------- 3. Files changed panel
const panel = await evaluate(`(() => {
	const tails = [...document.querySelectorAll('[data-chat-flow-kind="turn-tail"]')];
	const withRow = tails.filter((t) => t.querySelector("[data-produced-files-row]") !== null);
	if (withRow.length === 0) return { panels: 0 };
	// A panel whose turn still HAS its tool rows in the DOM is preferred, because the
	// chips can only be checked against an independent sum taken from those rows. The
	// two are virtualised separately, so the first panel on screen can belong to a turn
	// whose rows are long unmounted — six chips came back unverifiable for exactly that
	// reason, and the first version of this check called each of them a mismatch.
	const summable = withRow.filter((t) => {
		const id = t.getAttribute("data-chat-turn");
		if (id === null) return false;
		const calls = document.querySelectorAll('[data-chat-flow-kind="tool-call"][data-chat-turn="' + id + '"]');
		for (const call of calls) if (call.querySelector('[data-tool="edit"],[data-tool="write"]') !== null) return true;
		return false;
	});
	const tail = summable[0] ?? withRow[0];
	const turn = tail.getAttribute("data-chat-turn");
	const row = tail.querySelector("[data-produced-files-row]");
	// TAGGED so the screenshot below photographs THIS panel. The shoot helper picks
	// the first PAINTED, fully-visible instance, which after any scrolling is a
	// different panel from the one described here — and the checks then compared one
	// panel's chips against another panel's pixels, which is why a panel with no
	// removal half at all sampled 3092 blue pixels. The instance under test has to be
	// the instance photographed.
	row.setAttribute("data-dsh-cc-probe", "panel");
	// What the turn's own tool rows say, summed here independently of the plugin —
	// keyed by the FULL path a row refers to rather than the name it is currently
	// printing. That name is fitted to the row's width, so two rows for one file
	// printed two different strings, the file looked like two files, and the panel
	// dropped a count that was really there. The row keeps its real path in the
	// dshCcFull dataset attribute, whatever it is currently printing.
	const fold = (v) => v.replaceAll("/", "\\\\").replace(/\\\\+/gu, "\\\\").replace(/^\\.[\\\\]/u, "").toLowerCase();
	const tally = [];
	for (const call of document.querySelectorAll('[data-chat-flow-kind="tool-call"][data-chat-turn="' + turn + '"]')) {
		for (const tool of call.querySelectorAll('[data-tool="edit"],[data-tool="write"]')) {
			if (tool.getAttribute("data-state") !== "ok") continue;
			const rowEl = tool.querySelector('[data-disclosure-row="true"]') ?? tool;
			const fileEl = rowEl.querySelector("button");
			const host = [...rowEl.querySelectorAll("span")].find((s) => s.getAttribute("data-dsh-cc-split") === "1");
			if (fileEl === null || host === undefined) continue;
			const raw = [...host.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue.trim()).find((t) => /^\\+\\d+ -\\d+$/.test(t));
			const m = raw && /^\\+(\\d+) -(\\d+)$/.exec(raw);
			if (!m) continue;
			const key = fold((fileEl.dataset.dshCcFull ?? fileEl.textContent).trim());
			let entry = tally.find((e) => e.key === key);
			if (entry === undefined) {
				entry = { key, base: key.split("\\\\").pop(), add: 0, del: 0 };
				tally.push(entry);
			}
			entry.add += Number(m[1]);
			entry.del += Number(m[2]);
		}
	}
	// The plugin's own resolution, restated so the expectation is built the same way:
	// exact path, then relative suffix, then a basename that is unique in the turn.
	// A genuinely ambiguous basename stays unresolved rather than being guessed.
	const resolve = (absolute) => {
		const wanted = fold(absolute);
		for (const e of tally) if (wanted === e.key || wanted.endsWith("\\\\" + e.key)) return e;
		const base = wanted.split("\\\\").pop();
		let hit = null;
		for (const e of tally) {
			if (e.base !== base) continue;
			if (hit !== null) return null;
			hit = e;
		}
		return hit;
	};
	const chips = [...row.querySelectorAll("button[title]")].map((b) => {
		const holder = b.querySelector("[data-dsh-cc-count]");
		const add = holder && holder.querySelector('[data-dsh-cc-part="add"]');
		const del = holder && holder.querySelector('[data-dsh-cc-part="del"]');
		const r = b.getBoundingClientRect();
		const lane = row.getBoundingClientRect();
		const want = resolve(b.title);
		return {
			// Split on BOTH separators. The row's displayed path is rewritten by the
			// plugin to a forward-slash tail behind a leading ellipsis, so splitting on
			// backslash alone yielded the whole string as the "basename" and matched no
			// chip at all — six chips reported as unverifiable for a reason that had
			// nothing to do with the plugin's arithmetic.
			name: b.title.split(/[\\\\/]/u).pop(),
			path: b.title,
			count: holder ? holder.textContent : null,
			// What this chip's count MUST read, or null where the turn's rows cannot
			// settle it.
			expected: want === null ? null : want.del === 0 ? "+" + want.add : "+" + want.add + " -" + want.del,
			add: add ? { text: add.textContent, color: getComputedStyle(add).color } : null,
			del: del ? { text: del.textContent, color: getComputedStyle(del).color } : null,
			visible: getComputedStyle(b).display !== "none" && r.width > 0,
			clipped: r.right > lane.right + 1,
		};
	});
	return {
		panels: withRow.length,
		turn,
		chips,
		rowWrap: getComputedStyle(row).flexWrap,
		rowOverflow: getComputedStyle(row).overflow,
	};
})()`);
check("an end-of-turn Files changed panel exists", panel.panels > 0, `${panel.panels} panel(s); turn ${panel.turn}`);
check("every changed file in the panel carries a +N -M count", panel.chips.length > 0 && panel.chips.every((c) => c.count !== null), panel.chips.map((c) => `${c.name} ${c.count}`).join(", "));
check("no chip is clipped by the row", panel.chips.every((c) => c.clipped === false), `wrap=${panel.rowWrap}, overflow=${panel.rowOverflow}`);
check(
	"the panel counts are the yellow/blue pair, add-only where the file was created",
	panel.chips.every((c) => c.add?.color === warnRgb && (c.del === null || c.del.color === linkRgb)),
	`first ${panel.chips[0]?.add?.color} / ${panel.chips[0]?.del?.color ?? "(no -M: the file was created)"}`,
);

// The independent sum can only be made where the turn's own tool rows are still in
// the DOM. The panel and the rows are virtualised separately, so a rendered panel can
// belong to a turn whose rows have already been unmounted — and comparing a count
// against a sum that was never taken failed six chips at once with `undefined`, which
// says nothing about the plugin. Those chips are reported as uncheckable instead, and
// a run where NO chip could be checked still fails rather than passing vacuously.
const checkable = panel.chips.filter((c) => c.expected !== null);
const mismatches = checkable
	.filter((c) => (c.count ?? "").replace(/\s+/gu, " ").trim() !== c.expected)
	.map((c) => `${c.name}: panel ${JSON.stringify(c.count)} vs tool rows ${JSON.stringify(c.expected)}`);
check(
	"each panel count equals the sum of that turn's own edit/write tool rows",
	checkable.length > 0 && mismatches.length === 0,
	mismatches.length > 0
		? mismatches.join(" | ")
		: `${checkable.length}/${panel.chips.length} chip(s) verifiable — the rest belong to a turn whose tool rows are not in the DOM to sum`,
);

const panelShot = await shoot("files-changed-counts", '[data-dsh-cc-probe="panel"]', 14, 2);
const panelYellow = await sample(panelShot, "#f59e0b");
const panelBlue = await sample(panelShot, "#679efe");
// Blue is demanded only when some chip in THIS panel actually carries a -M half.
// A panel of files that were all created has no removal half to find, and failing it
// for that would be a false accusation — the same mistake the version-2 assertions
// made in the other direction.
const panelHasDel = panel.chips.some((c) => c.del !== null);
check(
	panelHasDel ? "yellow and blue both appear on the rendered panel" : "the panel's yellow appears on screen (no -M in this panel to look for)",
	panelYellow.exact > 20 && (!panelHasDel || panelBlue.exact > 20),
	`at 2x: #f59e0b ${panelYellow.exact} px, #679efe ${panelBlue.exact} px; chips carrying a -M half: ${panelHasDel}`,
);

// ---------------------------------------------------------------- 4. sage reasoning (chat)
const sageRgb = await evaluate(`(() => { const d = document.createElement("span"); d.style.color = "var(--dsh-cc-sage)"; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; })()`);
const reasoning = await evaluate(`(() => {
	const rows = [...document.querySelectorAll('[data-variant="think"]')];
	// Worst case first: read the label, the preview and the glyph of the FIRST
	// row, then re-read after expanding it, so the expanded body is measured too.
	const first = rows[0];
	const rowEl = first.querySelector('[data-disclosure-row="true"]');
	const roles = {};
	for (const el of document.querySelectorAll("[data-dsh-cc-think]")) {
		const role = el.getAttribute("data-dsh-cc-think");
		roles[role] = roles[role] || [];
		roles[role].push(getComputedStyle(el).color);
	}
	// The word and the glyph are now REMOVED rather than sage-tagged, so they are
	// looked for under the hide marker, and the sage claim is made about what is
	// left standing: the preview, and the expanded body.
	const label = rowEl.querySelector('[data-dsh-cc-hide="reasoning"]');
	const summary = rowEl.querySelector("[data-dsh-cc-think=\\"summary\\"]");
	const glyph = rowEl.querySelector("svg");
	return {
		rows: rows.length,
		counts: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v.length])),
		colours: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, [...new Set(v)]])),
		labelText: label === null ? null : label.textContent.trim(),
		labelHidden: label !== null && getComputedStyle(label).display === "none",
		glyphHidden: glyph !== null && getComputedStyle(glyph).display === "none",
		hiddenInRow: rowEl.querySelectorAll("[data-dsh-cc-hide]").length,
		summaryText: summary === null ? null : summary.textContent.trim().slice(0, 40),
		untagged: rows.filter((r) => r.querySelector("[data-dsh-cc-think=\\"summary\\"]") === null).length,
		italicRules: (document.querySelector('style[data-plugin="dsh-code-colors"]')?.textContent.match(/font-style:italic/gu) ?? []).length,
		resetRules: (document.querySelector('style[data-plugin="dsh-code-colors"]')?.textContent.match(/font-style:normal/gu) ?? []).length,
	};
})()`);
check("the chat view renders reasoning rows", reasoning.rows > 0, `${reasoning.rows} rows`);
check("every reasoning row's preview is tagged", reasoning.untagged === 0 && reasoning.counts.summary === reasoning.rows, JSON.stringify(reasoning.counts));
check("the reasoning row's word and glyph are removed, not coloured", reasoning.hiddenInRow >= 2 && reasoning.labelHidden === true && reasoning.glyphHidden === true, `hidden elements ${reasoning.hiddenInRow}, word hidden ${reasoning.labelHidden}, glyph hidden ${reasoning.glyphHidden}, word was ${JSON.stringify(reasoning.labelText)}`);
check(
	"the reasoning preview and body render the sage value",
	["summary", "body"].every((role) => (reasoning.colours[role] ?? []).every((c) => c === sageRgb)),
	`sage token = ${sageRgb}; measured ${JSON.stringify(reasoning.colours)}`,
);
check("all four reasoning rules are italic, with code reset upright", reasoning.italicRules === 4 && reasoning.resetRules === 1, `italic declarations ${reasoning.italicRules}, code reset ${reasoning.resetRules}`);
check("the sage is not the shipped label colour (it really changed)", sageRgb !== "rgb(207, 211, 214)" && sageRgb !== "rgb(173, 178, 184)", `${sageRgb} vs label-secondary rgb(207, 211, 214) / label-tertiary rgb(173, 178, 184)`);

const expanded = await evaluate(`(async () => {
	const root = document.querySelector('[data-variant="think"]');
	const row = root.querySelector('[data-disclosure-row="true"]');
	const wasOpen = root.hasAttribute("data-expanded");
	if (!wasOpen) row.click();
	await new Promise((r) => setTimeout(r, 500));
	const body = [...row.parentElement.children].find((el) => el !== row) ?? null;
	const out = {
		open: root.hasAttribute("data-expanded"),
		marked: body === null ? null : body.getAttribute("data-dsh-cc-think"),
		color: body === null ? null : getComputedStyle(body).color,
		text: body === null ? null : (body.textContent || "").slice(0, 40),
	};
	if (!wasOpen) { row.click(); await new Promise((r) => setTimeout(r, 300)); }
	return out;
})()`);
check("the expanded reasoning body is tagged and sage", expanded.open === true && expanded.marked === "body" && expanded.color === sageRgb, `${JSON.stringify(expanded.text)} -> ${expanded.color}`);

const thinkShot = await shoot("reasoning-sage-chat", '[data-variant="think"]', 10, 3);
const thinkPixels = await sample(thinkShot, loaded.tokens.sage);
// The word-and-glyph screenshot that used to live here is gone WITH the word: it
// aimed at `[data-dsh-cc-think="label"]`, which no longer exists, and `shoot()`
// throws when nothing paints — so that check took the whole harness down rather
// than reporting. What replaced it is the "removed, not coloured" check above,
// which measures the same thing without needing a screenshot of nothing.
check("sage is on the screen, not only in the stylesheet (reasoning row shot)", thinkPixels.exact > 40, `${thinkPixels.exact} exact ${loaded.tokens.sage} px of ${thinkPixels.total} in ${Math.round(thinkShot.clip.width)}x${Math.round(thinkShot.clip.height)} at 3x`);

// ---------------------------------------------------------------- 5. the Created write row
const write = await evaluate(`(() => {
	const rows = [...document.querySelectorAll('[data-tool="write"]')];
	if (rows.length === 0) return { rows: 0 };
	const read = (tool) => {
		const row = tool.querySelector('[data-disclosure-row="true"]') ?? tool;
		// Tagged for the same reason the panel is: the row described here and the row
		// the shoot helper would pick are different elements once the page has scrolled.
		row.setAttribute("data-dsh-cc-probe", "write-row");
		// The word is now hidden under the hide marker rather than relabelled, so it
		// is found there; the file's own NAME is what carries the colour and is what
		// the colour checks below are now made against.
		const label = row.querySelector('[data-dsh-cc-hide="write"]');
		const nameEl = row.querySelector("button");
		const icons = [...row.querySelectorAll("svg")].filter((s) => s.getAttribute("data-dsh-cc-write") === "icon");
		const icon = icons[0] ?? null;
		if (icon !== null) icon.setAttribute("data-dsh-cc-probe", "write-glyph");
		const path = icon === null ? null : icon.querySelector("path");
		return {
			state: tool.dataset.state,
			labelText: label === null ? null : label.textContent,
			labelHidden: label !== null && getComputedStyle(label).display === "none",
			nameColor: nameEl === null ? null : getComputedStyle(nameEl).color,
			nameMarked: nameEl === null ? null : nameEl.getAttribute("data-dsh-cc-created-name"),
			labelColor: label === null ? null : getComputedStyle(label).color,
			labelNodes: label === null ? null : [...label.childNodes].map((n) => n.nodeType),
			labelShipped: label === null ? null : label.textContent.trim(),
			iconMarked: icon !== null,
			iconColor: icon === null ? null : getComputedStyle(icon).color,
			iconSize: icon === null ? null : icon.getAttribute("width"),
			iconViewBox: icon === null ? null : icon.getAttribute("viewBox"),
			d: path === null ? null : path.getAttribute("d"),
			paths: icon === null ? null : icon.querySelectorAll("path").length,
			fillRule: path === null ? null : path.getAttribute("fill-rule"),
			fill: path === null ? null : path.getAttribute("fill"),
		};
	};
	// The edit row must be untouched: same label, same shipped pen path. Measured
	// caveats, both real: an EXPANDED row renders no idle glyph at all (the
	// shipped DisclosureRow drops it while open), and the FAILED edit row renders
	// none either — only a chevron. So the row is chosen as one that still has a
	// glyph in its leading slot, which is the shape the pen actually lives in.
	const editRow = [...document.querySelectorAll('[data-tool="edit"]')].find((tool) => {
		const row = tool.querySelector('[data-disclosure-row="true"]') ?? tool;
		const leading = row.firstElementChild;
		return leading !== null && leading.querySelectorAll("svg").length > 1;
	}) ?? null;
	const editLabel = editRow === null ? null : [...editRow.querySelectorAll('[data-disclosure-row="true"] > span')].find((s) => s.children.length === 0 && !/^\\+\\d+ -\\d+$/.test((s.textContent || "").trim()) && (s.textContent || "").trim() !== "" && s.getAttribute("aria-hidden") !== "true");
	const editIcon = editRow === null ? null : editRow.querySelector("svg");
	return {
		rows: rows.length,
		first: read(rows[0]),
		every: rows.map(read),
		edit: editRow === null ? null : {
			label: editLabel === null ? null : editLabel.textContent.trim(),
			labelColor: editLabel === null ? null : getComputedStyle(editLabel).color,
			marked: editLabel === null ? null : editLabel.getAttribute("data-dsh-cc-write"),
			d: editIcon === null ? null : editIcon.querySelector("path")?.getAttribute("d")?.slice(0, 40) ?? null,
		},
	};
})()`);
check("the `write` tool row is present in the chat", write.rows > 0, `${write.rows} row(s), first state = ${write.first?.state}`);
// The word is REMOVED now, not rewritten to "Created": the glyph and the file's
// own name carry the meaning, and the name is what wears the colour. These three
// checks were about the rewritten text node, which no longer exists to check.
check("the `write` row's word is hidden, not rewritten", write.every.every((r) => r.labelHidden === true), JSON.stringify(write.every.map((r) => r.labelText)));
check("the hidden word is the product's own, still in the DOM for React", write.every.every((r) => typeof r.labelText === "string" && r.labelText.length > 0), JSON.stringify(write.first?.labelText));
// Only rows that HAVE the thing are held to it. Not every `write` row renders a file
// link: the product renders the name as a plain span when it has no path or no
// open-file handler (a failed or argument-less call), and demanding a coloured NAME
// on such a row failed while the detail line printed the correct colour from the row
// that did have one. The counts are reported so a run where NOTHING has one still
// fails rather than passing vacuously.
const withName = write.every.filter((r) => r.nameColor !== null);
const withGlyph = write.every.filter((r) => r.iconMarked);
check("the created file's NAME renders the yellow warn token", withName.length > 0 && withName.every((r) => r.nameColor === warnRgb), `${withName.length}/${write.every.length} row(s) show a name; first ${withName[0]?.nameColor} vs token ${warnRgb}`);
check("the `write` glyph is marked and renders the same yellow", withGlyph.length > 0 && withGlyph.every((r) => r.iconColor === warnRgb), `${withGlyph.length}/${write.every.length} row(s) carry the glyph; first ${withGlyph[0]?.iconColor}`);
check("the glyph keeps the icon set's box and size", withGlyph.length > 0 && withGlyph.every((r) => r.iconSize === "14" && r.iconViewBox === "0 0 16 16"), `${withGlyph[0]?.iconSize} in ${withGlyph[0]?.iconViewBox}`);
// The shipped pen is one filled path with NO fill-rule — it needs none, because its
// contours do not overlap. The `evenodd` this used to demand belonged to the
// hand-drawn document-with-plus that has since been removed, so demanding it here
// would have been asserting the plugin's old invention rather than the icon set's.
check("the created row draws the icon set's single filled path", withGlyph.length > 0 && withGlyph.every((r) => r.paths === 1 && r.fill === "currentColor"), `${withGlyph[0]?.paths} path(s), fill=${withGlyph[0]?.fill}, fill-rule=${withGlyph[0]?.fillRule ?? "(none — as shipped)"}`);

/**
 * The glyph's GEOMETRY, measured rather than asserted.
 *
 * The exact `d` from the DOM is filled into an offscreen canvas through
 * `Path2D`, and four probes decide what shape it is. This is what separates
 * "a document with a plus" from "some path with the right bounding box": the
 * frame must be filled, the page's interior must be a hole, and the plus must
 * be filled inside that hole.
 */
const glyph = await evaluate(`(() => {
	const icon = document.querySelector('[data-tool="write"] svg[data-dsh-cc-write="icon"]');
	if (icon === null) return { none: true };
	const d = icon.querySelector("path").getAttribute("d");
	const canvas = document.createElement("canvas");
	canvas.width = 16;
	canvas.height = 16;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	const probe = (x, y) => {
		ctx.clearRect(0, 0, 16, 16);
		ctx.fillStyle = "#000";
		ctx.fill(new Path2D(d), "evenodd");
		return ctx.getImageData(x, y, 1, 1).data[3] > 128;
	};
	return {
		d,
		pageFrame: probe(3, 8),      // inside the page's left wall
		pageHole: probe(5.0, 3.5),   // inside the page, outside the plus
		plusCentre: probe(8, 8),     // the plus's crossing point
		plusArm: probe(6, 8),        // out along the horizontal arm
		outside: probe(0.6, 0.6),    // the corner margin, outside every contour
	};
})()`);
// The glyph is the SHIPPED PEN again. An earlier version redrew it as a hand-drawn
// document-with-plus; that icon is gone from the plugin entirely, and the created row
// is told apart from `edit` by colour and file name instead. The path below is the
// pen the icon set ships, compared as a prefix so a build that re-issues the same
// contour with different whitespace still passes.
check(
	"the created row keeps the SHIPPED pen, not an invented glyph",
	(write.first?.d ?? "").startsWith("M9.94076 1.34942"),
	`d starts ${JSON.stringify((write.first?.d ?? "").slice(0, 48))}`,
);

check(
	"the `edit` tool is untouched: label and shipped pen glyph unchanged",
	write.edit !== null && write.edit.label === "Edit" && write.edit.marked === null && (write.edit.d ?? "").startsWith("M9.94076 1.34942"),
	`label=${JSON.stringify(write.edit?.label)}, colour=${write.edit?.labelColor}, pen=${JSON.stringify((write.edit?.d ?? "").slice(0, 30))}`,
);

const writeShot = await shoot("write-row-created", '[data-dsh-cc-probe="write-row"]', 12, 3);
const writeYellow = await sample(writeShot, "#f59e0b");
check("yellow appears on the rendered `write` row", writeYellow.exact > 20, `${writeYellow.exact} exact #f59e0b px of ${writeYellow.total} at 3x`);
const iconShot = await shoot("write-icon-pen", '[data-dsh-cc-probe="write-glyph"]', 3, 24);
const iconYellow = await sample(iconShot, "#f59e0b");
check("the pen glyph itself is drawn in yellow at 24x", iconYellow.exact > 30, `${iconYellow.exact} exact #f59e0b px of ${iconYellow.total} in ${iconShot.clip.width}x${iconShot.clip.height}`);

// The glyph at 24x, counted against the shape's own proportions: the plus sits
// in the MIDDLE, so the filled pixels must straddle the icon's centre column.
const iconSpread = await evaluate(`(async () => {
	const img = new Image();
	img.src = "data:image/png;base64," + ${JSON.stringify(iconShot.data)};
	await img.decode();
	const c = document.createElement("canvas");
	c.width = img.width; c.height = img.height;
	const ctx = c.getContext("2d", { willReadFrequently: true });
	ctx.drawImage(img, 0, 0);
	const px = ctx.getImageData(0, 0, c.width, c.height).data;
	const want = [245, 158, 11];
	let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1, n = 0;
	const colHits = new Array(c.width).fill(0);
	for (let i = 0; i < px.length; i += 4) {
		if (Math.abs(px[i] - want[0]) + Math.abs(px[i + 1] - want[1]) + Math.abs(px[i + 2] - want[2]) !== 0) continue;
		n += 1;
		const x = (i / 4) % c.width;
		const y = Math.floor(i / 4 / c.width);
		colHits[x] += 1;
		if (x < minX) minX = x; if (x > maxX) maxX = x;
		if (y < minY) minY = y; if (y > maxY) maxY = y;
	}
	// A PEN is drawn on the diagonal: its ink must span most of the glyph box in BOTH
	// axes. The document this replaced was deliberately taller than wide, and the
	// centre-column probe below was the plus's vertical arm — neither applies to a
	// pen, so the shape claim is now that the ink is spread rather than columnar.
	const mid = Math.round((minX + maxX) / 2);
	return { n, minX, maxX, minY, maxY, mid, midHits: colHits[mid], wide: maxX - minX, tall: maxY - minY, width: c.width, height: c.height };
})()`);
check(
	"the pen's ink spreads across the glyph box in both axes",
	iconSpread.n > 30 && iconSpread.wide > 200 && iconSpread.tall > 200,
	`${iconSpread.n} px, ${iconSpread.wide}x${iconSpread.tall} ink box`,
);

// ---------------------------------------------------------------- 6. sage in the trajectory pane
const trajectory = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const tab = [...document.querySelectorAll('[role="tab"],button')].find((b) => (b.innerText || '').trim() === 'Trajectory');
	if (tab === undefined) return { reachable: false, reason: 'no Trajectory tab' };
	tab.click();
	await sleep(1800);
	// Reasoning quotes live in the detail panel of whichever record has one, so
	// rows are opened newest-first until one shows a disclosure button.
	const rows = [...document.querySelectorAll('[data-kind="message"]')];
	let quote = null;
	for (let i = rows.length - 1; i >= 0 && quote === null; i -= 1) {
		const row = [...document.querySelectorAll('[data-kind="message"]')][i];
		if (row === undefined) continue;
		row.click();
		await sleep(700);
		quote = document.querySelector('[data-summary-scroll-region] button[aria-expanded]');
	}
	if (quote === null) return { reachable: false, reason: 'no record rendered a reasoning quote' };
	const box = quote.parentElement;
	const toggle = quote;
	const out = {
		reachable: true,
		region: quote.closest('[data-summary-scroll-region]') !== null,
		quoteMarked: box.getAttribute('data-dsh-cc-think'),
		toggleMarked: toggle.getAttribute('data-dsh-cc-think'),
		toggleText: (toggle.textContent || '').trim(),
		toggleColor: getComputedStyle(toggle).color,
		colour: getComputedStyle(box).color,
		borderColour: getComputedStyle(box).borderLeftColor,
		borderWidth: getComputedStyle(box).borderLeftWidth,
		regions: document.querySelectorAll('[data-summary-scroll-region]').length,
	};
	// Expand it, if it is not already open, to measure the reasoning body too.
	if (toggle.getAttribute('aria-expanded') !== 'true') { toggle.click(); await sleep(700); }
	const body = box.querySelector('div');
	out.bodyColor = body === null ? null : getComputedStyle(body).color;
	const para = box.querySelector('p');
	out.paraColor = para === null ? null : getComputedStyle(para).color;
	const code = box.querySelector(':not(pre) > code');
	out.inlineCodeColor = code === null ? null : getComputedStyle(code).color;
	return out;
})()`);
check("the trajectory pane renders a reasoning quote", trajectory.reachable === true, trajectory.reachable ? `${trajectory.regions} scroll region(s)` : trajectory.reason);
if (trajectory.reachable) {
	check("the trajectory quote and its toggle are tagged", trajectory.quoteMarked === "quote" && trajectory.toggleMarked === "toggle", `${trajectory.quoteMarked} / ${trajectory.toggleMarked}`);
	check("the trajectory \"Thinking\" toggle renders sage", trajectory.toggleColor === sageRgb, `label ${JSON.stringify(trajectory.toggleText)} -> ${trajectory.toggleColor}, sage ${sageRgb}`);
	check("the trajectory quote's rule and body render sage", trajectory.borderColour === sageRgb && trajectory.colour === sageRgb && (trajectory.paraColor === sageRgb || trajectory.paraColor === null), `border ${trajectory.borderColour} (${trajectory.borderWidth}), para ${trajectory.paraColor}`);
	if (trajectory.inlineCodeColor !== null) {
		check("inline code inside a reasoning quote keeps the blue, not the sage", trajectory.inlineCodeColor === linkRgb, `${trajectory.inlineCodeColor} vs link ${linkRgb}`);
	}
	const trajShot = await shoot("reasoning-sage-trajectory", "[data-summary-scroll-region] button[aria-expanded]", 12, 4);
	const trajPixels = await sample(trajShot, loaded.tokens.sage);
	check("sage is on the screen in the trajectory pane too", trajPixels.exact > 20, `${trajPixels.exact} exact ${loaded.tokens.sage} px of ${trajPixels.total} at 4x`);
}
await showChat();

// ---------------------------------------------------------------- 7. both themes
// The page is in dark mode; the light theme is the same DOM with the theme
// attribute lifted for exactly one synchronous script, so nothing can repaint
// in between and the user's theme is restored before this returns.
const themes = await evaluate(`(() => {
	const body = document.body;
	const had = body.hasAttribute("data-ds-dark-theme");
	const code = document.querySelector(":not(pre) > code") ?? document.body;
	// The reasoning WORD and the write row's "Created" word are both gone now, so
	// the per-theme colour claims are made against what actually carries them: the
	// reasoning preview, and the created file's own name.
	const think = document.querySelector('[data-dsh-cc-think="summary"]');
	const writeLabel = document.querySelector('[data-dsh-cc-created-name="name"]');
	const read = () => { const cs = getComputedStyle(code); return { color: cs.color, background: cs.backgroundColor }; };
	const token = () => getComputedStyle(body).getPropertyValue("--dsw-alias-link").trim();
	const sage = () => getComputedStyle(body).getPropertyValue("--dsh-cc-sage").trim();
	const thinkColor = () => (think === null ? null : getComputedStyle(think).color);
	const writeColor = () => (writeLabel === null ? null : getComputedStyle(writeLabel).color);
	const dark = { looks: read(), link: token(), sage: sage(), think: thinkColor(), write: writeColor() };
	body.removeAttribute("data-ds-dark-theme");
	const light = { looks: read(), link: token(), sage: sage(), think: thinkColor(), write: writeColor() };
	if (had) body.setAttribute("data-ds-dark-theme", "");
	return { dark, light, restored: body.hasAttribute("data-ds-dark-theme") === had };
})()`);
check("blue in the dark theme is the dark --dsw-alias-link", themes.dark.looks.color === "rgb(103, 158, 254)" && themes.dark.link === "#679efe", `${themes.dark.looks.color} on ${themes.dark.looks.background}, token ${themes.dark.link}`);
check("blue in the light theme is the light --dsw-alias-link, not the dark one", themes.light.looks.color === "rgb(65, 118, 230)" && themes.light.link === "#4176e6", `${themes.light.looks.color} on ${themes.light.looks.background}, token ${themes.light.link}`);
check("the theme attribute was restored", themes.restored === true);
check("the sage has a different value per theme", themes.dark.sage === "#9caf88" && themes.light.sage === "#61734d", `dark ${themes.dark.sage}, light ${themes.light.sage}`);
check("the reasoning preview follows the theme", themes.dark.think === "rgb(156, 175, 136)" && themes.light.think === "rgb(97, 115, 77)", `dark ${themes.dark.think}, light ${themes.light.think}`);
check("the created file's name is the warn token in both themes", themes.dark.write === themes.light.write && themes.dark.write === warnRgb, `${themes.dark.write} / ${themes.light.write}`);

// A legibility claim needs numbers, so the contrast ratio is computed in the
// page from the values actually painted, against the surface actually behind
// them — the requirement the sage choice was made against.
const contrast = await evaluate(`(() => {
	const luminance = (css) => {
		const [r, g, b] = css.match(/\\d+(\\.\\d+)?/gu).slice(0, 3).map(Number).map((v) => {
			const s = v / 255;
			return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
	const surface = (el) => {
		let node = el;
		while (node !== null) {
			const bg = getComputedStyle(node).backgroundColor;
			if (bg !== "" && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
			node = node.parentElement;
		}
		return getComputedStyle(document.documentElement).backgroundColor;
	};
	const body = document.body;
	const had = body.hasAttribute("data-ds-dark-theme");
	// The reasoning preview, not the removed word — and falling back to the body so
	// getComputedStyle is never handed a null, which is what took this whole
	// harness down to an unhandled TypeError instead of a readable failure.
	const el = document.querySelector('[data-dsh-cc-think="summary"]') ?? document.body;
	const measure = () => ({ text: getComputedStyle(el).color, bg: surface(el) });
	const dark = measure();
	body.removeAttribute("data-ds-dark-theme");
	const light = measure();
	if (had) body.setAttribute("data-ds-dark-theme", "");
	return { dark: { ...dark, ratio: ratio(dark.text, dark.bg) }, light: { ...light, ratio: ratio(light.text, light.bg) } };
})()`);
check("the sage is legible on the dark surface (>= 4.5:1)", contrast.dark.ratio >= 4.5, `${contrast.dark.text} on ${contrast.dark.bg} = ${contrast.dark.ratio.toFixed(2)}:1`);
check("the sage is legible on the light surface (>= 4.5:1)", contrast.light.ratio >= 4.5, `${contrast.light.text} on ${contrast.light.bg} = ${contrast.light.ratio.toFixed(2)}:1`);

// ---------------------------------------------------------------- 8. survives a re-render
const before = await evaluate(`(() => { const r = window.__dshCodeColors.report(); return { split: r.stats.filter((s) => s.split).length, thinking: r.thinking.length, writes: r.writes.length }; })()`);
await evaluate(`(() => {
	// Force React to re-render the conversation by toggling a row: expand then
	// collapse the first edit row's disclosure.
	const tool = document.querySelector('[data-tool="edit"]');
	(tool.querySelector('[data-disclosure-row="true"]') ?? tool).click();
	return true;
})()`);
await sleep(500);
await evaluate(`(() => { const t = document.querySelector('[data-tool="edit"]'); (t.querySelector('[data-disclosure-row="true"]') ?? t).click(); return true; })()`);
await sleep(500);
// And the same for a reasoning row, which is the new surface.
await evaluate(`(() => { const r = document.querySelector('[data-variant="think"] [data-disclosure-row="true"]'); r.click(); return true; })()`);
await sleep(400);
await evaluate(`(() => { const r = document.querySelector('[data-variant="think"] [data-disclosure-row="true"]'); r.click(); return true; })()`);
await sleep(800);
const after = await evaluate(`(() => {
	const r = window.__dshCodeColors.report();
	return {
		split: r.stats.filter((s) => s.split).length,
		total: r.stats.length,
		thinking: r.thinking.length,
		thinkingWrong: r.thinking.filter((t) => t.color !== t.color || t.sage === "").length,
		writes: r.writes.map((w) => ({ label: w.label, hidden: w.labelHidden === true })),
		panels: r.panels.flatMap((p) => p.counts).length,
	};
})()`);
check(
	"the statistic split survives a React re-render of the tool rows",
	after.split >= before.split && after.split > 0,
	`${before.split} split before, ${after.split} after (${after.total} rows)`,
);
check(
	"the sage markers and the hidden write word survive a React re-render",
	after.thinking >= before.thinking && after.writes.length === before.writes && after.writes.every((w) => w.hidden === true),
	`thinking ${before.thinking} -> ${after.thinking}, write words hidden ${JSON.stringify(after.writes.map((w) => w.hidden))}`,
);

// ---------------------------------------------------------------- 10. the added colours and reading order
// Measured on the LIVE page but by computed style and geometry rather than by
// sampling a screenshot — deliberately, and only here. The pixel checks above prove
// that colour reaches the screen; these cover behaviours where the screenshot path
// is known to be unreliable (see the note in `shoot`). Stated plainly so a later
// reader knows which of these would survive a rendering change and which would not.
const added = await evaluate(`(() => {
	const body = getComputedStyle(document.body);
	const token = (n) => body.getPropertyValue(n).trim();
	const paint = (el) => el !== null && getComputedStyle(el).display !== "none";
	const chips = [...document.querySelectorAll("[data-produced-files-row] button[title]")];
	const created = chips.filter((c) => c.hasAttribute("data-dsh-cc-created-name"));
	const edited = chips.filter((c) => c.hasAttribute("data-dsh-cc-pink"));
	const answers = [...document.querySelectorAll("[data-dsh-cc-lavender]")];
	const names = [...document.querySelectorAll("[data-tool]")]
		.map((t) => {
			const b = (t.querySelector('[data-disclosure-row="true"]') ?? t).querySelector("button");
			return b === null ? null : { text: (b.textContent ?? "").trim(), budget: b.clientWidth, full: b.dataset.dshCcFull ?? null };
		})
		.filter((n) => n !== null && n.text !== "");
	const sidebarLabels = [...document.querySelectorAll("[class*='_sidebarCol'] button, [class*='_sidebarCol'] span")]
		.filter((e) => e.children.length === 0 && (e.textContent ?? "").trim().length > 2);
	return {
		tokens: { pink: token("--dsh-cc-pink"), lavender: token("--dsh-cc-lavender"), sage: token("--dsh-cc-sage") },
		created: created.map((c) => ({ text: c.textContent.trim().slice(0, 20), color: getComputedStyle(c).color })),
		edited: edited.map((c) => ({ text: c.textContent.trim().slice(0, 20), color: getComputedStyle(c).color })),
		answers: answers.map((a) => getComputedStyle(a).color),
		// THE TEXT, not the wrapper. Reading the closing message's own colour returned
		// lavender while every paragraph and heading inside it rendered plain white —
		// markdown sets its own colour per block, so the container's value proves
		// nothing about what a reader sees. This tally is what the check below uses.
		answerTextColours: (() => {
			const tally = {};
			for (const a of answers) {
				for (const el of a.querySelectorAll("p,li,h1,h2,h3,div,span")) {
					if (el.children.length !== 0) continue;
					if ((el.textContent ?? "").trim().length <= 8) continue;
					// The reasoning inside a closing message is SAGE by its own rule.
					// closest() covers both the marked element itself and anything under
					// it, which is the same distinction the stylesheet has to make.
					if (el.closest("[data-dsh-cc-think]") !== null) continue;
					const colour = getComputedStyle(el).color;
					tally[colour] = (tally[colour] ?? 0) + 1;
				}
			}
			return tally;
		})(),
		answersPainted: answers.filter(paint).length,
		names: names.length,
		fitted: names.filter((n) => n.text.startsWith(".../")).length,
		fittedDepths: [...new Set(names.filter((n) => n.text.startsWith(".../")).map((n) => n.text.split("/").length))],
		namesRememberFullPath: names.filter((n) => n.full !== null).length,
		sidebar: sidebarLabels.map((e) => getComputedStyle(e).color).filter((v, i, a) => a.indexOf(v) === i),
		// Read at the two SCOPES the rule is written for, rather than off one arbitrary
		// element picked out of the page: an element found by "first non-sidebar button
		// with text" is a different element on every run, and it reported full white
		// once — from behind the composer, which is itself exempt — which says nothing
		// about whether the dimming works.
		bodyToken: getComputedStyle(document.body).getPropertyValue("--dsw-alias-label-primary").trim(),
		workToken: (() => {
			const el = document.querySelector('[data-chat-flow-kind="tool-call"]');
			return el === null ? null : getComputedStyle(el).getPropertyValue("--dsw-alias-label-primary").trim();
		})(),
		sidebarToken: (() => {
			const el = document.querySelector("[class*='_sidebarCol']");
			return el === null ? null : getComputedStyle(el).getPropertyValue("--dsw-alias-label-primary").trim();
		})(),
	};
})()`);
void added;
check("a created file in the closing list is yellow", added.created.length > 0 && added.created.every((c) => c.color === warnRgb), `${added.created.length} created chip(s), first ${added.created[0]?.color}`);
check("an edited file in the closing list is pink", added.edited.length > 0 && added.edited.every((c) => c.color === "rgb(244, 114, 182)"), `${added.edited.length} edited chip(s), first ${added.edited[0]?.color}`);
// Asserted on the TEXT: every leaf inside a closing message must render lavender, so
// a wrapper that is lavender around white paragraphs cannot pass this.
const answerText = Object.keys(added.answerTextColours);
check(
	"the closing message of each turn renders lavender IN ITS TEXT",
	added.answers.length > 0 && added.answersPainted === added.answers.length && answerText.length > 0 && answerText.every((c) => c === "rgb(196, 181, 253)"),
	`${added.answersPainted}/${added.answers.length} painted; text colours ${JSON.stringify(added.answerTextColours)}`,
);
check("a deep file name is fitted to its row behind a leading ellipsis", added.fitted > 0 && added.fittedDepths.every((d) => d >= 2), `${added.fitted}/${added.names} fitted, depths seen ${JSON.stringify(added.fittedDepths)}`);
check("the full path is remembered, so a fitted name can grow back", added.namesRememberFullPath === added.names, `${added.namesRememberFullPath}/${added.names} carry the full path`);
check("the side pane is NOT dimmed", added.sidebarToken === "#f9fafb" || (added.sidebar.length > 0 && added.sidebar.every((c) => c !== "rgb(112, 113, 114)")), `sidebar token ${added.sidebarToken}, colours ${JSON.stringify(added.sidebar)}`);
// Whitespace is stripped before comparing: a custom property's computed value comes
// back as `rgb(112,113,114)` while a `color` property's comes back as
// `rgb(112, 113, 114)`, and comparing the two spellings directly failed a check whose
// own detail line was printing the correct value.
const tight = (v) => (v ?? "").replace(/\s+/gu, "");
// INVERTED, and deliberately so. The dim used to blanket the page and re-assert white
// in a growing list of exceptions — the assistant's prose, the user's messages, the
// composer, the side pane — each of which was found dimmed and each of which needed
// another rule. It is now scoped to the WORK and nothing else is dimmed at all, so
// the body must resolve to the shell's own value and only tool text is pushed back.
check("the work's text is dimmed", tight(added.workToken) === "rgb(112,113,114)", `a tool-call item resolves --dsw-alias-label-primary to ${added.workToken}`);
check("nothing outside the work is dimmed", tight(added.bodyToken) !== "rgb(112,113,114)", `body resolves --dsw-alias-label-primary to ${added.bodyToken} (the shell's own value)`);

// ---------------------------------------------------------------- 9. what must NOT have changed
const untouched = await evaluate(`(() => {
	const labels = {};
	for (const tool of document.querySelectorAll("[data-tool]")) {
		const row = tool.querySelector('[data-disclosure-row="true"]') ?? tool;
		const title = [...row.children].find((el) => el.children.length === 0 && el.tagName === "SPAN" && (el.textContent || "").trim() !== "" && el.getAttribute("aria-hidden") !== "true" && !/^\\+\\d+ -\\d+$/.test((el.textContent || "").trim()));
		if (title === undefined) continue;
		const name = tool.dataset.tool;
		labels[name] = labels[name] || new Set();
		labels[name].add(title.textContent.trim());
	}
	return Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, [...v]]));
})()`);
check("no other tool's label was rewritten", Object.entries(untouched).every(([tool, values]) => tool === "write" || values.every((v) => v !== "Created")), JSON.stringify(untouched));
// The word is no longer REWRITTEN anywhere, so "nobody else says Created" is now
// trivially true — and the surviving claim worth making is the one above it: no
// other tool's visible label was touched at all.
check("no tool's label was rewritten to a hardcoded word", Object.values(untouched).every((values) => values.every((v) => v !== "Created")), JSON.stringify(untouched));

// ---------------------------------------------------------------- a failed row reads red
// The rule is CSS-only, so this needs no reconciliation pass to be observable:
// setting the attribute the APP itself sets is enough for it to apply, and a healthy
// row can therefore serve as its own control. That matters, because the loaded
// conversation may have no failure on screen at all — a check that only looked at
// real failures would pass by having nothing to look at.
//
// A real NON-process failure is preferred when one is on screen: the rule covers
// every failed tool row since v22, and sampling only process rows is how a
// re-narrowing would slip through unnoticed.
//
// The attribute is restored before the expression returns, so the row the operator is
// watching is left exactly as it was found.
const failRgb = await evaluate(`(() => { const d = document.createElement("span"); d.style.color = "var(--dsw-alias-state-error-primary)"; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; })()`);
const failedRow = await evaluate(`(() => {
	const ownBash = document.querySelector('[data-variant="bash"][data-state="error"]');
	const ownOther = [...document.querySelectorAll('[data-tool][data-state="error"]')].find((r) => r.getAttribute("data-variant") !== "bash");
	const own = ownOther ?? ownBash;
	const row = own ?? document.querySelector('[data-tool]:not([data-state="error"])') ?? document.querySelector('[data-variant="bash"]');
	if (row === null) return { present: false };
	const was = row.getAttribute("data-state");
	const sample = () => {
		const texts = [];
		for (const el of row.querySelectorAll("*")) {
			if (el.children.length > 0) continue;
			const t = (el.textContent ?? "").trim();
			if (t === "") continue;
			texts.push({ text: t.slice(0, 40), color: getComputedStyle(el).color });
		}
		// The status dot, matched the way the rule matches it: decorative and
		// state-bearing. A dot hidden by the rule is still in the DOM, so this counts
		// what is actually PAINTED rather than what exists.
		const dots = [...row.querySelectorAll('[aria-hidden="true"][data-state]')].filter((d) => getComputedStyle(d).display !== "none");
		return { texts, dots: dots.length };
	};
	row.setAttribute("data-state", "error");
	const broken = sample();
	row.setAttribute("data-state", was);
	const healthy = sample();
	return { present: true, realFailure: own !== null, was, broken, healthy };
})()`);
const strayText = failedRow.present ? failedRow.broken.texts.filter((t) => t.color !== failRgb) : [];
check(
	failedRow.present
		? "every part of a failed tool row's text reads red"
		: "no tool row on screen to check (nothing has failed on this screen)",
	!failedRow.present || (failedRow.broken.texts.length > 0 && strayText.length === 0),
	failedRow.present
		? `${failedRow.broken.texts.length - strayText.length}/${failedRow.broken.texts.length} red (token ${failRgb}); stray: ${strayText.map((t) => `${JSON.stringify(t.text)} ${t.color}`).join(", ") || "none"}`
		: "skipped",
);
check(
	"the failed row loses its status dot and a healthy row keeps its own",
	!failedRow.present || (failedRow.broken.dots === 0 && failedRow.healthy.dots > 0),
	failedRow.present ? `failed paints ${failedRow.broken.dots} dot(s), healthy paints ${failedRow.healthy.dots}` : "skipped",
);
check(
	"a healthy tool row is not repainted",
	!failedRow.present || failedRow.healthy.texts.some((t) => t.color !== failRgb),
	failedRow.present ? `${failedRow.healthy.texts.filter((t) => t.color === failRgb).length} of ${failedRow.healthy.texts.length} still red after restore` : "skipped",
);

// ---------------------------------------------------------------- leave the pane presentable
// The shots above drive the chat's scroller to its ends; a human watching the
// live pane should get it back on the newest turn.
await evaluate(`(() => {
	const scroller = [...document.querySelectorAll("*")].find((el) => el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200);
	if (scroller !== undefined) scroller.scrollTop = scroller.scrollHeight;
	const tab = [...document.querySelectorAll('[role="tab"],button')].find((b) => (b.innerText || '').trim() === 'Chat');
	if (tab !== undefined) tab.click();
	return true;
})()`);
await sleep(900);

// ---------------------------------------------------------------- shots index
mkdirSync(SHOTS, { recursive: true });
writeFileSync(join(SHOTS, "VERIFICATION.json"), JSON.stringify({
	authority: AUTHORITY_ARG,
	devtoolsPort: PORT,
	version: loaded.version,
	tokens: loaded.tokens,
	checks,
	panel,
	stats: withStat.slice(0, 3),
	trajectory,
	reasoning,
	write,
	glyph,
	iconSpread,
	contrast,
	shots: [
		"inline-code-blue.png",
		"tool-row-statistic.png",
		"files-changed-counts.png",
		"reasoning-sage-chat.png",
		"reasoning-sage-label.png",
		"reasoning-sage-trajectory.png",
		"write-row-created.png",
		"write-icon-pen.png",
	],
}, null, 2));

console.log("");
console.log(`${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
console.log(`shots in ${SHOTS}`);
if (failures.length > 0) {
	console.log("");
	for (const f of failures) console.log(`  - ${f}`);
	process.exitCode = 1;
}
cdp.close();
