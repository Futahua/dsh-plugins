// Put this plugin on the profile's module path.
//
// The profile resolves a loader row's `name` through `profiles/web/node_modules`,
// which is pnpm-managed; each of the other user plugins is a junction there into
// its own directory under `plugins/`. This recreates that junction for
// dsh-chat-backdrop. It is idempotent and needs no network.
//
// Run it after a `pnpm install` in the profile: pnpm prunes node_modules entries
// it does not find in package.json.
//
//   node install-link.mjs
import { existsSync, lstatSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NAME = "dsh-chat-backdrop";
const PROFILE = resolve(HERE, "..", "..");
const TARGET = HERE;
const LINK = join(PROFILE, "node_modules", NAME);

if (!existsSync(join(PROFILE, "package.json"))) {
	console.error(`not a dsh profile: ${PROFILE} has no package.json`);
	process.exit(1);
}

if (existsSync(LINK)) {
	const stat = lstatSync(LINK);
	if (stat.isSymbolicLink() && resolve(dirname(LINK), readlinkSync(LINK)) === resolve(TARGET)) {
		console.log(`already linked: ${LINK} -> ${TARGET}`);
		process.exit(0);
	}
	console.error(`${LINK} exists and is not this plugin's link (${stat.isSymbolicLink() ? readlinkSync(LINK) : "a real entry"}); leaving it alone`);
	process.exit(1);
}

symlinkSync(TARGET, LINK, "junction");
console.log(`linked: ${LINK} -> ${TARGET}`);
