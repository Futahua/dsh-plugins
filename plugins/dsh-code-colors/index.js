/**
 * Host half of dsh-code-colors.
 *
 * All of the behaviour lives in `lib/client.js`: the client-modules scanner only
 * discovers client bundles through a loader row (`dsh-client-modules/lib/index.js`
 * walks `ctx.loader.entries()`), so this package needs a host entry to exist at
 * all — but it registers no service, route, or hook.
 *
 * @module dsh-code-colors
 */

/** Stable Cordis plugin name. */
const name = "dsh-code-colors";

/** No services required: the client bundle owns the whole behaviour. */
const inject = [];

/** Present so the row is a valid loader entry; intentionally does nothing. */
function apply() {}

export { apply, inject, name };
export default { apply, inject, name };
