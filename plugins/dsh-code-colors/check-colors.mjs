// Histogram the colours actually present in a captured shot, to find out why one
// colour samples as zero while another in the same region samples fine.
//
//   node check-colors.mjs "[data-produced-files-row]" [pad] [scale]
import { connect, devtoolsPort, ensureGui, findTarget, waitForApp } from "./cdp.mjs";

const [, , selector = "[data-produced-files-row]", padArg = "14", scaleArg = "2"] = process.argv;
const pad = Number(padArg);
const scale = Number(scaleArg);

const port = await devtoolsPort(undefined);
let target = await findTarget(port, { required: false });
if (target === null) {
	const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	target = list.find((t) => t.type === "page");
}
const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
if (await ensureGui(cdp)) await waitForApp(cdp);

const evaluate = async (expression) => {
	const out = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
	return out.result.value;
};

// Scroll the FIRST MATCH into view, painted or not — the point here is diagnosis.
await evaluate(`(() => {
	const el = document.querySelector(${JSON.stringify(selector)});
	if (el !== null) el.scrollIntoView({ block: "center" });
	return true;
})()`);
await new Promise((r) => setTimeout(r, 900));

const rect = await evaluate(`(() => {
	const el = document.querySelector(${JSON.stringify(selector)});
	if (el === null) return null;
	const r = el.getBoundingClientRect();
	return { x: r.x, y: r.y, width: r.width, height: r.height, sx: scrollX, sy: scrollY,
		display: getComputedStyle(el).display, items: el.querySelectorAll("[data-dsh-cc-part]").length };
})()`);
if (rect === null) {
	console.log("selector matched nothing");
	process.exit(1);
}
console.log("element:", JSON.stringify(rect));

const shot = await cdp.send("Page.captureScreenshot", {
	format: "png",
	clip: { x: Math.max(0, rect.x + rect.sx - pad), y: Math.max(0, rect.y + rect.sy - pad), width: rect.width + pad * 2, height: rect.height + pad * 2, scale },
});

const hist = await evaluate(`(async () => {
	const img = new Image();
	img.src = "data:image/png;base64," + ${JSON.stringify(shot.data)};
	await img.decode();
	const c = document.createElement("canvas");
	c.width = img.width;
	c.height = img.height;
	const ctx = c.getContext("2d", { willReadFrequently: true });
	ctx.drawImage(img, 0, 0);
	const px = ctx.getImageData(0, 0, c.width, c.height).data;
	const tally = new Map();
	for (let i = 0; i < px.length; i += 4) {
		const key = px[i] + "," + px[i + 1] + "," + px[i + 2];
		tally.set(key, (tally.get(key) ?? 0) + 1);
	}
	const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
	const find = (hex) => {
		const want = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
		let exact = 0;
		let near = 0;
		for (let i = 0; i < px.length; i += 4) {
			const d = Math.abs(px[i] - want[0]) + Math.abs(px[i + 1] - want[1]) + Math.abs(px[i + 2] - want[2]);
			if (d === 0) exact += 1;
			if (d <= 24) near += 1;
		}
		return { exact, near };
	};
	return { size: c.width + "x" + c.height, distinct: tally.size, top, yellow: find("#f59e0b"), blue: find("#679efe"), pink: find("#f472b6") };
})()`);

console.log("image:", hist.size, "distinct colours:", hist.distinct);
console.log("yellow #f59e0b:", JSON.stringify(hist.yellow));
console.log("blue   #679efe:", JSON.stringify(hist.blue));
console.log("pink   #f472b6:", JSON.stringify(hist.pink));
console.log("top colours:");
for (const [colour, n] of hist.top) console.log("   ", colour.padEnd(16), n);
cdp.close();
