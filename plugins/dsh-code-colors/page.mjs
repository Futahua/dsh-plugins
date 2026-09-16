// Run one expression in the LIVE GUI and print its JSON result.
//
// The browser tools answer inside the conversation; this answers on stdout, so a
// DOM question can be asked in a repeatable, diffable way and the same query can
// be re-run after every edit. The page is auto-authenticated (see cdp.mjs) if it
// is not already showing the application.
//
//   node page.mjs "document.title"
//   node page.mjs --file query.js [--port 57120] [--raw]
import { readFileSync } from "node:fs";
import { connect, devtoolsPort, ensureGui, findTarget, waitForApp } from "./cdp.mjs";

const argv = process.argv.slice(2);
const flag = (key, fallback) => {
	const at = argv.indexOf(`--${key}`);
	return at === -1 ? fallback : argv[at + 1];
};
const has = (key) => argv.includes(`--${key}`);

const file = flag("file", null);
const literal = file === null ? argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--port") : null;
const expression = file === null ? literal : readFileSync(file, "utf8");
if (!expression) {
	console.error("usage: node page.mjs \"<js expression>\" | --file <path.js> [--port n]");
	process.exit(2);
}

const port = await devtoolsPort(flag("port", undefined));
let target = await findTarget(port, { required: false });
if (target === null) {
	const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	target = list.find((t) => t.type === "page");
}
if (target === undefined) throw new Error(`no page target on ${port}`);

const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
const navigated = await ensureGui(cdp);
if (navigated) await waitForApp(cdp);
// The client bundle boots asynchronously after the document completes.
for (let i = 0; i < 20; i += 1) {
	const loaded = await cdp.send("Runtime.evaluate", { expression: "typeof window.__dshCodeColors", returnByValue: true });
	if (loaded.result.value === "object") break;
	await new Promise((r) => setTimeout(r, 250));
}

const out = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
if (out.exceptionDetails) {
	console.error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
	process.exitCode = 1;
} else {
	console.log(has("raw") ? out.result.value : JSON.stringify(out.result.value, null, 2));
}
cdp.close();
