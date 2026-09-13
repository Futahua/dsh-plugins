/**
 * The `dsh` backend: binds ACP sessions to real DeepSeek Harness agents.
 *
 * Two relationships to an agent, and the difference matters more than any other
 * thing in this file:
 *
 *  - **Owned.** This plugin called `ctx.agents.create`/`resume`, so it holds the
 *    handle and owns teardown. Used for sessions the ACP client asked for.
 *  - **Adopted.** The agent already exists — the web GUI created it and is
 *    driving it right now — so this plugin *gets* it with `ctx.agents.get` and
 *    **must never dispose it**. Disposing another frontend's agent would tear
 *    down the session the human is looking at. `agent.ctx` is the agent-scoped
 *    Context, the same object `setup` receives at create time, so an adopted
 *    agent can be observed with a scoped listener even though this plugin was
 *    not there when it was built.
 *
 * Everything here was established by reading the installed packages
 * (`@deepseek-ai/dsh-agent`, `-session`, `-llm`, `-api-session-controller`,
 * `-api-workspace-controller`, `-plan-mode`), and DESIGN.md §0 records the
 * findings this is built from.
 *
 * @module dsh-acp-control/backend-dsh
 */

import { promptToText } from "./backends.js";

/** The name this plugin's messages are attributed to. */
export const PLUGIN_SOURCE = "dsh-acp-control";

/**
 * How long `session/list` will wait for per-session titles before listing
 * without them.
 *
 * Titles cost one store read each, so the phase is O(sessions) against the
 * host's whole store. Bounded because a caller that asked for a list is not
 * asking to wait for the slowest session on the machine.
 */
const TITLE_BUDGET_MS = 10_000;

/** DSH turn-end reason → ACP `StopReason`. Mirrors the first-party codec member for member. */
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
 * **This build has no `assistant/chunk` event.** Its vocabulary is the committed
 * `assistant/message`, plus `tool/call`, `tool/result`, `turn/*`, `step/*` —
 * generated into
 * `@deepseek-ai/dsh-session/lib/types/known-event-types.js`. An earlier revision
 * translated raw deltas and produced a turn that ended `end_turn` having
 * delivered nothing.
 *
 * @param {object} event - a committed DSH session event.
 * @returns {object[]} the ACP updates it projects to; empty when it has none.
 */
