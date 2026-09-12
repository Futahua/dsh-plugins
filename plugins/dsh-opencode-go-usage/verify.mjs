/**
 * Self-check for dsh-opencode-go-usage.
 *
 * The service itself needs a Cordis context, so this exercises the extracted
 * `fetchUsage` path plus the pure helpers against the machine's real credential
 * store and the live gateway. Run:
 *   node .dsh/profiles/web/plugins/dsh-opencode-go-usage/verify.mjs
 */
import { readFileSync } from "node:fs";
import { DEFAULT_BASE_URL, describeFailure, fetchUsage, normalizeWindow } from "./index.js";

let failures = 0;
const check = (label, condition, detail = "") => {
	if (!condition) failures += 1;
	console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

console.log("normalizeWindow:");
check("reads percent + resetsAt", normalizeWindow("rolling", { status: "ok", percent: 26, resetsAt: "2026-09-12T11:50:42Z" })?.percent === 26);
check("labels the 5-hour window", normalizeWindow("rolling", { percent: 1 })?.label === "5-hour");
check("rejects a non-object", normalizeWindow("weekly", null) === undefined);
check("keeps an unknown status verbatim", normalizeWindow("monthly", { status: "warning", percent: 90 })?.status === "warning");
check("tolerates a missing percent", normalizeWindow("weekly", { status: "ok" })?.percent === undefined);

console.log("describeFailure:");
check(
	"names the entitlement failure",
	describeFailure(403, '{"error":{"type":"EntitlementError","message":"OpenCode Go subscription required."}}').includes("subscription required"),
);
check("names an auth failure", describeFailure(401, '{"error":{"type":"AuthError","message":"Unauthorized"}}').startsWith("OpenCode Go rejected"));
check("falls back for non-JSON", describeFailure(500, "<html>oops</html>").includes("HTTP 500"));

console.log("failure paths (no network needed):");
await fetchUsage({ baseUrl: DEFAULT_BASE_URL, apiKey: "sk-definitely-not-valid", timeoutMs: 15_000 }).then(
	() => check("a bad key is rejected", false, "unexpectedly succeeded"),
	(error) => check("a bad key is rejected", /rejected the credential|Unauthorized/iu.test(error.message), error.message.slice(0, 60)),
);

// --- live reading -------------------------------------------------------------
const credentialsYaml = readFileSync("D:/Letters/MatTroiSeConMoc/.dsh/.credentials.yaml", "utf8");
const key = /OPENCODE_GO_API_KEY:\s*(\S+)/u.exec(credentialsYaml)?.[1];
check("found OPENCODE_GO_API_KEY in the credential store", typeof key === "string");

console.log("live reading:");
if (key !== undefined) {
	try {
		const { windows } = await fetchUsage({ baseUrl: DEFAULT_BASE_URL, apiKey: key, timeoutMs: 15_000 });
		check("three windows are present", windows.length === 3, windows.map((w) => w.key).join(","));
		for (const w of windows) {
			const pct = w.percent === undefined ? "?" : `${w.percent}%`;
			const reset = w.resetsAt ? new Date(w.resetsAt).toISOString() : "no reset";
			check(`${w.label.padEnd(7)} window readable`, w.percent !== undefined, `${pct}, resets ${reset}`);
		}
	} catch (error) {
		check("live usage request succeeded", false, error.message);
	}
}

console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
