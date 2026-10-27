#!/usr/bin/env python3
"""deploy_relays.py v3 — Deploy relay proxy Vercel massal, PARALEL (multi-worker).

Upgrade dari v2 (sequential):
- 3 worker paralel via ThreadPoolExecutor + job queue
- Jitter anti rate-limit per job (0.5-1.5s) — paralelisme tetap jalan
- Progress live per 5 job
- Auto-detect plan per team (hobby/personal=3, pro_trial/pro=100 default)

Usage:
  export VERCEL_TOKEN="<token>"
  python3 deploy_relays.py            # auto-detect plan -> deploy sesuai limit
  python3 deploy_relays.py 50         # paksa 50 relay per plan
  python3 deploy_relays.py 50 --workers 5

Requires: stdlib only (urllib, concurrent.futures).
"""
import argparse
import json
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

TOKEN = os.environ.get("VERCEL_TOKEN", "").strip()
if not TOKEN:
    print("❌ VERCEL_TOKEN env required")
    sys.exit(1)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTFILE = os.path.join(SCRIPT_DIR, "relay_urls.txt")

PLAN_LABELS = {
    "personal": "Personal",
    "hobby": "Hobby",
    "pro": "Pro",
    "pro_trial": "Pro Trial",
    "enterprise": "Enterprise",
    "enterprise_trial": "Enterprise Trial",
}

PLAN_DEFAULT_COUNT = {
    "personal": 100,
    "hobby": 100,
    "pro": 100,
    "pro_trial": 100,
    "enterprise": 100,
    "enterprise_trial": 100,
}


def vercel_api(method, path, body=None, team_id=None):
    """Call Vercel API. Returns parsed JSON or {'error': ...}."""
    url = f"https://api.vercel.com{path}"
    if team_id:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}teamId={team_id}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        body_txt = e.read()[:500].decode("utf-8", "replace")
        return {"error": f"HTTP {e.code}: {body_txt}"}
    except Exception as e:
        return {"error": str(e)[:200]}


def vercel_get_plans():
    """Detect deployable Vercel plans (teams under token user).
    Returns (plans, error): plans = [{team_id, slug, name, plan}, ...]
    No teams -> personal account = 1 plan.
    """
    plans = []
    teams = vercel_api("GET", "/v2/teams")
    if "error" in teams:
        return [], f"teams: {teams['error']}"
    t_list = teams.get("teams", [])
    if not t_list:
        user = vercel_api("GET", "/v2/user")
        if "error" in user:
            return [], f"user: {user['error']}"
        u = user.get("user", {})
        plans.append({
            "team_id": None,
            "slug": u.get("username") or u.get("name") or "personal",
            "name": "Personal",
            "plan": "personal",
        })
        return plans, None
    for t in t_list:
        tid = t.get("id")
        plan_name = "unknown"
        detail = vercel_api("GET", f"/v2/teams/{tid}")
        if "error" not in detail:
            plan_name = detail.get("billing", {}).get("plan") or "unknown"
        plans.append({
            "team_id": tid,
            "slug": t.get("slug"),
            "name": t.get("name") or t.get("slug"),
            "plan": plan_name,
        })
    return plans, None


# Files uploaded with every deployment (relative to SCRIPT_DIR).
# Keep in sync with the repo layout — a missing entry here deploys a broken proxy.
DEPLOY_FILES = [
    "api/proxy/index.ts",
    "api/health.ts",
    "api/ui.ts",
    "lib/proxy-handler.ts",
    "package.json",
    "vercel.json",
]


def read_sources():
    """Read every file that must ship with the deployment.

    Returns (files, error) where files is the Vercel deployment "files" payload.
    """
    out = []
    for rel in DEPLOY_FILES:
        path = os.path.join(SCRIPT_DIR, rel)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                out.append({"file": rel, "data": fh.read()})
        except Exception as e:
            return None, f"read {rel}: {e}"
    return out, None