export function translateSessionEvent(event) {
	switch (event?.type) {
		case "assistant/message": {
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

/** A sink the listeners write into; the session object decides what each field does. */
function makeSink() {
	return { emit: () => {}, requestPermission: undefined, lastTurnEnd: undefined, onEvent: undefined };
}

/**
 * Register this plugin's listeners on one agent's own scoped context.
 *
 * `agentCtx` is scope-filtered to exactly this agent, and Cordis unregisters
 * everything when the agent is disposed — which is what keeps one session's
 * updates out of another's.
 *
 * @param {object} agentCtx - the agent's scoped context.
 * @param {string} sessionId - the session id the listeners belong to.
 * @param {object} sink - the sink to write into.
 * @returns {() => void} a disposer that removes this plugin's listeners.
 */
function wireListeners(agentCtx, sessionId, sink) {
	const disposers = [];
	disposers.push(
		agentCtx.on("session/event", (_session, event) => {
			// An adopted session hands every event to the registry, which owns
			// both the state tracking and the update translation. An owned
			// session translates here, because its prompt path owns the turn.
			if (sink.onEvent !== undefined) {
				sink.onEvent(event);
				return;
			}
			if (event?.type === "turn/end") {
				sink.lastTurnEnd = event.data?.reason;
				return;
			}
			for (const update of translateSessionEvent(event)) sink.emit(update);
		}),
	);
	disposers.push(
		agentCtx.on("approval/request", (request, next) => {
			// Only this session's own agent, and only while a turn *this plugin*
			// started is in flight. Outside that window the request belongs to
			// the human's turn and falls through to DSH's own answerer — the
			// GUI — rather than being silently answered by a controller the
			// human cannot see. See DESIGN.md §11 for the policy and its
			// alternatives.
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
		}),
	);
	return () => {
		for (const dispose of disposers) {
			try {
				dispose?.();
			} catch {
				// A listener whose scope already unwound needs no removal.
			}
		}
	};
}

/**
 * Build the DSH backend.
 *
 * @param {object} options - backend options.
 * @param {object} options.ctx - the Cordis context to create agents under and read canonical services from.
 * @param {(message: string) => void} [options.logger] - diagnostics.
 * @param {string} [options.provider] - provider route override for created agents.
 * @param {string} [options.model] - model override for created agents.
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

	/** Handles this plugin created and therefore owns. */
	const owned = new Map();
	/** Agents this plugin adopted and must NOT dispose. */
	const adopted = new Map();

	/** The route for a new session: the configured pin, else the profile's live default. */
	function selection() {
		if (provider !== undefined && model !== undefined) return { provider, model };
		const fallback = ctx.get?.("agentDefaultModel")?.currentSelection?.();
		if (fallback !== undefined) return { provider: provider ?? fallback.provider, model: model ?? fallback.model };
		return undefined;
	}

	/** Open one agent this plugin owns and wire its event stream into ACP updates. */
	async function open({ sessionId, cwd, resume }) {
		const sink = makeSink();
		const route = selection();
		const setup = (agentCtx) => {
			if (route !== undefined) installModelSelection(agentCtx, { current: route, assembled: undefined });
			wireListeners(agentCtx, sessionId, sink);
		};
		const handle =
			resume === true
				? await agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: route, setup })
				: await agents.create({ sessionId: SessionId(sessionId), meta: { cwd }, agentOptions: route, setup });
		owned.set(sessionId, handle);
		return { handle, sink };
	}

	/** The ACP-facing session object over an agent this plugin owns. */
	function ownedSession(handle, sink, sessionId) {
		return {
			adopted: false,
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
							source: { kind: "plugin", plugin: PLUGIN_SOURCE },
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
				owned.delete(sessionId);
				await handle.dispose();
			},
		};
	}

	/** The ACP-facing session object over an agent this plugin only borrowed. */
	function adoptedSession(agent, sink, detachListeners, sessionId) {
		return {
			adopted: true,
			async prompt({ content, emit, requestPermission, signal }) {
				sink.emit = emit;
				sink.requestPermission = requestPermission;
				sink.lastTurnEnd = undefined;
				const onAbort = () => agent.cancel({ kind: "user" });
				signal?.addEventListener("abort", onAbort, { once: true });
				try {
					agent.followup(
						createUserMessage({
							content: [{ type: "text", text: promptToText(content) }],
							// Attributed to the plugin, not to the human. The GUI
							// renders this turn in the same conversation, and it
							// must be able to say where it came from rather than
							// impersonating the person watching it.
							source: { kind: "plugin", plugin: PLUGIN_SOURCE },
						}),
					);
					await agent.whenIdle();
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
				agent.cancel({ kind: "user" });
			},
			/**
			 * Detach, and **never dispose**.
			 *
			 * The agent belongs to whoever created it. This plugin did not, so
			 * tearing it down would close the session the human is working in —
			 * the one outcome attachment exists to avoid. Only this plugin's own
			 * listeners are removed.
			 */
			async dispose() {
				adopted.delete(sessionId);
				detachListeners();
				logger?.(`detached from session ${sessionId} without disposing the agent (owned elsewhere)`);
			},
		};
	}

	return {
		name: "dsh",
		/** DSH session event -> ACP updates, for adopted sessions the registry observes. */
		translate: translateSessionEvent,
		/**
		 * This backend can see every live agent in its process, so a missing
		 * one is *evidence* that nothing holds the session, not merely an
		 * absence of information.
		 */
		observesLiveAgents: true,

		async create({ sessionId, cwd }) {
			const { handle, sink } = await open({ sessionId, cwd, resume: false });
			logger?.(`agent ${sessionId} created under the dsh backend (cwd ${cwd})`);
			return ownedSession(handle, sink, sessionId);
		},

		async resume({ sessionId, cwd }) {
			// A live agent wins over a persisted resume, always. Resuming a
			// session another frontend is driving would produce a second owner
			// of one conversation; adopting it is the whole point.
			const live = agents.get(SessionId(sessionId));
			if (live !== undefined) {
				logger?.(`session ${sessionId} is live; attaching instead of resuming`);
				return this.adopt({ sessionId, cwd });
			}
			const { handle, sink } = await open({ sessionId, cwd, resume: true });
			logger?.(`agent ${sessionId} resumed under the dsh backend`);
			return ownedSession(handle, sink, sessionId);
		},

		/**
		 * Adopt an already-live agent, or report that there is none.
		 *
		 * @param {object} input - `{sessionId, onEvent}`.
		 * @returns {Promise<object|undefined>} the borrowed session, or undefined when nothing is live.
		 */
		async adopt({ sessionId, onEvent }) {
			const existing = adopted.get(sessionId);
			if (existing !== undefined) return existing;
			const agent = agents.get(SessionId(sessionId));
			if (agent === undefined) return undefined;
			const sink = makeSink();
			sink.onEvent = onEvent;
			const detachListeners = wireListeners(agent.ctx, sessionId, sink);
			const session = adoptedSession(agent, sink, detachListeners, sessionId);
			adopted.set(sessionId, session);
			logger?.(`adopted live session ${sessionId} (status ${agent.status}); the agent stays owned by whoever created it`);
			return session;
		},

		/** Every live agent this backend can see, for `session/list` and attachability. */
		async live() {
			return agents.list().map((agent) => ({
				sessionId: String(agent.id),
				status: agent.status,
				cwd: agent.session?.header?.cwd,
			}));
		},

		/**
		 * The host's persisted sessions, so `session/list` shows the sessions a
		 * human has been working in and not only the ones this plugin made.
		 *
		 * These are *persisted* rows: a session with no live agent is honestly
		 * `closed`, and whether it can be adopted is reported separately by
		 * `live()`. Best-effort throughout — a titles failure degrades to an
		 * untitled list rather than failing the call, because a list that cannot
		 * read titles is still a useful list.
		 */
		async list() {
			const query = ctx.get?.("sessionQuery");
			if (query === undefined) return await this.live();
			try {
				const records = await query.listSessions();
				const titles = new Map();
				// Titles are one store read *per session*, so on a home with tens
				// of megabytes of transcripts this phase can outlast any caller.
				// It is bounded rather than awaited: a list without titles is
				// useful, a list that never returns is not, and the first title
				// read that cannot answer in time is not going to be followed by
				// one that can.
				try {
					const observations = await Promise.race([
						query.readTitleSnapshots(records.map((record) => record.header.id)),
						new Promise((resolve) => {
							const timer = setTimeout(() => resolve(undefined), TITLE_BUDGET_MS);
							timer.unref?.();
						}),
					]);
					if (observations === undefined) {
						logger?.(`session/list: title snapshots exceeded ${TITLE_BUDGET_MS}ms for ${records.length} session(s); listing without titles`);
					} else {
						for (const observation of observations) {
							if ("value" in observation && observation.value?.title !== undefined) {
								titles.set(observation.sessionId, observation.value.title.title);
							}
						}
					}
				} catch {
					// Titles are best-effort; a session with no title is still a session.
				}
				return records.map((record) => ({
					sessionId: String(record.header.id),
					cwd: record.header.cwd ?? "/",
					title: titles.get(record.header.id),
					updatedAt: record.header.createdAt === undefined ? undefined : new Date(record.header.createdAt).toISOString(),
				}));
			} catch (error) {
				logger?.(`sessionQuery.listSessions failed: ${error instanceof Error ? error.message : String(error)}`);
				return await this.live();
			}
		},

		async remove(sessionId) {
			const handle = owned.get(sessionId);
			if (handle !== undefined) {
				owned.delete(sessionId);
				try {
					await handle.dispose();
				} catch (error) {
					logger?.(`dispose failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			const borrowed = adopted.get(sessionId);
			if (borrowed !== undefined) await borrowed.dispose();
		},

		/**
		 * The canonical DSH mutation surface, delegated to rather than
		 * reimplemented.
		 *
		 * Each entry reports `{unavailable: reason}` when the service is not
		 * mounted, so a caller refuses in its own words instead of writing to a
		 * second source of truth. The absence of `unarchive` is a *finding*, not
		 * an omission: `workspaceRegistry.archiveSession` is one-way.
		 */
		canonical: {
			async rename(sessionId, title) {
				const controller = ctx.get?.("sessionController");
				if (controller?.rename === undefined) return { unavailable: "this composition mounts no sessionController" };
				await controller.rename({ sessionId, title });
				return { ok: true };
			},
			async archive(sessionId) {
				const controller = ctx.get?.("workspaceController");
				if (controller?.archiveSession === undefined) {
					return { unavailable: "this composition mounts no workspaceController" };
				}
				const value = await controller.archiveSession({ sessionId });
				return { ok: true, archivedSessionIds: value?.archivedSessionIds };
			},
			async unarchive() {
				return {
					unavailable:
						"DSH has no unarchive: workspaceRegistry.archiveSession only adds to the archived set, and this plugin will not keep a second copy of that fact",
				};
			},
			async archivedIds() {
				const registry = ctx.get?.("workspaceRegistry");
				if (registry?.archivedSessionIds === undefined) return undefined;
				return new Set([...registry.archivedSessionIds].map(String));
			},
			async setMode(sessionId, modeId) {
				const planMode = ctx.get?.("planMode");
				if (planMode?.set === undefined) return { unavailable: "this composition mounts no planMode" };
				const agent = agents.get(SessionId(sessionId));
				if (agent === undefined) return { unavailable: "the session has no live agent, so it has no access mode to set" };
				const outcome = planMode.set(agent, modeId === "plan");
				return { ok: true, outcome };
			},
			async fork(sessionId, atSeq) {
				const controller = ctx.get?.("sessionController");
				if (controller?.fork === undefined) return { unavailable: "this composition mounts no sessionController" };
				const value = await controller.fork({ sessionId, atSeq });
				return { ok: true, sessionId: value?.sessionId };
			},
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
