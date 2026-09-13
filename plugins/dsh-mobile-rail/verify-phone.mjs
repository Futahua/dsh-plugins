/**
 * End-to-end verification of the mobile rail, on a real phone, with real touches.
 *
 * A tab of its own is opened so the user's tab is left exactly as it was, and the
 * taps are real touches (`Input.dispatchTouchEvent`), so what is tested is the
 * gesture and not a DOM method. Every assertion is a measurement.
 *
 *   adb forward tcp:9444 localabstract:chrome_devtools_remote
 *   node verify-phone.mjs            # or: node verify-phone.mjs 9444
 */
import { attach, closeTab, newTab, sleep, SHOTS, STATE_EXPR } from "./phone.mjs";

const PORT = Number(process.argv[2] ?? process.env.CDP_PORT ?? 9444);

let failures = 0;
/**
 * The plugin's own view of the world, read before the last tap.
 *
 * A band that ignores a tap has half a dozen unrelated reasons and no visible symptom,
 * and a run that began with the phone asleep failed section 2 with nothing but "the
 * sidebar did not open" -- because the app had focused the composer and the on-screen
 * keyboard was up, which stands the bands down *on purpose*. Reading `gates` before each
 * tap makes every failure below say which gate closed.
 */
let preTapGates = null;
const check = (label, ok, detail = "") => {
	if (!ok) failures++;
	const gates = ok || preTapGates === null ? "" : `\n         at that tap: ${JSON.stringify(preTapGates)}`;
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}${gates}`);
};

/**
 * Everything the app has to be before a measurement means anything.
 *
 * The frame mounted, the "Internal Testing Notice" dismissed (while that dialog is up the
 * frame is `0px 0px 0px` and every geometry assertion below fails for a reason that has
 * nothing to do with this plugin), and the sidebar toggle this plugin drives actually
 * present — dismissing the dialog remounts the sidebar, and the first tap once fired into
 * that gap.
 */
const prepare = async (target) => {
	await target.waitFor("document.querySelector('.dsh-mobile-rail-frame')!==null", { label: "the app frame" });
	await target.waitFor("window.__dshMobileRail && window.__dshMobileRail.version>=3", { label: "bundle v3+" });
	// Waiting for the frame is not enough: on a cold tab the product mounts the frame
	// before it settles into the mobile collapsed state, and a run that started measuring
	// then reported four failures that did not exist. Wait for the state itself.
	await target.waitFor(
		"(function(){var f=document.querySelector('.dsh-mobile-rail-frame');return !!f && f.hasAttribute('data-sidebar-collapsed') && f.children.length>=2;})()",
		{ label: "the mobile layout to settle" },
	);
	await sleep(800);
	const notice = await target.ev(`(function(){
    var d=document.querySelector('[class*="_dialog_"]');
    if(!d) return null;
    var b=d.querySelector('button');
    if(!b) return 'no button';
    var text=(d.innerText||'').trim().slice(0,40);
    b.click();
    return text;
  })()`);
	if (notice !== null && typeof notice === "string") {
		console.log(`   dismissed an app dialog first: ${JSON.stringify(notice)}`);
		await sleep(1200);
	}
	await target.waitFor(
		"document.querySelector('[data-slot=\"sidebar\"] button[aria-label=\"Open sidebar\"]')!==null || document.querySelector('[data-slot=\"sidebar\"] button[aria-label=\"Collapse sidebar\"]')!==null",
		{ label: "the sidebar toggle to exist" },
	);
};

/**
 * Is the app actually showing a session?
 *
 * A tab that opens on the app's welcome screen ("hero") has no editable composer, no model
 * chip and no conversation — and, measured, the browser pane was left expanded there,
 * because the pane's own collapse control was not mounted when the plugin looked for it.
 * Every left-edge tap then hit "tap beside the open pane" and closed the pane instead of
 * opening the sidebar: fifteen failures from one cause, none of them this plugin's.
 *
 * Bounded, and it does not reload: a reload used to be how this recovered, and a wedged
 * renderer after one turned the wait into ten minutes of silence (every `Runtime.evaluate`
 * timing out at 15s, forty times). A fresh tab is the recovery instead.
 */
const awaitSession = async (target) => {
	for (let i = 0; i < 16; i++) {
		const answer = await target.ev(
			`(function(){ var c=document.querySelector('[data-composer-input]'); return !!(c && c.isContentEditable); })()`,
		);
		if (answer === true) return true;
		if (answer !== null && typeof answer === "object" && answer.__error !== undefined) {
			console.log(`   the page stopped answering: ${answer.__error}`);
			return false;
		}
		await sleep(500);
	}
	return false;
};

let created = await newTab(PORT);
/**
 * Attached inside the try, and closed in `finally`.
 *
 * An `attach` that threw used to leave its tab behind, because the try started
 * after it — which is how the phone accumulated blank tabs, and blank tabs are
 * what makes Chrome on Android stop loading new ones.
 */
let page;
try {
	page = await attach(created);
	await prepare(page);
	let hasSession = await awaitSession(page);
	if (!hasSession) {
		// One fresh tab. This is the recovery that replaced the reload, and it is cheap:
		// the tab is closed either way, and a run without a session is not worth having.
		console.log("   this tab has no session open; trying one fresh tab");
		await closeTab(PORT, created.id);
		page.close();
		created = await newTab(PORT);
		page = await attach(created);
		await prepare(page);
		hasSession = await awaitSession(page);
	}
	if (hasSession) {
		console.log("   the app has a session open (the composer is editable)");
	} else {
		console.log("   NO SESSION: the app is on its welcome screen. The band and composer");
		console.log("   checks below are not meaningful in that state; treat failures with care.");
	}

	// The pane's packaged default is collapsed by the plugin on load, through the pane's
	// own control. If it is still expanded, that is the first thing to look at rather than
	// the band: an expanded pane eats every left-edge tap as "tap beside the open pane".
	const paneExpanded = async () =>
		(await page.ev(`document.querySelector('[data-dsh-browser-pane="expanded"]')!==null`)) === true;
	if (await paneExpanded()) {
		console.log("   the pane is still expanded; waiting for this plugin to settle it");
		for (let i = 0; i < 16 && (await paneExpanded()); i++) await sleep(500);
	}
	check("the pane's packaged default is settled closed before anything is measured",
		!(await paneExpanded()), "otherwise the first left-edge tap closes the pane instead");

	// Can this phone deliver a touch to the page at all?
	//
	// Nothing below means anything if it cannot, and the failure is invisible: with Chrome
	// backgrounded on Android the page answers every query normally while touch input is
	// delivered nowhere. Measured, with the phone in someone's hand and another app in
	// front: a real touch at x=10 produced no `pointerdown` at all, not even on `window`
	// capture, at any y — and the run reported fifteen failures that were all this one fact.
	// A brush is the probe because a brush deliberately opens nothing, whoever sees it.
	await page.ev(`(function(){
    window.__sawTouch = 0;
    window.addEventListener('pointerdown', function(){ window.__sawTouch += 1; }, true);
    return true;
  })()`);
	await page.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 10, y: 600 }] });
	await page.call("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 70, y: 600 }] });
	await page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await sleep(500);
	if ((await page.ev("window.__sawTouch")) < 1) {
		console.log(`
  STOPPING: this phone is not delivering touch to the page.

  Chrome has to be the app IN FRONT on the phone, with the screen on. A backgrounded
  Chrome does not composite its pages, so DevTools touch events arrive nowhere while every
  page query still answers normally. Bring Chrome to the front on the phone and rerun;
  connect-phone.mjs reports which app is in front.`);
		await closeTab(PORT, created.id);
		page.close();
		process.exit(1);
	}
	console.log("   touches are being delivered to the page");

	// A tap's own timeline, recorded in the page from the moment the run starts.
	//
	// Reading state after a CDP tap races the app's re-render, and a MutationObserver is
	// bound to one element -- which is exactly the thing in question. So the drawer is
	// *polled* every 50ms and every pointer/click is logged with a timestamp: a state
	// change nobody asked for can then be told from one this plugin made, and a replaced
	// frame shows up as `REPLACED` rather than as silence.
	await page.ev(`(function(){
    window.__trace = [];
    var t = function(){ return Math.round(performance.now()); };
    var first = document.querySelector('.dsh-mobile-rail-frame');
    first.__probe = 'first';
    var last = null;
    setInterval(function(){
      var f = document.querySelector('.dsh-mobile-rail-frame');
      var v = f
        ? (f.hasAttribute('data-sidebar-collapsed') ? 'closed' : 'OPEN') + ' w' +
          Math.round(f.children[0].getBoundingClientRect().width) + ' ' + (f.__probe || 'REPLACED')
        : 'no frame';
      if (v !== last) { window.__trace.push({t: t(), k: 'state', v: v}); last = v; }
    }, 50);
    var rec = function(e){
      var el=e.target;
      window.__trace.push({t:t(), k:e.type, x:Math.round(e.clientX||0), y:Math.round(e.clientY||0),
        tag:el?el.tagName:'?', cls:el?String(el.className).slice(0,24):''});
    };
    window.addEventListener('pointerdown', rec, true);
    window.addEventListener('pointerup', rec, true);
    window.addEventListener('click', rec, true);
    return true;
  })()`);

	/**
	 * A real touch tap, with a reading of everything that decides its fate taken first.
	 *
	 * Three different failures look identical from the check below: a gate stood the band
	 * down, a real control was under the tap (the band deliberately defers to it), or the
	 * page never received the gesture at all. `gates` covers the first, the hit test covers
	 * the second, and the visual-viewport offsets catch the third — a page whose visual
	 * viewport does not match its layout viewport is one where the coordinates dispatched
	 * below may not land where they say.
	 */
	const tap = async (x, y) => {
		preTapGates = await page.json(`(function(){
      var INTERACTIVE='button,a[href],input,select,textarea,summary,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[contenteditable="true"]';
      var el=document.elementFromPoint(${x},${y});
      var vv=window.visualViewport;
      return {
        gates: window.__dshMobileRail ? window.__dshMobileRail.gates : null,
        under: el ? el.tagName + '.' + String(el.className).slice(0,24) : 'none',
        control: !!(el && el.closest && el.closest(INTERACTIVE)),
        narrow: window.innerWidth,
        vv: vv ? {scale: vv.scale, w: Math.round(vv.width), h: Math.round(vv.height), top: Math.round(vv.offsetTop)} : null,
        inner: {w: window.innerWidth, h: window.innerHeight},
        glows: document.querySelectorAll('.dsh-mobile-glow').length
      };
    })()`);
		await page.tap(x, y);
	};
	/**
	 * A screenshot, which is evidence and never an assertion.
	 *
	 * `Page.captureScreenshot` returns nothing while the page is not being composited —
	 * measured on a sleeping phone — and that used to throw and abandon the whole run
	 * halfway through, losing every check after it.
	 */
	const shot = async (path) => {
		try {
			return await page.shot(path);
		} catch (error) {
			return `no screenshot (${error.message})`;
		}
	};

	/**
	 * Does the app have a conversation on screen?
	 *
	 * Its testing notice and its empty state both leave the frame at `0px 0px 0px` —
	 * no sidebar, no centre column — and in that state a width measurement says
	 * nothing about this plugin either way. The checks that need a conversation are
	 * therefore reported as skipped rather than quietly failing.
	 */
	const hasConversation = async () => (await state()).centreW > 0;
	const skippable = async (label, ok, detail) => {
		if (await hasConversation()) check(label, ok, detail);
		else console.log(`  skip ${label}  (the app has no conversation open)`);
	};

	const state = async () => await page.json(STATE_EXPR);
	/**
	 * Make sure the bands are live before tapping one.
	 *
	 * The phone is in someone's hand, and the app focuses the composer as soon as a
	 * session loads — so a run can catch the keyboard up, in which case the bands
	 * *deliberately* stand down and a tap test would measure that instead of the band.
	 * Measured happening: section 4b failed twice with nothing wrong, because the
	 * keyboard was up at the time. Blur whatever holds focus first.
	 */
	const clearFocus = async () => {
		await page.ev(`(function(){ var a=document.activeElement; if(a && a.blur) a.blur(); return a?a.tagName:null; })()`);
		await sleep(300);
	};
	/** Are the centre column's own children painted? */
	const centrePainted = async () =>
		await page.ev(`(function(){
      var kids=document.querySelector('.dsh-mobile-rail-frame').children[1].children, out=[];
      for(var i=0;i<kids.length;i++) out.push(getComputedStyle(kids[i]).visibility);
      return out.join(',');
    })()`);

	const s0 = await state();
	console.log(`viewport ${s0.viewport}px  bundle ${s0.bundle}\n`);
	check("the app is showing the mobile layout", s0.viewport <= 768, `${s0.viewport}px`);

	console.log("1. closed on load -- the rail must be gone:");
	let s = s0;
	check("sidebar collapsed", s.collapsed === true);
	check("rail hidden", s.railHidden === true);
	await skippable("conversation gets the full width", s.centreW === s.viewport, `${s.centreW} of ${s.viewport}`);
	check("centre content is painted", (await centrePainted()) === "visible");

	console.log("\n2. real touch tap on the left edge (10,400):");
	await clearFocus();
	await tap(10, 400);
	s = await state();
	check("sidebar opened", s.collapsed === false, JSON.stringify(s));
	check("it is the real 280px sidebar", s.sidebarW === 280, String(s.sidebarW));
	await skippable("centre content is blanked", (await centrePainted()) === "hidden", await centrePainted());
	console.log("   shot: " + (await shot(`${SHOTS}/verify-open.png`)));

	// The animation: the glow lights on the band tap, and the drawer is caught
	// mid-slide. Sampled with raw events because tap() settles afterwards, by
	// which time a 240ms animation is long over.
	//
	// A device with animations switched off at the OS level (Android's animator
	// duration scale 0) reports `prefers-reduced-motion: reduce`. The stylesheet
	// deliberately animates anyway, so this asserts the slide on a device that asks
	// for none -- which is exactly the case that used to be invisible.
	const reduced = await page.ev("matchMedia('(prefers-reduced-motion: reduce)').matches");
	console.log(`   device reports prefers-reduced-motion: ${reduced ? "reduce" : "no-preference"}`);
	check("the slide rule is present",
		(await page.ev("document.querySelector('style[data-plugin=\"dsh-mobile-rail\"]').textContent.includes('animation:dsh-mobile-rail-slide-in')")) === true);

	const glowState = async () => await page.json(`(function(){
    var g=document.querySelector('.dsh-mobile-glow[data-edge="left"]');
    return {present:!!g, lit:!!(g&&g.hasAttribute('data-lit')),
      parent:g&&g.parentNode?g.parentNode.tagName:null,
      pointerEvents:g?getComputedStyle(g).pointerEvents:null};
  })()`);
	/**
	 * Record whether a flash happened, from inside the page.
	 *
	 * The flash lasts FLASH_MS by design, and a CDP round trip over ADB can outlast
	 * that, so reading the attribute afterwards is a race that produced false
	 * failures. A MutationObserver in the page cannot miss it.
	 */
	const watchFlash = async (side) => await page.ev(`(function(){
    var g=document.querySelector('.dsh-mobile-glow[data-edge="${side}"]');
    if(!g) return 'no glow';
    window.__flash = window.__flash || {};
    window.__flash["${side}"] = false;
    if(g.__flashWatcher) g.__flashWatcher.disconnect();
    g.__flashWatcher = new MutationObserver(function(){
      if(g.hasAttribute('data-lit')) window.__flash["${side}"] = true;
    });
    g.__flashWatcher.observe(g,{attributes:true,attributeFilter:['data-lit']});
    return 'watching';
  })()`);
	const flashed = async (side) => (await page.ev(`!!(window.__flash && window.__flash["${side}"])`)) === true;
	/**
	 * Close the drawer, tap the band, and watch the transform while it moves.
	 * Always resets first: an earlier version tapped the band a second time while
	 * the drawer was already open, which put the tap *inside* the drawer.
	 */
	const slideAndGlow = async () => {
		if ((await state()).collapsed === false) await tap(350, 400);
		const closed = (await state()).collapsed === true;
		await watchFlash("left");
		await page.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 10, y: 400 }] });
		await page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		let minTx = 0;
		const samples = [];
		for (let i = 0; i < 14; i++) {
			const t = await page.ev("getComputedStyle(document.querySelector('.dsh-mobile-rail-frame').children[0]).transform");
			samples.push(String(t));
			const m = /matrix\(([^)]+)\)/.exec(String(t));
			if (m !== null) {
				const tx = Number(m[1].split(",")[4]);
				if (Number.isFinite(tx) && tx < minTx) minTx = tx;
			}
			await sleep(30);
		}
		return { closed, litNow: await flashed("left"), minTx, samples };
	};

	const run = await slideAndGlow();
	check("the band tap started from a closed drawer", run.closed === true);
	check("and it opened it", (await state()).collapsed === false);
	// On this phone `reduced` is true and the slide must still happen; on a device
	// that allows motion it must happen too. Same assertion either way.
	check("the drawer is caught sliding in", run.minTx < -20,
		`leftmost transform translateX ${run.minTx}px with prefers-reduced-motion: ${reduced ? "reduce" : "no-preference"}`);

	console.log("\n2b. the animation (real touch, sampled during):");
	const lit = await glowState();
	check("the glow element exists", lit.present === true);
	check("it is mounted on body, not in the frame", lit.parent === "BODY", String(lit.parent));
	check("it cannot swallow taps", lit.pointerEvents === "none", String(lit.pointerEvents));
	check("the band tap lit it", run.litNow === true, `lit=${run.litNow} (read inside the flash window)`);

	// Is it actually above the drawer? `elementsFromPoint` skips
	// pointer-events:none elements, so it is switched on for one reading only.
	const stack = await page.ev(`(function(){
    var g=document.querySelector('.dsh-mobile-glow[data-edge="left"]');
    if(!g) return 'no glow';
    g.style.pointerEvents='auto';
    var hit=document.elementsFromPoint(6,400).map(function(e){return String(e.className).slice(0,30);});
    g.style.pointerEvents='';
    return JSON.stringify(hit.slice(0,4));
  })()`);
	const order = JSON.parse(stack);
	const glowAt = order.findIndex((c) => c.includes("dsh-mobile-glow"));
	const drawerAt = order.findIndex((c) => c.includes("sidebarCol"));
	check("the glow paints above the drawer", glowAt >= 0 && (drawerAt < 0 || glowAt < drawerAt),
		`glow ${glowAt}, drawer ${drawerAt} in ${stack}`);

	console.log("\n2d. the strip behaves like a button (press highlights, click opens):");
	/** The strip's two states, plus whether the drawer is still closed. */
	const stripState = async () => await page.json(`(function(){
    var g=document.querySelector('.dsh-mobile-glow[data-edge="left"]');
    var f=document.querySelector('.dsh-mobile-rail-frame');
    return {held:!!(g&&g.hasAttribute('data-held')), lit:!!(g&&g.hasAttribute('data-lit')),
      closed:f.hasAttribute('data-sidebar-collapsed')};
  })()`);
	const touch = (type, x, y) => page.call("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });

	// Reset to closed, then press and hold without lifting.
	await tap(350, 400);
	check("starting closed for the button test", (await state()).collapsed === true);
	await touch("touchStart", 10, 400);
	await sleep(450);
	const holding = await stripState();
	check("a held press highlights the strip", holding.held === true);
	check("and does not open the drawer yet", holding.closed === true);
	await touch("touchEnd");
	const justAfter = await stripState();
	check("the flash fires on the click", (await flashed("left")) === true);
	check("the highlight is released with the finger", justAfter.held === false);
	await sleep(500);
	check("and the release opened the drawer", (await state()).collapsed === false);
	check("the flash goes out again", (await stripState()).lit === false);

	// A brush: press inside the strip, drag across and away, lift.
	await tap(350, 400);
	await touch("touchStart", 10, 400);
	await touch("touchMove", 18, 400);
	check("the highlight follows a finger still on the strip", (await stripState()).held === true);
	await touch("touchMove", 70, 400);
	check("and goes out as the finger leaves it", (await stripState()).held === false);
	await touch("touchEnd");
	await sleep(500);
	check("a brush across the strip never opens it", (await state()).collapsed === true);

	// A scroll that happens to start on the strip: travels, stays in the band.
	await touch("touchStart", 10, 400);
	await touch("touchMove", 10, 470);
	await touch("touchEnd");
	await sleep(500);
	check("a scroll beginning on the strip never opens it", (await state()).collapsed === true,
		"travelled 70px, so it was not a tap");

	console.log("\n2c. the glow goes out by itself:");
	await tap(350, 400);
	await sleep(600);
	const settled = await glowState();
	check("no longer lit", settled.lit === false);
	check("and it is not left behind as a second element",
		(await page.ev("document.querySelectorAll('.dsh-mobile-glow[data-edge=\"left\"]').length")) === 1);
	await tap(10, 400);
	check("drawer can still be opened afterwards", (await state()).collapsed === false);
	await tap(350, 400);

	console.log("\n3. real touch tap on the blank strip (350,400):");
	await clearFocus();
	// Start from a drawer that is definitely open. This section used to end the previous
	// one with a tap at the same spot and then tap again, so a run that arrived here
	// already closed blamed this tap for a state it never changed -- observed once, with
	// every event of the tap accounted for and nothing moved. Opening it here first makes
	// the check say what it means: the drawer was open, this tap shut it.
	if ((await state()).collapsed === true) await tap(10, 400);
	check("starting from an open drawer", (await state()).collapsed === false);
	await tap(350, 400);
	s = await state();
	check("sidebar collapsed again", s.collapsed === true, JSON.stringify(s));
	check("rail is gone again", s.railHidden === true);
	await skippable("conversation back to full width", s.centreW === s.viewport, `${s.centreW} of ${s.viewport}`);
	await skippable("centre content painted again", (await centrePainted()) === "visible");

	console.log("\n4. the edge tap works repeatedly:");
	await clearFocus();
	await tap(10, 400);
	s = await state();
	check("opened a second time", s.collapsed === false, JSON.stringify(s));
	await tap(380, 500);
	s = await state();
	check("closed a second time", s.collapsed === true, JSON.stringify(s));
	console.log("   shot: " + (await shot(`${SHOTS}/verify-closed.png`)));

	// Regression: `click()` dispatches at (0,0), so the guard that swallows the
	// compatibility click used to swallow the toggle's own activation whenever the
	// tap was in the top-left corner.
	console.log("\n4b. the top-left corner still opens it (regression):");
	await clearFocus();
	await tap(8, 8);
	s = await state();
	check("corner tap opened the drawer", s.collapsed === false, JSON.stringify(s));
	check("and it is still the real 280px sidebar", s.sidebarW === 280, String(s.sidebarW));
	await tap(350, 400);
	s = await state();
	check("closed again from the blank strip", s.collapsed === true, JSON.stringify(s));

	console.log("\n5. no appearance of the old CSS strip:");
	check("no reveal attribute anywhere", !(await page.ev("document.querySelector('[data-rail-revealed]')!==null")));
	check("only one plugin stylesheet",
		(await page.ev("document.querySelectorAll('style[data-plugin=\"dsh-mobile-rail\"]').length")) === 1);
	// The frame's own child count varies with what the product mounts (the resize
	// handle only exists while the drawer is open), so assert on what this plugin
	// could have added rather than on a count.
	check("nothing of ours inside the frame",
		(await page.ev("document.querySelector('.dsh-mobile-rail-frame').querySelectorAll('[class*=\"dsh-mobile-rail\"],[data-dsh-mobile-rail]').length")) === 0);
	check("centre column is still the 2nd child (selectors are pinned to reality)",
		(await page.ev("document.querySelector('.dsh-mobile-rail-frame').children[1].className.includes('centerCol')")) === true);

	console.log("\n6. a desktop-width viewport is untouched:");
	const geom = `(function(){
    var f=document.querySelector('.dsh-mobile-rail-frame');
    return {collapsed:f.getAttribute('data-sidebar-collapsed'),
      sidebarW:Math.round(f.children[0].getBoundingClientRect().width),
      centreW:Math.round(f.children[1].getBoundingClientRect().width)};
  })()`;
	await page.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	await sleep(800);
	const before = await page.json(geom);
	await tap(6, 400);
	const after = await page.json(geom);
	check("desktop keeps the sidebar where the product put it",
		before.collapsed === after.collapsed && before.sidebarW === after.sidebarW,
		`${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
	check("desktop conversation keeps its width", before.centreW === after.centreW, `${before.centreW} -> ${after.centreW}`);
	check("desktop is not blanked",
		(await page.ev("getComputedStyle(document.querySelector('.dsh-mobile-rail-frame').children[1].children[0]).visibility")) === "visible");
	await page.call("Emulation.clearDeviceMetricsOverride", {});

	console.log("\n7. the right edge: the browser pane");
	/** Everything that decides whether the pane is usable on a phone. */
	const paneState = async () => await page.json(`(function(){
    var rail=document.querySelector('[data-dsh-browser-pane="collapsed"]');
    var panel=document.querySelector('[data-dsh-browser-pane="expanded"]');
    var r=panel?panel.getBoundingClientRect():null;
    var f=document.querySelector('.dsh-mobile-rail-frame');
    return {
      rail:!!rail, railDisplay:rail?getComputedStyle(rail).display:null,
      panel:!!panel, panelW:r?Math.round(r.width):null, panelLeft:r?Math.round(r.left):null,
      margin:document.body.style.marginRight||"none",
      // The packaged pane writes its width into the inline style; this plugin wins
      // the cascade with !important, so the COMPUTED value is what decides the
      // layout. Asserting on the inline value was measuring the wrong thing.
      marginComputed:getComputedStyle(document.body).marginRight,
      frameW:f?Math.round(f.getBoundingClientRect().width):null,
      vw:window.innerWidth,
      boot:document.documentElement.hasAttribute('data-dsh-pane-boot'),
      toggle:(function(){
        var b=document.querySelector('button[aria-label="Expand browser pane"]')
          ||document.querySelector('button[aria-label="Collapse browser pane"]');
        return b?b.getAttribute('aria-label'):null;
      })()
    };
  })()`);
	const rightGlow = `document.querySelector('.dsh-mobile-glow[data-edge="right"]')`;

	let ps = await paneState();
	check("the pane ships a collapsed rail, which is what used to be the strip", ps.rail === true);
	check("that rail is not shown on a phone", ps.railDisplay === "none", String(ps.railDisplay));
	check("the pane reserves no layout space (computed margin is zero)", ps.marginComputed === "0px", `computed ${ps.marginComputed}, inline ${ps.margin}`);
	check("so the GUI keeps its full width", ps.frameW === ps.vw, `${ps.frameW} of ${ps.vw}`);
	check("the packaged expanded default was settled on load", ps.panel === false, JSON.stringify(ps));
	check("and the boot flag is gone", ps.boot === false);
	check("the pane's own toggle is reachable by name", ps.toggle !== null, String(ps.toggle));

	// Press, release, and watch the panel move.
	const paneEdge = ps.vw - 10;
	await watchFlash("right");
	await page.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: paneEdge, y: 300 }] });
	check("pressing the right edge highlights it",
		(await page.ev(`!!${rightGlow} && ${rightGlow}.hasAttribute('data-held')`)) === true);
	check("and does not open the pane yet", (await paneState()).panel === false);
	await page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	check("the click flashes it", (await flashed("right")) === true);
	check("and lights only that edge",
		(await page.ev(`document.querySelector('.dsh-mobile-glow[data-edge="left"]').hasAttribute('data-lit')`)) === false);

	let minTx = 0;
	for (let i = 0; i < 12; i++) {
		const t = String(await page.ev(`(function(){
      var p=document.querySelector('[data-dsh-browser-pane="expanded"]');
      return p?getComputedStyle(p).transform:'none';
    })()`));
		const m = /matrix\(([^)]+)\)/.exec(t);
		if (m !== null) {
			const tx = Number(m[1].split(",")[4]);
			if (Number.isFinite(tx) && tx > minTx) minTx = tx;
		}
		await sleep(25);
	}
	check("the pane is caught sliding in from the right", minTx > 20, `rightmost transform translateX ${minTx}px`);

	await sleep(600);
	ps = await paneState();
	check("the pane opened", ps.panel === true, JSON.stringify(ps));
	check("it fits the phone instead of overflowing", ps.panelW <= ps.vw - 17, `${ps.panelW} of ${ps.vw}`);
	check("the GUI still has its full width behind it", ps.frameW === ps.vw, `${ps.frameW} of ${ps.vw}`);
	check("and the pane still reserves nothing", ps.marginComputed === "0px", `computed ${ps.marginComputed}, inline ${ps.margin}`);

	console.log("   shot: " + (await shot(`${SHOTS}/verify-pane-open.png`)));

	console.log("\n7b. a tap beside it closes it:");
	await tap(Math.max(6, ps.panelLeft - 60), 300);
	ps = await paneState();
	check("the pane closed", ps.panel === false, JSON.stringify(ps));
	check("the rail is hidden again, not left as a strip", ps.railDisplay === "none");
	check("and nothing was left reserved on the body", ps.marginComputed === "0px", `computed ${ps.marginComputed}, inline ${ps.margin}`);

	console.log("\n7c. the top-right corner belongs to the app, not the band:");
	/**
	 * The control nearest the right edge in the app's top bar — deliberately not a
	 * hardcoded coordinate: measured, `(vw-12, 14)` is a control only while the right
	 * panel has something to show, and a plain div otherwise.
	 */
	const cornerProbe = async (register) => await page.json(`(function(){
    var vw=window.innerWidth;
    var best=null;
    var bs=document.querySelectorAll('button[aria-label], a[href], [role="button"][aria-label]');
    for(var i=0;i<bs.length;i++){
      var b=bs[i], r=b.getBoundingClientRect();
      if(r.width===0||r.height===0) continue;
      // On screen, in the top bar. Without the on-screen test this picked a control at
      // x=803 on a 418px viewport -- left over from the desktop metrics override -- and
      // then "tapped" 400px past the right edge.
      if(r.left<0||r.right>vw||r.top<0||r.bottom>160) continue;
      var d=Math.round(vw-r.right);
      if(best===null||d<best.d) best={d:d,label:(b.getAttribute('aria-label')||'').slice(0,34),
        x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),el:b};
    }
    if(best===null) return {found:false};
    if(${register ? "true" : "false"}){
      window.__cornerClicks=0;
      best.el.addEventListener('click',function(){window.__cornerClicks++;},true);
    }
    return {found:true,label:best.label,x:best.x,y:best.y,w:best.w,h:best.h,
      distanceFromRight:best.d,insideBand:(best.x+best.w)>vw-24};
  })()`);
	const corner = await cornerProbe(true);
	if (corner.found === false) {
		console.log("  skip  no control in the top bar in this state");
	} else {
		console.log(`   nearest top-bar control: "${corner.label}" at (${corner.x},${corner.y}) ` +
			`${corner.w}x${corner.h}, ${corner.distanceFromRight}px from the edge, inside the band: ${corner.insideBand}`);
		await clearFocus();
		await tap(Math.round(corner.x + corner.w / 2), Math.round(corner.y + corner.h / 2));
		check("tapping a top-bar control does not open the pane", (await paneState()).panel === false);
		const cornerClicks = await page.ev("window.__cornerClicks");
		check("and the control received the click instead", cornerClicks >= 1, `clicks ${cornerClicks}`);

		// That click did what it says on the tin — it opened the right sidebar — so put
		// the state back before measuring anything else, and say so, because a later
		// failure otherwise looks like a band bug rather than a state change.
		const afterCorner = await cornerProbe(false);
		if (afterCorner.found === true && afterCorner.label.startsWith("Collapse")) {
			console.log(`   (the click opened the right sidebar; closing it again)`);
			await clearFocus();
			await tap(Math.round(afterCorner.x + afterCorner.w / 2), Math.round(afterCorner.y + afterCorner.h / 2));
			await sleep(500);
		}
	}

	// Empty edge space below it must still open the pane.
	await clearFocus();
	await tap(ps.vw - 12, 400);
	const openedByBand = await paneState();
	check("empty edge space still opens the pane", openedByBand.panel === true, JSON.stringify(openedByBand));
	if (openedByBand.panel === true) {
		await tap(Math.max(6, openedByBand.panelLeft - 60), 400);
		check("and tapping beside it closes it again", (await paneState()).panel === false);
	}

	console.log("\n8. typing on a real device");
	/** What the app thinks is focused, and what the viewport looks like. */
	const typingState = async () => await page.json(`(function(){
    var a=document.activeElement;
    return {
      activeIsComposer: !!(a&&a.closest&&a.closest('[data-composer-input]')),
      activeIsEditable: !!(a&&a.isContentEditable),
      collapsed: document.querySelector('.dsh-mobile-rail-frame').hasAttribute('data-sidebar-collapsed'),
      innerHeight: window.innerHeight,
      vvHeight: window.visualViewport?Math.round(window.visualViewport.height):null
    };
  })()`);
	/** Focus the composer the way the app itself does. */
	const focusComposer = async () => await page.ev(`(function(){
    var c=document.querySelector('[data-composer-input]');
    if(!c) return 'no composer';
    c.focus();
    return document.activeElement===c ? 'focused' : 'focus refused';
  })()`);

	check("the app's composer exists and can take focus", (await focusComposer()) === "focused");
	let ts = await typingState();
	check("the composer is focused", ts.activeIsComposer === true && ts.activeIsEditable === true, JSON.stringify(ts));

	// Case 1: focused, but NO keyboard. The full height has to be forced, because the
	// phone's own keyboard may be up during a run — measured once: the visual viewport
	// at 413 while innerHeight stayed 747 — and then this is not the case under test.
	await tap(350, 400);
	const fullHeight = ts.innerHeight;
	await page.call("Emulation.setDeviceMetricsOverride", { width: 419, height: fullHeight, deviceScaleFactor: 1.71875, mobile: true });
	await sleep(400);
	await focusComposer();
	const focusedFull = await typingState();
	// Everything that could decide the tap's fate, read before it lands: a panel left
	// open by an earlier section makes this tap a *dismiss* rather than an open, which
	// looks identical to a blocked band in the result.
	const preTap = await page.json(`(function(){
    var f=document.querySelector('.dsh-mobile-rail-frame');
    var el=document.elementFromPoint(10,400);
    return {
      collapsed: f.hasAttribute('data-sidebar-collapsed'),
      pane: !!document.querySelector('[data-dsh-browser-pane="expanded"]'),
      under: el?el.tagName:'none',
      control: !!(el&&el.closest&&el.closest('button,a[href],input,select,textarea,summary,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[contenteditable="true"]')),
      gates: window.__dshMobileRail.gates
    };
  })()`);
	await tap(10, 400);
	ts = await typingState();
	check("a focused composer with no keyboard does NOT block the bands",
		focusedFull.vvHeight === focusedFull.innerHeight && ts.collapsed === false,
		`viewport ${focusedFull.innerHeight}/${focusedFull.vvHeight} -> collapsed ${ts.collapsed}; before ${JSON.stringify(preTap)}`);
	await tap(350, 400);

	// Case 2: focused AND the keyboard up. A shorter window is a faithful simulation:
	// measured on this phone, the keyboard leaves innerHeight alone and shrinks the
	// visual viewport, which is exactly what a height override reproduces.
	await focusComposer();
	await page.call("Emulation.setDeviceMetricsOverride", { width: 419, height: 420, deviceScaleFactor: 1.71875, mobile: true });
	await sleep(500);
	await focusComposer();
	const shrunk = await typingState();
	check("the simulated keyboard really did shrink the layout viewport",
		shrunk.innerHeight < focusedFull.innerHeight - 120, `${focusedFull.innerHeight} -> ${shrunk.innerHeight}`);

	const underKeyboard = await page.ev(`(function(){
    var g=document.querySelector('.dsh-mobile-glow[data-edge="left"]');
    return g?g.hasAttribute('data-held'):null;
  })()`);
	check("no highlight under the keyboard", underKeyboard === false);
	await tap(10, 400);
	ts = await typingState();
	check("tapping the band under the keyboard does not open the drawer", ts.collapsed === true, JSON.stringify(ts));
	check("and it dismissed the field instead (the app received the tap)",
		ts.activeIsComposer === false, `activeIsComposer ${ts.activeIsComposer}`);

	// Case 3: keyboard up but nothing focused — the bands are live again.
	await tap(10, 400);
	ts = await typingState();
	check("with nothing focused the band works even while the window is short",
		ts.collapsed === false, JSON.stringify(ts));
	await tap(350, 400);
	await page.call("Emulation.clearDeviceMetricsOverride", {});
	await sleep(400);

	console.log("\n9. the composer's controls on a phone");
	/** The composer's controls, where they sit, and whether the commands button is gone. */
	const composer = async () => await page.json(`(function(){
    var root=document.querySelector('[data-slot="conversation.composer"]');
    var cmd=root.querySelector('button[aria-label="Commands"]');
    var out={commandsDisplay:cmd?getComputedStyle(cmd).display:null, controls:[],
      containerRight:Math.round(document.querySelector('[data-slot="conversation.composer.bar"] > div').getBoundingClientRect().right)};
    var bs=root.querySelectorAll('button');
    for(var i=0;i<bs.length;i++){
      var b=bs[i], r=b.getBoundingClientRect();
      if(r.width===0||r.height===0) continue;
      out.controls.push({label:(b.getAttribute('aria-label')||'').slice(0,26),
        x:Math.round(r.x), w:Math.round(r.width), y:Math.round(r.y), h:Math.round(r.height)});
    }
    return out;
  })()`);
	let c = await composer();
	check("the commands (+) button is hidden on a phone", c.commandsDisplay === "none", String(c.commandsDisplay));

	// Controls on one visual row have different `y` TOPS — they are vertically centred and
	// have different heights (28, 20, 34) — so a row is a band of centres, not an equal y.
	const centre = (k) => Math.round((k.y + k.h / 2) / 8) * 8;
	/** The control row, and the two ways it can go wrong: overlap, or running off the end. */
	const rowOf = (reading) => {
		const model = reading.controls.find((k) => k.label.startsWith("Select model")) ?? null;
		if (model === null) return null;
		const at = centre(model);
		const row = reading.controls.filter((k) => centre(k) === at).sort((a, b) => a.x - b.x);
		let overlap = 0;
		let gap = Infinity;
		for (let i = 1; i < row.length; i++) {
			const space = row[i].x - (row[i - 1].x + row[i - 1].w);
			if (space < gap) gap = space;
			if (-space > overlap) overlap = -space;
		}
		return {
			model,
			at,
			row,
			overlap,
			gap,
			rightmost: Math.max(...row.map((k) => k.x + k.w)),
			others: [...new Set(reading.controls.filter((k) => centre(k) !== at).map(centre))],
		};
	};

	const modelControl = c.controls.find((k) => k.label.startsWith("Select model")) ?? null;
	check("the model chip is present", modelControl !== null, JSON.stringify(c.controls.map((k) => k.label)));
	const native = rowOf(c);
	check("every composer control sits on ONE row", native.row.length >= 5,
		`${native.row.length} controls at centre y=${native.at}: ${native.row.map((k) => k.label || "(usage ring)").join(", ")}`);
	check("and nothing control-like was left on another control row",
		native.others.every((y) => Math.abs(y - native.at) > 20), `other rows: ${native.others.join(", ")}`);
	check("no control overlaps another", native.overlap === 0, `worst overlap ${native.overlap}px`);
	check("and the gaps between them are even enough to read", native.gap >= 6, `smallest gap ${native.gap}px`);
	check("the row still ends inside the composer", native.rightmost <= c.containerRight,
		`edge ${native.rightmost} vs ${c.containerRight}`);
	console.log("   shot: " + (await shot(`${SHOTS}/composer-row.png`)));

	// The same row on a narrower phone. This is the stress the flex chain exists for: a
	// 360px screen leaves the row 318px, so something has to give, and the only thing
	// allowed to is the model chip. Measured at 419px the chip truncates 163px -> 151px;
	// the failure this guards against is the other group shrinking instead, which spills
	// the fixed-size icons and overlaps them.
	//
	// What is asserted is only what the plugin promises -- nothing overlaps, nothing runs
	// past the composer, and the chip is the thing that gave. Which controls the app itself
	// chooses to show at 360px is the app's business, so the count is reported, not
	// required to match.
	await page.call("Emulation.setDeviceMetricsOverride", {
		width: 360, height: 747, deviceScaleFactor: 1.71875, mobile: true,
	});
	await sleep(700);
	const narrowReading = await composer();
	const narrow = rowOf(narrowReading);
	check("on a 360px screen the commands button is still hidden", narrowReading.commandsDisplay === "none");
	check("the model chip is still there to take the squeeze", narrow !== null, "no chip found");
	if (narrow !== null) {
		check("nothing overlaps on a 360px screen", narrow.overlap === 0,
			`worst overlap ${narrow.overlap}px, gap ${narrow.gap}px, ${narrow.row.length} controls: ` +
				narrow.row.map((k) => `${k.label || "(ring)"} ${k.w}px`).join(", "));
		check("and nothing runs past the composer", narrow.rightmost <= narrowReading.containerRight,
			`edge ${narrow.rightmost} vs ${narrowReading.containerRight}`);
		check("the chip is what gave, not the icons",
			narrow.model.w <= native.model.w,
			`chip ${native.model.w}px at 419 -> ${narrow.model.w}px at 360`);
	}
	await page.call("Emulation.clearDeviceMetricsOverride", {});
	await sleep(400);

	console.log("");
	if (failures > 0) {
		// Only on failure, and only the drawer's own timeline: a bare "the drawer was
		// open" says nothing about which event opened it.
		console.log("gesture trace:");
		console.log("  " + JSON.stringify(await page.json("window.__trace"), null, 0));
	}
	console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
} finally {
	await closeTab(PORT, created.id);
	console.log("clean tab closed");
	page?.close();
}
process.exitCode = failures === 0 ? 0 : 1;






