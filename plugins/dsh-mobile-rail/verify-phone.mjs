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
const check = (label, ok, detail = "") => {
	if (!ok) failures++;
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

const created = await newTab(PORT);
const page = await attach(created);
try {
	await page.waitFor("document.querySelector('.dsh-mobile-rail-frame')!==null", { label: "the app frame" });
	await page.waitFor("window.__dshMobileRail && window.__dshMobileRail.version>=3", { label: "bundle v3+" });
	// Waiting for the frame is not enough: on a cold tab the product mounts the
	// frame before it settles into the mobile collapsed state, and a run that
	// started measuring then reported four failures that did not exist. Wait for
	// the state itself.
	await page.waitFor(
		"(function(){var f=document.querySelector('.dsh-mobile-rail-frame');return !!f && f.hasAttribute('data-sidebar-collapsed') && f.children.length>=2;})()",
		{ label: "the mobile layout to settle" },
	);
	await sleep(800);

	const state = async () => await page.json(STATE_EXPR);
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
	check("conversation gets the full width", s.centreW === s.viewport, `${s.centreW} of ${s.viewport}`);
	check("centre content is painted", (await centrePainted()) === "visible");

	console.log("\n2. real touch tap on the left edge (10,400):");
	await page.tap(10, 400);
	s = await state();
	check("sidebar opened", s.collapsed === false, JSON.stringify(s));
	check("it is the real 280px sidebar", s.sidebarW === 280, String(s.sidebarW));
	check("centre content is blanked", (await centrePainted()) === "hidden", await centrePainted());
	console.log("   shot: " + (await page.shot(`${SHOTS}/verify-open.png`)));

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
    var g=document.querySelector('.dsh-mobile-rail-glow');
    return {present:!!g, lit:!!(g&&g.hasAttribute('data-lit')),
      parent:g&&g.parentNode?g.parentNode.tagName:null,
      pointerEvents:g?getComputedStyle(g).pointerEvents:null};
  })()`);
	/**
	 * Close the drawer, tap the band, and watch the transform while it moves.
	 * Always resets first: an earlier version tapped the band a second time while
	 * the drawer was already open, which put the tap *inside* the drawer.
	 */
	const slideAndGlow = async () => {
		if ((await state()).collapsed === false) await page.tap(350, 400);
		const closed = (await state()).collapsed === true;
		await page.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 10, y: 400 }] });
		await page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		// Read the glow inside its 320ms window: the sampling loop below outlives it.
		const litNow = (await glowState()).lit;
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
		return { closed, litNow, minTx, samples };
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
	check("the band tap lit it", run.litNow === true, `lit=${run.litNow} (read inside the 320ms window)`);

	// Is it actually above the drawer? `elementsFromPoint` skips
	// pointer-events:none elements, so it is switched on for one reading only.
	const stack = await page.ev(`(function(){
    var g=document.querySelector('.dsh-mobile-rail-glow');
    if(!g) return 'no glow';
    g.style.pointerEvents='auto';
    var hit=document.elementsFromPoint(6,400).map(function(e){return String(e.className).slice(0,30);});
    g.style.pointerEvents='';
    return JSON.stringify(hit.slice(0,4));
  })()`);
	const order = JSON.parse(stack);
	const glowAt = order.findIndex((c) => c.includes("dsh-mobile-rail-glow"));
	const drawerAt = order.findIndex((c) => c.includes("sidebarCol"));
	check("the glow paints above the drawer", glowAt >= 0 && (drawerAt < 0 || glowAt < drawerAt),
		`glow ${glowAt}, drawer ${drawerAt} in ${stack}`);

	console.log("\n2c. the glow goes out by itself:");
	await page.tap(350, 400);
	await sleep(600);
	const settled = await glowState();
	check("no longer lit", settled.lit === false);
	check("and it is not left behind as a second element",
		(await page.ev("document.querySelectorAll('.dsh-mobile-rail-glow').length")) === 1);
	await page.tap(10, 400);
	check("drawer can still be opened afterwards", (await state()).collapsed === false);
	await page.tap(350, 400);

	console.log("\n3. real touch tap on the blank strip (350,400):");
	await page.tap(350, 400);
	s = await state();
	check("sidebar collapsed again", s.collapsed === true, JSON.stringify(s));
	check("rail is gone again", s.railHidden === true);
	check("conversation back to full width", s.centreW === s.viewport, `${s.centreW} of ${s.viewport}`);
	check("centre content painted again", (await centrePainted()) === "visible");

	console.log("\n4. the edge tap works repeatedly:");
	await page.tap(10, 400);
	s = await state();
	check("opened a second time", s.collapsed === false, JSON.stringify(s));
	await page.tap(380, 500);
	s = await state();
	check("closed a second time", s.collapsed === true, JSON.stringify(s));
	console.log("   shot: " + (await page.shot(`${SHOTS}/verify-closed.png`)));

	// Regression: `click()` dispatches at (0,0), so the guard that swallows the
	// compatibility click used to swallow the toggle's own activation whenever the
	// tap was in the top-left corner.
	console.log("\n4b. the top-left corner still opens it (regression):");
	await page.tap(8, 8);
	s = await state();
	check("corner tap opened the drawer", s.collapsed === false, JSON.stringify(s));
	check("and it is still the real 280px sidebar", s.sidebarW === 280, String(s.sidebarW));
	await page.tap(350, 400);
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
	await page.tap(6, 400);
	const after = await page.json(geom);
	check("desktop keeps the sidebar where the product put it",
		before.collapsed === after.collapsed && before.sidebarW === after.sidebarW,
		`${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
	check("desktop conversation keeps its width", before.centreW === after.centreW, `${before.centreW} -> ${after.centreW}`);
	check("desktop is not blanked",
		(await page.ev("getComputedStyle(document.querySelector('.dsh-mobile-rail-frame').children[1].children[0]).visibility")) === "visible");
	await page.call("Emulation.clearDeviceMetricsOverride", {});

	console.log("");
	console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
} finally {
	await closeTab(PORT, created.id);
	console.log("clean tab closed");
	page.close();
}
process.exitCode = failures === 0 ? 0 : 1;
