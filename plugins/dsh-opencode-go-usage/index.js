/**
 * OpenCode Go subscription usage for DeepSeek Harness.
 *
 * Reports how much of the OpenCode Go allowance is spent, from the gateway's own
 * usage endpoint (`https://opencode.ai/zen/go/v1/usage`), which answers with the
 * three rolling windows Go enforces:
 *
 *   {"usage":{
 *      "rolling":{"status":"ok","percent":26,"resetsAt":"2026-09-12T11:50:42Z"},
 *      "weekly": {"status":"ok","percent":41,"resetsAt":"2026-09-14T00:00:00Z"},
 *      "monthly":{"status":"ok","percent":20,"resetsAt":"2026-10-11T15:43:05Z"}}}
 *
 * Verified against this account's own key; the endpoint is not documented on
 * https://opencode.ai/docs/go/ (that page only points at the web console), so
 * treat the response shape as observed rather than guaranteed. Every failure
 * mode is therefore reported instead of thrown: an unavailable reading must
 * never take the GUI down with it.
 *
 * The API key is resolved through `ctx.credentials` with the same
 * `apiKeyEnv` reference the `opencode-go` provider uses, so the plugin follows
 * wherever the route is already configured and never stores a second copy.
 *
 * @module dsh-opencode-go-usage
 */

import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
// The same launch-environment reader `dsh-llm-pi-ai` uses when no credential
// store is reachable, so the fallback order matches the provider's exactly.
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";

/** Default endpoint; Go and Zen share the gateway root but not the entitlement. */
const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
/**
 * Read-only route the Web GUI polls. Lives under `/api` so it inherits
 * Connection's Host fence and browser-session authentication rather than
 * needing an auth story of its own.
 */
const STATUS_PATH = "/api/opencode-go-usage.status";
/** The three windows Go enforces, in the order the console lists them. */
const WINDOW_KEYS = ["rolling", "weekly", "monthly"];
/** Human labels for each window, matching the console's wording. */
const WINDOW_LABELS = {
	rolling: "5-hour",
	weekly: "Weekly",
	monthly: "Monthly",
};

/**
 * Normalize one window from the gateway payload.
 *
 * Only `percent` and `resetsAt` are load-bearing; anything else is passed
 * through as the reported status so an unfamiliar value is still visible rather
 * than silently coerced into "ok".
 * @param key - the window key (`rolling`, `weekly`, `monthly`).
 * @param raw - the gateway's object for that window, if any.
 * @returns the normalized window, or undefined when absent.
 */
function normalizeWindow(key, raw) {
	if (raw === null || typeof raw !== "object") return undefined;
	const percent = typeof raw.percent === "number" && Number.isFinite(raw.percent) ? raw.percent : undefined;
	const resetsAt = typeof raw.resetsAt === "string" ? raw.resetsAt : undefined;
	return {
		key,
		label: WINDOW_LABELS[key] ?? key,
		status: typeof raw.status === "string" ? raw.status : "unknown",
		percent,
		resetsAt,
	};
}

/**
 * Describe a non-2xx answer. The gateway uses typed JSON errors, and the two
 * that matter operationally — no key, or no Go entitlement — read very
 * differently to a user, so they are surfaced verbatim.
 * @param status - HTTP status code.
 * @param body - the raw response text, already size-capped by the caller.
 * @returns a short human-readable reason.
 */
function describeFailure(status, body) {
	let type;
	let message;
	try {
		const parsed = JSON.parse(body);
		type = parsed?.error?.type;
		message = parsed?.error?.message;
	} catch {
		/* not JSON: fall back to the status line */
	}
	if (type === "EntitlementError") return `OpenCode Go subscription required (${message ?? "no entitlement"})`;
	if (type === "AuthError") return `OpenCode Go rejected the credential (${message ?? "unauthorized"})`;
	if (typeof message === "string" && message !== "") return message;
	return `usage request failed with HTTP ${status}`;
}

/**
 * Read one usage window set from the gateway.
 *
 * Kept as a free function rather than a method so it can be exercised without a
 * Cordis context (see verify.mjs): the network and parsing behaviour is the part
 * worth testing, and it has no dependency on the plugin lifecycle.
 * @param options - endpoint, credential, and timeout.
 * @returns `{ windows }` on success; throws a described Error otherwise.
 */
