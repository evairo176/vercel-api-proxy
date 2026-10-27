import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const target = (req.headers["x-relay-target"] as string) || "";
  const path = (req.headers["x-relay-path"] as string) || (req.url || "").split("?").shift() || "/";
  if (!target) {
    res.status(400).json({ error: "x-relay-target header required" });
    return;
  }

  const url = target.replace(/\/+$/, "") + path;

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (["x-relay-target", "x-relay-path", "host", "content-length", "accept-encoding"].includes(k.toLowerCase())) continue;
    if (Array.isArray(v)) {
      headers[k] = v.join(", ");
    } else if (typeof v === "string") {
      headers[k] = v;
    }
  }
  headers["accept-encoding"] = "identity";

  try {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body);
    const upstream = await fetch(url, {
      method: req.method || "POST",
      headers,
      body,
      redirect: "follow",
    });

    for (const [k, v] of upstream.headers.entries()) {
      if (k.toLowerCase() === "content-length") continue;
      res.setHeader(k, v);
    }
    res.setHeader("x-relay-proxy", "vercel");
    res.status(upstream.status);

    if (upstream.body) {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (e: any) {
    res.status(502).json({ error: "relay_failed", detail: String(e?.message || e) });
  }
}

export const config = {
  // maxDuration omitted — Vercel Hobby caps at 60s anyway, letting platform decide
};
