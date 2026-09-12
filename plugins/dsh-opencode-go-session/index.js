/**
 * OpenCode Go route support for DeepSeek Harness.
 *
 * Closes two gaps in the installed `@earendil-works/pi-ai` (0.85.1) that
 * neither the catalog nor `settings.yaml` can close, without editing anything
 * under `node_modules`.
 *
 * 1. **Session header.** `https://opencode.ai/zen/go/v1` answers a sessionless
 *    request with `400 MissingSessionID`. pi-ai can emit a session-affinity
 *    header only when `compat.sendSessionAffinityHeaders` is set, and only
 *    under the hard-coded names `x-session-id`, `session_id`,
 *    `x-client-request-id` or `x-session-affinity` — `x-opencode-session` is
 *    unreachable by construction (`api/openai-completions.js:557-568`,
 *    `dist/types.d.ts:46`). `dsh-llm-pi-ai` marks those two compat fields
 *    `"withhold"` (`lib/index.js:403,405`), so configuration cannot obtain the
 *    header either, and the only remaining lever — a static profile `headers`
 *    entry — is one fixed id shared by every conversation.
 *
 *    This plugin supplies the header per conversation from the Harness
 *    `SessionId` that the agent loop already threads into every request
 *    (`dsh-agent-loop/lib/index.js:1215` -> `GenerateOptions.sessionId` ->
 *    `dsh-llm-pi-ai/lib/index.js:1871` -> pi-ai stream options). It attaches
 *    pi-ai's own public `transformHeaders` hook (`dist/models.d.ts:43`), which
 *    `applyAuth()` runs last — after auth headers and after the profile's
 *    `headers` — so the per-session value wins and still covers every protocol
 *    on the route.
 *
 * 2. **Missing model.** `deepseek-v4.1-flash` is absent from the installed
 *    opencode-go catalog. Because `api` is a route-level field only, a
 *    catalog-absent model forces `api:` onto the route, and that override then
 *    repoints every other model on the route — which spans three protocols
 *    (`anthropic-messages`, `openai-completions`, `openai-responses`).
 *    Registering the entry below lets the route serve the catalog unchanged,
 *    so each model keeps its native protocol and endpoint.
 *
 * Both are installed at module load — before the adapter resolves any profile —
 * and the class below only reports and reconfigures them; nothing here depends
 * on the service being instantiated eagerly.
 *
 * Remove the `CATALOG_GAPS` entry (and the `modelOverrides` beside it in
 * `settings.yaml`) once pi-ai ships the model; remove the whole plugin once
 * pi-ai emits the header itself.
 *
 * Runtime peers, resolved through `$DSH_HOME/profiles/node_modules` by
 * Node's ordinary parent-walk: `@earendil-works/pi-ai`,
 * `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`.
 *
 * @module dsh-opencode-go-session
 */

import { createHash } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createModels } from "@earendil-works/pi-ai";

/**
 * Catalog entries the installed pi-ai does not describe, in the exact shape
 * `dist/providers/data/opencode-go.json` uses. `compat` mirrors the sibling
 * `deepseek-v4-flash` entry, which is what a hand-declared model otherwise
 * loses: `detectCompat` keys DeepSeek behaviour off `provider === "deepseek"`
 * or a `deepseek.com` base URL, so neither matches this route.
 *
 * `cost` is deliberately zero rather than guessed: the harness never reads
 * pi-ai's cost metadata (`dsh-llm-pi-ai` zeroes it, and undeclared models get
 * the same zeros), so a wrong number would be an invented fact.
 *
 * `input` is text-only, matching the non-vision siblings; a vision-capable
 * revision needs `["text", "image"]` here.
 */
const CATALOG_GAPS = [
	{
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		api: "openai-completions",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		},
		thinkingLevelMap: {
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			max: "max",
		},
	},
];

/** Live settings the request hook reads; module scope so a late service still gets defaults. */
const runtime = {
	enabled: true,
	providers: new Set(["opencode-go"]),
	header: "x-opencode-session",
	sessionIdStyle: "uuid",
};

/** A load-time failure to register the catalog gaps, reported once a logger exists. */
let catalogGapError;
/** How many catalog gaps were registered, for the startup log line. */
let catalogGapCount = 0;

/**
 * pi-ai's exports map does not expose `models.generated.js`, and `getBuiltinModels`
 * returns a detached array, so the only way to add a model the installed catalog
 * lacks is to reach the generated module directly — its URL taken from beside the
 * package entry, which resolves to the same module instance the catalog reads.
 * @returns the generated catalog module.
 */
async function importGeneratedCatalog() {
	const entry = import.meta.resolve("@earendil-works/pi-ai");
	return await import(new URL("./models.generated.js", entry).href);
}

/**
 * Register every catalog gap not already present. An id the installed catalog
 * already describes is left untouched, so this is idempotent and quietly
 * becomes a no-op once pi-ai ships the model.
 */
