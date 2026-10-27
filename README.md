# Vercel AI Proxy — Deploy Relay Massal

```
febfrmn
****
    ***




  *
       *
     *
 *    *
*  *
       *
       *
    *
          Vercel AI Proxy · deploy relay proxy massal
          https://saweria.co/febfrmn
```

Deploy **relay proxy AI ke Vercel massal** — auto-detect plan + **PARALEL multi-worker**. Satu deploy = satu proxy.

## Fitur

- 🤖 **Auto-detect plan** — baca `/v2/teams` → billing.plan tiap team (hobby / pro_trial / pro / enterprise / personal)
- 📦 **Deploy via API langsung** — create project → disable SSO → POST `/v13/deployments` (bukan CLI `npx vercel`)
- ⚡ **PARALEL** — 3 workers default (up to N), jitter anti rate-limit, 3-5x lebih cepat dari sequential
- 🔢 **Jumlah bebas** — dari argumen / env / default per plan
- 📄 **Output `relay_urls.txt`** — 1 URL per baris

## Struktur

```
vercel-ai-proxy/
├── api/proxy/index.ts        # Route /api/proxy (satu-satunya entry function)
├── api/health.ts             # Route /api/health — liveness probe
├── lib/proxy-handler.ts      # ⭐ Seluruh logic relay
├── vercel.json               # Rewrite: /(.*) → /api/proxy?__relay_path=$1
├── tsconfig.json             # Typecheck lokal (tidak ikut deploy)
├── deploy_relays.py          # ⭐ Deploy massal + auto-detect plan
├── assign_relays.py          # Assign relay URLs ke provider connections
├── inject_relays.py          # Inject URL relay ke database
└── package.json              # Deploy single + @vercel/node
```

## Cara Kerja Proxy

`lib/proxy-handler.ts` relay universal:

- Request masuk → baca header `x-relay-target` (URL tujuan upstream)
- Path **dan** query string diteruskan utuh, body dikirim sebagai byte mentah
- Forward semua header kecuali `x-relay-target`, `host`, `connection`, `transfer-encoding`, `content-length`, `accept-encoding`
- Response: status + header aman diteruskan, body di-stream dengan backpressure
- Tambah header `x-relay-proxy: vercel` dan `x-relay-upstream-status`
- Tanpa secret — murni header-based, caller bawa auth sendiri

### Pemakaian

```bash
# Base URL relay = root deployment, path diteruskan otomatis
curl https://relay-xxxx.vercel.app/v1/chat/completions \
  -H "x-relay-target: https://api.openai.com" \
  -H "authorization: Bearer $OPENAI_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

`x-relay-path` masih didukung sebagai override eksplisit kalau path perlu dipaksa:

```bash
curl https://relay-xxxx.vercel.app/ \
  -H "x-relay-target: https://api.openai.com" \
  -H "x-relay-path: /v1/models?limit=5"
```

### Yang dijamin handler ini

| Kasus | Perilaku |
|-------|----------|
| Path + query string | Diteruskan utuh (`?limit=10&after=x` tidak hilang) |
| Body JSON / multipart | Byte mentah, tidak di-parse + stringify ulang |
| Redirect 3xx dari upstream | Diteruskan apa adanya, tidak di-follow |
| Response terkompresi | Body sudah di-decode, header `content-encoding` dibuang |
| Stream besar / SSE | `pipeline()` dengan backpressure, tidak terpotong |
| `set-cookie` multiple | Diteruskan sebagai array |
| CORS preflight | Dijawab lokal, 204 |
| `204` / `304` / `HEAD` | Tanpa body (sesuai spec) |
| Upstream mati | `502 relay_failed` |
| Upstream timeout | `504 upstream_timeout` |
| Target bukan http(s) | `400 invalid_target_protocol` |

### Environment variable (opsional)

| Env | Default | Fungsi |
|-----|---------|--------|
| `ALLOWED_ORIGINS` | `*` | Daftar origin dipisah koma untuk CORS |
| `ALLOWED_TARGET_HOSTS` | (kosong = semua) | Whitelist hostname upstream, anti open-proxy |
| `RELAY_TIMEOUT_MS` | `60000` | Batas waktu request ke upstream |

## Auto-Detect Plan

`deploy_relays.py` otomatis deteksi plan akun Vercel:

| Plan | Default relay | Catatan |
|------|--------------|---------|
| semua plan | 100 | Default seragam |

- **Tiap team** di `/v2/teams` = 1 plan (billing.plan dibaca dari detail team)
- **Tidak ada team** → personal account = 1 plan

## Deploy Massal

```bash
export VERCEL_TOKEN="<token>"

# auto-detect plan → jumlah default sesuai plan
python3 deploy_relays.py

# paksa jumlah (paralel 3 workers)
python3 deploy_relays.py 50

# custom jumlah worker
python3 deploy_relays.py 100 --workers 5

# atau via env
RELAY_COUNT=100 python3 deploy_relays.py
```

| Env | Fungsi |
|-----|--------|
| `VERCEL_TOKEN` | Token Vercel (WAJIB) |
| `RELAY_COUNT` | Jumlah relay per plan (kalau ga pakai argumen) |
| `RELAY_ALLOWED_HOSTS` | Kalau diisi (mis. `api.entrim.ai`), tiap project dapat env `ALLOWED_TARGET_HOSTS` — relay terkunci, tidak bisa dipakai sebagai open proxy |

> Catatan Vercel: `[...path].ts` catch-all **tidak** didukung di project non-framework (dianggap nama file literal, hasilnya 404). Karena itu path asli dititipkan lewat query `__relay_path` oleh rewrite.

## Multi provider (host di path)

Satu deployment bisa nembak provider apa saja. Host upstream jadi segmen path:

```
https://<relay>/<host>/v1/chat/completions                 # tanpa gerbang token
https://<relay>/<RELAY_TOKEN>/<host>/v1/chat/completions    # dengan gerbang token
```

Contoh: `https://relay-xxx.vercel.app/2676.../api.entrim.ai/v1` bisa dipakai langsung
sebagai base URL 9router / OpenAI SDK. Ganti provider = ganti segmen host, tanpa deploy ulang.

- Prioritas target: header `x-relay-target` > host di path > env `DEFAULT_TARGET`
- `RELAY_TOKEN` kalau diisi: segmen pertama wajib sama, kalau salah `401 invalid_relay_token`.
  Secret ditaruh di path (bukan query) supaya tetap aman di client yang menyambung string base URL.
- `ALLOWED_TARGET_HOSTS` mendukung `*` dan `*.example.com`
- UI builder ada di `/` (halaman statis, daftar provider disimpan di localStorage browser, tanpa server storage)

## Verifikasi deployment

```bash
# liveness
curl -s https://relay-xxxx.vercel.app/api/health
# -> {"ok":true,"service":"vercel-ai-proxy","version":2,...}

# relay end-to-end
curl -s https://relay-xxxx.vercel.app/v1/models \
  -H "x-relay-target: https://api.openai.com" \
  -H "authorization: Bearer $KEY"
```

## Typecheck lokal

```bash
bun install          # atau npm install
npm run typecheck    # tsc --noEmit
```

## Konvensi

- Python stdlib (urllib) — tanpa dependency tambahan
- TypeScript + @vercel/node untuk function
- Semua token via env — NO hardcode
- Path relatif — jalankan dari folder script
- Output URL relay ke `relay_urls.txt`

---
Dibuat oleh [febfrmn](https://github.com/febfrmn) · Traktir kopi: https://saweria.co/febfrmn
