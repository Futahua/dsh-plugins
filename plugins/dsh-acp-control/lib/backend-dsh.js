/**
 * The `dsh` backend: binds each ACP session to a real DeepSeek Harness agent.
 *
 * This is the production path. The `scripted` adapter exists so the protocol
 * can be verified without a model; this one is what the plugin is *for*.
 *
 * Every peer package is imported lazily, inside {@link createDshBackend},
 * because the module is reachable from `lib/standalone.js`, which must stay
 * importable outside a DSH install. A static import here would make the whole
 * plugin unloadable in exactly the situation where a clear error is wanted.
 *
 * The seams used are the same ones the first-party `@deepseek-ai/dsh-acp`
 * uses — `ctx.agents.create`/`resume` with a `setup` callback, the agent's own
 * unpublished setup context for event listeners, and `installModelSelection`
 * for the per-session route. Reading that package's `lib/index.js` is the
 * fastest way to understand this one.
 *
 * @module dsh-acp-control/backend-dsh
 */

import { promptToText } from "./backends.js";

/** DSH turn-end reason → ACP `StopReason`.
 *
 * Mirrors the first-party codec (`@deepseek-ai/dsh-acp/lib/index.js`, the
 * `turnEndToStopReason` switch) member for member, rather than inventing a
 * mapping. Two of its choices are surprising enough to be worth not
 * rediscovering: `aborted` maps to `end_turn`, not `cancelled` — a cancellation
 * that the *client* asked for is reported through the prompt request's own
 * abort path, so by the time a turn ends as `aborted` the reason is an internal
 * abort, not a user cancel — and `error` maps to `end_turn` because the failure
 * already reached the client as an error event, and ACP's `refusal` means the
 * *model* declined.
 */
export function stopReasonOf(reason) {
	if (reason === undefined) return "end_turn";
	switch (reason.kind) {
		case "completed":
			return "end_turn";
		case "max-tokens":
			return "max_tokens";
		case "aborted":
			return "end_turn";
		case "interrupted":
			return "cancelled";
		case "blocked":
		case "error":
			return "end_turn";
		default:
			return "end_turn";
	}
}

/** DSH tool name → ACP `ToolKind`. Icon/UX hint only. */
export function toolKindOf(name) {
	if (name === "bash" || name === "pwsh") return "execute";
	if (name === "read") return "read";
	if (name === "edit" || name === "write" || name === "str_replace_editor") return "edit";
	if (name === "glob" || name === "grep") return "search";
	if (name === "web_search" || name === "web_fetch") return "fetch";
	if (name === "subagent" || name === "workflow" || name === "ralph" || name === "todo_write") return "think";
	return "other";
}

/**
 * Pure DSH session event → ACP `session/update` translation.
 *
 * Pure on purpose: it is the one piece of the DSH adapter that can be checked
 * without a harness, and it is where a protocol bug would be invisible — an
 * update that never arrives looks exactly like an agent that said nothing.
 *
 * **This build has no `assistant/chunk` event.** Its vocabulary is the
 * committed `assistant/message`, plus `tool/call`, `tool/result`, `turn/start`,
 * `turn/end`, `step/*`. That is not a guess: the set is generated into
 * `@deepseek-ai/dsh-session/lib/types/known-event-types.js`, and the first-party
 * bridge reads `assistant/message` too. An earlier revision of this adapter
 * translated raw `assistant/chunk` deltas — a shape an older third-party plugin
 * was written against — and the effect was a turn that completed with
 * `end_turn` and delivered *nothing*: the classic silent no-op, caught only by
 * running it against a live profile (verify/plugin-boot.mjs). Hence the
 * deliberate mirroring of the first-party's block walk below.
 *
 * @param {object} event - a committed DSH session event.
 * @returns {object[]} the ACP updates it projects to; empty when it has none.
 */
