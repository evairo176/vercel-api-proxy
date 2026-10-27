import type { VercelRequest, VercelResponse } from "@vercel/node";

const PAGE = `<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Relay - Provider Builder</title>
<style>
:root{--bg:#0b0d10;--card:#14181d;--line:#232a32;--fg:#e6edf3;--dim:#8b98a5;--acc:#3fd0c9;--warn:#f2b544}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:28px 18px 60px}
h1{font-size:20px;margin:0 0 4px} h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:26px 0 10px}
p.sub{color:var(--dim);margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
label{display:block;font-size:12px;color:var(--dim);margin:10px 0 4px}
input,select{width:100%;background:#0e1216;border:1px solid var(--line);color:var(--fg);border-radius:7px;padding:9px 10px;font:13px ui-monospace,monospace}
input:focus,select:focus{outline:none;border-color:var(--acc)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:640px){.row{grid-template-columns:1fr}}
button{background:var(--acc);color:#06231f;border:0;border-radius:7px;padding:9px 14px;font-weight:600;cursor:pointer}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line);font-weight:500}
button:active{transform:translateY(1px)}
pre{background:#0e1216;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font:12px/1.5 ui-monospace,monospace;margin:8px 0 0;white-space:pre-wrap;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
td.mono{font:12px ui-monospace,monospace;word-break:break-all;color:var(--acc)}
.tag{display:inline-block;font-size:11px;padding:2px 7px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
.ok{color:#4ade80}.bad{color:#f87171}
.hint{color:var(--dim);font-size:12px;margin-top:8px}
</style></head><body><div class="wrap">
<h1>AI Relay - Provider Builder</h1>
<p class="sub">Satu deployment buat banyak provider AI. Host upstream ditaruh di path, jadi nambah provider cuma ganti base URL. Gak perlu redeploy.</p>

<div class="card">
  <div class="row">
    <div><label>Relay host</label><input id="host" placeholder="relay-xxx.vercel.app"></div>
    <div><label>Relay token (path secret)</label><input id="token" placeholder="token dari env RELAY_TOKEN"></div>
  </div>
  <div class="row">
    <div><label>Provider</label><select id="preset"></select></div>
    <div><label>Upstream host</label><input id="upstream" placeholder="api.openai.com"></div>
  </div>
  <label>Label (buat daftar lo)</label><input id="label" placeholder="my-openai">
  <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
    <button id="add">Tambah ke daftar</button>
    <button class="ghost" id="copyBase">Copy base URL</button>
  </div>
  <div class="hint" id="preview"></div>
</div>

<h2>Base URL</h2>
<pre id="base">-</pre>

<h2>Contoh pakai</h2>
<pre id="snippet">-</pre>

<h2>Daftar provider lo</h2>
<table><thead><tr><th>Label</th><th>Base URL</th><th></th></tr></thead><tbody id="rows"></tbody></table>
<p class="hint">Disimpan di localStorage browser ini. Tidak ada data yang dikirim ke server.</p>
</div>
<script>
const PRESETS = [
  ["Entrim","api.entrim.ai"],["xAI","api.x.ai"],["OpenAI","api.openai.com"],
  ["Anthropic (OpenAI-compat)","api.anthropic.com"],["DeepSeek","api.deepseek.com"],
  ["Groq","api.groq.com"],["OpenRouter","openrouter.ai"],["Together","api.together.xyz"],
  ["Mistral","api.mistral.ai"],["Fireworks","api.fireworks.ai"],
  ["Moonshot","api.moonshot.ai"],["Zhipu","open.bigmodel.cn"],["Custom",""]
];
const $ = (id) => document.getElementById(id);
const store = {
  get: () => { try { return JSON.parse(localStorage.getItem("relay.providers") || "[]"); } catch { return []; } },
  set: (v) => localStorage.setItem("relay.providers", JSON.stringify(v)),
};

$("host").value = localStorage.getItem("relay.host") || location.host;
$("token").value = localStorage.getItem("relay.token") || "";

PRESETS.forEach(([name, host]) => {
  const o = document.createElement("option");
  o.value = host; o.textContent = host ? name + " - " + host : name;
  $("preset").appendChild(o);
});
$("preset").onchange = () => {
  const v = $("preset").value;
  if (v) $("upstream").value = v;
};

function baseUrl() {
  const host = ($("host").value || location.host).trim().replace(/^https?:\\/\\//, "").replace(/\\/+$/, "");
  const token = $("token").value.trim();
  const up = $("upstream").value.trim().replace(/^https?:\\/\\//, "").replace(/\\/+$/, "");
  if (!up) return "";
  return "https://" + host + "/" + (token ? token + "/" : "") + up + "/v1";
}

function snippet(url) {
  if (!url) return "-";
  const model = "MODEL_ID";
  return [
    "curl " + url + "/chat/completions \\\\",
    '  -H "Authorization: Bearer ***" \\\\',
    '  -H "content-type: application/json" \\\\',
    "  -d '{\\"model\\":\\"" + model + "\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}'",
    "",
    "# Python OpenAI SDK",
    "from openai import OpenAI",
    "c = OpenAI(base_url=\\"" + url + "\\", api_key=\\"sk-...\\")",
    "c.chat.completions.create(model=\\"" + model + "\\", messages=[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}])",
  ].join("\\n");
}

function render() {
  const url = baseUrl();
  $("base").textContent = url || "-";
  $("snippet").textContent = snippet(url);
  $("preview").textContent = url
    ? "Request ke " + url + "/chat/completions diteruskan ke https://" + $("upstream").value.trim() + "/v1/chat/completions"
    : "Isi upstream host dulu.";
  localStorage.setItem("relay.host", $("host").value);
  localStorage.setItem("relay.token", $("token").value);
  const rows = store.get();
  $("rows").innerHTML = rows.length
    ? rows.map((r, i) =>
        "<tr><td>" + r.label + "</td><td class=\\"mono\\">" + r.url +
        "</td><td><button class=\\"ghost\\" data-copy=\\"" + i + "\\">copy</button> " +
        "<button class=\\"ghost\\" data-del=\\"" + i + "\\">x</button></td></tr>").join("")
    : "<tr><td colspan=\\"3\\" style=\\"color:#8b98a5\\">Belum ada. Isi form di atas, klik Tambah.</td></tr>";
}

$("add").onclick = () => {
  const url = baseUrl();
  if (!url) return;
  const label = $("label").value.trim() || $("upstream").value.trim();
  const rows = store.get().filter((r) => r.url !== url);
  rows.unshift({ label, url });
  store.set(rows);
  $("label").value = "";
  render();
};

$("copyBase").onclick = async () => {
  const url = baseUrl();
  if (!url) return;
  try { await navigator.clipboard.writeText(url); $("copyBase").textContent = "Copied"; }
  catch { $("copyBase").textContent = "Copy gagal"; }
  setTimeout(() => ($("copyBase").textContent = "Copy base URL"), 1200);
};

$("rows").onclick = async (e) => {
  const t = e.target;
  const rows = store.get();
  if (t.dataset.copy !== undefined) {
    try { await navigator.clipboard.writeText(rows[+t.dataset.copy].url); t.textContent = "ok"; }
    catch { t.textContent = "fail"; }
    setTimeout(() => (t.textContent = "copy"), 1000);
  }
  if (t.dataset.del !== undefined) {
    rows.splice(+t.dataset.del, 1);
    store.set(rows);
    render();
  }
};

["host", "token", "upstream"].forEach((id) => ($(id).oninput = render));
render();
</script></body></html>`;

export default function handler(req: VercelRequest, res: VercelResponse): void {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "public, max-age=0, must-revalidate");
  res.statusCode = 200;
  res.end(PAGE);
}
