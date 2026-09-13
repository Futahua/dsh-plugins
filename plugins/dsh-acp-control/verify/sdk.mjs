/**
 * Locate and import the official ACP SDK.
 *
 * The checks drive this server with the reference client. That client lives in
 * the DSH profile's `node_modules` on this machine, so the path is resolved the
 * same way the harness launcher resolves `dsh`: from `DSH_HOME`, with an
 * override for anywhere else.
 *
 * The SDK is a **verification** dependency only. The server itself imports
 * nothing outside `node:` and the Cordis/Schemastery peers every plugin in this
 * repository already uses (DESIGN.md §8).
 *
 * @module dsh-acp-control/verify/sdk
 */

import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Candidate locations, most specific first. */
function candidates() {
	const out = [];
	if (process.env.ACP_SDK !== undefined) out.push(resolve(process.env.ACP_SDK));
	const homes = [process.env.DSH_HOME, "D:/Letters/MatTroiSeConMoc/.dsh", join(process.env.USERPROFILE ?? "", ".dsh")].filter(
		(home) => typeof home === "string" && home.length > 0,
	);
	for (const home of homes) {
		out.push(resolve(home, "profiles/node_modules/@agentclientprotocol/sdk/dist/acp.js"));
		out.push(resolve(home, "profiles/web/node_modules/@agentclientprotocol/sdk/dist/acp.js"));
	}
	return out;
}

/**
 * Import the SDK, or explain precisely what to set.
 * @returns {Promise<{sdk: object, path: string}>} the module and where it came from.
 */
export async function loadSdk() {
	const tried = [];
	for (const path of candidates()) {
		try {
			await access(path);
		} catch {
			tried.push(path);
			continue;
		}
		const sdk = await import(pathToFileURL(path).href);
		return { sdk, path };
	}
	throw new Error(
		`could not find @agentclientprotocol/sdk. Set ACP_SDK to its dist/acp.js path.\nTried:\n  ${tried.join("\n  ")}`,
	);
}