export function translateSessionEvent(event) {
	switch (event?.type) {
		case "assistant/message": {
			// One committed message, walked in block order: reasoning first if
			// the model emitted it, then the answer. `messageId` is DSH's own
			// id, so a client can group chunks into one message — the point of
			// ACP's Message ID support.
			const message = event.data?.message;
			if (message === undefined) return [];
			const updates = [];
			for (const block of message.content ?? []) {
				if (block?.type === "reasoning") {
					if (typeof block.text === "string" && block.text.length > 0) {
						updates.push({
							sessionUpdate: "agent_thought_chunk",
							messageId: message.id,
							content: { type: "text", text: block.text },
						});
					}
					continue;
				}
				if (block?.type === "text") {
					if (typeof block.text === "string" && block.text.length > 0) {
						updates.push({
							sessionUpdate: "agent_message_chunk",
							messageId: message.id,
							content: { type: "text", text: block.text },
						});
					}
					continue;
				}
				if (block?.type === "image") {
					// The bytes live in the attachment store and resolving them
					// needs services this slice does not inject; a marker is
					// honest, whereas silence would look like an empty answer.
					updates.push({
						sessionUpdate: "agent_message_chunk",
						messageId: message.id,
						content: { type: "text", text: "[image output]" },
					});
				}
			}
			return updates;
		}
		case "tool/call": {
			const { callId, name, arguments: rawArguments } = event.data ?? {};
			let parsed;
			try {
				parsed = JSON.parse(rawArguments);
			} catch {
				// Malformed model JSON is preserved as an opaque string rather
				// than dropped: the call still happened.
				parsed = rawArguments;
			}
			const record = parsed !== null && typeof parsed === "object" ? parsed : {};
			const path = typeof record.file_path === "string" ? record.file_path : typeof record.path === "string" ? record.path : undefined;
			return [
				{
					sessionUpdate: "tool_call",
					toolCallId: String(callId),
					title: typeof name === "string" ? name : "tool",
					kind: toolKindOf(String(name)),
					// `in_progress`, not `pending`: the call is already committed
					// to the durable log by the time this event exists, so it is
					// running, not awaiting input.
					status: "in_progress",
					rawInput: parsed,
					...(path === undefined ? {} : { locations: [{ path }] }),
				},
			];
		}
		case "tool/result": {
			const block = event.data?.message?.content?.[0];
			if (block === undefined) return [];
			const content = [];
			for (const part of block.content ?? []) {
				if (part?.type === "text" && part.text.length > 0) {
					content.push({ type: "content", content: { type: "text", text: part.text } });
				}
			}
			// `isError` is the result's own verdict; `event.data.error` is the
			// turn-level failure. Either means the tool failed.
			const failed = block.isError === true || event.data?.error !== undefined;
			if (event.data?.error !== undefined) {
				content.push({
					type: "content",
					content: { type: "text", text: `error ${event.data.error.name}: ${event.data.error.code}` },
				});
			}
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId: String(block.toolCallId),
					status: failed ? "failed" : "completed",
					content,
				},
			];
		}
		case "todo/write": {
			return [
				{
					sessionUpdate: "plan",
					entries: (event.data?.todos ?? []).map((todo) => ({
						content: todo.content,
						priority: "medium",
						status: todo.status,
					})),
				},
			];
		}
		default:
			return [];
	}
}

/**
 * Build the DSH backend.
 *
 * @param {object} options - backend options.
 * @param {object} options.ctx - the Cordis context to create agents under.
 * @param {(message: string) => void} [options.logger] - diagnostics.
 * @param {string} [options.provider] - provider route override; the profile default is used when absent.
 * @param {string} [options.model] - model override; the profile default is used when absent.
 * @returns {Promise<object>} the backend adapter.
 */