async function fetchUsage({ baseUrl, apiKey, timeoutMs }) {
	const url = `${baseUrl.replace(/\/+$/u, "")}/usage`;
	const response = await fetch(url, {
		headers: {
			authorization: `Bearer ${apiKey}`,
			accept: "application/json",
			// Go prefers clients that identify themselves over generic HTTP libraries.
			"user-agent": "dsh-opencode-go-usage/1.0",
		},
		signal: AbortSignal.timeout(timeoutMs),
	});
	const body = (await response.text()).slice(0, 4_000);
	if (!response.ok) throw new Error(describeFailure(response.status, body));

	const windows = WINDOW_KEYS.map((key) => normalizeWindow(key, JSON.parse(body)?.usage?.[key])).filter(
		(entry) => entry !== undefined,
	);
	if (windows.length === 0) throw new Error("usage response carried no recognizable windows");
	return { windows };
}

/**
 * Publish the reading to the Web GUI.
 *
 * `connection.fetch.register` is an exact route under `/api`, so the browser
 * reaches it with the same origin, cookie, and Host that already authenticate
 * the rest of the GUI — no extra auth, and no typert code generation (the
 * typert generator is not installed in this deployment).
 *
 * Registration is deferred through `ctx.inject` because a plugin can be
 * constructed before `connection` is available; a failure here degrades to
 * "no route" and is reported, never thrown, so a UI convenience can never stop
 * the session from working.
 * @param ctx - plugin context that may gain a `connection` service.
 * @param service - the usage service the route reads from.
 */
function registerStatusRoute(ctx, service) {
	// Deferred because `connection` may mount after this plugin; `fetch.register`
	// itself is scoped to whichever context registers it, so the route must be
	// claimed on the injecting context rather than this one.
	ctx.inject(["connection"], (connectionCtx) => {
		try {
			connectionCtx.connection.fetch.register({
				path: STATUS_PATH,
				methods: ["GET"],
				requestBody: "buffered",
				fetch: () => {
					// Serve the cached reading immediately; the background poll
					// keeps it fresh, so a UI poll never waits on the network.
					return Promise.resolve(
						Response.json(service.status(), {
							headers: { "cache-control": "no-store" },
						}),
					);
				},
			});
			connectionCtx.logger?.info?.(`opencode-go-usage: serving ${STATUS_PATH}`);
		} catch (error) {
			connectionCtx.logger?.warn?.(`opencode-go-usage: could not register ${STATUS_PATH}: ${error}`);
		}
	});
}

/**
 * Owns the subscription-usage reading and its cache.
 *
 * The service is deliberately read-only and failure-tolerant: `status()` always
 * answers, marking unavailability in the payload rather than rejecting, so a
 * UI poll can render something useful even when the network or the
 * subscription is missing.
 */
class OpencodeGoUsage extends Service {
	static Config = z.object({
		enabled: z.boolean().default(true),
		/** Gateway root; the `/usage` path is appended. */
		baseUrl: z.string().default(DEFAULT_BASE_URL),
		/** Credential reference, matching the `opencode-go` provider profile. */
		apiKeyEnv: z.string().default("OPENCODE_GO_API_KEY"),
		/** Minimum age before a cached reading is refreshed. */
		cacheMs: z.natural().default(30_000),
		/** Background refresh period; 0 disables polling. */
		refreshMs: z.natural().default(60_000),
		/** Per-request timeout. */
		timeoutMs: z.natural().default(10_000),
		/**
		 * How long to keep retrying while the credential store is still loading.
		 * The store fills its in-memory map from a file watcher, so the very
		 * first read after boot can miss a credential that exists on disk.
		 */
		credentialRetryMs: z.natural().default(15_000),
	});

	/** Last successful reading, or undefined before the first success. */
	#snapshot;
	/** Why the most recent attempt failed, cleared by any success. */
	#error;
	/** In-flight refresh, so concurrent callers share one request. */
	#inflight;
	/** Interval handle for the background poll. */
	#timer;

