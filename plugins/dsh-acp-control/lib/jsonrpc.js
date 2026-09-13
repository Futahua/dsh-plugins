/**
 * JSON-RPC 2.0 framing and error vocabulary for ACP.
 *
 * Implemented directly against the stable ACP v1 schema
 * (`@agentclientprotocol/sdk` 1.4.0, `schema/schema.json`, `PROTOCOL_VERSION
 * = 1`) rather than through the SDK, for the reason given in DESIGN.md §8:
 * this plugin's subject matter — cursors, log positions, refusals — is outside
 * what the SDK models, and the SDK types `onRequest` as a closed union of
 * standard methods, so an extension namespace needs a cast to register at all.
 * The wire is small enough to implement exactly.
 *
 * Nothing here imports anything. It is pure framing, so it is the one module
 * every transport and every check can share.
 *
 * @module dsh-acp-control/jsonrpc
 */

/** The JSON-RPC version string every frame carries. */
export const JSONRPC_VERSION = "2.0";

/** The ACP protocol version this server speaks. Stable v1. */
export const PROTOCOL_VERSION = 1;

/**
 * Client→agent methods. Taken verbatim from the stable schema's
 * `AGENT_METHODS`; a name is only listed here once it is implemented or
 * deliberately stubbed (DESIGN.md §3).
 */
export const AGENT_METHODS = {
	initialize: "initialize",
	authenticate: "authenticate",
	logout: "logout",
	sessionNew: "session/new",
	sessionLoad: "session/load",
	sessionList: "session/list",
	sessionDelete: "session/delete",
	sessionFork: "session/fork",
	sessionResume: "session/resume",
	sessionClose: "session/close",
	sessionSetMode: "session/set_mode",
	sessionSetConfigOption: "session/set_config_option",
	sessionPrompt: "session/prompt",
	sessionCancel: "session/cancel",
};

/** Agent→client methods. */
export const CLIENT_METHODS = {
	sessionRequestPermission: "session/request_permission",
	sessionUpdate: "session/update",
};

/** Protocol-level methods (the `$/` namespace ACP reserves). */
export const PROTOCOL_METHODS = {
	cancelRequest: "$/cancel_request",
};

/**
 * The prefix marking this plugin's extension namespace.
 *
 * A *wire* fact, so it lives with the other wire facts: it decides which
 * methods only an opted-in client may be sent. It is `_dsh/` and not `dsh/`
 * because the third-party DSH ACP plugin already uses the bare `dsh/`
 * namespace for different methods with different shapes, and two incompatible
 * things must not claim one namespace. The leading underscore matches ACP's own
 * convention for reserved/extension space (`_meta`, `$/cancel_request`).
 */
export const EXTENSION_PREFIX = "_dsh/";

/**
 * Whether a frame belongs to the extension namespace.
 * @param {object} frame - a JSON-RPC frame.
 * @returns {boolean} true when its method is extension-scoped.
 */
export function isExtensionFrame(frame) {
	return typeof frame?.method === "string" && frame.method.startsWith(EXTENSION_PREFIX);
}

/**
 * Error codes. The first five are JSON-RPC's; the next four are the subset of
 * ACP's own server-error range this server uses; `refused` is this plugin's,
 * and is documented in DESIGN.md §2.
 */
export const ErrorCode = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internalError: -32603,
	requestCancelled: -32800,
	authRequired: -32000,
	resourceNotFound: -32002,
	/** A well-formed command the session's current state does not allow. */
	refused: -32003,
};

/**
 * A JSON-RPC error that carries a structured `data` payload.
 *
 * `data.type` is the machine-readable discriminator. Clients MUST switch on it
 * rather than on `code`, so that the numeric code can change without breaking
 * a client that only cares about the category (DESIGN.md §2).
 */
export class RpcError extends Error {
	/**
	 * @param {number} code - a JSON-RPC error code.
	 * @param {string} message - human-readable summary.
	 * @param {object} [data] - structured payload; `type` is required for
	 *   errors this server originates.
	 */
	constructor(code, message, data) {
		super(message);
		this.name = "RpcError";
		this.code = code;
		this.data = data;
	}
}

