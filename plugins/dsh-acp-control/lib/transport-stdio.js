/**
 * The stdio transport: NDJSON JSON-RPC on stdin and stdout.
 *
 * This is the established ACP path — editors launch the agent as a child
 * process and speak to it over the pipes — so it is the one that has to be
 * exactly right, and the one whose failure mode is worst.
 *
 * **stdout carries protocol frames and nothing else.** A stray `console.log`
 * anywhere in the process corrupts the stream, and the symptom is a client
 * that hangs rather than an error anyone can read. Every diagnostic this
 * plugin emits goes to stderr; `write` below is the only thing that touches
 * stdout, and it is the only thing that should.
 *
 * @module dsh-acp-control/transport-stdio
 */

import { Connection } from "./connection.js";
import { readChunk, serialize } from "./jsonrpc.js";

/**
 * Serve one control plane over a pair of streams.
 *
 * @param {object} options - transport options.
 * @param {object} options.plane - the control plane.
 * @param {NodeJS.ReadableStream} options.input - the readable side (normally `process.stdin`).
 * @param {NodeJS.WritableStream} options.output - the writable side (normally `process.stdout`).
 * @param {(message: string) => void} [options.logger] - diagnostics; the caller is responsible for pointing this at stderr.
 * @param {() => void} [options.onClose] - called once the input ends.
 * @returns {{connection: Connection, close: () => void}} the connection and a stopper.
 */
export function serveStdio({ plane, input, output, logger, onClose }) {
	const connection = new Connection({
		transportName: "stdio",
		logger,
		write: (frame) => output.write(serialize(frame)),
	});
	plane.attach(connection);

	let buffer = "";
	let closed = false;

	/**
	 * Stop serving. Idempotent, because three different things call it —
	 * input end, a write error, and plugin teardown — and double-teardown is
	 * how a clean exit turns into a crash during shutdown.
	 */
	const close = () => {
		if (closed) return;
		closed = true;
		plane.detach(connection);
		connection.close();
		onClose?.();
	};

	input.setEncoding?.("utf8");
	input.on("data", (chunk) => {
		const { frames, rest, errors } = readChunk(buffer, String(chunk));
		buffer = rest;
		for (const error of errors) {
			// A parse error is answered, not swallowed: the peer sent something
			// and is entitled to know it did not arrive.
			output.write(serialize({ jsonrpc: "2.0", id: null, error: { code: error.code, message: error.message, data: error.data } }));
		}
		for (const frame of frames) {
			void connection
				.handle(plane, frame)
				.then((response) => {
					if (response !== null) output.write(serialize(response));
				})
				.catch((error) => {
					logger?.(`stdio dispatch failed: ${String(error)}`);
				});
		}
	});
	input.on("end", () => {
		logger?.("stdin ended; closing the stdio connection");
		close();
	});
	input.on("error", (error) => {
		logger?.(`stdin error: ${String(error)}`);
		close();
	});

	return { connection, close };
}
