/**
 * Shared configuration for the verification scripts.
 *
 * Everything is environment-overridable so the same scripts work against any
 * DSH install and any host:
 *
 *   DSH_AUTHORITY   host:port serving the Web GUI   (default: this machine's tailnet name)
 *   DSH_HOST_MATCH  substring used to find the GUI tab in Chrome DevTools
 *   DSH_HOME        Harness home directory
 *   DSH_PLUGIN_DIR  where these plugin directories are installed
 *   CDP_PORT        local port forwarded to the phone's Chrome DevTools socket
 */

const HOME = process.env.DSH_HOME ?? 'D:\\Letters\\MatTroiSeConMoc\\.dsh'

/** The authority the Web GUI is reached on. Set DSH_AUTHORITY for another host. */
const AUTHORITY = process.env.DSH_AUTHORITY ?? 'sloptop.taild88607.ts.net:3080'

/** Substring that identifies the GUI tab among Chrome's DevTools targets. */
const HOST_MATCH = process.env.DSH_HOST_MATCH ?? 'sloptop'

/** Harness home; holds settings.yaml and .credentials.yaml. */
const DSH_HOME = HOME

/** Where plugin directories live for the web profile. */
const PLUGIN_DIR = process.env.DSH_PLUGIN_DIR ?? `${HOME}\\profiles\\web\\plugins`

/** Local port forwarded to the phone's `chrome_devtools_remote` socket. */
const CDP_PORT = Number(process.env.CDP_PORT ?? 9444)

/** Trusted-host flag value the layout fence needs; must match Serve exactly. */
const TRUSTED_HOST = process.env.DSH_TRUSTED_HOST ?? AUTHORITY

export { AUTHORITY, HOST_MATCH, DSH_HOME, PLUGIN_DIR, CDP_PORT, TRUSTED_HOST }

/** Absolute URL of the GUI. */
export const BASE_URL = `http://${AUTHORITY}`
