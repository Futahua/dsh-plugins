/**
 * The append-only event log, and replay from a cursor.
 *
 * This is the module that makes "a reconnecting client misses nothing and
 * duplicates nothing" true rather than aspirational (DESIGN.md §5). The ACP
 * remote-transport RFD explicitly does not replay in-flight messages and
 * defers resumability to v2, so the guarantee has to be built here or not at
 * all.
 *
 * Three properties carry the guarantee, and each is a deliberate choice:
 *
 *  1. **One global monotonic `eventId`,** starting at 1, shared by every
 *     session. Per-session counters would need a second ordering for the
 *     connection-scoped stream, and two orderings is one too many. A
 *     session-scoped replay is the same query with a filter.
 *
 *  2. **The frame is stored, not re-derived.** When an event had a wire
 *     representation, the exact frame that went out is recorded with it and
 *     replayed byte-for-byte. Re-deriving on replay would let the replay path
 *     drift from the live path; storing makes them the same bytes by
 *     construction. Records with no wire representation (state transitions,
 *     refusals, archive flags) carry no frame and are not re-emitted — their
 *     ids are still consumed, so a stream's `id:` values may legitimately
 *     skip. The cursor is a log position, not a frame counter.
 *
 *  3. **Ids are assigned synchronously, the disk write is not.** Live replay
 *     reads the in-memory index, so a subscriber can never observe a gap
 *     while a write is in flight; durability follows on a serialized chain,
 *     and `flush()` awaits it. A crash costs at most the in-progress write.
 *
 * @module dsh-acp-control/eventlog
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ErrorCode, RpcError } from "./jsonrpc.js";

/** Event types this log produces. */
export const EventType = {
	/** A session was created. Rebuilds the session at boot. */
	created: "session.created",
	/** A session changed state. */
	state: "session.state",
	/** A user prompt was admitted. */
	prompt: "session.prompt",
	/** One ACP `session/update` was emitted; carries the frame. */
	update: "session.update",
	/** The title changed. Rebuilds the title at boot. */
	title: "session.title",
	/** The archived flag changed. Rebuilds the flag at boot. */
	archived: "session.archived",
	unarchived: "session.unarchived",
	/** A session was forked from another. */
	forked: "session.forked",
	/** A permission request was made or answered. */
	permission: "session.permission",
	/** A turn ended. */
	turnEnd: "session.turn_end",
	/** A cancellation was accepted. Recorded before it is performed, so a cancel that was asked for is never invisible. */
	cancel: "session.cancel",
	/** A turn or backend failed. */
	error: "session.error",
	/** A command was refused. Logged so a client that missed the response still learns of it. */
	refused: "session.refused",
	/** The session was closed (agent disposed, record kept). */
	closed: "session.closed",
	/** The session was deleted. */
	deleted: "session.deleted",
	/** The log hit its size cap and will accept no more writes. */
	exhausted: "log.exhausted",
	/** A client's cursor was below the retained floor. */
	gap: "log.gap",
};

/**
 * The append-only log.
 *
 * Not a stream abstraction: it is a file plus an index, and the index is what
 * replay reads. Everything that wants live delivery subscribes.
 */
export class EventLog {
	#path;
	#maxBytes;
	/** Every retained event, in `eventId` order. Index 0 is `firstRetainedEventId`. */
	#events = [];
	#bytes = 0;
	#nextEventId = 1;
	/** Serializes disk writes so line order on disk matches `eventId` order. */
	#writeChain = Promise.resolve();
	#subscribers = new Set();
	#exhausted = false;
	#closed = false;
	/**
	 * The most recent failed disk write, if any.
	 *
	 * A failed append must not be swallowed: `flush()` rethrows this, and the
	 * registry turns that into a failed command (DESIGN.md §5). The chain keeps
	 * running so one bad write does not wedge the log for the rest of the
	 * process, which is why the error is *recorded* rather than allowed to
	 * reject the chain.
	 */
	#writeError;
	/** What recovery found, for the boot log line. */
	#recovered = { dropped: 0, lastEventId: 0 };

	/**
	 * @param {object} options - log options.
	 * @param {string} options.path - the NDJSON file to append to.
	 * @param {number} [options.maxBytes] - refuse further writes past this size.
	 */
	constructor({ path, maxBytes = 64 * 1024 * 1024 }) {
		this.#path = path;
		this.#maxBytes = maxBytes;
	}

