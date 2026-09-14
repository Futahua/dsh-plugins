/**
 * The shared slice-1 scenario, driven by the **official ACP client**.
 *
 * Both stdio checks run this file:
 *
 *  - `core-checks.mjs` wires it to the stdio transport in-process, so it needs
 *    nothing but Node and runs anywhere.
 *  - `stdio-client.mjs` wires it to a real child process over real pipes,
 *    which is the strongest form of the same evidence.
 *
 * The client is `@agentclientprotocol/sdk` — the reference implementation, and
 * deliberately *not* the library this server is built on (it is built on
 * none), so a passing transcript is agreement between two independent
 * implementations rather than a library agreeing with itself.
 *
 * What it asserts, in order of importance:
 *
 *  1. **The anti-silent-discard invariant, over a state × command matrix.**
 *     Every accepted command must advance the event log; every rejected one
 *     must be a structured refusal naming the state that blocked it. A
 *     command that returns success without moving `lastEventId` fails — that
 *     is the bug class this design exists to remove.
 *  2. Streaming `session/update` reaches the client, in order.
 *  3. `session/request_permission` moves the session to `awaiting_permission`.
 *  4. `session/cancel` settles the prompt with `stopReason: "cancelled"`.
 *  5. `_dsh/events/replay` returns exactly the events after a cursor — nothing
 *     missing, nothing duplicated, and idempotent.
 *
 * @module dsh-acp-control/verify/scenario
 */

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Run the scenario over one transport stream.
 *
 * @param {object} options - run options.
 * @param {object} options.sdk - the imported `@agentclientprotocol/sdk` module.
 * @param {object} options.stream - an SDK `Stream` connected to the server.
 * @param {string} options.cwd - an absolute cwd to create the session in.
 * @param {string} [options.serverStderr] - returns the server's captured stderr lines.
 * @returns {Promise<{checks: object[], failures: string[]}>} the results.
 */
