// Is the LIVE server serving this plugin?
//
// The profile's `cordis.patch.yml` is hot-reloaded (`patchReload: live`), so a new
// row reaches the boot graph without restarting `dsh web` — but the running page
// does NOT get a newly added client bundle injected, so a browser reload is still
// needed before the bundle executes. This asks the server, which is the half that
// a reload cannot fix.
//
//   DSH_HOME       Harness home holding .credentials.yaml
//   DSH_AUTHORITY  host:port of the GUI (default 127.0.0.1:3080, or argv[2])
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const DSH_HOME = process.env.DSH_HOME ?? resolve(HERE, "../../../..");
const AUTHORITY = process.argv[2] ?? process.env.DSH_AUTHORITY ?? "127.0.0.1:3080";
const PLUGIN_ID = "dsh-code-colors";

/** Read the browser-session signing secret from the local credential store. */
function readSecret() {
	const file = join(DSH_HOME, ".credentials.yaml");
	const text = readFileSync(file, "utf8");
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

const res = await fetch(`http://${AUTHORITY}/`, { headers: { Cookie: cookieFor(AUTHORITY) } });
const body = await res.text();
console.log(`live index (${AUTHORITY}): HTTP ${res.status}, ${body.length} bytes`);

const inGraph = body.includes(PLUGIN_ID);
console.log(`  ${PLUGIN_ID.padEnd(22)} in boot graph: ${inGraph}`);
for (const id of ["dsh-mobile-rail", "dsh-opencode-go-usage"]) {
	console.log(`  ${id.padEnd(22)} in boot graph: ${body.includes(id)}`);
}

// The bundle itself must be fetched, not merely named in the graph. The
// client-modules carrier serves bundles under `/plugins`, as one combo script per
// entry plus the combined application script; only this plugin's own combo is
// interesting, so the combined one (a comma list) and the HTML-escaped duplicate
// (`&amp;`) are skipped rather than described. The `rev` query is part of the
// URL and must be kept: without it the route 404s.
const paths = [...new Set([...body.matchAll(/["'](\/plugins\/\?\?[^"']+)/gu)].map((m) => m[1]))]
	.filter((u) => !u.includes("&amp;"))
	.filter((u) => u.replace(/^\/plugins\/\?\?/u, "").split("&")[0] === `${PLUGIN_ID}/client.js`);
if (paths.length === 0) console.log("  bundle url for plugin  : NONE");
for (const url of paths) {
	const got = await fetch(`http://${AUTHORITY}${url}`, { headers: { Cookie: cookieFor(AUTHORITY) } });
	const text = await got.text();
	const declares = text.includes(PLUGIN_ID);
	console.log(`  bundle ${url} -> HTTP ${got.status}, ${text.length} bytes, declares ${PLUGIN_ID}: ${declares}`);
}

process.exitCode = inGraph && paths.length > 0 ? 0 : 1;
