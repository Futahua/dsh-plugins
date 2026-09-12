/**
 * Minimal ADB + CDP harness for driving the DSH Web GUI on a real phone.
 *
 * Shared by the phone probes in this directory. It exists because the phone
 * cannot be reached the obvious ways:
 *
 *   - `/json/new` answers `500 Could not create new page` on Android Chrome, so a
 *     new tab is opened with `Target.createTarget` on the **browser** socket;
 *   - a background tab does not repaint, so a capture is taken after
 *     `Page.bringToFront`;
 *   - gestures must be real, so taps go out as `Input.dispatchTouchEvent` and the
 *     browser synthesises the pointer events the plugin listens for. A synthetic
 *     `element.click()` proves the DOM wiring, not the gesture.
 *
 * Reaching this socket needs a forward first:
 *
 *   adb forward tcp:9444 localabstract:chrome_devtools_remote
 *
 * Environment:
 *   CDP_PORT / DSH_CDP_PORT  local port forwarded to the phone  (default 9444)
 *   DSH_HOST_MATCH           substring identifying the GUI tab  (default "sloptop")
 *   DSH_URL                  GUI URL **as the phone reaches it** (default below)
 *   DSH_SHOT_DIR             screenshot directory (default ./shots beside this file)
 *
 * Note the URL default: the phone cannot use 127.0.0.1, because that is the phone.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CDP_PORT = Number(process.env.CDP_PORT ?? process.env.DSH_CDP_PORT ?? 9444);
export const HOST_MATCH = process.env.DSH_HOST_MATCH ?? "sloptop";
export const GUI_URL = process.env.DSH_URL ?? `http://${process.env.DSH_AUTHORITY ?? "sloptop.taild88607.ts.net:3080"}/`;
export const SHOTS = process.env.DSH_SHOT_DIR ?? fileURLToPath(new URL("./shots", import.meta.url));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function tabs(port = CDP_PORT) {
	return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

/** The DSH tab already open on the phone. */
export async function dshTab(port = CDP_PORT, match = HOST_MATCH) {
	const found = (await tabs(port)).find((t) => t.type === "page" && (t.url ?? "").includes(match));
	if (found === undefined) throw new Error(`no tab matching "${match}" on the phone; is the forward up?`);
	return found;
}

/**
 * Open a new tab, so a probe never disturbs whatever the user has open.
 *
 * `Target.createTarget` over the browser socket is the only path that works on
 * Android Chrome; the `/json/new` HTTP endpoint refuses.
 */
export async function newTab(port = CDP_PORT, url = GUI_URL) {
	const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
	const ws = new WebSocket(version.webSocketDebuggerUrl);
	let id = 0;
	const pending = new Map();
	const call = (method, params = {}) =>
		new Promise((resolve) => {
			const i = ++id;
			pending.set(i, resolve);
			ws.send(JSON.stringify({ id: i, method, params }));
		});
	ws.addEventListener("message", (e) => {
		const m = JSON.parse(e.data);
		if (m.id !== undefined && pending.has(m.id)) {
			pending.get(m.id)(m);
			pending.delete(m.id);
		}
	});
	await new Promise((r) => ws.addEventListener("open", r));
	const res = await call("Target.createTarget", { url });
	ws.close();
	if (res.result?.targetId === undefined) throw new Error(`could not open a tab: ${JSON.stringify(res.error)}`);
	let found;
	for (let i = 0; i < 20; i++) {
		found = (await tabs(port)).find((t) => t.id === res.result.targetId);
		if (found !== undefined) break;
		await sleep(150);
	}
	if (found === undefined) throw new Error("the new tab never appeared in /json/list");
	// Android Chrome sometimes hands back a blank tab instead of navigating the one it
	// just created, which then waits forever for a page that never arrives. Drive it
	// explicitly and hand back the refreshed target.
	if ((found.url ?? "") === "" || (found.url ?? "") === "about:blank") {
		const blank = await attach(found, { front: false });
		await blank.call("Page.navigate", { url });
		blank.close();
		await sleep(400);
		found = (await tabs(port)).find((t) => t.id === res.result.targetId) ?? found;
	}
	return found;
}

