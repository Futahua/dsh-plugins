// Does the LIVE server serve the plugins?
//
// Mints a browser-session cookie the same way the bridge does, using the signing
// secret from the local credential store — never a hardcoded copy.
//
// This file previously carried the live secret in plain text. It was never
// committed (checked with `git log -S`), but it is the reason this header and the
// runtime read below exist: a secret in a dev script is one careless copy away
// from a public repository.
//
//   DSH_HOME       Harness home holding .credentials.yaml
//                  (config.mjs when present, else four levels up from this file)
//   DSH_AUTHORITY  host:port of the GUI (config.mjs, else 127.0.0.1:3080, or argv[2])
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// `config.mjs` sits at the repository root; the live profile has no such file, so
// fall back to resolving the Harness home from this script's own location (four
// levels up from the plugin directory). One source file, two layouts: in the
// repository the authority comes from config, in the live profile it defaults to
// loopback, which needs no Host fence.
let config = {};
try {
	config = await import("../../config.mjs");
} catch {
	// live profile layout: no config.mjs next to the plugin
}

const DSH_HOME = process.env.DSH_HOME ?? config.DSH_HOME ?? resolve(HERE, "../../../..");
const AUTHORITY = process.argv[2] ?? process.env.DSH_AUTHORITY ?? config.AUTHORITY ?? "127.0.0.1:3080";

/** Read the browser-session signing secret from the local credential store. */
function readSecret() {
	const file = join(DSH_HOME, ".credentials.yaml");
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		throw new Error(
			`cannot read ${file}. Set DSH_HOME to the Harness home, or point this script at an install that has one.`,
		);
	}
	// The record is a 32-byte base64url value stored under client-connection.
	const match = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{43})/u.exec(text);
	if (!match) throw new Error(`${file} has no client-connection/browser-session secret`);
	return match[1];
}

const key = Buffer.from(readSecret().replaceAll("-", "+").replaceAll("_", "/"), "base64");
const b64url = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

/** A cookie valid for one authority, backdated to tolerate clock skew. */
function cookieFor(authority) {
	const issuedAt = Date.now() - 60_000;
	const expiresAt = issuedAt + 30 * 864e5;
	const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), "utf8"));
	const sig = b64url(createHmac("sha256", key).update(body).digest());
	return `dsh-auth-${b64url(createHash("sha256").update(authority).digest())}=v1.${body}.${sig}`;
}

const headers = { Cookie: cookieFor(AUTHORITY) };
const res = await fetch(`http://${AUTHORITY}/`, { headers });
const body = await res.text();
console.log(`live index (${AUTHORITY}): HTTP ${res.status}, ${body.length} bytes`);

for (const id of ["dsh-mobile-rail", "dsh-opencode-go-usage"]) {
	console.log(`  ${id.padEnd(22)} in boot graph: ${body.includes(id)}`);
}

const usage = await fetch(`http://${AUTHORITY}/api/opencode-go-usage.status`, { headers });
console.log(`  usage route           : HTTP ${usage.status}`);
