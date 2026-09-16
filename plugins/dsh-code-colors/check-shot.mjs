// Histogram a PNG the harness already wrote, to see what it actually captured.
//
//   node check-shot.mjs shots/files-changed-counts.png
import { readFileSync } from "node:fs";
import { connect, devtoolsPort, ensureGui, findTarget, waitForApp } from "./cdp.mjs";

const file = process.argv[2] ?? "shots/files-changed-counts.png";
const data = readFileSync(file).toString("base64");

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

const out = await cdp.send("Runtime.evaluate", {
	expression: `(async () => {
		const img = new Image();
		img.src = "data:image/png;base64," + ${JSON.stringify(data)};
		await img.decode();
		const c = document.createElement("canvas");
		c.width = img.width; c.height = img.height;
		const ctx = c.getContext("2d", { willReadFrequently: true });
		ctx.drawImage(img, 0, 0);
		const px = ctx.getImageData(0, 0, c.width, c.height).data;
		const tally = new Map();
		for (let i = 0; i < px.length; i += 4) {
			const key = px[i] + "," + px[i + 1] + "," + px[i + 2];
			tally.set(key, (tally.get(key) ?? 0) + 1);
		}
		return {
			size: c.width + "x" + c.height,
			distinct: tally.size,
			top: [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
		};
	})()`,
	returnByValue: true,
	awaitPromise: true,
});
const r = out.result.value;
console.log(file, r.size, "distinct:", r.distinct);
for (const [colour, n] of r.top) console.log("   ", colour.padEnd(16), n);
cdp.close();
