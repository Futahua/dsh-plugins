// Embed the backdrop PNG as a data URI into lib/client.js.
// A client bundle cannot reach package files, so the picture travels inside
// the script. Idempotent: skips work when the placeholder is already gone.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PNG = join(HERE, "assets", "backdrop.png");
const CLIENT = join(HERE, "lib", "client.js");
const PLACEHOLDER = "__BACKDROP_DATA_URI__";

const src = readFileSync(CLIENT, "utf8");
if (!src.includes(PLACEHOLDER)) {
	console.log("already embedded; nothing to do");
	process.exit(0);
}
const uri = "data:image/png;base64," + readFileSync(PNG).toString("base64");
writeFileSync(CLIENT, src.replaceAll(PLACEHOLDER, uri));
console.log(`embedded ${(uri.length / 1024).toFixed(0)}KB data URI`);
