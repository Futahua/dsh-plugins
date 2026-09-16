// Exercise the backdrop host service without the server: fake ctx, temp home.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "bd-test-"));
const { default: ChatBackdrop } = await import("./index.js");

let route = null;
const noop = () => {};
const fakeCtx = new Proxy(
	{
		reflect: { provide: noop },
		inject(deps, cb) {
			cb({ connection: { fetch: { register(r) { route = r; } } }, logger: { info: noop, warn: noop } });
		},
	},
	{
		get(t, p) {
			if (p in t) return t[p];
			if (p === Symbol.toPrimitive) return undefined;
			return (...args) => ({ dispose: noop, off: noop, rebind: noop });
		},
	},
);
const svc = new ChatBackdrop(fakeCtx, { enabled: true });
await new Promise((r) => setTimeout(r, 300));
if (route === null) throw new Error("route was not registered");

const call = async (method, body, query = "") => {
	const init = { method, headers: {} };
	if (body !== undefined) {
		init.headers["content-type"] = "application/json";
		init.body = JSON.stringify(body);
	}
	const res = await route.fetch(new Request("http://x" + route.path + query, init));
	let json = null;
	try { json = await res.json(); } catch {}
	return { status: res.status, json };
};
const checks = [];
const check = (name, ok, detail) => {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  — " + detail}`);
};

// 1. default state on a fresh home
let r = await call("GET");
check("fresh home answers the default", r.status === 200 && r.json.on === true && r.json.img === null && r.json.updatedAt === 0, JSON.stringify(r.json));

// 2. PUT on+img persists and echoes a stamp
const IMG = "data:image/png;base64,AAAABBBB";
r = await call("PUT", { on: true, img: IMG });
check("PUT merges and stamps", r.status === 200 && r.json.on === true && r.json.img === IMG && r.json.updatedAt > 0, `updatedAt=${r.json?.updatedAt}`);

// 3. poll with current stamp: small answer, no img
r = await call("GET", undefined, `?since=${r.json.updatedAt}`);
check("up-to-date poll stays small", r.status === 200 && !("img" in r.json) && r.json.hasImg === true, JSON.stringify(r.json));

// 4. stale poll carries the picture
r = await call("GET", undefined, "?since=0");
check("stale poll carries img", r.status === 200 && r.json.img === IMG, `keys=${Object.keys(r.json).join(",")}`);

// 5. toggle off keeps the picture, bumps the stamp
const t1 = r.json.updatedAt;
r = await call("PUT", { on: false });
check("off keeps img, moves stamp", r.status === 200 && r.json.on === false && r.json.img === IMG && r.json.updatedAt >= t1, JSON.stringify({ on: r.json.on, updatedAt: r.json.updatedAt }));

// 6. garbage rejected, state untouched
r = await call("PUT", { on: "yes", img: "http://evil/x" });
check("garbage is a 400", r.status === 400, JSON.stringify(r.json));
r = await call("GET");
check("state survived garbage", r.json.on === false && r.json.img === IMG, JSON.stringify({ on: r.json.on }));

// 7. persisted to disk (the save is fire-and-forget: poll briefly)
let disk = null;
for (let i = 0; i < 40 && disk === null; i += 1) {
	try {
		disk = JSON.parse(readFileSync(join(process.env.DSH_HOME, "chat-backdrop.json"), "utf8"));
	} catch {
		await new Promise((r) => setTimeout(r, 50));
	}
}
check("disk matches memory", disk !== null && disk.on === false && disk.img === IMG, disk === null ? "no file appeared" : `updatedAt=${disk.updatedAt}`);

// 8. a second instance loads the persisted document
let route2 = null;
const ctx2 = { reflect: { provide: () => {} }, inject(d, cb) { cb({ connection: { fetch: { register(x) { route2 = x; } } }, logger: {} }); }, on() {}, get() {} };
const svc2 = new ChatBackdrop(ctx2, { enabled: true });
await new Promise((res) => setTimeout(res, 300));
const res2 = await route2.fetch(new Request("http://x/api/chat-backdrop.state"));
const j2 = await res2.json();
check("restart restores persisted state", j2.on === false && j2.img === IMG, JSON.stringify({ on: j2.on }));

// 9. disabled plugin registers nothing
let route3 = "unset";
new ChatBackdrop({ reflect: { provide: () => {} }, inject() { route3 = "injected"; }, on() {}, get() {} }, { enabled: false });
check("disabled registers no route", route3 === "unset");

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length > 0 ? 1 : 0);