	/**
	 * Open the log, recovering state from disk.
	 *
	 * Recovery is not just "find the last id": a partially written final line
	 * (the crash case) is dropped rather than treated as corruption, because
	 * the alternative — refusing to boot on a torn write — turns a lost event
	 * into a lost harness.
	 *
	 * @param {object} options - see the constructor.
	 * @returns {Promise<EventLog>} the opened log.
	 */
	static async open(options) {
		const log = new EventLog(options);
		await log.#recover();
		return log;
	}

	async #recover() {
		await mkdir(dirname(this.#path), { recursive: true });
		let text;
		try {
			text = await readFile(this.#path, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		const lines = text.split("\n");
		const tail = lines.pop() ?? "";
		let dropped = 0;
		let maxId = 0;
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			let record;
			try {
				record = JSON.parse(trimmed);
			} catch {
				dropped += 1;
				continue;
			}
			if (typeof record.eventId !== "number" || record.eventId <= maxId) {
				dropped += 1;
				continue;
			}
			maxId = record.eventId;
			this.#events.push(record);
			this.#bytes += Buffer.byteLength(`${trimmed}\n`, "utf8");
		}
		if (tail.trim() !== "") dropped += 1; // torn final line
		this.#nextEventId = maxId + 1;
		this.#recovered = { dropped, lastEventId: maxId };
		if (this.#bytes >= this.#maxBytes) this.#exhausted = true;
	}

	/** @returns {{dropped: number, lastEventId: number}} recovery summary. */
	get recovery() {
		return this.#recovered;
	}

	/** @returns {number} the id of the most recent event, or 0 when empty. */
	get lastEventId() {
		return this.#nextEventId - 1;
	}

	/** @returns {number} the oldest id still replayable. Always 1 in slice 1 — the log never truncates. */
	get firstRetainedEventId() {
		return this.#events.length === 0 ? 1 : this.#events[0].eventId;
	}

	/** @returns {boolean} true when the size cap has been reached. */
	get exhausted() {
		return this.#exhausted;
	}

	/** @returns {string} the log file path. */
	get path() {
		return this.#path;
	}

	/** A snapshot for `_dsh/log/info`. */
	info() {
		return {
			path: this.#path,
			lastEventId: this.lastEventId,
			firstRetainedEventId: this.firstRetainedEventId,
			events: this.#events.length,
			bytes: this.#bytes,
			maxBytes: this.#maxBytes,
			exhausted: this.#exhausted,
			recovery: this.#recovered,
		};
	}

	/**
	 * Append one event.
	 *
	 * The id is assigned and the in-memory index updated before this function
	 * returns, so a subscriber notified here can never see an id gap. The disk
	 * write is queued; `flush()` awaits it.
	 *
	 * @param {object} input - the event body.
	 * @param {string} input.sessionId - the session it belongs to.
	 * @param {string} input.actor - who caused it (`human:zed`, `agent:<id>`, `system:acp-control`).
	 * @param {string} input.type - one of {@link EventType}.
	 * @param {object} [input.data] - the payload.
	 * @param {object|((eventId: number) => object)} [input.frame] - the ACP frame that goes on the wire, when there is one. Pass a function when the frame must carry its own `eventId` (this plugin's notifications do, in `_meta`), since the id does not exist until this call assigns it.
	 * @returns {object} the stored record, including its assigned `eventId`.
	 */
	append({ sessionId, actor, type, data, frame }) {
		if (this.#closed) {
			throw new RpcError(ErrorCode.internalError, "the event log is closed", { type: "log_closed" });
		}
		if (this.#exhausted) {
			throw new RpcError(
				ErrorCode.internalError,
				`the event log reached its ${this.#maxBytes}-byte cap and accepts no further writes`,
				{ type: "log_exhausted", lastEventId: this.lastEventId, path: this.#path },
			);
		}
		const eventId = this.#nextEventId++;
		const resolvedFrame = typeof frame === "function" ? frame(eventId) : frame;
		const record = {
			eventId,
			sessionId,
			ts: new Date().toISOString(),
			actor,
			type,
			...(data === undefined ? {} : { data }),
			...(resolvedFrame === undefined ? {} : { frame: resolvedFrame }),
		};
		const line = `${JSON.stringify(record)}\n`;
		const size = Buffer.byteLength(line, "utf8");
		this.#events.push(record);
		this.#bytes += size;
		if (this.#bytes >= this.#maxBytes) this.#exhausted = true;
		this.#writeChain = this.#writeChain
			.then(() => appendFile(this.#path, line, "utf8"))
			.catch((error) => {
				// Recorded, not swallowed, and not re-thrown: re-throwing would
				// reject the chain and make every later append inherit the
				// failure. `flush()` is where this surfaces, which is what makes
				// "the command succeeded" mean "the event is on disk".
				this.#writeError = error;
			});
		for (const subscriber of this.#subscribers) {
			try {
				subscriber(record);
			} catch {
				// A subscriber's failure must not corrupt the log for others.
			}
		}
		return record;
	}

	/**
	 * Append the one-time exhaustion marker, bypassing the cap.
	 *
	 * The marker is the difference between "the log is full" and "the log is
	 * full and nobody was told" — and the second is exactly the silent failure
	 * this design exists to prevent. It is appended directly rather than
	 * through {@link append} because `append` is what refuses.
	 */
	appendExhaustionNotice() {
		const record = {
			eventId: this.#nextEventId++,
			sessionId: null,
			ts: new Date().toISOString(),
			actor: "system:acp-control",
			type: EventType.exhausted,
			data: { maxBytes: this.#maxBytes, lastEventId: this.#nextEventId - 2, path: this.#path },
		};
		this.#events.push(record);
		this.#writeChain = this.#writeChain
			.then(() => appendFile(this.#path, `${JSON.stringify(record)}\n`, "utf8"))
			.catch((error) => {
				this.#writeError = error;
			});
		for (const subscriber of this.#subscribers) {
			try {
				subscriber(record);
			} catch {
				/* see append() */
			}
		}
		return record;
	}

	/**
	 * Read events strictly after a cursor.
	 *
	 * `after: -1` means "everything I have", which is the OpenHands
	 * `latest_event_id = -1` convention for a fresh client.
	 *
	 * @param {object} [query] - the replay query.
	 * @param {string} [query.sessionId] - only this session's events.
	 * @param {number} [query.after] - cursor; only events with a greater id.
	 * @param {number} [query.limit] - maximum records to return.
	 * @returns {object[]} matching events, in `eventId` order.
	 */
	read({ sessionId, after = -1, limit } = {}) {
		const out = [];
		for (const record of this.#events) {
			if (record.eventId <= after) continue;
			if (sessionId !== undefined && record.sessionId !== sessionId) continue;
			out.push(record);
			if (limit !== undefined && out.length >= limit) break;
		}
		return out;
	}

	/**
	 * Subscribe to live appends.
	 * @param {(record: object) => void} listener - called with each stored record.
	 * @returns {() => void} unsubscribe.
	 */
	subscribe(listener) {
		this.#subscribers.add(listener);
		return () => this.#subscribers.delete(listener);
	}

	/**
	 * Await every queued disk write, and **throw if any of them failed**.
	 *
	 * This is the whole durability contract (DESIGN.md §5): a command does not
	 * report success until the events it produced are on disk. Before this,
	 * `flush()` merely awaited a chain whose errors had already been swallowed,
	 * so a rename could return success, reach live clients, advance every
	 * cursor, and be gone after a restart — a durability claim that was simply
	 * false.
	 *
	 * A recorded failure is thrown once and cleared. Once-and-cleared rather
	 * than sticky, because a transient failure (a full disk that is emptied, a
	 * file handle that is restored) should not wedge the process forever; and a
	 * *persistent* failure re-records itself on the very next append, so the
	 * next flush reports it again.
	 *
	 * With concurrent commands, the failure may be reported to whichever
	 * command flushes first rather than to the one whose write failed. That is
	 * deliberate: the alternative is per-event attribution machinery, and the
	 * property that matters is that the failure is *reported to someone* rather
	 * than lost.
	 *
	 * @throws the most recent write failure, if there was one.
	 */
	async flush() {
		await this.#writeChain;
		if (this.#writeError !== undefined) {
			const error = this.#writeError;
			this.#writeError = undefined;
			throw error;
		}
	}

	/** @returns {Error|undefined} the pending write failure, without clearing it. */
	get writeError() {
		return this.#writeError;
	}

	/** Stop accepting writes and await the tail. */
	async close() {
		this.#closed = true;
		await this.flush();
	}
}
