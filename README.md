# Vercel AI Proxy — Deploy Relay Massal

```
febfrmn
****   
    ***
       
       
  *    
       
     * 
 *    *
*  *   
       
       
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
├── api/proxy.ts         # Relay proxy (Vercel Serverless Function)
├── vercel.json          # Rewrite semua request → /api/proxy
├── deploy_relays.py     # ⭐ Deploy massal + auto-detect plan
├── assign_relays.py     # Assign relay URLs ke provider connections
├── inject_relays.py     # Inject URL relay ke database (contoh)
├── package.json         # Deploy single + @vercel/node
```

## Cara Kerja Proxy

`api/proxy.ts` relay universal:
- Request masuk → baca header `x-relay-target` (URL tujuan) + `x-relay-path` (opsional)
- Forward semua header kecuali `x-relay-target`, `host`, `content-length`, `accept-encoding`
- Stream response balik, tambah header `x-relay-proxy: vercel`
- Tanpa secret — murni header-based

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

## Konvensi

- Python stdlib (urllib) — tanpa dependency tambahan
- TypeScript + @vercel/node untuk function
- Semua token via env — NO hardcode
- Path relatif — jalankan dari folder script
- Output URL relay ke `relay_urls.txt`

---
Dibuat oleh [febfrmn](https://github.com/febfrmn) · Traktir kopi: https://saweria.co/febfrmn