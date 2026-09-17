/**
 * Host half of dsh-browser-tweaks.
 *
 * All of the behaviour lives in the profile config override (`cordis.patch.yml`
 * points the shipped pane's stealth mode at the shortcut profile) and in
 * `lib/client.js` (which hides the "My Chrome" mode button): the client-modules
 * scanner only discovers client bundles through a loader row
 * (`dsh-client-modules/lib/index.js` walks `ctx.loader.entries()`), so this
 * package needs a host entry to exist at all — but it registers no service,
 * route, or hook.
 *
 * @module dsh-browser-tweaks
 */

/** Stable Cordis plugin name. */
const name = "dsh-browser-tweaks";

/** No services required: config plus the client bundle own the whole behaviour. */
const inject = [];

/** Present so the row is a valid loader entry; intentionally does nothing. */
function apply() {}

export { apply, inject, name };
export default { apply, inject, name };
