/**
 * Health endpoint — deployment liveness probe.
 *
 * Lives at /api/health. Vercel checks the filesystem before applying
 * vercel.json rewrites, so this static route wins over the catch-all.
 * No upstream call, no secrets, no body parsing.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

export const config = {
  api: { bodyParser: false },
};

export default function handler(req: VercelRequest, res: VercelResponse) {
  const allowList = (process.env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowAny = allowList.length === 0 || allowList.includes("*");
  const origin =
    typeof req.headers.origin === "string" ? req.headers.origin : "";

  res.setHeader(
    "access-control-allow-origin",
    allowAny ? "*" : origin && allowList.includes(origin) ? origin : allowList[0]
  );
  res.setHeader("access-control-allow-methods", "GET,HEAD,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (!allowAny) res.setHeader("vary", "Origin");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.statusCode = 200;
  res.end(
    JSON.stringify({
      ok: true,
      service: "vercel-ai-proxy",
      version: 2,
      uptime: Math.round(process.uptime()),
      time: new Date().toISOString(),
    })
  );
}