/** The method does not exist, or exists and is not implemented here. */
export function methodNotFound(method, detail) {
	return new RpcError(ErrorCode.methodNotFound, `Method not found: ${method}`, {
		type: "unimplemented",
		method,
		...detail,
	});
}

/** The request was understood but its parameters are unusable. */
export function invalidParams(message, detail) {
	return new RpcError(ErrorCode.invalidParams, message, { type: "invalid_params", ...detail });
}

/** A well-formed request against unknown or missing state. */
export function notFound(message, detail) {
	return new RpcError(ErrorCode.resourceNotFound, message, { type: "not_found", ...detail });
}

/** This server failed at something that should have worked. */
export function internalError(message, detail) {
	return new RpcError(ErrorCode.internalError, message, { type: "internal", ...detail });
}

/** The request was cancelled (peer sent `$/cancel_request` or aborted). */
export function requestCancelled(message, detail) {
	return new RpcError(ErrorCode.requestCancelled, message, { type: "cancelled", ...detail });
}

/** A JSON-RPC request frame. */
export function requestFrame(id, method, params) {
	return { jsonrpc: JSONRPC_VERSION, id, method, params };
}

/** A JSON-RPC success response frame. */
export function resultFrame(id, result) {
	return { jsonrpc: JSONRPC_VERSION, id, result };
}

/** A JSON-RPC error response frame. */
export function errorFrame(id, error) {
	const payload = {
		code: error.code ?? ErrorCode.internalError,
		message: error.message ?? String(error),
	};
	if (error.data !== undefined) payload.data = error.data;
	return { jsonrpc: JSONRPC_VERSION, id, error: payload };
}

/** A JSON-RPC notification frame. */
export function notificationFrame(method, params) {
	return { jsonrpc: JSONRPC_VERSION, method, params };
}

/** Serialize one frame the way every ACP stdio transport does: one line. */
export function serialize(frame) {
	return `${JSON.stringify(frame)}\n`;
}

/**
 * Classify one inbound frame without interpreting it.
 *
 * A frame is a request when it has both `method` and `id`; a notification when
 * it has `method` and no `id` (JSON-RPC 2.0 §4); a response when it has `id`
 * and either `result` or `error`; anything else is malformed.
 *
 * @param {unknown} frame - a parsed JSON value.
 * @returns {{kind: 'request'|'notification'|'response'|'invalid', frame: any}}
 */
export function classify(frame) {
	if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
		return { kind: "invalid", frame };
	}
	const hasId = frame.id !== undefined && frame.id !== null;
	if (typeof frame.method === "string") {
		return { kind: hasId ? "request" : "notification", frame };
	}
	if (hasId && ("result" in frame || "error" in frame)) {
		return { kind: "response", frame };
	}
	return { kind: "invalid", frame };
}

/**
 * Split a byte stream into complete NDJSON frames, holding the remainder.
 *
 * ACP's stdio transport is newline-delimited JSON, and neither a chunk
 * boundary nor a pipe flush has any obligation to fall on a newline — so the
 * tail of an incomplete line must be carried, not discarded and not parsed.
 * Returns the frames that were complete plus whatever remains buffered.
 *
 * @param {string} buffer - previously buffered text.
 * @param {string} chunk - newly arrived text.
 * @returns {{frames: any[], rest: string, errors: RpcError[]}}
 */
export function readChunk(buffer, chunk) {
	const text = buffer + chunk;
	const lines = text.split("\n");
	const rest = lines.pop() ?? "";
	const frames = [];
	const errors = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			frames.push(JSON.parse(trimmed));
		} catch (error) {
			errors.push(
				new RpcError(ErrorCode.parseError, `Parse error: ${error instanceof Error ? error.message : String(error)}`, {
					type: "parse_error",
					line: trimmed.slice(0, 200),
				}),
			);
		}
	}
	return { frames, rest, errors };
}
