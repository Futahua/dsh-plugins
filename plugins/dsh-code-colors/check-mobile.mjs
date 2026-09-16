// What happens to the Files changed counts on a phone-width viewport?
//
//   node check-mobile.mjs [width] [height]
import { connect, devtoolsPort, ensureGui, findTarget, waitForApp } from "./cdp.mjs";

const width = Number(process.argv[2] ?? 390);
const height = Number(process.argv[3] ?? 844);

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

await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 3, mobile: true });
try {
	await cdp.send("Page.reload", { ignoreCache: true });
	await waitForApp(cdp);
	await new Promise((r) => setTimeout(r, 3500));

	const out = await evaluate(`(() => {
		const painted = (el) => el !== null && getComputedStyle(el).display !== "none" && el.getClientRects().length > 0;
		const rows = [...document.querySelectorAll("[data-produced-files-row]")];
		const row = rows[0] ?? null;
		const tail = row === null ? null : row.closest("[data-turn-tail]");
		const turn = tail === null ? null : tail.getAttribute("data-turn-tail");
		// What the turn's own tool rows say, split by the tool that produced them.
		const calls = turn === null ? [] : [...document.querySelectorAll('[data-chat-flow-kind="tool-call"][data-chat-turn="' + turn + '"]')];
		const tools = {};
		for (const call of calls) {
			for (const t of call.querySelectorAll("[data-tool]")) {
				const key = t.getAttribute("data-tool") + ":" + t.getAttribute("data-state");
				tools[key] = (tools[key] ?? 0) + 1;
			}
		}
		const named = [...document.querySelectorAll('[data-chat-flow-kind="tool-call"][data-chat-turn="' + turn + '"] [data-tool="edit"],[data-chat-flow-kind="tool-call"][data-chat-turn="' + turn + '"] [data-tool="write"]')]
			.map((t) => {
				const r = t.querySelector('[data-disclosure-row="true"]') ?? t;
				const b = r.querySelector("button");
				return { state: t.getAttribute("data-state"), tool: t.getAttribute("data-tool"), name: b === null ? null : (b.textContent || "").trim().slice(0, 26) };
			});
		const strips = [...document.querySelectorAll("[data-dsh-cc-fold-strip]")];
		return {
			viewport: innerWidth + "x" + innerHeight,
			rows: rows.length,
			turn,
			toolCallsForTurn: calls.length,
			tools,
			toolRowNames: named.slice(0, 8),
			turnFolded: turn !== null && document.querySelector('[data-chat-flow-kind="turn-tail"][data-chat-turn="' + turn + '"]')?.hasAttribute("data-dsh-cc-folded"),
			stripForTurn: strips.filter((s) => s.getAttribute("data-dsh-cc-fold-strip") === turn).length,
			panels: rows.slice(0, 1).map((lane) => {
				const box = lane.getBoundingClientRect();
				return {
					laneBox: Math.round(box.width) + "x" + Math.round(box.height),
					chips: [...lane.querySelectorAll("button[title]")].map((b) => {
						const holder = b.querySelector("[data-dsh-cc-count]");
						const r = b.getBoundingClientRect();
						return {
							name: (b.textContent || "").trim().slice(0, 22),
							chipPainted: painted(b),
							holderPresent: holder !== null,
							holderText: holder === null ? null : (holder.textContent || "").trim(),
							title: (b.getAttribute("title") || "").split(/[\\\\/]/u).pop(),
							clippedRight: Math.round(r.right) > Math.round(box.right) + 1,
						};
					}),
				};
			}),
		};
	})()`);
	console.log(JSON.stringify(out, null, 2));
} finally {
	await cdp.send("Emulation.clearDeviceMetricsOverride");
	cdp.close();
}
