/**
 * Make the phone reachable over ADB, wirelessly, and confirm the DevTools forward.
 *
 * The whole point of this script is that the phone is usually across the room. Once
 * Android's Wireless debugging has been switched on and this computer has paired with
 * it (both are on the phone's screen, once), ADB reconnects by itself over mDNS every
 * time both machines are on the same network — but "by itself" is doing a lot of work
 * in that sentence, and when it does not, the failure looks like a dead phone rather
 * than a missing connection. So this reports each step instead of assuming.
 *
 *   node connect-phone.mjs            # connect if needed, then forward + verify
 *   node connect-phone.mjs --status   # report only, change nothing
 *
 * Environment:
 *   ADB             path to adb (default: the Windows SDK path, else `adb` on PATH)
 *   DSH_CDP_PORT    local port for the DevTools forward (default 9444)
 *
 * First-time pairing cannot be automated: Android shows a six-digit code that only a
 * human can read. When this script finds no device it prints exactly what to tap.
 */
import { execFileSync } from "node:child_process";

const ADB = process.env.ADB ?? "D:\\Programs\\AndroidSDK\\platform-tools\\adb.exe";
const PORT = Number(process.env.DSH_CDP_PORT ?? process.env.CDP_PORT ?? 9444);
const STATUS_ONLY = process.argv.includes("--status");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run adb, returning stdout whether it succeeded or not. */
function adb(...args) {
	try {
		return execFileSync(ADB, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch (error) {
		// adb exits non-zero for plenty of ordinary situations (no devices, no forward).
		return `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
	}
}

/** The serial of an attached device, USB or wireless, or null. */
function attachedSerial() {
	for (const line of adb("devices").split("\n").slice(1)) {
		const [serial, state] = line.trim().split(/\s+/u);
		if (serial !== undefined && serial !== "" && state === "device") return serial;
	}
	return null;
}

console.log(`adb: ${ADB}`);
console.log(adb("version").split("\n")[0]);

let serial = attachedSerial();
if (serial === null && !STATUS_ONLY) {
	// ADB reconnects to a paired device over mDNS on its own, but not instantly: give it
	// a few seconds before treating the phone as absent.
	//
	// Polling `adb devices` rather than `adb wait-for-device`: the latter never exits
	// while nothing is connected, so bounding it means killing the process — and
	// `execFileSync` *throws* when it kills a child on timeout, which crashed this
	// script the first time the phone happened to be asleep.
	process.stdout.write("no device yet; waiting for mDNS auto-connect ");
	for (let i = 0; i < 20 && serial === null; i++) {
		process.stdout.write(".");
		await sleep(500);
		serial = attachedSerial();
	}
	console.log("");
}

if (serial === null && !STATUS_ONLY) {
	// Wireless debugging advertises itself; if the device is paired, connecting is one
	// command. The list is often empty on Windows, so this is a best effort.
	const services = adb("mdns", "services")
		.split("\n")
		.map((line) => line.trim().split(/\s+/u))
		.filter((parts) => parts[1] === "_adb-tls-connect._tcp");
	for (const [name, , endpoint] of services) {
		console.log(`trying ${name} at ${endpoint}`);
		console.log("  " + adb("connect", endpoint));
		serial = attachedSerial();
		if (serial !== null) break;
	}
}

if (serial === null) {
	console.log(`
No device. On the phone:

  1. Settings -> Developer options -> Wireless debugging -> ON.
  2. Put the phone on the same Wi-Fi as this computer (mDNS does not cross networks,
     and it does not cross Tailscale).
  3. If this computer has never paired with it: tap "Pair device with pairing code",
     then run   adb pair <ip>:<pair-port> <six-digit code>   and rerun this script.

After pairing once, ADB reconnects on its own whenever both are on that network.`);
	process.exit(STATUS_ONLY ? 0 : 1);
}

console.log(`device: ${serial}`);

if (STATUS_ONLY) {
	console.log(adb("forward", "--list") || "no forwards");
	process.exit(0);
}

// The forward dies with the transport, so it is re-asserted on every connect rather
// than assumed to survive. The CDP socket it targets is Chrome's DevTools endpoint.
adb("forward", `tcp:${PORT}`, "localabstract:chrome_devtools_remote");
console.log(`forward: ${adb("forward", "--list")}`);

// Wake the phone before anything is measured on it.
//
// A sleeping phone makes a bad test rig, and the failures are silent and misleading:
// measured, a run that began with the screen off failed section 2 completely -- the
// band tap "did nothing" -- because the app had auto-focused the composer and the
// on-screen keyboard was up, and the band stands down under the keyboard on purpose.
// `Page.captureScreenshot` also returns nothing while the page is not being composited,
// which killed the run outright rather than reporting it.
const woke = adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
adb("shell", "wm", "dismiss-keyguard");
console.log(`woke the screen${woke ? `: ${woke}` : ""}`);

/**
 * Is Chrome actually the app in front?
 *
 * It has to be, and this is not a formality: a backgrounded Chrome on Android does not
 * composite its pages, and touch events dispatched over DevTools are then delivered
 * nowhere. Measured, with the phone in someone's hand and another app in front: a real
 * touch at x=10 produced no `pointerdown` at all — not even on `window` capture — while
 * every page query kept answering normally, so a whole run reported fifteen failures that
 * were all this one fact. Bringing Chrome forward is the user's call, not this script's,
 * so it says what it found and leaves it alone.
 */
const focus = adb("shell", "dumpsys", "window");
const focused = /mCurrentFocus=Window\{[^}]*\s([^\s}]+)/.exec(focus)?.[1] ?? null;
const chromeInFront = focused !== null && /chrome/i.test(focused);
if (chromeInFront) {
	console.log(`foreground app: ${focused} (Chrome is in front)`);
} else {
	console.log(`foreground app: ${focused ?? "unknown"} — NOT Chrome`);
	console.log(`
  Chrome must be the app in front on the phone for a device run. A backgrounded Chrome
  does not composite its pages, and DevTools touch events are delivered nowhere: the
  page still answers every query, so the run fails everywhere for one invisible reason.
  Open Chrome on the phone (the DeepSeek Harness tab), leave the screen on, and rerun.`);
}

try {
	const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
	console.log(`Chrome: ${version.Browser} — DevTools reachable on 127.0.0.1:${PORT}`);
	console.log(
		chromeInFront
			? "\nReady: verify-phone.mjs can drive this phone now."
			: "\nDevTools is reachable, but bring Chrome to the front before a device run.",
	);
} catch (error) {
	console.log(`DevTools NOT reachable on 127.0.0.1:${PORT}: ${error.message}`);
	console.log("Open Chrome on the phone at least once, then rerun.");
	process.exit(1);
}
