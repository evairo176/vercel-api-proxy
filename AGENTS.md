# Vercel AI Proxy

Deploy relay proxy AI ke Vercel massal — auto-detect plan, satu script (Python stdlib).

> ⚠️ **ATURAN UTAMA: TANYA DULU SEBELUM EKSEKUSI.**
> Jangan langsung jalanin script / deploy tanpa konfirmasi ke user.
> Repo ini dipakai buat hal yang punya impact (deploy massal, token API) —
> salah paham = buang waktu + resource. Pastikan kamu paham dulu.

---

## Konteks Project

- `lib/proxy-handler.ts` — seluruh logic relay (forward header `x-relay-target`)
- `api/proxy/index.ts` + `api/proxy/[...path].ts` — thin route, re-export handler
- `api/health.ts` — liveness probe (`/api/health`)
- `vercel.json` — rewrite `/` → `/api/proxy`, `/(.*)` → `/api/proxy/$1`
- `deploy_relays.py` — deploy massal + auto-detect plan (`DEPLOY_FILES` wajib sinkron dengan layout repo)
- `assign_relays.py` — assign relay URL ke provider connections
- `inject_relays.py` — inject relay ke DB (contoh)
- `tests/relay.test.mjs` — test lokal end-to-end (`bun tests/relay.test.mjs`)

**Alur normal:**
1. `export VERCEL_TOKEN="..."` (dari user)
2. `python3 deploy_relays.py` — auto-detect plan (default 100 per plan)
3. Output: `relay_urls.txt`

---

## WAJIB TANYA SEBELUM EKSEKUSI

### 1. Deploy relay
Sebelum jalanin `deploy_relays.py`, tanya dulu:
- **Berapa jumlah relay?** (default: 100 per plan — tapi tanya dulu)
- **Token Vercel udah di-set?** (`VERCEL_TOKEN`)
- **Target akun/team mana?** (personal atau team tertentu)
- **Output ke file apa?** (default `relay_urls.txt`)

JANGAN langsung deploy tanpa jawaban ini.

### 2. Assign / Inject
Sebelum jalanin `assign_relays.py` / `inject_relays.py`, tanya:
- **DB mana?** (`ENV_FILE` / `DATABASE_URL`)
- **File URL mana?** (default `relay_urls.txt`)
- **Ini production atau test?**

### 3. Perubahan kode
Kalau user minta ubah kode (proxy handler, deploy script, dll), tanya:
- **Behavior apa yang diubah?** (jelasin pemahamanmu dulu)
- **Breaking change atau gak?**
- **Perlu test dulu?** (`bun tests/relay.test.mjs` — 43 assertion, wajib ALL PASS)

---

## Konvensi Kode

- Python stdlib (urllib) — tanpa dependency tambahan
- TypeScript + @vercel/node untuk function
- Semua token/ID via env (`VERCEL_TOKEN`) — NO hardcode
- Path relatif — jalankan dari folder script
- Output URL relay ke `relay_urls.txt` (bukan stdout)

## Hard Don'ts

- ❌ Jangan langsung deploy tanpa konfirmasi jumlah + token
- ❌ Jangan hardcode `VERCEL_TOKEN` / team ID / project ID
- ❌ Jangan commit `relay_urls.txt` dengan URL production
- ❌ Jangan tambah dependency (requests, vercel CLI) — stdlib cukup
- ❌ Jangan deploy via `npx vercel` CLI — pakai API langsung (`deploy_relays.py`)
- ❌ Jangan ubah `api/proxy.ts` behavior tanpa jelasin ke user dulu

## Debug

- `python3 deploy_relays.py` tanpa token → `❌ VERCEL_TOKEN env required`
- Token invalid → `❌ Gagal deteksi plan: teams: HTTP 403 invalidToken`
- Kalau error aneh → cek dulu `VERCEL_TOKEN` valid + akun punya plan