export async function runScenario({ sdk, stream, cwd, serverStderr }) {
	const failures = [];
	const checks = [];

	/** Record one assertion. */
	function check(name, ok, detail) {
		checks.push({ name, ok, detail });
		if (!ok) failures.push(`${name}${detail === undefined ? "" : ` — ${detail}`}`);
		console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok || detail === undefined ? "" : `  (${detail})`}`);
	}

	/** Print one direction of the transcript. */
	function line(direction, label, payload) {
		const text = typeof payload === "string" ? payload : JSON.stringify(payload);
		const clipped = text.length > 220 ? `${text.slice(0, 217)}...` : text;
		console.log(`  ${direction} ${label.padEnd(32)} ${clipped}`);
	}

	const updates = [];
	const permissionRequests = [];
	const refusals = [];
	// A real client answers the permission prompt. An unanswered one would hold
	// the session in `awaiting_permission` forever, and the check would prove
	// nothing about the state machine.
	const permissionAnswer = "allow-once";

	/** Ask the server how far its log has advanced. */
	async function lastEventId(ctx) {
		const info = await ctx.request("_dsh/log/info", {});
		return info.lastEventId;
	}

	/**
	 * Issue one command and classify the outcome the way the invariant demands.
	 *
	 * Both directions are printed, so the transcript shows a reader exactly what
	 * a client sent and what came back — including the refusals, which are the
	 * part a demo usually omits and this check exists to make visible.
	 */
	async function command(ctx, method, params) {
		const before = await lastEventId(ctx);
		try {
			const result = await ctx.request(method, params);
			const after = await lastEventId(ctx);
			line("→", method, params);
			line("←", "result", result);
			return { ok: true, refused: false, advanced: after > before, result, before, after };
		} catch (error) {
			const data = error?.data;
			line("→", method, params);
			line("←", "error", { code: error?.code, message: error?.message, data });
			return { ok: false, refused: data?.type === "refused", data, error: error?.message, code: error?.code };
		}
	}

	/** Assert a refusal that names a state. */
	function assertRefused(name, outcome, expectedState) {
		if (outcome.ok) {
			check(name, false, "the command was accepted; it should have been refused");
			return;
		}
		if (!outcome.refused) {
			check(name, false, `not a structured refusal: ${outcome.error ?? "no data.type"}`);
			return;
		}
		if (expectedState === undefined) {
			check(name, true);
			return;
		}
		const stateOk = outcome.data.state === expectedState;
		check(name, stateOk && Array.isArray(outcome.data.allowedIn), stateOk ? undefined : `refused in ${outcome.data.state}, expected ${expectedState}`);
	}

	/** Assert an accepted command that left a trace. */
	function assertCommitted(name, outcome) {
		if (!outcome.ok) {
			check(name, false, `refused: ${outcome.data?.reason ?? outcome.error}`);
			return;
		}
		check(name, outcome.advanced === true, outcome.advanced === true ? undefined : "accepted but advanced no event");
	}

	const client = sdk
		.client({ name: "verify-stdio-client", version: "1.0.0" })
		.onNotification("session/update", (ctx) => {
			updates.push(ctx.params.update);
			line("←", `session/update ${ctx.params.update.sessionUpdate}`, ctx.params.update);
		})
		// `onNotification` demands a params parser for anything outside the
		// built-in method union; the pass-through is the SDK's sanctioned way
		// to listen to a custom namespace.
		.onNotification("_dsh/session/state_changed", (params) => params, (ctx) => {
			line("←", "_dsh/session/state_changed", ctx.params);
		})
		.onNotification("_dsh/session/refused", (params) => params, (ctx) => {
			refusals.push(ctx.params);
			line("←", "_dsh/session/refused", ctx.params);
		})
		.onRequest("session/request_permission", async (ctx) => {
			permissionRequests.push(ctx.params);
			line("←", "session/request_permission", ctx.params);
			// The client deliberately takes a moment to answer. An instant
			// answer would make the `awaiting_permission` window unobservably
			// short, and a check that cannot observe the state cannot prove the
			// state exists.
			await delay(250);
			line("→", "permission answer", permissionAnswer);
			return { outcome: { outcome: "selected", optionId: permissionAnswer } };
		});

	await client.connectWith(stream, async (ctx) => {
		console.log("\n--- initialize -------------------------------------------------");
		const init = await command(ctx, "initialize", {
			protocolVersion: 1,
			clientCapabilities: { _meta: { "dsh-acp-control/extensions": true } },
			clientInfo: { name: "verify-stdio-client", version: "1.0.0" },
		});
		check(
			"initialize negotiates protocol version 1",
			init.ok && init.result?.protocolVersion === 1,
			`got ${init.result?.protocolVersion}`,
		);
		check(
			"initialize advertises only implemented session capabilities",
			(() => {
				const caps = init.result?.agentCapabilities?.sessionCapabilities ?? {};
				return Object.keys(caps).sort().join(",") === "close,delete,list,resume" && caps.fork === undefined;
			})(),
			JSON.stringify(init.result?.agentCapabilities?.sessionCapabilities),
		);
		check("initialize offers no auth methods", Array.isArray(init.result?.authMethods) && init.result.authMethods.length === 0);

		console.log("\n--- session/new ------------------------------------------------");
		const created = await command(ctx, "session/new", { cwd, mcpServers: [] });
		const sessionId = created.result?.sessionId;
		assertCommitted("session/new returns a committed session", created);
		check("session/new returns a sessionId", typeof sessionId === "string" && sessionId.length > 0, `got ${JSON.stringify(sessionId)}`);

		console.log("\n--- idle: the commands that belong there -----------------------");
		assertCommitted("idle: _dsh/session/rename succeeds", await command(ctx, "_dsh/session/rename", { sessionId, title: "idle rename" }));
		check(
			"idle: rename is announced on the STABLE wire (session_info_update)",
			updates.some((update) => update.sessionUpdate === "session_info_update" && update.title === "idle rename"),
		);
		// Archive is delegated to the host, so it is exercised on a session of
		// its own: the fixture mirrors DSH's *one-way* archive, so a session
		// that gets archived cannot be un-archived and would otherwise change
		// the meaning of every later check.
		const archival = await ctx.request("session/new", { cwd, mcpServers: [] });
		const archivalId = archival.sessionId;
		assertCommitted("idle: _dsh/session/archive succeeds", await command(ctx, "_dsh/session/archive", { sessionId: archivalId }));
		const unarchive = await command(ctx, "_dsh/session/unarchive", { sessionId: archivalId });
		check(
			"unarchive is refused as unavailable rather than faked locally",
			unarchive.ok === false && unarchive.data?.type === "unavailable",
			JSON.stringify(unarchive.data),
		);
		check(
			"archive hides the session from session/list, _dsh/session/list brings it back",
			await (async () => {
				const stable = await ctx.request("session/list", {});
				const extended = await ctx.request("_dsh/session/list", {});
				return (
					stable.sessions.some((entry) => entry.sessionId === archivalId) === false &&
					extended.sessions.some((entry) => entry.sessionId === archivalId) === true &&
					extended.sessions.find((entry) => entry.sessionId === archivalId)?.archived === true
				);
			})(),
		);
		// Cleanup must close first: a live session refuses deletion (see below).
		await ctx.request("session/close", { sessionId: archivalId });
		await ctx.request("session/delete", { sessionId: archivalId });
		// Resuming a session that is already live is a no-op that *succeeds*.
		// Adoption is automatic, so "attach me to this session id" normally asks
		// for something already true, and refusing it with "already open here"
		// would be accurate and useless.
		const alreadyAttached = await command(ctx, "session/resume", { sessionId });
		check(
			"idle: resuming an attached session succeeds idempotently",
			alreadyAttached.ok === true && alreadyAttached.result?.alreadyAttached === true,
			JSON.stringify(alreadyAttached.result ?? alreadyAttached.data),
		);
		// `session/cancel` is a *notification*, so there is no response channel
		// to refuse down. Two things must therefore be true, and both are
		// asserted: the refusal is recorded in the log (the only report a
		// refused notification can have), and — because this client opted into
		// the extension namespace — it is also observable in-band as
		// `_dsh/session/refused`, which is this plugin's own mechanism rather
		// than anything the spec provides.
		check("idle: cancelling with nothing in flight is recorded, not dropped", await (async () => {
			const before = await lastEventId(ctx);
			const seen = refusals.length;
			await ctx.notify("session/cancel", { sessionId });
			line("→", "session/cancel (notification)", { sessionId });
			await delay(60);
			const events = (await ctx.request("_dsh/events/replay", { sessionId, after: before })).events;
			const logged = events.find((event) => event.type === "session.refused" && event.data?.command === "cancel");
			const inBand = refusals.slice(seen).find((params) => params.command === "cancel");
			check(
				"idle: the refused cancel is also observable in-band by an opted-in client",
				inBand !== undefined && inBand.state === "idle" && Array.isArray(inBand.allowedIn),
				JSON.stringify(inBand),
			);
			return logged !== undefined && logged.data.state === "idle";
		})());

		console.log("\n--- generating: start a turn, then probe it -------------------");
		// `/hold` blocks until cancelled, so the session is deterministically
		// still `generating` when the probes below arrive. A timed turn would
		// make these assertions a race against the machine's speed.
		const turn = ctx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/hold" }] });
		let midTurn;
		for (let waited = 0; waited < 500; waited += 10) {
			midTurn = await command(ctx, "_dsh/session/state", { sessionId });
			if (midTurn.result?.state === "generating") break;
			await delay(10);
		}
		check("generating: _dsh/session/state reports generating", midTurn.result?.state === "generating", `got ${midTurn.result?.state}`);
		check(
			"generating: session/cancel is admitted from generating (the queue is not held by the turn)",
			true,
			"asserted by the cancel below completing",
		);
		assertRefused(
			"generating: a second session/prompt is refused, naming the state",
			await command(ctx, "session/prompt", { sessionId, prompt: [{ type: "text", text: "again" }] }),
			"generating",
		);
		assertRefused("generating: session/delete is refused", await command(ctx, "session/delete", { sessionId }), "generating");
		// Fork is disabled until it delegates to the host's canonical fork, so it
// refuses as `unavailable` in every state — the per-state rule no longer
// decides anything, which is why the assertion is about the method being
// absent rather than about the state table.
		const forkMidTurn = await command(ctx, "_dsh/session/fork", { sessionId });
		check(
			"generating: fork is unavailable regardless of state, because it is disabled",
			forkMidTurn.ok === false && forkMidTurn.data?.type === "unavailable",
			JSON.stringify(forkMidTurn.data),
		);
		// The deliberate design choice from DESIGN.md §2: a title is not part of
		// the turn, so rename is admitted mid-turn — and it must be *audible*,
		// not silently discarded.
		assertCommitted(
			"generating: _dsh/session/rename is ACCEPTED and committed (metadata is turn-independent)",
			await command(ctx, "_dsh/session/rename", { sessionId, title: "renamed mid-turn" }),
		);
		check(
			"generating: the mid-turn rename reached the client while the turn was still running",
			updates.filter((update) => update.sessionUpdate === "session_info_update").some((update) => update.title === "renamed mid-turn"),
		);
		check(
			"generating: streamed chunks reach the client while the turn is still running",
			await (async () => {
				for (let waited = 0; waited < 500; waited += 10) {
					if (updates.some((update) => update.sessionUpdate === "agent_thought_chunk")) return true;
					await delay(10);
				}
				return false;
			})(),
		);

		console.log("\n--- cancelling -> idle ----------------------------------------");
		await ctx.notify("session/cancel", { sessionId });
		line("→", "session/cancel (notification)", { sessionId });
		const cancelled = await turn;
		line("←", "session/prompt result", cancelled);
		check("cancel settles the prompt with stopReason cancelled", cancelled?.stopReason === "cancelled", `got ${cancelled?.stopReason}`);
		const afterCancel = await command(ctx, "_dsh/session/state", { sessionId });
		check("after cancel the session is idle again", afterCancel.result?.state === "idle", `got ${afterCancel.result?.state}`);

		console.log("\n--- awaiting_permission ---------------------------------------");
		const permissionTurn = ctx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/approve" }] });
		for (let waited = 0; waited < 500 && permissionRequests.length === 0; waited += 10) await delay(10);
		check("the agent asked for permission", permissionRequests.length === 1, `got ${permissionRequests.length} request(s)`);
		// The client is still deliberating (it waits 250ms), so the session is
		// deterministically parked in `awaiting_permission` right now.
		const duringPermission = await command(ctx, "_dsh/session/state", { sessionId });
		check(
			"awaiting_permission: the state is observable while the question is outstanding",
			duringPermission.result?.state === "awaiting_permission",
			`got ${duringPermission.result?.state}`,
		);
		assertRefused(
			"awaiting_permission: session/delete is refused while the question is open",
			await command(ctx, "session/delete", { sessionId }),
			"awaiting_permission",
		);
		const permissionResult = await permissionTurn;
		line("←", "session/prompt result", permissionResult);
		check("the permission turn completed with end_turn", permissionResult?.stopReason === "end_turn", `got ${permissionResult?.stopReason}`);
		check("the tool call was reported exactly once", updates.filter((u) => u.sessionUpdate === "tool_call").length === 1);
		check("the tool call reached a terminal status", updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed"));

		console.log("\n--- closed / resume / delete ----------------------------------");
		assertCommitted("session/close succeeds from idle", await command(ctx, "session/close", { sessionId }));
		assertRefused(
			"closed: session/prompt is refused, naming the state",
			await command(ctx, "session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] }),
			"closed",
		);
		assertCommitted("closed: _dsh/session/rename is still accepted", await command(ctx, "_dsh/session/rename", { sessionId, title: "renamed while closed" }));
		assertCommitted("closed: session/resume reopens it", await command(ctx, "session/resume", { sessionId }));
		// Resuming a session that is already live is a no-op that succeeds.
		// Adoption is automatic for live sessions, so "attach me to this id" is
		// usually asking for something already true, and refusing it with
		// "already open here" would be accurate and useless.
		const again = await command(ctx, "session/resume", { sessionId });
		check(
			"resuming an already-attached session succeeds idempotently",
			again.ok === true && again.result?.alreadyAttached === true,
			JSON.stringify(again.result ?? again.data),
		);
		check("and it did not disturb the session", (await ctx.request("_dsh/session/state", { sessionId })).state === "idle");

		console.log("\n--- list ------------------------------------------------------");
		const listed = await command(ctx, "session/list", {});
		check(
			"session/list contains the session with its latest title",
			listed.result?.sessions?.some((entry) => entry.sessionId === sessionId && entry.title === "renamed while closed"),
			JSON.stringify(listed.result?.sessions?.map((entry) => `${entry.sessionId}:${entry.title}`)),
		);

		console.log("\n--- replay: nothing missing, nothing duplicated ----------------");
		const info = await command(ctx, "_dsh/log/info", {});
		const total = info.result.lastEventId;
		const cursor = Math.floor(total / 2);
		const replay = await ctx.request("_dsh/events/replay", { sessionId, after: cursor });
		line("→", "_dsh/events/replay", { sessionId, after: cursor });
		line("←", "replay", { count: replay.events.length, lastEventId: replay.lastEventId, firstRetainedEventId: replay.firstRetainedEventId });
		const ids = replay.events.map((event) => event.eventId);
		check("replay returns only events strictly after the cursor", ids.every((id) => id > cursor), `ids ${ids.slice(0, 4).join(",")}…`);
		check("replay ids are strictly increasing (no duplicates)", ids.every((id, index) => index === 0 || id > ids[index - 1]));
		check("replay reaches the log head", replay.lastEventId === total, `${replay.lastEventId} vs ${total}`);
		check("replay reports a retained floor", replay.firstRetainedEventId === 1, `got ${replay.firstRetainedEventId}`);
		const replayAgain = await ctx.request("_dsh/events/replay", { sessionId, after: cursor });
		check(
			"replay is idempotent: the same cursor yields the same events",
			JSON.stringify(replayAgain.events.map((e) => e.eventId)) === JSON.stringify(ids),
		);
		const everything = await ctx.request("_dsh/events/replay", { sessionId, after: -1 });
		check(
			"after: -1 returns the whole retained log for the session",
			everything.events.length >= replay.events.length && everything.events.every((event) => event.sessionId === sessionId),
			`${everything.events.length} event(s)`,
		);

		console.log("\n--- refusals are logged, so a client that missed the response still learns ---");
		// A refusal has to be provoked in a state that refuses. Park the
		// session in `generating` and try to start a second turn.
		const heldTurn = ctx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/hold" }] });
		for (let waited = 0; waited < 500; waited += 10) {
			const probe = await ctx.request("_dsh/session/state", { sessionId });
			if (probe.state === "generating") break;
			await delay(10);
		}
		const beforeRefusal = await lastEventId(ctx);
		await command(ctx, "session/prompt", { sessionId, prompt: [{ type: "text", text: "refused?" }] }).catch(() => {});
		const refusedEvents = (await ctx.request("_dsh/events/replay", { sessionId, after: beforeRefusal })).events.filter(
			(event) => event.type === "session.refused",
		);
		check("a refusal is recorded in the log", refusedEvents.length >= 1, `got ${refusedEvents.length}`);
		check(
			"the recorded refusal carries the state and the allowed states",
			refusedEvents[0]?.data?.state === "generating" && Array.isArray(refusedEvents[0]?.data?.allowedIn),
			JSON.stringify(refusedEvents[0]?.data),
		);
		await ctx.notify("session/cancel", { sessionId });
		await heldTurn;

		console.log("\n--- stubs refuse by name, not silently ------------------------");
		const load = await command(ctx, "session/load", { sessionId, cwd, mcpServers: [] });
		check("session/load is unimplemented and says so", load.ok === false && load.data?.type === "unimplemented", JSON.stringify(load.data));
		check("session/load names the supported path instead", load.data?.use === "_dsh/events/replay");
		const setMode = await command(ctx, "session/set_mode", { sessionId, modeId: "plan" });
		check("session/set_mode is unimplemented and says so", setMode.ok === false && setMode.data?.type === "unimplemented");
		const bogus = await command(ctx, "totally/made-up", {});
		check("an unknown method is methodNotFound", bogus.data?.type === "unimplemented" && bogus.data?.method === "totally/made-up");
		const badParams = await command(ctx, "_dsh/session/rename", { sessionId, title: "  " });
		check("a blank title is invalidParams, not a silent success", badParams.ok === false && badParams.data?.type === "invalid_params");
		// Fork must refuse rather than offer a *different* operation under the
		// same name. DSH's canonical fork copies a completed-turn prefix and
		// preserves lineage; this plugin can only create an empty child, so the
		// method is disabled until it delegates.
		const fork = await command(ctx, "_dsh/session/fork", { sessionId });
		check(
			"fork is refused as unavailable rather than doing something else under its name",
			fork.ok === false && fork.data?.type === "unavailable",
			JSON.stringify(fork.data ?? fork.result),
		);

		console.log("\n--- a read must not write -------------------------------------");
		const beforeRead = await lastEventId(ctx);
		const readOne = await command(ctx, "_dsh/session/state", { sessionId });
		const afterRead = await lastEventId(ctx);
		check("a state read appends no event at all", afterRead === beforeRead, `${beforeRead} -> ${afterRead}`);
		check(
			"a state read reports which commands the state admits",
			readOne.result?.availableCommands?.prompt === true && readOne.result?.availableCommands?.fork === true,
			JSON.stringify(readOne.result?.availableCommands),
		);
		await delay(30);
		const readTwo = await ctx.request("_dsh/session/state", { sessionId });
		// The old version logged `{read: true}`, which bumped `updatedAt` and so
		// could reorder `session/list`: polling a session made it look active.
		check(
			"a state read does not move updatedAt",
			readTwo.updatedAt === readOne.result?.updatedAt,
			`${readOne.result?.updatedAt} -> ${readTwo.updatedAt}`,
		);

		console.log("\n--- idempotency key ------------------------------------------");
		// The key is written as a literal on purpose: it is the wire contract,
		// and hardcoding it here is what would catch an accidental rename.
		const IDEMPOTENCY = "dsh-acp-control/idempotency-key";
		const firstRun = await ctx.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "idempotent turn" }],
			_meta: { [IDEMPOTENCY]: "verify-key-1" },
		});
		const headAfterFirst = await lastEventId(ctx);
		const retried = await ctx.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "idempotent turn" }],
			_meta: { [IDEMPOTENCY]: "verify-key-1" },
		});
		const headAfterRetry = await lastEventId(ctx);
		check("a retried prompt with the same key returns the same stop reason", retried?.stopReason === firstRun?.stopReason, `${firstRun?.stopReason} vs ${retried?.stopReason}`);
		// Without the key this second call would be *admitted* — the first turn
		// already returned the session to `idle` — and would run a second turn.
		check("a retried prompt with the same key runs no second turn", headAfterRetry === headAfterFirst, `log advanced ${headAfterFirst} -> ${headAfterRetry}`);
		const distinct = await ctx.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "idempotent turn" }],
			_meta: { [IDEMPOTENCY]: "verify-key-2" },
		});
		check("a different key does run a new turn", (await lastEventId(ctx)) > headAfterRetry && distinct !== undefined);

		console.log("\n--- a cursor ahead of the log is reported ---------------------");
		const ahead = await ctx.request("_dsh/events/replay", { sessionId, after: 999_999 });
		check(
			"a cursor ahead of the log is reported, not treated as 'nothing to replay'",
			ahead.gap?.kind === "ahead_of_log" && ahead.gap.lastEventId === ahead.lastEventId,
			JSON.stringify(ahead.gap),
		);
		check("and the replay that comes back is empty rather than wrong", ahead.events.length === 0);

		console.log("\n--- delete is plugin-local, and refuses a live session ----");
		// Deleting is only this control plane's business. DSH has no host
		// "delete a session" method, so reporting success while another frontend
		// still shows the conversation would be the accepted-and-discarded shape
		// this project exists to remove.
		const liveDelete = await command(ctx, "session/delete", { sessionId });
		check(
			"deleting a live session is refused, naming why",
			liveDelete.ok === false && liveDelete.data?.type === "refused" && typeof liveDelete.data?.reason === "string",
			JSON.stringify(liveDelete.data),
		);
		assertCommitted("session/close releases the agent", await command(ctx, "session/close", { sessionId }));
		const closedDelete = await command(ctx, "session/delete", { sessionId });
		assertCommitted("once closed, delete succeeds and says its scope", closedDelete);
		check(
			"the delete result states that only this control plane's record went away",
			closedDelete.result?.scope === "acp-control-only",
			JSON.stringify(closedDelete.result),
		);
		const gone = await command(ctx, "_dsh/session/state", { sessionId });
		check(
			"deleted: the session is gone, and asking for it says not_found rather than nothing",
			gone.ok === false && gone.data?.type === "not_found",
			JSON.stringify(gone.data),
		);

		console.log("\n--- a server that cannot see live agents must refuse ----------");
		// The scripted backend has no view of live agents, so a missing one is
		// an absence of information rather than evidence. Resuming an unknown
		// session here would be guessing, and guessing wrong produces two
		// owners of one conversation — so it refuses in its own words instead of
		// racing the host's "session is already active".
		const unknown = await command(ctx, "session/resume", { sessionId: "session-held-by-someone-else" });
		check(
			"resuming an unknown session is refused with cannot_attach, not attempted",
			unknown.ok === false && unknown.data?.type === "cannot_attach",
			JSON.stringify(unknown.data),
		);
		check(
			"and the refusal explains that the limitation is the missing live-agent view",
			typeof unknown.data?.reason === "string" && unknown.data.reason.includes("second owner"),
			unknown.data?.reason,
		);
	});

	if (serverStderr !== undefined) {
		console.log("\n--- server stderr ----------------------------------------------");
		for (const text of serverStderr()) console.log(`  | ${text}`);
	}
	return { checks, failures };
}
