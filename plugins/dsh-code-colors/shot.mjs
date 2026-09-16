// Screenshot the live GUI through the shared browser's DevTools endpoint.
//
// The agent's browser tools answer in the conversation; this writes the same
// picture to disk, so a claim about what the GUI looks like is backed by an
// artifact someone else can open.
//
//   node shot.mjs <name> [--selector "<css>"] [--pad 16] [--full] [--width 1400] [--height 1000] [--port n]
//
// With `--selector` the element is scrolled to the middle of the viewport and
// the clip is its own box (padded), which keeps the shot about the thing being
// claimed rather than about the window. Without it the whole viewport is taken.
//
// The DevTools port and the session cookie are handled by cdp.mjs: the port is
// discovered (it changes with whichever Chrome the browser-agent pane launched)
// and the page is authenticated before it is shot, so this works on a browser
// that has never opened the GUI.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, devtoolsPort, ensureGui, findTarget, waitForApp } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "shots");

const argv = process.argv.slice(2);
const name = argv[0];
if (!name) {
	console.error("usage: node shot.mjs <name> [--selector <css>] [--pad n] [--full] [--port n]");
	process.exit(2);
}
const flag = (key, fallback) => {
	const at = argv.indexOf(`--${key}`);
	return at === -1 ? fallback : argv[at + 1];
};
const has = (key) => argv.includes(`--${key}`);

const PORT = await devtoolsPort(flag("port", undefined));
const SELECTOR = flag("selector", null);
const PAD = Number(flag("pad", "16"));
const FULL = has("full");
const WIDTH = Number(flag("width", "0"));
const HEIGHT = Number(flag("height", "0"));

const target = await findTarget(PORT, { required: false });
if (target === null) throw new Error(`no page target on DevTools port ${PORT}`);
const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
if (await ensureGui(cdp)) await waitForApp(cdp);

if (WIDTH > 0 && HEIGHT > 0) {
	await cdp.send("Emulation.setDeviceMetricsOverride", {
		width: WIDTH,
		height: HEIGHT,
		deviceScaleFactor: 1,
		mobile: false,
	});
}

let clip;
if (SELECTOR !== null) {
	const measured = await cdp.send("Runtime.evaluate", {
		expression: `(() => {
			const el = document.querySelector(${JSON.stringify(SELECTOR)});
			if (el === null) return null;
			el.scrollIntoView({ block: "center", behavior: "instant" });
			const r = el.getBoundingClientRect();
			return { x: r.x, y: r.y, width: r.width, height: r.height, scrollY: window.scrollY };
		})()`,
		returnByValue: true,
	});
	const box = measured.result.value;
	if (box === null) throw new Error(`selector matched nothing: ${SELECTOR}`);
	// Let the scroll settle before the picture is taken.
	await new Promise((r) => setTimeout(r, 350));
	const again = await cdp.send("Runtime.evaluate", {
		expression: `(() => { const r = document.querySelector(${JSON.stringify(SELECTOR)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
		returnByValue: true,
	});
	const r = again.result.value;
	clip = {
		x: Math.max(0, r.x - PAD),
		y: Math.max(0, r.y - PAD),
		width: r.width + PAD * 2,
		height: r.height + PAD * 2,
		scale: 1,
	};
}

const shot = await cdp.send("Page.captureScreenshot", {
	format: "png",
	...(clip === undefined ? {} : { clip }),
	...(FULL ? { captureBeyondViewport: true } : {}),
});

mkdirSync(SHOTS, { recursive: true });
const file = join(SHOTS, `${name}.png`);
writeFileSync(file, Buffer.from(shot.data, "base64"));
console.log(`${file}  ${Buffer.from(shot.data, "base64").length} bytes${clip === undefined ? "" : `  clip ${Math.round(clip.width)}x${Math.round(clip.height)} at ${Math.round(clip.x)},${Math.round(clip.y)}`}`);

cdp.close();
