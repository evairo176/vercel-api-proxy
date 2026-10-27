/**
 * Local end-to-end test for the relay handler.
 *
 * Emulates Vercel routing:
 *   /api/health        -> api/health.ts
 *   /api/proxy/*       -> lib/proxy-handler.ts
 *   anything else      -> rewrite to /api/proxy + original path (like vercel.json)
 */

import http from "node:http";
import zlib from "node:zlib";
import proxyHandler from "../lib/proxy-handler.ts";
import healthHandler from "../api/health.ts";

const UPSTREAM_PORT = 4399;
const RELAY_PORT = 4400;

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

// ---------- upstream echo server ----------
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);

    // simulate a gzip-ish response: body decoded by fetch, header tells client
    if (req.url.startsWith("/slow")) {
      // never responds -> exercises the TTFB timeout path
      setTimeout(() => { try { res.writeHead(200); res.end("late"); } catch {} }, 5000);
      return;
    }
    if (req.url.startsWith("/sse")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let n = 0;
      const iv = setInterval(() => {
        if (n === 5) { clearInterval(iv); res.end(); return; }
        res.write(`data: {"i":${n++}}\n\n`);
      }, 20);
      return;
    }
    if (req.url.startsWith("/redirect")) {
      res.writeHead(302, { location: "https://example.com/target" });
      res.end("moved");
      return;
    }
    if (req.url.startsWith("/big")) {
      res.writeHead(200, { "content-type": "text/plain" });
      for (let i = 0; i < 5000; i++) res.write(`chunk-${i}\n`);
      res.end();
      return;
    }
    if (req.url.startsWith("/cookie")) {
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url.startsWith("/gzip")) {
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ compressed: true })));
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gz);
      return;
    }
    if (req.url.startsWith("/nocontent")) {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        bodyLen: raw.length,
        body: raw.toString("utf8"),
      })
    );
  });
});

// ---------- relay (vercel-like) ----------
const relay = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${RELAY_PORT}`);

  const fakeReq = Object.assign(req, {
    query: {},
    cookies: {},
  });
  const fakeRes = res;

  if (url.pathname === "/api/health") {
    return healthHandler(fakeReq, fakeRes);
  }

  // mimic vercel.json: "/" -> /api/proxy ; "/(.*)" -> /api/proxy?__relay_path=$1
  const capture = url.pathname === "/" ? "" : url.pathname.replace(/^\//, "");
  const qs = new URLSearchParams(url.search);
  if (capture) qs.set("__relay_path", capture);
  req.url = `/api/proxy${qs.toString() ? "?" + qs.toString() : ""}`;
  return proxyHandler(fakeReq, fakeRes);
});

await new Promise((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));
await new Promise((r) => relay.listen(RELAY_PORT, "127.0.0.1", r));

const BASE = `http://127.0.0.1:${RELAY_PORT}`;
const TARGET = `http://127.0.0.1:${UPSTREAM_PORT}`;
const H = { "x-relay-target": TARGET };

console.log("\n=== 1. health ===");
{
  const r = await fetch(`${BASE}/api/health`);
  const j = await r.json();
  check("status 200", r.status === 200, r.status);
  check("ok=true", j.ok === true, JSON.stringify(j));
  check("cors header", r.headers.get("access-control-allow-origin") === "*");
}

console.log("\n=== 2. path + query preserved ===");
{
  const r = await fetch(`${BASE}/v1/models?limit=10&after=abc`, { headers: H });
  const j = await r.json();
  check("path forwarded", j.url === "/v1/models?limit=10&after=abc", j.url);
  check("limit kept", j.url.includes("limit=10"), j.url);
  check("after kept", j.url.includes("after=abc"), j.url);
}

console.log("\n=== 3. deep path ===");
{
  const r = await fetch(`${BASE}/v1/chat/completions`, { headers: H });
  const j = await r.json();
  check("deep path", j.url === "/v1/chat/completions", j.url);
}

console.log("\n=== 4. raw JSON body not stringified twice ===");
{
  const payload = JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] });
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { ...H, "content-type": "application/json" },
    body: payload,
  });
  const j = await r.json();
  check("byte length identical", j.bodyLen === Buffer.byteLength(payload), `${j.bodyLen} vs ${Buffer.byteLength(payload)}`);
  check("body verbatim", j.body === payload);
  check("parses as JSON", (() => { try { JSON.parse(j.body); return true; } catch { return false; } })());
}

console.log("\n=== 5. auth header forwarded, relay headers stripped ===");
{
  const r = await fetch(`${BASE}/v1/models`, {
    headers: { ...H, authorization: "Bearer sk-test-123", "x-relay-path": "" },
  });
  const j = await r.json();
  check("authorization passed", j.headers.authorization === "Bearer sk-test-123", j.headers.authorization);
  check("x-relay-target stripped", j.headers["x-relay-target"] === undefined);
  check("accept-encoding identity", j.headers["accept-encoding"] === "identity", j.headers["accept-encoding"]);
}

console.log("\n=== 6. redirect NOT followed ===");
{
  const r = await fetch(`${BASE}/redirect`, { headers: H, redirect: "manual" });
  check("302 passes through", r.status === 302, r.status);
  check("location header", r.headers.get("location") === "https://example.com/target", r.headers.get("location"));
}

console.log("\n=== 7. large stream intact ===");
{
  const r = await fetch(`${BASE}/big`, { headers: H });
  const text = await r.text();
  const lines = text.trim().split("\n");
  check("5000 chunks", lines.length === 5000, lines.length);
  check("first chunk", lines[0] === "chunk-0", lines[0]);
  check("last chunk", lines[4999] === "chunk-4999", lines[4999]);
}

