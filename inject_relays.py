#!/usr/bin/env python3
"""Inject relay URLs ke database proxy_pool (contoh)."""
import os, sys, sqlite3, json

# DB URL from env
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
if not DATABASE_URL:
    # read from env file
    for line in open(os.environ.get("ENV_FILE", os.path.expanduser("~/.relay.env"))):
        line = line.strip()
        if line.startswith("DATABASE_URL="):
            DATABASE_URL = line.split("=", 1)[1].strip()
            break

if not DATABASE_URL:
    print("DATABASE_URL env required")
    sys.exit(1)

URLS_FILE = os.environ.get("RELAY_URLS_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "relay_urls.txt"))
if not os.path.exists(URLS_FILE):
    print("URLS file not found:", URLS_FILE)
    sys.exit(1)

# ── connect ───────────────────────────────────────────────────────────
if DATABASE_URL.startswith("postgres"):
    import psycopg2
    conn = psycopg2.connect(DATABASE_URL)
elif DATABASE_URL.startswith("sqlite"):
    path = DATABASE_URL.replace("sqlite:///", "")
    conn = sqlite3.connect(path)
else:
    print("Unsupported DATABASE_URL scheme")
    sys.exit(1)

cur = conn.cursor()

# pastikan tabel ada
cur.execute("""CREATE TABLE IF NOT EXISTS proxy_pool (
    url TEXT PRIMARY KEY,
    status TEXT DEFAULT 'new',
    last_check INTEGER DEFAULT 0
)""")

# inject semua URL
inserted = 0
for line in open(URLS_FILE):
    url = line.strip()
    if not url:
        continue
    try:
        cur.execute("INSERT OR IGNORE INTO proxy_pool (url) VALUES (?)", (url,))
        inserted += 1
    except Exception as e:
        print("skip", url, e)

conn.commit()
print(f"✅ {inserted} relay URLs di-inject ke proxy_pool")
