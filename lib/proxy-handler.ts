/**
 * Vercel AI relay proxy — transparent header-driven forwarder.
 *
 * Contract
 * --------
 *   x-relay-target : absolute upstream base URL (e.g. https://api.openai.com/v1)
 *   x-relay-path   : optional subpath (+ query) appended to the base
 *                    falls back to the rewritten request path
 *
 * Everything else (headers, query string, raw body bytes, status, response
 * headers, streamed body) is forwarded verbatim. No secrets are stored here:
 * the caller brings its own auth header.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const config = {
  api: {
    // Raw byte passthrough: we forward the body untouched instead of letting
    // Vercel parse it (JSON.parse + re-stringify corrupts multipart and
    // double-encodes JSON strings).
    bodyParser: false,
    responseLimit: false,
  },
  maxDuration: 60,
};

/** Headers that must never be copied from the client request to upstream. */
const STRIP_REQUEST_HEADERS = new Set([
  "x-relay-target",
  "x-relay-path",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "content-length", // recomputed by fetch from the raw buffer
  "accept-encoding", // we force identity + strip encoding downstream
]);

/** Headers that must never be copied from the upstream response to the client. */
const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  // Node's fetch already decompressed the body, so a forwarded
  // content-encoding would make the client try to gunzip plain bytes.
  "content-encoding",
  "content-length", // no longer matches the decoded body
]);

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD", "OPTIONS"]);

function parseList(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildCorsHeaders(
  req: VercelRequest,
  allowListRaw: string
): Record<string, string> {
  const allowList = parseList(allowListRaw);
  const allowAny = allowList.length === 0 || allowList.includes("*");
  const requestOrigin =
    typeof req.headers.origin === "string" ? req.headers.origin : "";

  let allowOrigin = "*";
  const extra: Record<string, string> = {};

  if (!allowAny) {
    if (requestOrigin && allowList.includes(requestOrigin)) {
      allowOrigin = requestOrigin;
      extra["vary"] = "Origin";
    } else if (!requestOrigin) {
      allowOrigin = allowList[0];
    } else {
      // Origin not allowed: keep the tightest value, browser blocks it.
      allowOrigin = allowList[0];
      extra["vary"] = "Origin";
    }
  }

  const requestedHeaders =
    typeof req.headers["access-control-request-headers"] === "string"
      ? req.headers["access-control-request-headers"]
      : "authorization,content-type,x-relay-target,x-relay-path,x-request-id,accept";

  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS",
    "access-control-allow-headers": requestedHeaders,
    "access-control-expose-headers":
      "x-relay-proxy,x-relay-upstream-status,content-type,content-length",
    "access-control-max-age": "86400",
    ...extra,
  };
}

function applyHeaders(
  res: VercelResponse,
  headers: Record<string, string>
): void {
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}

function sendJson(
  res: VercelResponse,
  status: number,
  payload: Record<string, unknown>,
  cors: Record<string, string>
): void {
  applyHeaders(res, cors);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.statusCode = status;
  res.end(JSON.stringify(payload));
}

function methodHasBody(method: string): boolean {
  return !METHODS_WITHOUT_BODY.has(method);
}

async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as unknown as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Strip a leading slash run so concatenation is predictable. */
function trimSlashes(value: string): string {
  return value.replace(/^\/+/, "");
}

/**
 * Rebuild the upstream subpath from (in priority order):
 *   1. x-relay-path header — explicit override, wins over everything
 *   2. ?__relay_path= capture injected by the vercel.json rewrite
 *      (Vercel does not support [...slug].ts catch-all outside Next.js, so the
 *      rewrite parks the original path in a query param instead)
 *   3. the real request pathname with the /api/proxy prefix removed
 *
 * Real query params are always merged back in, so ?limit=10 survives.
 */
function resolveSubpath(
  req: VercelRequest,
  pathname: string,
  searchParams: URLSearchParams
): { path: string; query: string } {
  const headerPath =
    typeof req.headers["x-relay-path"] === "string"
      ? req.headers["x-relay-path"].trim()
      : "";

  const rewritten =
    typeof searchParams.get("__relay_path") === "string"
      ? (searchParams.get("__relay_path") as string)
      : "";

  let subpath = headerPath || rewritten;
  if (!subpath) {
    subpath = pathname.startsWith("/api/proxy")
      ? pathname.slice("/api/proxy".length)
      : pathname;
  }

  // The header/path may itself embed a query string: split it out and merge.
  let subpathQuery = "";
  const qIndex = subpath.indexOf("?");
  if (qIndex !== -1) {
    subpathQuery = subpath.slice(qIndex + 1);
    subpath = subpath.slice(0, qIndex);
  }

  const merged = new URLSearchParams(subpathQuery);
  for (const [key, value] of searchParams.entries()) {
    if (key === "__relay_path") continue;
    merged.append(key, value);
  }

  return { path: trimSlashes(subpath), query: merged.toString() };
}

