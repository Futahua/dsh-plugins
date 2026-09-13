/**
 * The session backend port, and the deterministic `scripted` adapter.
 *
 * A *backend* is whatever actually runs agent work behind a session. The
 * control plane never talks to an agent directly — it admits commands, records
 * events, and hands the work to a backend (DESIGN.md §9). That seam is what
 * lets the protocol, the state machine, and the replay be verified over a real
 * socket without a model, a key, or a network.
 *
 * Two adapters implement this port:
 *
 *  - `dsh` (lib/backend-dsh.js) — the production path, binding each ACP
 *    session to a real DeepSeek Harness agent. It is loaded lazily so that
 *    importing this module never requires the DSH packages to be resolvable.
 *  - `scripted` (below) — a fixture. It is **never** the default: it exists so
 *    that a transcript can be reproduced exactly, and every transcript it
 *    produces says which backend produced it.
 *
 * @module dsh-acp-control/backends
 */

/**
 * ACP `StopReason` values, from the stable v1 schema. The turn's terminal
 * vocabulary is small and fixed, so it is mirrored here rather than imported.
 */
export const StopReason = Object.freeze({
	endTurn: "end_turn",
	maxTokens: "max_tokens",
	maxTurnRequests: "max_turn_requests",
	refusal: "refusal",
	cancelled: "cancelled",
});

/**
 * @typedef {object} PromptInput
 * @property {ReadonlyArray<object>} content - the admitted ACP content blocks.
 * @property {(update: object) => void} emit - publish one `session/update` payload.
 * @property {(request: object) => Promise<{optionId: string|null}>} requestPermission - ask the client; the session moves to `awaiting_permission` around this call.
 * @property {AbortSignal} signal - aborted when the turn is cancelled.
 */

/**
 * @typedef {object} BackendSession
 * @property {(input: PromptInput) => Promise<{stopReason: string}>} prompt - run one turn to completion.
 * @property {() => void} cancel - ask the running turn to stop.
 * @property {() => Promise<void>} dispose - release everything this session owns.
 */

/**
 * @typedef {object} Backend
 * @property {string} name - the adapter's name, reported in `initialize.agentInfo` and in the boot log.
 * @property {boolean} [observesLiveAgents] - whether a missing agent is *evidence* that nothing holds a session, or merely an absence of information. A backend without this cannot be trusted to decide that resuming a persisted session is safe.
 * @property {(event: object) => object[]} [translate] - DSH session event → ACP updates, for adopted sessions whose events the registry forwards.
 * @property {(input: {sessionId: string, cwd: string}) => Promise<BackendSession>} create
 * @property {(input: {sessionId: string, cwd: string}) => Promise<BackendSession>} resume
 * @property {(input: {sessionId: string, cwd?: string, onEvent: (event: object) => void}) => Promise<BackendSession|undefined>} [adopt] - borrow an agent that already exists. Returns undefined when nothing is live; the returned session **must not dispose the agent**.
 * @property {() => Promise<Array<{sessionId: string, status?: string, cwd?: string}>>} [live] - the agents this backend can currently see.
 * @property {() => Promise<Array<{sessionId: string, status?: string, cwd?: string, title?: string, updatedAt?: string}>>} list - sessions this backend knows about, live or persisted.
 * @property {(sessionId: string) => Promise<void>} remove
 * @property {object} [canonical] - the host's canonical mutation services, so this plugin never keeps a second copy of a fact the host already owns.
 */

/**
 * Fold ACP prompt content blocks into plain text for a backend that only
 * understands text.
 *
 * `resource_link` becomes a Markdown link and an inline `resource` its text,
 * which is what the model should see; an image becomes a marker rather than
 * being silently dropped, so a text-only backend's transcript still shows that
 * something was sent that it could not carry.
 *
 * @param {ReadonlyArray<object>} blocks - ACP content blocks.
 * @returns {string} the folded text.
 */