/** Close a tab by target id. */
export async function closeTab(port = CDP_PORT, targetId) {
	await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`);
}

/** Attach to a target and return the small vocabulary the probes use. */
export async function attach(target, { front = true } = {}) {
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	let id = 0;
	const pending = new Map();
	/**
	 * Every call is bounded.
	 *
	 * A wedged renderer never answers, and an unanswered CDP call used to hang the
	 * whole script with no clue why. A timeout turns that into a diagnosable error.
	 */
	const CALL_TIMEOUT_MS = Number(process.env.DSH_CDP_TIMEOUT_MS ?? 15000);
	const call = (method, params = {}) =>
		new Promise((resolve) => {
			const i = ++id;
			const timer = setTimeout(() => {
				if (pending.delete(i)) resolve({ timedOut: true, method });
			}, CALL_TIMEOUT_MS);
			pending.set(i, (message) => {
				clearTimeout(timer);
				resolve(message);
			});
			ws.send(JSON.stringify({ id: i, method, params }));
		});
	ws.addEventListener("message", (e) => {
		const m = JSON.parse(e.data);
		if (m.id !== undefined && pending.has(m.id)) {
			pending.get(m.id)(m);
			pending.delete(m.id);
		}
	});
	await new Promise((r) => ws.addEventListener("open", r));
	await call("Runtime.enable", {});
	await call("Page.enable", {});
	if (front) await call("Page.bringToFront", {});

	const ev = async (expression) => {
		const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (r.timedOut === true) return { __error: `no response to Runtime.evaluate within ${CALL_TIMEOUT_MS}ms (wedged renderer?)` };
		if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text };
		return r.result?.result?.value;
	};
	const json = async (expr) => JSON.parse(await ev(`JSON.stringify(${expr})`));

	/**
	 * Wait for a predicate written in page script, so "loaded" is measured.
	 *
	 * The phone is a phone: a cold tab has been seen to take 3 seconds and, once,
	 * longer than 20. The timeout is therefore generous, and when it does fire the
	 * failure carries the page's own state -- a bare "timed out" cost a debugging
	 * round trip that this avoids.
	 */
	const waitFor = async (expression, { timeoutMs = 60000, label = expression } = {}) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await ev(expression)) return true;
			await sleep(250);
		}
		const where = await ev(
			`JSON.stringify({href:location.href,title:document.title,state:document.readyState,frame:!!document.querySelector('.dsh-mobile-rail-frame'),bundle:window.__dshMobileRail&&window.__dshMobileRail.version})`,
		);
		throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}; page was ${where}`);
	};

	/** A real tap, so the browser generates the pointer events itself. */
	const tap = async (x, y, { hold = 0 } = {}) => {
		await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
		if (hold > 0) await sleep(hold);
		await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await sleep(600);
	};

	const shot = async (path) => {
		const r = await call("Page.captureScreenshot", { format: "png", fromSurface: true });
		if (r.result?.data === undefined) throw new Error("screenshot failed");
		mkdirSync(path.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
		writeFileSync(path, Buffer.from(r.result.data, "base64"));
		return path;
	};

	return { call, ev, json, waitFor, tap, shot, close: () => ws.close() };
}

/**
 * Everything that decides whether the sidebar is usable, as one reading.
 *
 * The sidebar **slot** is `display:contents`, so its own rect is 0x0 in every
 * state; the width lives on the frame's first grid child. Measuring the slot
 * instead of the column reports 0 and looks like a broken plugin.
 */
export const STATE_EXPR = `(function(){
  var f=document.querySelector('.dsh-mobile-rail-frame');
  if(!f) return {frame:false};
  var sbCol=f.children[0], centre=f.children[1];
  var sr=sbCol.getBoundingClientRect(), cr=centre.getBoundingClientRect();
  return {
    frame:true,
    collapsed:f.hasAttribute('data-sidebar-collapsed'),
    railHidden:getComputedStyle(sbCol).visibility==='hidden'||Math.round(sr.width)===0,
    sidebarW:Math.round(sr.width),
    centreX:Math.round(cr.x),
    centreW:Math.round(cr.width),
    centreVisible:getComputedStyle(centre).visibility,
    viewport:window.innerWidth,
    bundle:window.__dshMobileRail&&window.__dshMobileRail.version
  };
})()`;