	constructor(ctx, config) {
		super(ctx, "opencodeGoUsage");
		this.config = config;
		if (!config.enabled) return;

		// Seed immediately so the first UI poll usually finds data, then keep it
		// warm. Both are fire-and-forget: a failure is recorded, never thrown.
		void this.refresh();
		if (config.refreshMs > 0) {
			this.#timer = setInterval(() => void this.refresh(), config.refreshMs);
			this.#timer.unref?.();
		}
		this.ctx.on("dispose", () => this.stop());
		registerStatusRoute(ctx, this);
	}

	/** Stop polling. Safe to call more than once. */
	stop() {
		if (this.#timer !== undefined) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	/**
	 * Resolve the route credential the same way the provider adapter does.
	 *
	 * Uses `ctx.get("credentials")` rather than `ctx.credentials`: Cordis only
	 * exposes a service as a property when the plugin has injected it, and the
	 * credential store must stay optional here — the adapter treats a missing
	 * store as "fall back to the launch environment", and so does this.
	 *
	 * The launch environment is the fallback because this plugin is activated as
	 * an appended row and may construct before the credential service is
	 * visible; reading the variable directly keeps the first reading correct
	 * instead of reporting a false "no credential" until the next poll.
	 * @returns the API key, or undefined when nothing is stored under the reference.
	 */
	async #apiKey() {
		const ref = this.config.apiKeyEnv;
		// `resolve()` reads an in-memory map that the credential store fills from
		// its file watcher, so it can legitimately answer "nothing" during the
		// first moments after boot. Retry briefly before declaring it missing.
		const deadline = Date.now() + this.config.credentialRetryMs;
		for (;;) {
			const credentials = this.ctx.get("credentials");
			if (credentials !== undefined) {
				const resolved = await credentials.resolve(ref);
				const value = resolved?.value;
				if (typeof value === "string" && value !== "") return value;
			}
			const fromLaunch = launchEnvironmentOf(this.ctx).get(ref)?.value;
			if (typeof fromLaunch === "string" && fromLaunch !== "") return fromLaunch;
			const fromProcess = process.env[ref];
			if (typeof fromProcess === "string" && fromProcess !== "") return fromProcess;
			if (Date.now() >= deadline) return undefined;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	/**
	 * Refresh the reading unless the cache is still fresh.
	 * @param force - ignore the cache age.
	 * @returns the current reading.
	 */
	async refresh(force = false) {
		const age = this.#snapshot === undefined ? Infinity : Date.now() - this.#snapshot.fetchedAt;
		if (!force && age < this.config.cacheMs) return this.status();
		if (this.#inflight !== undefined) return this.#inflight;

		this.#inflight = this.#fetchOnce().finally(() => {
			this.#inflight = undefined;
		});
		return this.#inflight;
	}

	/**
	 * Perform one usage request and fold the outcome into the cached state.
	 * @returns the current reading.
	 */
	async #fetchOnce() {
		const fetchedAt = Date.now();
		try {
			const apiKey = await this.#apiKey();
			if (apiKey === undefined) {
				throw new Error(
					`no credential stored for ${this.config.apiKeyEnv}; store it through the credentials service or export it`,
				);
			}
			const { windows } = await fetchUsage({
				baseUrl: this.config.baseUrl,
				apiKey,
				timeoutMs: this.config.timeoutMs,
			});
			this.#snapshot = { windows, fetchedAt };
			this.#error = undefined;
		} catch (error) {
			// Keep the previous reading visible and record why it is stale.
			this.#error = error instanceof Error ? error.message : String(error);
		}
		return this.status();
	}

	/**
	 * Current reading. Never throws: failures are reported in the payload.
	 * @returns `{ ok, windows, fetchedAt, error }` for the UI to render.
	 */
	status() {
		return {
			ok: this.#snapshot !== undefined && this.#error === undefined,
			stale: this.#snapshot !== undefined && this.#error !== undefined,
			windows: this.#snapshot?.windows ?? [],
			fetchedAt: this.#snapshot?.fetchedAt ?? undefined,
			error: this.#error,
			plan: "opencode-go",
		};
	}
}

export { OpencodeGoUsage, fetchUsage, normalizeWindow, describeFailure, registerStatusRoute, WINDOW_KEYS, DEFAULT_BASE_URL, STATUS_PATH };
export default OpencodeGoUsage;