function isAllowedHost(url: URL): boolean {
  const allowList = parseList(process.env.ALLOWED_TARGET_HOSTS);
  if (allowList.length === 0) return true;
  return allowList.includes(url.hostname) || allowList.includes(url.host);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const cors = buildCorsHeaders(req, process.env.ALLOWED_ORIGINS || "*");
  const method = (req.method || "GET").toUpperCase();

  // 1. CORS preflight — answered locally, never reaches upstream.
  if (method === "OPTIONS") {
    applyHeaders(res, cors);
    res.statusCode = 204;
    res.end();
    return;
  }

  // 2. Target base URL (no open-proxy: must be absolute http/https).
  const rawTarget =
    typeof req.headers["x-relay-target"] === "string"
      ? req.headers["x-relay-target"].trim()
      : "";

  if (!rawTarget) {
    sendJson(res, 400, { error: "x-relay-target header required" }, cors);
    return;
  }

  let targetBase: URL;
  try {
    targetBase = new URL(rawTarget);
  } catch {
    sendJson(res, 400, { error: "invalid_target", detail: rawTarget }, cors);
    return;
  }

  if (targetBase.protocol !== "http:" && targetBase.protocol !== "https:") {
    sendJson(res, 400, { error: "invalid_target_protocol" }, cors);
    return;
  }

  if (!isAllowedHost(targetBase)) {
    sendJson(res, 403, { error: "target_host_not_allowed" }, cors);
    return;
  }

  // 3. Build the upstream URL — path AND query preserved.
  const parsed = new URL(req.url || "/", "http://relay.local");
  const { path: subpath, query } = resolveSubpath(
    req,
    parsed.pathname,
    parsed.searchParams
  );

  const base = targetBase.toString().replace(/\/+$/, "");
  const upstreamUrl = `${base}${subpath ? `/${subpath}` : ""}${
    query ? `?${query}` : ""
  }`;

  // 4. Forward client headers, minus hop-by-hop / relay-internal ones.
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(lower)) continue;
    if (Array.isArray(value)) headers.set(lower, value.join(", "));
    else headers.set(lower, value);
  }
  // Ask for plain bytes: we strip content-encoding on the way back anyway.
  headers.set("accept-encoding", "identity");

  // 5. Raw body passthrough (never JSON.parse/stringify).
  let body: Buffer | undefined;
  if (methodHasBody(method)) {
    try {
      const raw = await readRawBody(req);
      body = raw.length > 0 ? raw : undefined;
    } catch (err) {
      sendJson(
        res,
        400,
        {
          error: "body_read_failed",
          detail: String((err as Error)?.message || err),
        },
        cors
      );
      return;
    }
  }

  // 6. Call upstream. redirect:"manual" so 3xx reaches the client intact.
  //
  // The timeout only guards time-to-first-byte (connect + headers). Arming it
  // for the whole request would kill long SSE / streaming completions, so we
  // clear it as soon as headers arrive and let platform maxDuration cap the
  // body phase.
  const timeoutMs = Number(process.env.RELAY_TIMEOUT_MS || 60_000);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const isTimeout =
      timedOut ||
      (err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError"));
    sendJson(
      res,
      isTimeout ? 504 : 502,
      {
        error: isTimeout ? "upstream_timeout" : "relay_failed",
        detail: String((err as Error)?.message || err),
      },
      cors
    );
    return;
  }
  clearTimeout(timer);

  // 7. Mirror status + safe response headers (CORS wins over upstream's).
  res.statusCode = upstream.status;

  for (const [key, value] of upstream.headers.entries()) {
    const lower = key.toLowerCase();
    if (STRIP_RESPONSE_HEADERS.has(lower)) continue;
    if (lower.startsWith("access-control-")) continue; // ours wins
    if (lower === "set-cookie") continue; // handled below, needs array form
    res.setHeader(key, value);
  }

  const setCookies =
    typeof (upstream.headers as unknown as { getSetCookie?: () => string[] })
      .getSetCookie === "function"
      ? (
          upstream.headers as unknown as { getSetCookie: () => string[] }
        ).getSetCookie()
      : [];
  if (setCookies.length > 0) res.setHeader("set-cookie", setCookies);

  applyHeaders(res, cors);
  res.setHeader("x-relay-proxy", "vercel");
  res.setHeader("x-relay-upstream-status", String(upstream.status));

  // 8. Stream the body with real backpressure. 204/304 have no body.
  const noBodyStatus = [204, 304].includes(upstream.status);
  if (!upstream.body || noBodyStatus || method === "HEAD") {
    res.end();
    return;
  }

  try {
    await pipeline(
      Readable.fromWeb(upstream.body as unknown as Parameters<
        typeof Readable.fromWeb
      >[0]),
      res
    );
  } catch (err) {
    // Client disconnects mid-stream land here; nothing left to do but close.
    const message = String((err as Error)?.message || err);
    if (!/premature close|aborted|ECONNRESET/i.test(message)) {
      console.error("relay stream error:", message);
    }
    if (!res.writableEnded) res.end();
  }
}