console.log("\n=== 8. multiple set-cookie preserved ===");
{
  const r = await fetch(`${BASE}/cookie`, { headers: H });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  check("2 cookies", sc.length === 2, JSON.stringify(sc));
}

console.log("\n=== 9. 204 no body ===");
{
  const r = await fetch(`${BASE}/nocontent`, { headers: H });
  check("204 status", r.status === 204, r.status);
  const t = await r.text();
  check("empty body", t === "", JSON.stringify(t));
}

console.log("\n=== 10. CORS preflight ===");
{
  const r = await fetch(`${BASE}/v1/models`, {
    method: "OPTIONS",
    headers: { ...H, origin: "https://app.example.com", "access-control-request-headers": "authorization,content-type" },
  });
  check("204 preflight", r.status === 204, r.status);
  check("allow-origin", r.headers.get("access-control-allow-origin") === "*", r.headers.get("access-control-allow-origin"));
  check("allow-methods has POST", (r.headers.get("access-control-allow-methods") || "").includes("POST"));
}

console.log("\n=== 11. missing target ===");
{
  const r = await fetch(`${BASE}/v1/models`);
  const j = await r.json();
  check("400", r.status === 400, r.status);
  check("error msg", j.error === "no_target", JSON.stringify(j));
  check("cors on error", r.headers.get("access-control-allow-origin") === "*");
}

console.log("\n=== 12. bad target rejected ===");
{
  const r = await fetch(`${BASE}/v1/models`, { headers: { "x-relay-target": "file:///etc/passwd" } });
  check("400 invalid protocol", r.status === 400, r.status);
}

console.log("\n=== 13. x-relay-path override still works ===");
{
  const r = await fetch(`${BASE}/ignored`, { headers: { ...H, "x-relay-path": "/v1/embeddings?x=1" } });
  const j = await r.json();
  check("override path", j.url === "/v1/embeddings?x=1", j.url);
}

console.log("\n=== 14. upstream down -> 502 ===");
{
  const r = await fetch(`${BASE}/v1/models`, { headers: { "x-relay-target": "http://127.0.0.1:4499" } });
  const j = await r.json();
  check("502", r.status === 502, r.status);
  check("relay_failed", j.error === "relay_failed", JSON.stringify(j));
}

console.log("\n=== 15. HEAD no body ===");
{
  const r = await fetch(`${BASE}/v1/models`, { method: "HEAD", headers: H });
  check("200 status", r.status === 200, r.status);
  const t = await r.text();
  check("empty body", t === "", JSON.stringify(t));
}

console.log("\n=== 16. compressed upstream -> header stripped, body readable ===");
{
  const r = await fetch(`${BASE}/gzip`, { headers: H });
  const ce = r.headers.get("content-encoding");
  check("content-encoding stripped", ce === null, ce);
  const j = await r.json();
  check("body decompressed ok", j.compressed === true, JSON.stringify(j));
}

console.log("\n=== 17. SSE streaming arrives incrementally ===");
{
  const r = await fetch(`${BASE}/sse`, { headers: H });
  check("200", r.status === 200, r.status);
  check("event-stream type", (r.headers.get("content-type") || "").includes("text/event-stream"));
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let got = "";
  let firstAt = 0;
  const start = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!firstAt) firstAt = Date.now() - start;
    got += dec.decode(value, { stream: true });
  }
  check("5 events", (got.match(/^data: /gm) || []).length === 5, got.length);
  check("first event early (~20ms, not buffered)", firstAt > 0 && firstAt < 2000, `${firstAt}ms`);
}

console.log("\n=== 18. TTFB timeout -> 504 ===");
{
  const prev = process.env.RELAY_TIMEOUT_MS;
  process.env.RELAY_TIMEOUT_MS = "300";
  const t0 = Date.now();
  const r = await fetch(`${BASE}/slow`, { headers: H });
  const elapsed = Date.now() - t0;
  const j = await r.json();
  if (prev === undefined) delete process.env.RELAY_TIMEOUT_MS;
  else process.env.RELAY_TIMEOUT_MS = prev;
  check("504 status", r.status === 504, r.status);
  check("error upstream_timeout", j.error === "upstream_timeout", JSON.stringify(j));
  check("timed out fast (<2s)", elapsed < 2000, `${elapsed}ms`);
}

console.log("\n=== 19. multi-provider path routing (host in path, no header) ===");
{
  process.env.RELAY_PATH_SCHEME = "http";
  const r = await fetch(`${BASE}/127.0.0.1:${UPSTREAM_PORT}/v1/models`);
  const j = await r.json();
  check("200 without x-relay-target", r.status === 200, r.status);
  check("upstream path rebuilt", j.url === "/v1/models", j.url);
}

console.log("\n=== 20. RELAY_TOKEN path gate ===");
{
  process.env.RELAY_TOKEN = "sekret";
  const bad = await fetch(`${BASE}/salah/127.0.0.1:${UPSTREAM_PORT}/v1/models`);
  check("wrong token 401", bad.status === 401, bad.status);
  check("error invalid_relay_token", (await bad.json()).error === "invalid_relay_token");

  const ok = await fetch(`${BASE}/sekret/127.0.0.1:${UPSTREAM_PORT}/v1/models?limit=7`);
  const j = await ok.json();
  check("right token 200", ok.status === 200, ok.status);
  check("path + query intact", j.url === "/v1/models?limit=7", j.url);
  process.env.RELAY_TOKEN = "";
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);

upstream.close();
relay.close();
process.exit(failures === 0 ? 0 : 1);