def vercel_create_deployment(project_name, team_id=None):
    """Deploy 1 relay proxy: create project -> disable SSO -> POST deployment."""
    proj = vercel_api("POST", "/v10/projects", {"name": project_name, "framework": None}, team_id)
    project_id = proj.get("id")
    if not project_id:
        plist = vercel_api("GET", f"/v9/projects?name={project_name}", team_id=team_id)
        for p in plist.get("projects", []):
            if p.get("name") == project_name:
                project_id = p.get("id")
                break
    if not project_id:
        return {"ok": False, "error": f"project create failed: {proj.get('error', 'no id')}"}

    vercel_api("PATCH", f"/v9/projects/{project_id}", {"ssoProtection": None}, team_id)

    # Optional upstream whitelist so a leaked relay URL cannot be used as an
    # open proxy on the user's account. RELAY_ALLOWED_HOSTS="a.com,b.com"
    # RELAY_DEFAULT_TARGET="https://api.x.ai" makes the relay a drop-in base
    # URL for clients that can't set the x-relay-target header.
    envs = {}
    allowed = os.environ.get("RELAY_ALLOWED_HOSTS", "").strip()
    if allowed:
        envs["ALLOWED_TARGET_HOSTS"] = allowed
        envs["ALLOWED_ORIGINS"] = os.environ.get("RELAY_ALLOWED_ORIGINS", "*").strip()
    default_target = os.environ.get("RELAY_DEFAULT_TARGET", "").strip()
    if default_target:
        envs["DEFAULT_TARGET"] = default_target
    relay_token = os.environ.get("RELAY_TOKEN", "").strip()
    if relay_token:
        envs["RELAY_TOKEN"] = relay_token
    for key, value in envs.items():
        vercel_api(
            "POST",
            f"/v10/projects/{project_id}/env",
            {"key": key, "value": value, "type": "plain", "target": ["production", "preview"]},
            team_id,
        )

    files, ferr = read_sources()
    if ferr:
        return {"ok": False, "error": ferr}

    dep_body = {
        "name": project_name,
        "project": project_id,
        "files": files,
        "projectSettings": {"framework": None, "buildCommand": None, "outputDirectory": None},
        "target": "production",
    }
    dep = vercel_api("POST", "/v13/deployments", dep_body, team_id)
    if "error" in dep:
        return {"ok": False, "error": f"deploy: {dep['error']}"}
    url = dep.get("url")
    if not url:
        return {"ok": False, "error": f"no url in response: {str(dep)[:200]}"}
    return {"ok": True, "url": url, "project_id": project_id}


def deploy_one(plan, project_name, lock, state):
    """Worker: deploy 1 relay + update state. Thread-safe."""
    result = vercel_create_deployment(project_name, team_id=plan["team_id"])
    slug = plan["slug"]
    with lock:
        if result.get("ok"):
            state["deployed"][slug].append(result["url"])
            with open(OUTFILE, "a") as f:
                f.write(result["url"] + "\n")
        else:
            state["errors"][slug].append(f"{project_name}: {result.get('error', '?')[:120]}")
        state["done"] += 1
        done_now = state["done"]
    # jitter anti rate-limit — di luar lock biar paralel jalan
    time.sleep(random.uniform(0.5, 1.5))
    return done_now, result.get("ok", False)


def main():
    ap = argparse.ArgumentParser(description="Deploy relay proxy Vercel massal (paralel)")
    ap.add_argument("count", nargs="?", type=int, default=0, help="Relay per plan (0 = default per plan)")
    ap.add_argument("--workers", type=int, default=3, help="Jumlah worker paralel (default 3)")
    args = ap.parse_args()

    plans, perr = vercel_get_plans()
    if perr or not plans:
        print(f"❌ Gagal deteksi plan Vercel: {perr or 'tidak ada plan'}")
        return 1

    n_plans = len(plans)
    plan_desc = " + ".join(f"{PLAN_LABELS.get(p['plan'], p['plan'])} ({p['slug']})" for p in plans)

    count = args.count or int(os.environ.get("RELAY_COUNT", "0") or 0)
    if count <= 0:
        count = PLAN_DEFAULT_COUNT.get(plans[0]["plan"], 3)

    total = count * n_plans
    workers = max(1, min(args.workers, total))
    print("━" * 40)
    print(f"  Plans terdeteksi ({n_plans}): {plan_desc}")
    print(f"  Deploy {count}/plan × {n_plans} plan = {total} relay proxy")
    print(f"  Workers: {workers} (paralel)")
    print(f"  Output: {OUTFILE}")
    print("━" * 40)
    open(OUTFILE, "w").close()

    ts = int(time.time())
    rnd = uuid.uuid4().hex[:6]

    jobs = []
    for i in range(1, count + 1):
        for pi, plan in enumerate(plans, 1):
            project_name = f"relay-{ts}-{rnd}-p{pi}-{i}"
            jobs.append((plan, project_name))

    lock = threading.Lock()
    state = {
        "deployed": {p["slug"]: [] for p in plans},
        "errors": {p["slug"]: [] for p in plans},
        "done": 0,
    }

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(deploy_one, plan, name, lock, state): name for plan, name in jobs}
        for fut in as_completed(futures):
            done_now, ok = fut.result()
            if done_now % 5 == 0 or done_now == total:
                prog = " | ".join(
                    f"{PLAN_LABELS.get(p['plan'], p['plan'])}: {len(state['deployed'][p['slug']])}"
                    for p in plans)
                print(f"[{done_now}/{total}] {prog}")

    elapsed = time.time() - t0
    deployed_total = sum(len(v) for v in state["deployed"].values())
    err_total = sum(len(v) for v in state["errors"].values())

    print("━" * 40)
    print(f"Selesai dalam {elapsed:.0f}s ({total} deploy, {workers} workers)")
    print(f"Sukses: {deployed_total}/{total}")
    if err_total:
        print(f"Gagal: {err_total} — breakdown:")
        for slug, errs in state["errors"].items():
            if errs:
                print(f"  {slug}: {len(errs)} (contoh: {errs[0][:60]})")
        return 1
    print(f"URLs tersimpan di: {OUTFILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
