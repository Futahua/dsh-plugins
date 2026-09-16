/**
 * Shared backdrop state for DeepSeek Harness.
 *
 * The picture and its switch must follow the person across browsers: the phone
 * and the desktop are different localStorage jars, so browser storage alone
 * strands a choice on whichever screen made it. This service owns one small
 * document on the host — `{ on, img, updatedAt }` in
 * `$DSH_HOME/chat-backdrop.json` — and serves it to every browser behind the
 * same origin, alongside the picture they picked.
 *
 * Two routes, same shape the usage plugin proved: exact paths under `/api`,
 * so they inherit the Connection Host fence and browser-session
 * authentication instead of inventing an auth story.
 *
 *   GET /api/chat-backdrop.state[?since=n]
 *     Always `{ on, updatedAt, hasImg }`. The full `img` rides along only when
 *     the caller is out of date (no `since`, or `since` older than the stored
 *     stamp), so the 15s poll from every open browser costs bytes, not
 *     megabytes. Never throws: an unreadable store answers the default.
 *
 *   PUT /api/chat-backdrop.state  { on?, img? }
 *     Merges what was sent, stamps `updatedAt`, persists, and answers the full
 *     state. `img` must be a `data:image/` URI within the cap, or null to
 *     clear back to the bundled picture; anything else is a 400 that changes
 *     nothing. Last writer wins — both browsers share one clock, the host's.
 *
 * Failure policy matches the usage service: the GUI convenience degrades, the
 * session never does. A failed persist keeps serving memory; a failed read
 * serves the default.
 *
 * @module dsh-chat-backdrop
 */
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

/** Exact route the browsers share. */
const STATE_PATH = "/api/chat-backdrop.state";

/** Largest accepted picture, in data-URI characters (~4.5MB of image). */
const MAX_IMG = 6_000_000;

/** What a browser with no stored choice sees. */
const DEFAULT_STATE = { on: true, img: null, updatedAt: 0 };

class ChatBackdrop extends Service {
	static Config = z.object({
		enabled: z.boolean().default(true),
	});

	/** Last good state, memory-first so a failed disk never blanks a browser. */
	#state = { ...DEFAULT_STATE };
	/** Where it persists. Resolved once; the home never moves under a host. */
	#file;
	/** In-flight load, so concurrent readers share one parse. */
	#loading;

	constructor(ctx, config) {
		super(ctx, "chatBackdrop");
		this.config = config;
		if (!config.enabled) return;
		this.#file = join(resolveDshHome(), "chat-backdrop.json");
		void this.#load();
		ctx.inject(["connection"], (connectionCtx) => {
			try {
				connectionCtx.connection.fetch.register({
					path: STATE_PATH,
					methods: ["GET", "PUT"],
					requestBody: "buffered",
					fetch: (request) => this.#serve(request),
				});
				connectionCtx.logger?.info?.(`chat-backdrop: serving ${STATE_PATH}`);
			} catch (error) {
				connectionCtx.logger?.warn?.(`chat-backdrop: could not register ${STATE_PATH}: ${error}`);
			}
		});
	}

	/** Read the persisted document once, keeping memory on any failure. */
	async #load() {
		if (this.#loading !== undefined) return this.#loading;
		this.#loading = (async () => {
			try {
				const raw = JSON.parse(await fs.readFile(this.#file, "utf8"));
				this.#state = sanitize(raw, this.#state);
			} catch (error) {
				/* absent or broken store: the default stands */
			}
		})();
		return this.#loading;
	}

	/** Persist, atomically enough that a torn write cannot strand browsers. */
	async #save() {
		const text = JSON.stringify(this.#state);
		try {
			await fs.writeFile(this.#file + ".tmp", text);
			await fs.rename(this.#file + ".tmp", this.#file);
		} catch (error) {
			/* memory keeps serving; the disk catches up on the next write */
		}
	}

	/**
	 * Answer one browser request. Never throws: the fetch registry turns a
	 * rejection into a 500 with no body, which tells the browser nothing, so
	 * every failure here is a shaped payload instead.
	 */
	async #serve(request) {
		await this.#load();
		if (request.method === "GET") {
			let since = Number.NaN;
			try {
				const raw = new URL(request.url).searchParams.get("since");
				since = raw === null ? Number.NaN : Number(raw);
			} catch (error) {
				since = Number.NaN;
			}
			return Response.json(publicState(this.#state, Number.isNaN(since) ? -1 : since), {
				headers: { "cache-control": "no-store" },
			});
		}
		if (request.method === "PUT") {
			let body;
			try {
				body = await request.json();
			} catch (error) {
				return Response.json({ error: "body must be JSON" }, { status: 400 });
			}
			const merged = merge(this.#state, body);
			if (merged === null) {
				return Response.json({ error: "send { on?: boolean, img?: data:image/* URI | null }" }, { status: 400 });
			}
			this.#state = merged;
			void this.#save();
			return Response.json(publicState(this.#state, -1), {
				headers: { "cache-control": "no-store" },
			});
		}
		return new Response(null, { status: 405 });
	}
}

/**
 * What browsers may see. `img` rides along only when the caller is out of
 * date; otherwise the shape stays small and the browser keeps its own copy.
 */
function publicState(state, since) {
	const base = { on: state.on, updatedAt: state.updatedAt, hasImg: state.img !== null };
	return since < state.updatedAt ? { ...base, img: state.img } : base;
}

/** Keep only a well-shaped document; anything else leaves memory untouched. */
function sanitize(raw, fallback) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ...fallback };
	const on = typeof raw.on === "boolean" ? raw.on : fallback.on;
	const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : fallback.updatedAt;
	const img = raw.img === null || raw.img === undefined ? fallback.img : validImg(raw.img) ? raw.img : fallback.img;
	return { on, img, updatedAt };
}

/** A picture the browsers may hold, or null for the bundled one. */
function validImg(value) {
	return typeof value === "string" && value.startsWith("data:image/") && value.length <= MAX_IMG;
}

/**
 * Fold a PUT body into the stored state, or null when it says nothing usable.
 * A missing half keeps its stored value; `img: null` clears to the bundled
 * picture. The stamp always moves: the write happened, so browsers polling
 * `since` the old stamp must come and collect it.
 */
function merge(state, body) {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
	const hasOn = typeof body.on === "boolean";
	const hasImg = body.img === null || validImg(body.img);
	if (!hasOn && !hasImg && body.img !== undefined) return null;
	if (!hasOn && body.img === undefined) return null;
	return {
		on: hasOn ? body.on : state.on,
		img: body.img === undefined ? state.img : body.img,
		updatedAt: Date.now(),
	};
}

export { ChatBackdrop, STATE_PATH };
export default ChatBackdrop;
