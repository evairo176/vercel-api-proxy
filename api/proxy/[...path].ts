/**
 * Route: /api/proxy/[...path]
 *
 * Catch-all used by the vercel.json rewrite ("/(.*)" -> "/api/proxy/$1").
 * Keeping the original segments in the real path means the request path AND
 * query string survive the rewrite, so the relay behaves like a normal base
 * URL instead of demanding an x-relay-path header for every call.
 */

export { default, config } from "../../lib/proxy-handler";
