#!/usr/bin/env python3
"""Assign Vercel relay URLs ke provider connections (1:1 round-robin).

Reads relay_urls.txt, updates provider_connections.data->>'vercelRelayUrl'.
Usage: python3 assign_relays.py
"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
URLS_FILE = ROOT / "relay_urls.txt"

def dsn() -> str:
    env = Path(os.environ.get("ENV_FILE", str(ROOT.parent / ".relay.env")))
    for line in env.read_text(errors="replace").splitlines():
        line = line.strip()
        if line.startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("DATABASE_URL not found")

def main() -> int:
    urls = [u.strip() for u in URLS_FILE.read_text().splitlines() if u.strip()]
    if not urls:
        print("no urls in relay_urls.txt")
        return 1

    import psycopg2
    conn = psycopg2.connect(dsn())
    conn.autocommit = True
    cur = conn.cursor()

    cur.execute(
        "SELECT id, data FROM provider_connections WHERE provider = 'relay' AND is_active = TRUE ORDER BY name"
    )
    rows = cur.fetchall()
    if not rows:
        print("no active relay connections")
        return 1

    updated = 0
    for i, (cid, raw) in enumerate(rows):
        data = json.loads(raw) if isinstance(raw, str) else (raw or {})
        url = urls[i % len(urls)]
        data["vercelRelayUrl"] = url
        cur.execute(
            "UPDATE provider_connections SET data = %s, updated_at = NOW() WHERE id = %s",
            (json.dumps(data), cid),
        )
        updated += 1

    print(f"assigned {updated} connections (urls={len(urls)})")
    conn.close()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