export function promptToText(blocks) {
	const parts = [];
	for (const block of blocks ?? []) {
		switch (block?.type) {
			case "text":
				parts.push(String(block.text ?? ""));
				break;
			case "resource_link":
				parts.push(`[${block.name ?? "resource"}](${block.uri})`);
				break;
			case "resource": {
				const text = block.resource?.text;
				parts.push(typeof text === "string" && text.length > 0 ? text : `[resource] ${block.resource?.uri ?? "?"}`);
				break;
			}
			case "image":
				parts.push("[image: not carried by this backend]");
				break;
			case "audio":
				parts.push("[audio: not carried by this backend]");
				break;
			default:
				parts.push(`[${String(block?.type ?? "unknown")}: not carried by this backend]`);
				break;
		}
	}
	return parts.join("\n");
}

/** Sleep, cancellable. Used only by the scripted adapter, to make streaming observable. */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener?.("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		signal?.addEventListener?.("abort", onAbort, { once: true });
	});
}

/**
 * The deterministic fixture backend.
 *
 * Its whole value is that its output is a pure function of the prompt, so a
 * transcript is reproducible and a failure is a real failure rather than model
 * variation. Prompt prefixes select behaviour, which is what lets the checks
 * drive the state machine through `awaiting_permission`, `cancelling`, and
 * `failed` on demand:
 *
 * | prompt starts with | behaviour |
 * | --- | --- |
 * | `/approve` | emits a tool call, asks for permission, completes or fails on the answer |
 * | `/hold` | emits one chunk then blocks until cancelled — the only way to observe `generating` without racing a timer |
 * | `/slow` | streams many chunks, so a cancel has something to interrupt |
 * | `/fail` | ends the turn with an error |
 * | anything else | thinks, echoes, and ends |
 *
 * @param {object} [options] - adapter options.
 * @param {number} [options.chunkDelayMs] - delay between chunks; 0 makes checks fast.
 * @returns {Backend} the adapter.
 */