async function registerCatalogGaps() {
	const { MODELS } = await importGeneratedCatalog();
	for (const model of CATALOG_GAPS) {
		const catalog = MODELS[model.provider];
		if (catalog === undefined) throw new Error(`pi-ai catalog has no "${model.provider}" route`);
		if (catalog[model.id] !== undefined) continue;
		catalog[model.id] = { ...model };
		catalogGapCount += 1;
	}
}

try {
	await registerCatalogGaps();
} catch (error) {
	catalogGapError = error;
}

/**
 * Derive a stable RFC 4122 version-5-shaped UUID from one conversation id.
 *
 * Deterministic on purpose: every turn of a conversation must present the same
 * session to the gateway, or affinity and prompt-cache attribution break, and
 * two conversations must never collide. The digest is used rather than the raw
 * Harness id because the gateway's own ids are UUIDs and a format check cannot
 * be ruled out from here; `sessionIdStyle: raw` sends the Harness id verbatim
 * instead, which is easier to trace in logs if the gateway accepts it.
 * @param sessionId - the Harness `SessionId` string.
 * @returns a lower-case UUID string, stable for that session.
 */
function sessionUuid(sessionId) {
	const digest = createHash("sha1").update(`dsh:opencode-go:${sessionId}`).digest();
	const bytes = Buffer.from(digest.subarray(0, 16));
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Add the session header to one request's options, preserving any transform an
 * outer layer already installed.
 * @param model - the resolved pi-ai model descriptor.
 * @param options - the stream options the adapter passed.
 * @returns the options to forward, with the header hook attached when applicable.
 */
function withSessionHeader(model, options) {
	if (!runtime.enabled) return options;
	if (!runtime.providers.has(model?.provider)) return options;
	const sessionId = options?.sessionId;
	if (sessionId === undefined || sessionId === null || String(sessionId).length === 0) return options;
	const value = runtime.sessionIdStyle === "raw" ? String(sessionId) : sessionUuid(String(sessionId));
	const inner = options?.transformHeaders;
	return {
		...options,
		transformHeaders: async (headers) => {
			const merged = inner === undefined ? headers : await inner(headers);
			return { ...(merged ?? {}), [runtime.header]: value };
		},
	};
}

/** A failure to install the request hook, reported once a logger exists. */
let hookError;

/**
 * Wrap `stream` and `streamSimple` on pi-ai's `Models` prototype — the single
 * seam every request passes, since `complete`/`completeSimple` delegate to them
 * and the adapter calls `streamSimple`. `Models` is a class
 * (`dist/models.js:22`), so one prototype patch covers every collection,
 * including the one the adapter builds from live configuration.
 */
function installSessionHook() {
	try {
		const prototype = Object.getPrototypeOf(createModels({}));
		const wrapped = {};
		for (const method of ["stream", "streamSimple"]) {
			const original = prototype[method];
			if (typeof original !== "function") throw new Error(`pi-ai Models.${method} is not callable`);
			wrapped[method] = function (model, context, options) {
				return original.call(this, model, context, withSessionHeader(model, options));
			};
		}
		Object.assign(prototype, wrapped);
	} catch (error) {
		hookError = error;
	}
}

installSessionHook();

/**
 * Owns the OpenCode Go session header and the catalog catch-up.
 *
 * The service itself is inert — the work happens at module load so that no
 * ordering assumption is needed — but carrying a service keeps the plugin
 * shaped like every other DSH plugin and gives the configuration a validated
 * home and a startup report.
 */
class OpencodeGoSessionConfig extends Service {
	static Config = z.object({
		enabled: z.boolean().default(true),
		providers: z.array(z.string()).default(["opencode-go"]),
		header: z.string().default("x-opencode-session"),
		sessionIdStyle: z.union(["uuid", "raw"]).default("uuid"),
	});

	constructor(ctx, config) {
		super(ctx, "opencodeGoSession");
		runtime.enabled = config.enabled;
		runtime.providers = new Set(config.providers);
		runtime.header = config.header;
		runtime.sessionIdStyle = config.sessionIdStyle;

		// This entry activates before every bundle, so it must not assume a
		// logger exists yet.
		const log = ctx.logger;
		if (catalogGapError !== undefined) {
			log?.warn?.(`opencode-go-session: could not register catalog gaps, so configured models pi-ai does not describe will stay unresolvable: ${catalogGapError}`);
		} else if (catalogGapCount > 0) {
			log?.info?.(`opencode-go-session: registered ${catalogGapCount} model(s) the installed pi-ai catalog lacks`);
		}
		if (hookError !== undefined) {
			log?.warn?.(`opencode-go-session: could not install the per-session header hook, so requests may fail with MissingSessionID: ${hookError}`);
		}
		if (config.enabled && catalogGapError === undefined && hookError === undefined) {
			log?.info?.(`opencode-go-session: sending "${config.header}" per conversation (${config.sessionIdStyle}) for ${config.providers.join(", ")}`);
		}
	}
}

export { CATALOG_GAPS, OpencodeGoSessionConfig, sessionUuid };
export default OpencodeGoSessionConfig;
