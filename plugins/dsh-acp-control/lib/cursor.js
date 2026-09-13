/**
 * The replay cursor: how a client names the last event it received, and how
 * that position is put on the wire.
 *
 * **One place, on purpose.** The ACP Streamable HTTP & WebSocket Transport RFD
 * does **not** define event ids in v1 — it explicitly defers them to v2, where
 * streamed chunks carry an id described as a "last replay ID" for retry and
 * resumption. So `id:` is unclaimed today and points exactly where v2 is
 * going, which is the good case; but it also means v2 could *assign* the field
 * a meaning that differs from ours.
 *
 * The exposure that creates is contained here: every read and every write of a
 * cursor goes through this module, so adopting the v2 meaning is a change in
 * one file and nowhere else. Concretely, if v2 redefines the SSE id as an
 * opaque token rather than a log position, only {@link encodeEventId} and
 * {@link decodeCursor} change — `lib/transport-http.js` keeps calling the same
 * two functions, and the log keeps its own monotonic `eventId`.
 *
 * Deliberately *not* abstracted: the fact that the cursor is a log position at
 * all. Replay is defined as "every event with a greater id" (DESIGN.md §5), and
 * hiding that behind an opaque cursor type today would be ceremony for a
 * problem that does not exist yet.
 *
 * @module dsh-acp-control/cursor
 */

/**
 * "Everything I have" — the OpenHands `latest_event_id = -1` convention for a
 * fresh client. Not a valid log position; a sentinel meaning "no cursor".
 */
export const INITIAL_CURSOR = -1;

/**
 * Where a resume cursor came from, for the log line. Knowing which channel a
 * client used is the difference between diagnosing a stuck reconnect and
 * guessing at it.
 * @typedef {'query'|'last-event-id'|'none'} CursorSource
 */

/**
 * Parse one candidate cursor value.
 *
 * Rejects anything that is not a finite number rather than coercing: a cursor
 * silently read as 0 when it was meant as "I have nothing" would replay the
 * entire log to a client that only wanted the tail, and a cursor silently read
 * as "none" would drop events. Both are silent failures, so a malformed value
 * is reported as absent and the caller falls through to the next channel.
 *
 * @param {unknown} raw - the raw value, from a query parameter or a header.
 * @returns {number|undefined} the cursor, or undefined when unusable.
 */
export function decodeCursor(raw) {
	if (typeof raw !== "string" && typeof raw !== "number") return undefined;
	if (raw === "") return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value)) return undefined;
	// A negative cursor other than the sentinel is meaningless, and would read
	// as "everything" by accident; clamp rather than guess.
	if (value < 0) return INITIAL_CURSOR;
	return Math.floor(value);
}

/**
 * Read the resume cursor from a stream request.
 *
 * Precedence: an explicit `?after=` wins, then the standard `Last-Event-ID`
 * header — which a browser's `EventSource` sends by itself on reconnect, and
 * which is the whole reason a browser client needs no cursor code — then
 * {@link INITIAL_CURSOR} meaning "everything".
 *
 * @param {object} input - the request parts.
 * @param {URL} input.url - the parsed request URL.
 * @param {Record<string, unknown>} input.headers - the request headers.
 * @returns {{after: number, source: CursorSource}} the cursor and where it came from.
 */
export function readCursor({ url, headers }) {
	const fromQuery = decodeCursor(url.searchParams.get("after"));
	if (fromQuery !== undefined) return { after: fromQuery, source: "query" };
	const raw = headers["last-event-id"];
	const headerValue = Array.isArray(raw) ? raw[0] : raw;
	const fromHeader = decodeCursor(headerValue);
	if (fromHeader !== undefined) return { after: fromHeader, source: "last-event-id" };
	return { after: INITIAL_CURSOR, source: "none" };
}

/**
 * The `id:` field written on one SSE frame.
 *
 * A frame with no log position (a direct response to a POST, a keep-alive)
 * returns `undefined` and is written without an `id:` — correct, because such a
 * frame is not replayable and must not move the client's cursor.
 *
 * @param {number|undefined} eventId - the log position, when the frame has one.
 * @returns {string|undefined} the value for the `id:` field.
 */
export function encodeEventId(eventId) {
	return typeof eventId === "number" && Number.isFinite(eventId) ? String(eventId) : undefined;
}

/**
 * Whether a replayed record is beyond the client's cursor.
 *
 * The single definition of "after", used by both the replay read and any
 * caller that needs to reason about the boundary, so the two cannot disagree
 * about off-by-one.
 *
 * @param {number} eventId - the record's position.
 * @param {number} after - the client's cursor.
 * @returns {boolean} true when the record must be sent.
 */
export function isAfter(eventId, after) {
	return eventId > after;
}

/**
 * Whether a cursor has fallen below what the log still retains.
 *
 * Slice 1 never truncates, so this is always false in practice; it exists so
 * that adding retention later cannot silently start dropping a client's events
 * instead of telling it (DESIGN.md §5).
 *
 * @param {number} after - the client's cursor.
 * @param {number} firstRetainedEventId - the oldest replayable position.
 * @returns {boolean} true when the client must be told about a gap.
 */
export function hasGap(after, firstRetainedEventId) {
	return after >= 0 && after < firstRetainedEventId - 1;
}

/**
 * Whether a cursor sits **ahead of** everything the log has.
 *
 * This is the mirror of {@link hasGap}, and the more dangerous of the two
 * because it looks like success. A client that reconnects holding cursor 50
 * against a log whose high-water mark is 45 — which is what a crash that lost
 * the tail of the file, or a server restarted against a different data
 * directory, produces — is told "nothing to replay", then receives new events
 * numbered 46 upward and **never sees 46–50 at all**, because its cursor is
 * already past them. It has silently lost events and no way to know.
 *
 * `hasGap` cannot see this: it only looks downward from the cursor.
 *
 * @param {number} after - the client's cursor.
 * @param {number} lastEventId - the log's high-water mark.
 * @returns {boolean} true when the client's cursor is beyond the log.
 */
export function isAhead(after, lastEventId) {
	return after > lastEventId;
}

/**
 * Classify a resume attempt so the caller can tell the client what to do.
 *
 * One function rather than two checks at each call site: the conditions are
 * mutually exclusive, and a caller that tested them in the wrong order would
 * report the wrong remedy.
 *
 * @param {number} after - the client's cursor.
 * @param {{firstRetainedEventId: number, lastEventId: number}} log - the log's bounds.
 * @returns {{kind: 'ok'}|{kind: 'below_floor', firstRetainedEventId: number}|{kind: 'ahead_of_log', lastEventId: number}}
 */
export function classifyResume(after, log) {
	if (isAhead(after, log.lastEventId)) return { kind: "ahead_of_log", lastEventId: log.lastEventId };
	if (hasGap(after, log.firstRetainedEventId)) return { kind: "below_floor", firstRetainedEventId: log.firstRetainedEventId };
	return { kind: "ok" };
}
