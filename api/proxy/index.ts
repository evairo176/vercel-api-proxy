/**
 * Route: /api/proxy
 *
 * Thin wrapper — the whole relay lives in lib/proxy-handler.ts so both the
 * bare /api/proxy route and the /api/proxy/[...path] catch-all share one
 * implementation.
 */

export { default, config } from "../../lib/proxy-handler";
