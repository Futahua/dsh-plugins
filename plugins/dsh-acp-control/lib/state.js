/**
 * The session state machine: states, the transition table, and refusals.
 *
 * This module is the reason the plugin exists (DESIGN.md §2). It is pure — no
 * I/O, no Cordis — so the transition table can be read as the specification it
 * is, and so the check in `verify/` can assert over it directly.
 *
 * The invariant it enforces, stated once:
 *
 *   Nothing changes a session except an admitted command, and no admitted
 *   command is ever silent.
 *
 * A command is either admitted (and then the caller *must* append at least one
 * event, which `lib/session.js` verifies) or refused with a structured error
 * naming the state that blocked it. There is no third outcome, so there is no
 * path where a caller's text is accepted and dropped — the bug class this
 * design is aimed at.
 *
 * @module dsh-acp-control/state
 */

import { ErrorCode, RpcError } from "./jsonrpc.js";

/** Every state a session can be in. Exactly one applies at any moment. */
export const SessionState = {
	/** No turn in flight. The resting state. */
	idle: "idle",
	/** A prompt turn is running. */
	generating: "generating",
	/** The running turn is blocked on a client permission decision. */
	awaitingPermission: "awaiting_permission",
	/** Cancellation accepted; the turn is winding down. */
	cancelling: "cancelling",
	/** Teardown in flight. */
	closing: "closing",
	/** Terminal. Resumable and deletable. */
	closed: "closed",
	/** Terminal-by-error. Closable, deletable, resumable. */
	failed: "failed",
};

/** Every command the control plane admits. */
export const Command = {
	prompt: "prompt",
	cancel: "cancel",
	close: "close",
	delete: "delete",
	resume: "resume",
	rename: "rename",
	archive: "archive",
	unarchive: "unarchive",
	fork: "fork",
	state: "state",
};

const S = SessionState;

/**
 * The transition table. A command is admitted only in the states listed.
 *
 * Read the reasons alongside it — two of these entries are decisions against
 * the obvious alternative and are argued in DESIGN.md §2:
 *
 *  - `rename` is admitted *during* `generating`. Forbidding it would make a
 *    legitimate, turn-independent metadata write fail for a reason the user
 *    cannot act on. The original bug was never that rename was allowed; it was
 *    that rename was silent.
 *  - `fork` is `idle`-only, because a fork cuts the log at a settled turn
 *    boundary and `generating` has none.
 */
export const TRANSITIONS = Object.freeze({
	// One turn at a time. Everything else about a session is independent of it.
	[Command.prompt]: Object.freeze([S.idle]),
	// Cancelling an idle session is meaningless; cancelling twice is noise.
	[Command.cancel]: Object.freeze([S.generating, S.awaitingPermission]),
	// Close is the universal "stop and tear down", so it is admitted from
	// every live state including `failed`.
	[Command.close]: Object.freeze([S.idle, S.generating, S.awaitingPermission, S.cancelling, S.failed]),
	// Delete is not admitted while a turn is writing to the session: that is
	// how orphaned writes happen. Cancel or close first.
	[Command.delete]: Object.freeze([S.idle, S.closed, S.failed]),
	// Resume opens a recovered or closed session's backend handle. It is
	// admitted only where there is nothing to open: a session already live in
	// another state is refused by naming that state, rather than silently
	// returning a second handle to the same session.
	[Command.resume]: Object.freeze([S.closed, S.failed]),
	// Metadata writes: independent of the turn, so admitted in every state
	// where the session still exists and is not mid-teardown.
	[Command.rename]: Object.freeze([S.idle, S.generating, S.awaitingPermission, S.cancelling, S.closed, S.failed]),
	[Command.archive]: Object.freeze([S.idle, S.generating, S.awaitingPermission, S.cancelling, S.closed, S.failed]),
	[Command.unarchive]: Object.freeze([S.idle, S.generating, S.awaitingPermission, S.cancelling, S.closed, S.failed]),
	[Command.fork]: Object.freeze([S.idle]),
	// Reading state is always allowed, including mid-teardown.
	[Command.state]: Object.freeze([S.idle, S.generating, S.awaitingPermission, S.cancelling, S.closing, S.closed, S.failed]),
});

/**
 * The states a command would have been admitted in.
 * @param {string} command - one of {@link Command}.
 * @returns {readonly string[]} the allowed states, empty for an unknown command.
 */
export function allowedIn(command) {
	return TRANSITIONS[command] ?? [];
}

/**
 * Whether a command is admitted in a state.
 * @param {string} command - one of {@link Command}.
 * @param {string} state - one of {@link SessionState}.
 * @returns {boolean} true when the transition table admits it.
 */
export function allows(command, state) {
	return allowedIn(command).includes(state);
}

/**
 * The states reachable from one state — the half of the table a UI needs to
 * decide what to enable, without duplicating the table.
 * @param {string} state - one of {@link SessionState}.
 * @returns {Record<string, boolean>} command -> admitted.
 */
export function availableCommands(state) {
	const out = {};
	for (const command of Object.keys(TRANSITIONS)) out[command] = allows(command, state);
	return out;
}

/** Terminal states: nothing runs, and only close/delete/resume/rename apply. */
export function isTerminal(state) {
	return state === SessionState.closed || state === SessionState.failed;
}