export async function createDshBackend({ ctx, logger, provider, model }) {
	const [{ installModelSelection }, { createUserMessage }, { SessionId }] = await Promise.all([
		import("@deepseek-ai/dsh-agent"),
		import("@deepseek-ai/dsh-llm"),
		import("@deepseek-ai/dsh-session"),
	]);

	const agents = ctx.get?.("agents");
	if (agents === undefined) {
		throw new Error(
			"the dsh backend needs ctx.agents; boot the plugin inside a DSH profile that mounts @deepseek-ai/dsh-agent-loop",
		);
	}

	/** The route for a new session: the configured pin, else the profile's live default. */
	function selection() {
		if (provider !== undefined && model !== undefined) return { provider, model };
		const fallback = ctx.get?.("agentDefaultModel")?.currentSelection?.();
		if (fallback !== undefined) return { provider: provider ?? fallback.provider, model: model ?? fallback.model };
		return undefined;
	}

	/** The live agent handles this backend owns, by ACP session id. */
	const live = new Map();

	/**
	 * Open one agent and wire its event stream into ACP updates.
	 *
	 * Listeners are registered through the agent's own unpublished setup
	 * context, so `dsh-scope` filters events to exactly this agent and Cordis
	 * unregisters them when it is disposed — which is what keeps a session's
	 * updates from leaking into another's.
	 */
	async function open({ sessionId, cwd, resume }) {
		const sink = { emit: () => {}, requestPermission: undefined, lastTurnEnd: undefined };
		const route = selection();
		const setup = (agentCtx) => {
			if (route !== undefined) installModelSelection(agentCtx, { current: route, assembled: undefined });
			agentCtx.on("session/event", (_session, event) => {
				if (event?.type === "turn/end") {
					sink.lastTurnEnd = event.data?.reason;
					return;
				}
				// A committed event can project to several updates — one
				// message carries reasoning and answer blocks — so the
				// translator returns a list and every element is emitted.
				for (const update of translateSessionEvent(event)) sink.emit(update);
			});
			agentCtx.on("approval/request", (request, next) => {
				// Only this server's own session is answered here; a subagent
				// child or a foreign agent falls through to DSH's own policy, so
				// this backend never becomes a blanket auto-approver.
				if (String(request?.agent?.id) !== sessionId) return next();
				if (sink.requestPermission === undefined) return next();
				return sink
					.requestPermission({
						toolCall: {
							toolCallId: request.callId ?? `permission-${request.toolName}`,
							title: request.reason ?? `Permission: ${request.toolName}`,
							kind: "other",
							status: "pending",
						},
					})
					.then((decision) => {
						if (decision.optionId === null) return "cancelled";
						return decision.optionId.startsWith("allow") ? "allowed-once" : "rejected";
					})
					.catch(() => "unavailable");
			});
		};
		const handle = resume === true
			? await agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: route, setup })
			: await agents.create({
					sessionId: SessionId(sessionId),
					meta: { cwd },
					agentOptions: route,
					setup,
				});
		live.set(sessionId, handle);
		// The listeners registered in `setup` close over this exact object, so
		// it is handed back rather than a lookalike: a second sink would leave
		// the listeners writing into a cell nobody reads, which is the
		// silent-no-op shape this plugin exists to eliminate.
		return { handle, sink };
	}

	/** Build the ACP-facing session object over one agent handle and its listener sink. */
	function sessionFor(handle, sink, sessionId) {
		return {
			async prompt({ content, emit, requestPermission, signal }) {
				sink.emit = emit;
				sink.requestPermission = requestPermission;
				sink.lastTurnEnd = undefined;
				const onAbort = () => handle.agent.cancel({ kind: "user" });
				signal?.addEventListener("abort", onAbort, { once: true });
				try {
					handle.agent.followup(
						createUserMessage({
							content: [{ type: "text", text: promptToText(content) }],
							source: { kind: "user" },
						}),
					);
					await handle.agent.whenIdle();
					if (sink.lastTurnEnd?.kind === "error") {
						throw new Error(sink.lastTurnEnd.error?.message ?? "agent turn failed");
					}
					return { stopReason: stopReasonOf(sink.lastTurnEnd) };
				} finally {
					signal?.removeEventListener("abort", onAbort);
					sink.requestPermission = undefined;
				}
			},
			cancel() {
				handle.agent.cancel({ kind: "user" });
			},
			async dispose() {
				live.delete(sessionId);
				await handle.dispose();
			},
		};
	}

	return {
		name: "dsh",
		async create({ sessionId, cwd }) {
			const { handle, sink } = await open({ sessionId, cwd, resume: false });
			logger?.(`agent ${sessionId} created under the dsh backend (cwd ${cwd})`);
			return sessionFor(handle, sink, sessionId);
		},
		async resume({ sessionId, cwd }) {
			const { handle, sink } = await open({ sessionId, cwd, resume: true });
			logger?.(`agent ${sessionId} resumed under the dsh backend`);
			return sessionFor(handle, sink, sessionId);
		},
		async list() {
			const query = ctx.get?.("sessionQuery");
			if (query === undefined) {
				// Without the query service the list is the live agents only,
				// which is honest: it is what this process can actually see.
				return [...live.keys()].map((sessionId) => ({ sessionId, cwd: "/" }));
			}
			try {
				const records = await query.listSessions();
				const titles = new Map();
				try {
					for (const observation of await query.readTitleSnapshots(records.map((record) => record.header.id))) {
						if ("value" in observation && observation.value?.title !== undefined) {
							titles.set(observation.sessionId, observation.value.title.title);
						}
					}
				} catch {
					// Titles are best-effort; a session with no title is still a session.
				}
				return records.map((record) => ({
					sessionId: record.header.id,
					cwd: record.header.cwd ?? "/",
					title: titles.get(record.header.id),
					updatedAt: record.header.createdAt === undefined ? undefined : new Date(record.header.createdAt).toISOString(),
				}));
			} catch (error) {
				logger?.(`sessionQuery.listSessions failed: ${error instanceof Error ? error.message : String(error)}`);
				return [...live.keys()].map((sessionId) => ({ sessionId, cwd: "/" }));
			}
		},
		async remove(sessionId) {
			const handle = live.get(sessionId);
			if (handle === undefined) return;
			live.delete(sessionId);
			try {
				await handle.dispose();
			} catch (error) {
				logger?.(`dispose failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	};
}

/**
 * Load the DSH backend from `lib/standalone.js`'s `--backend dsh`.
 *
 * There is no context to build agents under outside a profile boot, and
 * inventing one here would produce a second, differently-configured harness
 * inside the process that is supposed to be serving the first. So this refuses
 * with the instruction instead.
 *
 * @param {object} options - `{logger}`.
 * @returns {Promise<never>} never returns.
 */
export async function loadDshBackend({ logger } = {}) {
	logger?.("--backend dsh needs a DSH profile boot; use the Cordis plugin (index.js) instead");
	throw new Error(
		"--backend dsh is not available from the standalone entry: the dsh backend creates agents through ctx.agents, " +
			"so it must run inside a DSH profile. Add dsh-acp-control to a profile's bundles and boot `dsh <profile>`.",
	);
}
