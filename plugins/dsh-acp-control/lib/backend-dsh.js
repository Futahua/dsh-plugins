/**
 * The `dsh` backend: binds ACP sessions to real DeepSeek Harness agents.
 *
 * Three relationships to an agent, and the differences matter more than
 * anything else in this file:
 *
 *  - **Owned.** This plugin called `ctx.agents.create`/`resume`, so it holds the
 *    handle and owns teardown.
 *  - **Adopted.** The agent already exists — the web GUI created it and is
 *    driving it right now — so this plugin *gets* it with `ctx.agents.get` and
 *    **must never dispose it**. `agent.ctx` is the agent-scoped Context, the
 *    same object `setup` receives at create time, so an adopted agent can be
 *    observed even though this plugin was not there when it was built.
 *  - **Not ours at all.** A subagent, or a child owned by one. Visible, never
 *    controllable.
 *
 * ## An ACP prompt owns one exact DSH turn, never an "agent is busy" interval
 *
 * This is the load-bearing rule of the file. `agent.followup()` queues one
 * ordinary message as its own turn, but `agent.whenIdle()` waits for the whole
 * *Agent* to go quiescent — including work queued behind it. So when ACP starts
 * turn A and a human queues turn H, the agent is continuously busy: A ends, H
 * starts, and a controller that settles on `whenIdle()` still believes its turn
 * is in flight. Every hazard below follows from that one mistake:
 *
 *  - it would answer a permission request **belonging to the human's turn**;
 *  - an ACP disconnect would abort the human's turn through the request signal;
 *  - and `agent.cancel()` would discard the human's queued work.
 *
 * So ownership is tracked per turn and *correlated* rather than assumed: the
 * message this plugin minted is matched to the turn DSH claimed it into, and
 * the ACP request settles at **that** turn's `turn/end` — not at the last one
 * observed, and not at quiescence. Where ownership is ambiguous the answer is
 * always to fail closed: do not answer, do not cancel.
 *
 * @module dsh-acp-control/backend-dsh
 */

import { promptToText } from "./backends.js";

/** The name this plugin's messages are attributed to. */
export const PLUGIN_SOURCE = "dsh-acp-control";

/**
 * How long `session/list` waits for per-session titles before listing without
 * them.
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

/**
 * DSH turn-end reason → ACP `StopReason`, for a turn **this control plane
 * owns**.
 *
 * Diverges from the first-party codec in exactly two places, because the
 * situation differs in exactly two ways. The first-party server is the only
 * frontend on its sessions, so a turn that was aborted there was aborted by the
 * caller, who already knows, and `end_turn` costs nothing. Here the abort can
 * arrive from the human's own GUI while an ACP client is waiting, and answering
 * `end_turn` would report a turn that *finished* when in fact somebody stopped
 * it. That is the same false-success class this plugin exists to make
 * impossible, so `aborted` becomes `cancelled`. For the same reason a `blocked`
 * turn becomes `refusal`, which ACP has and which says what happened.
 *
 * @param {object|undefined} reason - the `turn/end` reason, tagged by `kind`.
 * @returns {string} the ACP `StopReason` to settle the caller's request with.
 */
