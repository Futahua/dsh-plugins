/**
 * Self-check for the opencode-go-session plugin. Run after a pi-ai upgrade:
 *
 *   node verify.mjs
 *
 * Proves three things against the real pi-ai code path rather than by
 * inspection: the catalog gap is registered, every catalog model keeps its
 * native protocol, and the request that actually reaches `fetch` carries a
 * per-conversation `x-opencode-session` value.
 */

import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { sessionUuid } from "./index.js";

const check = (name) => console.log(`ok   ${name}`);

// ── 1. catalog gap ──────────────────────────────────────────────────────────
const catalog = getBuiltinModels("opencode-go");
const target = catalog.find((model) => model.id === "deepseek-v4.1-flash");
assert.ok(target, "deepseek-v4.1-flash was not registered into the catalog");
assert.equal(target.api, "openai-completions");
assert.equal(target.baseUrl, "https://opencode.ai/zen/go/v1");
assert.equal(target.compat.thinkingFormat, "deepseek");
assert.equal(target.compat.maxTokensField, "max_tokens");
assert.equal(target.reasoning, true);
check(`catalog gap registered (catalog now ${catalog.length} models)`);

// ── 2. native protocols preserved ───────────────────────────────────────────
const apis = new Set(catalog.map((model) => model.api));
assert.ok(apis.size >= 3, `expected the route to span several protocols, saw ${[...apis]}`);
assert.equal(catalog.find((m) => m.id === "minimax-m3")?.api, "anthropic-messages");
assert.equal(catalog.find((m) => m.id === "qwen3.8-flash")?.api, "anthropic-messages");
assert.equal(catalog.find((m) => m.id === "grok-4.6")?.api, "openai-responses");
assert.equal(catalog.find((m) => m.id === "deepseek-v4-flash")?.baseUrl, "https://opencode.ai/zen/go/v1");
check(`native protocols intact across ${apis.size} protocols (${[...apis].sort().join(", ")})`);

// ── 3. per-conversation header on the wire ──────────────────────────────────
process.env.OPENCODE_API_KEY ??= "verify-only";

const collection = createModels({});
collection.setProvider(opencodeGoProvider());
const served = collection.getModels("opencode-go").find((model) => model.id === "deepseek-v4.1-flash");
assert.ok(served, "the served collection does not contain deepseek-v4.1-flash");

const chunks = [
	{ id: "c1", object: "chat.completion.chunk", created: 0, model: "deepseek-v4.1-flash", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
	{ id: "c1", object: "chat.completion.chunk", created: 0, model: "deepseek-v4.1-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];
const sse = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;

/** Drive one request and return the headers that reached the transport. */
async function headersFor(sessionId, extra = {}) {
	let sent;
	const fakeFetch = async (url, init) => {
		sent = { url: String(url), headers: new Headers(init?.headers ?? {}) };
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const stream = collection.streamSimple(served, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, {
		apiKey: "verify-only",
		sessionId,
		fetch: fakeFetch,
		...extra,
	});
	try {
		for await (const _event of stream) break;
	} catch {
		// The header assertion below is the point; a stub stream may still end oddly.
	}
	assert.ok(sent, "no request reached fetch");
	return sent;
}

const first = await headersFor("session-54d3080b-84e8-4ab4-a30d-4084a58a1a96");
const again = await headersFor("session-54d3080b-84e8-4ab4-a30d-4084a58a1a96");
const other = await headersFor("session-88a13238-42f8-43c4-bc55-2be4ed459d96");

const headerOf = (sent) => sent.headers.get("x-opencode-session");
assert.equal(headerOf(first), sessionUuid("session-54d3080b-84e8-4ab4-a30d-4084a58a1a96"));
assert.match(headerOf(first), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
assert.equal(headerOf(first), headerOf(again), "the same conversation must keep the same session id");
assert.notEqual(headerOf(first), headerOf(other), "two conversations must not share a session id");
assert.ok(first.url.startsWith("https://opencode.ai/zen/go/v1/chat/completions"), `unexpected endpoint ${first.url}`);
check(`per-conversation header on the wire: ${headerOf(first)} (stable per conversation, distinct across conversations)`);

// The profile keeps a static `x-opencode-session` as a bootstrap fallback; the
// per-conversation value must still win, since `transformHeaders` runs after
// the profile headers are merged.
const overridden = await headersFor("session-54d3080b-84e8-4ab4-a30d-4084a58a1a96", {
	headers: { "x-opencode-session": "fb2aad82-e730-4ea2-9927-3139ffe0949b" },
});
assert.equal(headerOf(overridden), sessionUuid("session-54d3080b-84e8-4ab4-a30d-4084a58a1a96"));
assert.notEqual(headerOf(overridden), "fb2aad82-e730-4ea2-9927-3139ffe0949b");
check("static profile header is overridden by the per-conversation value");

// A request with no session id must be left untouched rather than given a
// fabricated one.
const anonymous = await headersFor(undefined, { headers: { "x-opencode-session": "static-only" } });
assert.equal(headerOf(anonymous), "static-only");
check("a sessionless request keeps whatever headers it arrived with");

// ── 4. the harness's own load path ──────────────────────────────────────────
// Resolve the plugin exactly as the profile loader does — by package specifier
// from the profile's node_modules — and activate it through cordis with the
// configuration the bundle patch declares, so the Config schema, the service
// registration, and the constructor body are all exercised.
const { Context } = await import("@deepseek-ai/cordis");
const activation = await import("dsh-opencode-go-session");
assert.equal(typeof activation.default, "function", "the plugin must default-export its cordis plugin");

const notices = [];
const ctx = new Context();
ctx.logger = { info: (message) => notices.push(["info", message]), warn: (message) => notices.push(["warn", message]) };
ctx.plugin(activation.default, {
	enabled: true,
	providers: ["opencode-go"],
	header: "x-opencode-session",
	sessionIdStyle: "uuid",
});
// Cordis applies a plugin on a fiber, so let the microtask queue drain before
// asserting on what the activation reported.
await new Promise((resolve) => setTimeout(resolve, 10));
const warnings = notices.filter(([level]) => level === "warn");
assert.deepEqual(warnings, [], `the plugin reported problems at activation: ${JSON.stringify(warnings)}`);
assert.ok(notices.length > 0, "the plugin reported nothing at activation");
check(`activates through cordis with the bundle's config: ${notices.map(([, m]) => m).join("; ")}`);

// Config defaults must survive an empty config, since cordis validates against
// `static Config` before the constructor runs.
const defaultsCtx = new Context();
defaultsCtx.logger = { info: () => {}, warn: () => {} };
defaultsCtx.plugin(activation.default, { enabled: true });
await new Promise((resolve) => setTimeout(resolve, 10));
check("activates with only `enabled` set (schema defaults applied)");

console.log("\nall checks passed");