export function createScriptedBackend({ chunkDelayMs = 12 } = {}) {
	const sessions = new Map();
	/** The fixture's canonical archived set — the host's fact, not the registry's. */
	const archived = new Set();

	/**
	 * Build one scripted session.
	 * @param {object} input - identity.
	 * @returns {BackendSession} the session.
	 */
	function makeSession({ sessionId, cwd }) {
		let controller;
		const record = {
			sessionId,
			cwd,
			title: undefined,
			updatedAt: new Date().toISOString(),
		};
		sessions.set(sessionId, record);

		return {
			async prompt({ content, emit, requestPermission, signal }) {
				controller = new AbortController();
				const onOuterAbort = () => controller.abort();
				signal?.addEventListener("abort", onOuterAbort, { once: true });
				const inner = controller.signal;
				const text = promptToText(content);
				const messageId = `scripted-${Date.now().toString(36)}`;
				let chunk = 0;
				/** Emit one chunk of a stream, then yield. */
				const say = async (value) => {
					await sleep(chunkDelayMs, inner);
					chunk += 1;
					emit({
						sessionUpdate: "agent_message_chunk",
						messageId,
						content: { type: "text", text: value },
					});
				};
				try {
					await sleep(chunkDelayMs, inner);
					emit({
						sessionUpdate: "agent_thought_chunk",
						messageId: `${messageId}-t`,
						content: { type: "text", text: "scripted backend: considering the prompt" },
					});

					if (text.startsWith("/fail")) {
						await sleep(chunkDelayMs, inner);
						throw new Error("scripted backend: requested failure");
					}

					if (text.startsWith("/approve")) {
						const toolCallId = `call-${messageId}`;
						emit({
							sessionUpdate: "tool_call",
							toolCallId,
							title: "write /tmp/scripted",
							kind: "edit",
							status: "pending",
							rawInput: { path: "/tmp/scripted" },
						});
						const decision = await requestPermission({
							toolCall: { toolCallId, title: "write /tmp/scripted", kind: "edit", status: "pending" },
							options: [
								{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
								{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
							],
						});
						if (decision.optionId === "allow-once") {
							emit({
								sessionUpdate: "tool_call_update",
								toolCallId,
								status: "completed",
								content: [{ type: "content", content: { type: "text", text: "wrote /tmp/scripted" } }],
							});
						} else if (decision.optionId === null) {
							// Cancelled while the question was outstanding.
							emit({ sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
							return { stopReason: StopReason.cancelled };
						} else {
							emit({ sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
							await say("The tool call was rejected.");
							return { stopReason: StopReason.endTurn };
						}
					}

					if (text.startsWith("/hold")) {
						// Block until cancelled. A check that wants to observe
						// `generating` cannot race a timer: with a fixed sleep,
						// a slow machine and a fast one disagree about what the
						// state was when the probe arrived, and the check either
						// flakes or silently stops testing anything.
						await say("holding the turn open until cancelled");
						await new Promise((_resolve, reject) => {
							if (inner.aborted) {
								reject(new Error("aborted"));
								return;
							}
							inner.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
						});
						return { stopReason: StopReason.cancelled };
					}

					if (text.startsWith("/slow")) {
						for (let index = 0; index < 40; index += 1) await say(`chunk ${index} `);
						return { stopReason: StopReason.endTurn };
					}

					const words = text.trim() === "" ? ["(empty prompt)"] : text.trim().split(/\s+/);
					await say("scripted backend received: ");
					for (const word of words.slice(0, 6)) await say(`${word} `);
					await say("— done.");
					return { stopReason: StopReason.endTurn };
				} catch (error) {
					if (inner.aborted || signal?.aborted === true) return { stopReason: StopReason.cancelled };
					throw error;
				} finally {
					signal?.removeEventListener("abort", onOuterAbort);
					record.updatedAt = new Date().toISOString();
				}
			},
			cancel() {
				controller?.abort();
			},
			async dispose() {
				controller?.abort();
				sessions.delete(sessionId);
			},
		};
	}

	return {
		name: "scripted",
		/**
		 * A fixture cannot see live agents, so a missing one tells it nothing.
		 * That is the difference between "nothing holds this session" and "I
		 * have no way to know", and a control plane must not treat the second
		 * as the first — see `session/resume`'s refusal in lib/server.js.
		 */
		observesLiveAgents: false,
		/** Nothing to borrow: this adapter never has a live agent behind a session. */
		async adopt() {
			return undefined;
		},
		/** Nor anything to list as live. */
		async live() {
			return [];
		},
		/**
		 * A fixture workspace registry.
		 *
		 * Archive works and unarchive does not — which is not an arbitrary
		 * fixture choice but a faithful copy of DSH, where
		 * `workspaceRegistry.archiveSession` only ever *adds* to the archived
		 * set and no unarchive exists. Giving the fixture the same one-way
		 * shape means the delegation plumbing and the refusal for the missing
		 * direction are both exercised by the portable checks, rather than only
		 * by the profile check.
		 */
		canonical: {
			async rename() {
				return { unavailable: "the scripted backend has no host to rename through" };
			},
			async archive(sessionId) {
				archived.add(sessionId);
				return { ok: true, archivedSessionIds: [...archived] };
			},
			async unarchive() {
				return {
					unavailable:
						"the scripted fixture mirrors DSH here: archiveSession only adds to the archived set, and no unarchive exists",
				};
			},
			async archivedIds() {
				return new Set(archived);
			},
			async setMode() {
				return { unavailable: "the scripted backend has no plan mode" };
			},
			async fork() {
				return { unavailable: "the scripted backend has no session controller" };
			},
		},
		async create(input) {
			return makeSession(input);
		},
		async resume(input) {
			return makeSession(input);
		},
		async list() {
			return [...sessions.values()].map((record) => ({ ...record }));
		},
		async remove(sessionId) {
			sessions.delete(sessionId);
		},
	};
}