/** Active states: an agent turn or its teardown is in flight. */
export function isBusy(state) {
	return (
		state === SessionState.generating ||
		state === SessionState.awaitingPermission ||
		state === SessionState.cancelling ||
		state === SessionState.closing
	);
}

/**
 * Why a command was refused in this state. The `hint` is the part a UI shows:
 * a refusal that names the state but not the way out is only half an answer.
 */
const REASONS = Object.freeze({
	[Command.prompt]: {
		generating: "a turn is already running",
		awaitingPermission: "the turn is waiting for a permission decision",
		cancelling: "the running turn is still winding down",
		closing: "the session is being torn down",
		closed: "the session is closed; resume it first",
		failed: "the session failed; resume it first",
	},
	[Command.cancel]: {
		idle: "no turn is in flight",
		cancelling: "cancellation is already in progress",
		closing: "the session is being torn down",
		closed: "the session is closed",
		failed: "the session has already failed",
	},
	[Command.close]: {
		closing: "teardown is already in progress",
		closed: "the session is already closed",
	},
	[Command.delete]: {
		generating: "a turn is writing to the session",
		awaitingPermission: "a turn is in flight, waiting for a permission decision",
		cancelling: "a turn is still winding down",
		closing: "teardown is in progress",
	},
	[Command.resume]: {
		idle: "the session is already open here",
		generating: "the session is already open here and has a turn in flight",
		awaitingPermission: "the session is already open here and is waiting for a permission decision",
		cancelling: "the session is already open here and a turn is winding down",
		closing: "the session is being torn down",
	},
	[Command.fork]: {
		generating: "a fork needs a settled turn boundary and this session has a turn in flight",
		awaitingPermission: "a fork needs a settled turn boundary and this session has a turn in flight",
		cancelling: "the running turn is still winding down",
		closing: "the session is being torn down",
		closed: "the session is closed; resume it before forking",
		failed: "the session failed; resume it before forking",
	},
	[Command.rename]: { closing: "the session is being torn down" },
	[Command.archive]: { closing: "the session is being torn down" },
	[Command.unarchive]: { closing: "the session is being torn down" },
});

/** The way out of a refusal, per command, when there is one. */
const HINTS = Object.freeze({
	[Command.prompt]: "wait for the running turn to end, or send session/cancel",
	[Command.cancel]: "nothing to cancel",
	[Command.close]: "already closing or closed",
	[Command.delete]: "send session/cancel and wait for the turn to end, then delete",
	[Command.resume]: "use the session that is already open, or wait for teardown",
	[Command.fork]: "wait for the turn to end, then fork",
	[Command.rename]: "wait for teardown to finish",
	[Command.archive]: "wait for teardown to finish",
	[Command.unarchive]: "wait for teardown to finish",
});

/**
 * Build the refusal for a command the state does not admit.
 *
 * The returned error's `data` is the contract: `type` is the discriminator,
 * `state` names what blocked it, and `allowedIn` names where it would have
 * worked. `eventId` is filled in by the caller, which knows the log position.
 *
 * @param {string} command - the refused command.
 * @param {string} state - the state that refused it.
 * @param {object} [extra] - additional `data` fields (`sessionId`, `eventId`, …).
 * @returns {RpcError} the refusal, always with `data.type === 'refused'`.
 */
export function refusal(command, state, extra = {}) {
	const reason = REASONS[command]?.[state] ?? `the session is ${state}`;
	const allowed = allowedIn(command);
	return new RpcError(ErrorCode.refused, `${command} is not allowed while the session is ${state}`, {
		type: "refused",
		command,
		state,
		allowedIn: [...allowed],
		reason,
		...(HINTS[command] === undefined ? {} : { hint: HINTS[command] }),
		...extra,
	});
}

/**
 * The states a session may move to from here, for the state-change event.
 *
 * A transition is not "any allowed state" — it is the specific edge the
 * command takes. Keeping the edges in one place means a state change reported
 * to a client is derived from the same table that admitted the command.
 */
export const EDGES = Object.freeze({
	[Command.prompt]: Object.freeze({ from: [S.idle], to: S.generating }),
	[Command.cancel]: Object.freeze({ from: [S.generating, S.awaitingPermission], to: S.cancelling }),
	[Command.close]: Object.freeze({
		from: [S.idle, S.generating, S.awaitingPermission, S.cancelling, S.failed],
		to: S.closing,
	}),
	[Command.delete]: Object.freeze({ from: [S.idle, S.closed, S.failed], to: S.closed }),
	[Command.resume]: Object.freeze({ from: [S.closed, S.failed], to: S.idle }),
	[Command.rename]: Object.freeze({ from: [], to: null }), // metadata: no state change
	[Command.archive]: Object.freeze({ from: [], to: null }),
	[Command.unarchive]: Object.freeze({ from: [], to: null }),
	[Command.fork]: Object.freeze({ from: [], to: null }), // creates a new session
	[Command.state]: Object.freeze({ from: [], to: null }),
});

/**
 * The state a command moves a session to, or `null` when it does not move it.
 * @param {string} command - the admitted command.
 * @param {string} state - the current state.
 * @returns {string|null} the next state.
 */
export function nextState(command, state) {
	const edge = EDGES[command];
	if (edge === undefined || edge.to === null) return null;
	if (!edge.from.includes(state)) return null;
	return edge.to;
}