export function stopReasonForOwned(reason) {
	if (reason?.kind === "aborted") return "cancelled";
	if (reason?.kind === "blocked") return "refusal";
	return stopReasonOf(reason);
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
 * `assistant/message`, plus `tool/call`, `tool/result`, `turn/*`, `step/*`.
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

/**
 * Whether a session belongs to subagent routing rather than to a person.
 *
 * Mirrors DSH's own ownership predicate, because being wrong in either
 * direction is bad in a different way. `session.header.origin === 'subagent'`
 * is the *durable* identity and survives a parent that has gone away;
 * `isOwnedBy` catches a runtime child whose durable record does not say so.
 * Testing only root status would miss the first, and `roots()` alone would miss
 * the second.
 *
 * @param {object} agents - the agent registry.
 * @param {object} session - the live session.
 * @param {object} agent - the live agent.
 * @returns {boolean} true when this session is not a person's conversation.
 */
export function isSubagentOwned(agents, session, agent) {
	if (session?.header?.origin === "subagent") return true;
	const parentId = session?.header?.parentSession;
	if (parentId === undefined || parentId === null) return false;
	const parent = agents.get(parentId);
	if (parent === undefined) return false;
	try {
		return agents.isOwnedBy(agent.id, parent) === true;
	} catch {
		// An ownership query that cannot answer must not be read as "no".
		return true;
	}
}

/**
 * Tracks which DSH turn, if any, an ACP request owns.
 *
 * The three ids are distinct on purpose: the message is what this plugin
 * minted, the turn is what DSH claimed it into, and `currentTurn` is what the
 * agent is doing *now* — which may be somebody else's turn.
 */
function makeTurnOwner() {
	return {
		/** The `UserMessage` id this plugin minted, if a prompt is in flight. */
		messageId: undefined,
		/** The DSH turn that message was claimed into. */
		turn: undefined,
		/** The turn the agent is currently running, from `turn/start`/`turn/end`. */
		currentTurn: undefined,
		/** Resolves the in-flight ACP prompt exactly once. */
		settle: undefined,
		/** The `turn/end` reason for {@link turn}. */
		reason: undefined,
	};
}

/**
 * Build the DSH backend.
 *
 * @param {object} options - backend options.
 * @param {object} options.ctx - the Cordis context.
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

	/** Whether a session id may be driven at all, and why not when it may not. */
	function classifySession(sessionId) {
		const agent = agents.get(SessionId(sessionId));
		if (agent === undefined) return { kind: "unknown" };
		if (isSubagentOwned(agents, agent.session, agent)) {
			return {
				kind: "subagent",
				reason:
					"this session belongs to subagent routing, not to a person; an external client driving it would be operating a delegated worker rather than a conversation",
			};
		}
		return { kind: "ordinary", agent };
	}

	/**
	 * Register this plugin's listeners on one agent's scoped context.
	 *
	 * @param {object} agentCtx - the agent's scoped context.
	 * @param {string} sessionId - the session id.
	 * @param {object} sink - where events are delivered.
	 * @returns {() => void} a disposer for this plugin's listeners.
	 */
	function wireListeners(agentCtx, sessionId, sink) {
		const disposers = [];
		disposers.push(
			agentCtx.on("session/event", (_session, event) => {
				const type = event?.type;
				if (type === "turn/start") {
					// The agent's current turn, recorded on every frontend's
					// behalf: this is what makes "is the turn running now MINE?"
					// answerable at all.
					sink.owner.currentTurn = event.data?.turn;
				} else if (type === "turn/end") {
					const ended = event.data?.turn;
					if (sink.owner.currentTurn === ended) sink.owner.currentTurn = undefined;
					// Settlement is by *correlation*, never by "the last turn
					// that ended": a human's turn ending must not settle an ACP
					// request, and an ACP turn ending must not be mistaken for
					// the human's.
					if (sink.owner.turn !== undefined && ended === sink.owner.turn) {
						sink.owner.reason = event.data?.reason;
						sink.owner.settle?.({ reason: event.data?.reason });
					}
				}
				// The registry observes every event, including the turn
				// boundaries, so its state machine and an attached ACP client
				// follow the human's turns too. This runs even though the turn
				// bookkeeping above does not depend on it.
				sink.onEvent?.(event);
			}),
		);
		disposers.push(
			agentCtx.on("agent/inbox/claimed", (payload) => {
				// The correlation that makes ownership exact: the message this
				// plugin minted, matched to the turn DSH claimed it into.
				if (sink.owner.messageId === undefined || payload?.message?.id !== sink.owner.messageId) {
					// Worth a line: while this plugin is waiting on a claim, any
					// other claimed message means the correlation is not going
					// to arrive, and the request will fall back to quiescence —
					// which looks identical from the outside.
					if (sink.owner.messageId !== undefined) {
						logger?.(
							`a claimed message ${String(payload?.message?.id)} in ${sessionId} is not the one this control plane is waiting on (${String(sink.owner.messageId)})`,
						);
					}
					return;
				}
				sink.owner.turn = payload.turn;
				logger?.(`claimed turn ${String(payload.turn)} as this control plane's own in ${sessionId}`);
			}),
		);
		/**
		 * The permission decision for this session, as a waterfall participant.
		 *
		 * Registered on **two** contexts on purpose, and the reason is not
		 * belt-and-braces: an approval is dispatched with a *scope target*
		 * (`scopeTarget(request.agent, request.agent)`) that is not the same
		 * object as `agent.ctx`, and the listener filter runs against that
		 * target. A listener registered on the agent's own context can therefore
		 * be filtered out of a waterfall it is the natural owner of — which is
		 * exactly what happened here: `session/event` and `agent/inbox/claimed`
		 * reached the agent-scoped listener (so turn ownership was correct),
		 * while the approval never did, and an approval during this control
		 * plane's *own* turn was silently left to the host.
		 *
		 * Registering on the plugin's own fiber context as well is what the
		 * first-party ACP server does. A waterfall stops at the first listener
		 * that returns a decision, so a request cannot be answered twice.
		 */
		const decideApproval = (request, next) => {
			// Logged before any predicate, so that "this listener was never
			// reached" and "this listener declined" are distinguishable —
			// they have different causes and only one of them is policy.
			logger?.(
				`an approval for ${String(request?.toolName)} reached this control plane for ${sessionId} ` +
					`(request agent ${String(request?.agent?.id)}, own turn ${String(sink.owner.turn)}, current turn ${String(sink.owner.currentTurn)})`,
			);
			if (String(request?.agent?.id) !== sessionId) return next();
			// Fail closed. A permission belongs to this plugin only while
			// the turn this plugin owns is the turn that is *current*;
			// anything else is the human's, and answering it here would let
			// an external client authorise an action inside someone else's
			// turn.
			if (sink.owner.turn === undefined || sink.owner.currentTurn !== sink.owner.turn) {
				// Logged because this is a *refusal to act*, and the two ways
				// it can happen are indistinguishable from the outside: the
				// plugin has no turn of its own here, or it has one and this
				// is somebody else's. They need different fixes.
				logger?.(
					`left the ${String(request?.toolName)} approval in ${sessionId} to the host: ` +
						(sink.owner.turn === undefined
							? "this control plane has no claimed turn in flight"
							: `the current turn ${String(sink.owner.currentTurn)} is not this control plane's turn ${String(sink.owner.turn)}`),
				);
				return next();
			}
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
		};
		disposers.push(agentCtx.on("approval/request", decideApproval));
		disposers.push(ctx.on("approval/request", decideApproval));
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

	/** A sink: the turn owner plus the callbacks the listeners deliver to. */
	function makeSink() {
		return { owner: makeTurnOwner(), emit: () => {}, requestPermission: undefined, onEvent: undefined };
	}

	/**
	 * Settle any request still waiting on this session, because the view that
	 * would have seen its `turn/end` is being torn down.
	 *
	 * Closing a session during an ACP-authored turn aborts the request and
	 * disposes this view. Detaching the listeners first removed the only route
	 * by which the waiting `session/prompt` could ever learn its turn had
	 * ended: the quiescence fallback covers a message that was never *claimed*,
	 * and this one had been. The request then hung forever while the view said
	 * `closed`. There is no ordering of the teardown that avoids this by
	 * itself, so the settlement is explicit.
	 *
	 * @param {object} sink - the session's sink.
	 * @param {string} sessionId - the session, for the log line.
	 */
	function settleOnDispose(sink, sessionId) {
		if (sink.owner.settle === undefined) return;
		logger?.(`settling the in-flight prompt for ${sessionId} because its view is being disposed`);
		sink.owner.settle({ disposed: true });
	}

	/**
	 * Run one ACP prompt as exactly one DSH turn.
	 *
	 * @param {object} input - `{agent, sink, content, emit, requestPermission, signal}`.
	 * @returns {Promise<{stopReason: string}>} the ACP outcome.
	 */
	async function runPrompt({ agent, sink, content, emit, requestPermission, signal }) {
		if (sink.owner.messageId !== undefined) {
			throw new Error("a prompt is already in flight for this session");
		}
		// `runPrompt` is handed an agent, not a session id, and the diagnostics
		// below name the session they are about — derived here rather than
		// assumed to be in scope.
		const sid = String(agent?.session?.id ?? agent?.id ?? "<unknown>");
		sink.emit = emit;
		sink.requestPermission = requestPermission;

		const message = createUserMessage({
			content: [{ type: "text", text: promptToText(content) }],
			// Attributed to the plugin, never to the person. The GUI renders
			// this turn in the same conversation and must be able to say where
			// it came from rather than impersonating whoever is watching.
			source: { kind: "plugin", plugin: PLUGIN_SOURCE },
		});
		sink.owner.messageId = message.id;
		sink.owner.turn = undefined;
		sink.owner.reason = undefined;

		const settled = new Promise((resolve) => {
			sink.owner.settle = resolve;
		});
		// The abort signal cancels only while this exact turn is the current
		// one. Wiring it straight to `agent.cancel` would let an ACP disconnect
		// abort whatever the agent happens to be doing — including a turn the
		// human started after ours finished.
		const onAbort = () => {
			if (sink.owner.turn !== undefined && sink.owner.currentTurn === sink.owner.turn) {
				agent.cancel({ kind: "user" }, { keepInbox: true });
			} else {
				logger?.(`ignoring an abort: this plugin no longer owns the running turn (current ${String(sink.owner.currentTurn)})`);
			}
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		agent.followup(message);
		logger?.(`authored prompt ${String(message.id)} for ${sid}; waiting for it to be claimed into a turn`);

		// Safety net, not the settlement path. If the message is dropped before
		// it is ever claimed into a turn, nothing will settle it; the agent
		// going fully idle is the only signal that no turn is coming. It cannot
		// settle a live turn early, because quiescence follows every queued turn.
		void agent.whenIdle().then(() => {
			if (sink.owner.turn === undefined) {
				// Reported on stderr as well as to the caller, because this is
				// the fallback that hides a broken correlation: the request
				// still settles, so from the outside it looks exactly like a
				// turn that ended normally.
				logger?.(`the prompt in ${sid} was never matched to a claimed turn; settling on quiescence instead`);
				sink.owner.settle?.({ neverClaimed: true });
			}
		});

		try {
			const outcome = await settled;
			// Captured before the `finally` clears it: the caller needs to know
			// *which* turn this request was, so its settlement can avoid
			// clearing a `generating` that already belongs to the next one.
			const ownedTurn = sink.owner.turn;
			if (outcome.neverClaimed === true) {
				// Reported as a **failure**, not as a clean `end_turn`. This
				// plugin's whole thesis is that an admitted command is never
				// silently a no-op; settling `end_turn` here would tell the
				// caller its prompt completed when no turn ever picked it up,
				// which is the exact false success this design exists to
				// prevent. The caller gets an error it can act on instead.
				throw new Error(
					"the prompt was accepted into the agent's inbox but no turn ever claimed it, so this control plane cannot say the turn ran",
				);
			}
			if (outcome.disposed === true) {
				// The session was closed while this turn was running and the
				// listeners that would have seen its `turn/end` are gone. There
				// is no turn to report on, and saying `end_turn` would be the
				// same false success in a different costume.
				throw new Error("the session was closed while this turn was running, so its outcome is unknown");
			}
			if (outcome.reason?.kind === "error") {
				throw new Error(outcome.reason.error?.message ?? "agent turn failed");
			}
			return { stopReason: stopReasonForOwned(outcome.reason), turn: ownedTurn };
		} finally {
			signal?.removeEventListener("abort", onAbort);
			sink.owner.messageId = undefined;
			sink.owner.turn = undefined;
			sink.owner.reason = undefined;
			sink.owner.settle = undefined;
			sink.requestPermission = undefined;
		}
	}

	/**
	 * Cancel, but only this plugin's own turn.
	 *
	 * @returns {{cancelled: boolean, reason?: string}} whether anything was cancelled.
	 */
	function cancelOwnTurn(agent, sink) {
		if (sink.owner.turn === undefined) {
			return { cancelled: false, reason: "this control plane has no turn of its own in flight for this session" };
		}
		if (sink.owner.currentTurn !== sink.owner.turn) {
			return {
				cancelled: false,
				reason: `the agent is running a turn this control plane did not start (turn ${String(sink.owner.currentTurn)})`,
			};
		}
		// `keepInbox` on every cancellation of a shared agent: without it this
		// would also discard whatever the human has queued behind this turn.
		agent.cancel({ kind: "user" }, { keepInbox: true });
		return { cancelled: true };
	}

	/** Open one agent this plugin owns. */
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
			async prompt(input) {
				return await runPrompt({ agent: handle.agent, sink, ...input });
			},
			cancel() {
				return cancelOwnTurn(handle.agent, sink);
			},
			/** Whether a cancel would actually hit a turn this plugin owns. */
			ownsTurn() {
				return sink.owner.turn !== undefined && sink.owner.currentTurn === sink.owner.turn;
			},
			async dispose() {
				owned.delete(sessionId);
				// Before anything is torn down. A `session/close` admitted
				// during this turn aborts the request and disposes this view,
				// and once these listeners are gone nothing will ever see the
				// turn's `turn/end` — so a request awaiting it would wait
				// forever while the session read `closed`. Settling here is the
				// guarantee that no settlement route can be lost.
				settleOnDispose(sink, sessionId);
				await handle.dispose();
			},
		};
	}

	/** The ACP-facing session object over an agent this plugin only borrowed. */
	function adoptedSession(agent, sink, detachListeners, sessionId) {
		return {
			adopted: true,
			async prompt(input) {
				return await runPrompt({ agent, sink, ...input });
			},
			cancel() {
				return cancelOwnTurn(agent, sink);
			},
			/** Whether a cancel would actually hit a turn this plugin owns. */
			ownsTurn() {
				return sink.owner.turn !== undefined && sink.owner.currentTurn === sink.owner.turn;
			},
			/** Detach, and **never dispose**: the agent belongs to whoever created it. */
			async dispose() {
				adopted.delete(sessionId);
				// See {@link settleOnDispose}: detaching first is what stranded
				// an in-flight ACP request with no way left to settle it.
				settleOnDispose(sink, sessionId);
				detachListeners();
				logger?.(`detached from session ${sessionId} without disposing the agent (owned elsewhere)`);
			},
		};
	}

	return {
		name: "dsh",
		/** This backend can see every live agent, so a missing one is evidence, not ignorance. */
		observesLiveAgents: true,
		translate: translateSessionEvent,

		/** Whether a session may be driven, and why not when it may not. */
		classify(sessionId) {
			const verdict = classifySession(sessionId);
			return verdict.kind === "ordinary" ? { kind: "ordinary" } : verdict;
		},

		async create({ sessionId, cwd }) {
			const { handle, sink } = await open({ sessionId, cwd, resume: false });
			logger?.(`agent ${sessionId} created under the dsh backend (cwd ${cwd})`);
			return ownedSession(handle, sink, sessionId);
		},

		async resume({ sessionId, cwd }) {
			// A live agent wins over a persisted resume, always: resuming a
			// session another frontend is driving would produce a second owner
			// of one conversation.
			const verdict = classifySession(sessionId);
			if (verdict.kind === "subagent") throw new Error(verdict.reason);
			if (verdict.kind === "ordinary") {
				logger?.(`session ${sessionId} is live; attaching instead of resuming`);
				return await this.adopt({ sessionId });
			}
			const { handle, sink } = await open({ sessionId, cwd, resume: true });
			logger?.(`agent ${sessionId} resumed under the dsh backend`);
			return ownedSession(handle, sink, sessionId);
		},

		/**
		 * Adopt an already-live agent, or report that there is none.
		 *
		 * @param {object} input - `{sessionId, onEvent}`.
		 * @returns {Promise<object|undefined>} the borrowed session, or undefined when nothing is adoptable.
		 */
		async adopt({ sessionId, onEvent }) {
			const existing = adopted.get(sessionId);
			if (existing !== undefined) return existing;
			const verdict = classifySession(sessionId);
			// Subagents are never adopted: not into the registry, not reported
			// as attachable, and never driven. Visible, not controllable.
			if (verdict.kind !== "ordinary") return undefined;
			const agent = verdict.agent;
			const sink = makeSink();
			sink.onEvent = onEvent;
			const detachListeners = wireListeners(agent.ctx, sessionId, sink);
			const session = adoptedSession(agent, sink, detachListeners, sessionId);
			adopted.set(sessionId, session);
			logger?.(`adopted live session ${sessionId} (status ${agent.status}); ownership stays with its creator`);
			return session;
		},

		/** Every live agent this backend can see, with its controllability. */
		async live() {
			return agents.list().map((agent) => {
				const subagent = isSubagentOwned(agents, agent.session, agent);
				return {
					sessionId: String(agent.id),
					status: agent.status,
					cwd: agent.session?.header?.cwd,
					kind: subagent ? "subagent" : "ordinary",
					controllable: subagent !== true,
				};
			});
		},

		/** The host's persisted sessions, so `session/list` shows what a human has been working in. */
		async list() {
			const query = ctx.get?.("sessionQuery");
			if (query === undefined) return await this.live();
			try {
				const records = await query.listSessions();
				const titles = new Map();
				// Titles cost one store read per session and are bounded rather
				// than awaited: a list without titles is useful, a list that
				// never returns is not.
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
				return records.map((record) => {
					const live = agents.get(record.header.id);
					const subagent =
						record.header.origin === "subagent" || (live !== undefined && isSubagentOwned(agents, live.session, live));
					return {
						sessionId: String(record.header.id),
						cwd: record.header.cwd ?? "/",
						title: titles.get(record.header.id),
						updatedAt: record.header.createdAt === undefined ? undefined : new Date(record.header.createdAt).toISOString(),
						kind: subagent ? "subagent" : "ordinary",
						controllable: subagent !== true,
					};
				});
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

		/** The canonical DSH surfaces, delegated to rather than reimplemented. */
		canonical: {
			/**
			 * Resolve a cold session through the host's own controller, so a GUI
			 * resume and an ACP resume of the same id deduplicate instead of
			 * racing to create two owners of one conversation.
			 */
			async resolveAgent(sessionId) {
				const controller = ctx.get?.("sessionController");
				if (controller?.resolveAgent === undefined) return { unavailable: "this composition mounts no sessionController" };
				const result = await controller.resolveAgent(sessionId);
				if (result?.error !== undefined) return { refused: result.error };
				return { ok: true };
			},

			/** The authoritative title. Refuses rather than keeping a private copy. */
			async rename(sessionId, title) {
				const controller = ctx.get?.("sessionController");
				if (controller?.rename === undefined) return { unavailable: "this composition mounts no sessionController" };
				const value = await controller.rename({ sessionId, title });
				return { ok: true, title: value?.title ?? title, seq: value?.seq };
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
				const verdict = classifySession(sessionId);
				if (verdict.kind !== "ordinary") return { unavailable: verdict.reason ?? "the session is not controllable" };
				const outcome = planMode.set(verdict.agent, modeId === "plan");
				return { ok: true, outcome };
			},
			/**
			 * Unavailable on purpose.
			 *
			 * DSH's canonical `sessionController.fork` picks a completed-turn
			 * boundary, copies the event prefix, preserves lineage and attaches
			 * the child to the workspace. The `_dsh/session/fork` this plugin
			 * used to offer created an empty child carrying a lineage marker —
			 * a materially different conversation under the same name. A method
			 * that promises one operation and performs another is worse than an
			 * absent one, so it refuses until it delegates.
			 */
			async fork() {
				return {
					unavailable:
						"forking is not delegated yet: DSH's canonical fork copies a completed-turn prefix and preserves lineage, while this plugin can only create an empty child, and offering the second under the first's name would promise an operation it does not perform",
				};
			},
		},
	};
}

/**
 * Load the DSH backend from `lib/standalone.js`'s `--backend dsh`.
 *
 * There is no context to build agents under outside a profile boot, and
 * inventing one here would produce a second, differently-configured harness
 * inside the process that is supposed to be serving the first.
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
