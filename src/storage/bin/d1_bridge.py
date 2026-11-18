#!/usr/bin/env python3
"""d1_bridge: stdio JSON-lines bridge from the Node D1 client to the
Cloudflare D1 HTTP API, using the fleet's stored `custom.cloudflare`
credential through the connector's dynamic-credential helper.

Protocol: one JSON object per line on stdin:
  {"id": <int>, "sql": "<statement>", "params": [...]}
BLOB params travel as JSON arrays of ints (the D1 HTTP API stores those
as true BLOBs; a base64 string would be stored as TEXT — probed live
2026-10-14, see README). One JSON object per line on stdout:
  {"id": <int>, "ok": true, "results": [...rows...], "meta": {...}}
  {"id": <int>, "ok": false, "status": <http>, "error": "<body excerpt>"}
The credential (and its surrogate) is never printed or written to disk.
"""
import json
import sys
import urllib.error
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/templates/skill/bin")
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

ACCOUNT_ID = "df3c35b2bb75d5acafb15572064f41c0"
DATABASE_ID = sys.argv[1] if len(sys.argv) > 1 else "ef0fd639-3694-4d9e-829a-af644c40b13f"
URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/d1/database/{DATABASE_ID}/query"


def decode_params(params):
    out = []
    for p in params:
        if isinstance(p, dict) and "$blob_b64" in p:
            out.append(list(__import__("base64").b64decode(p["$blob_b64"])))
        else:
            out.append(p)
    return out


def run(sql, params):
    body = json.dumps({"sql": sql, "params": decode_params(params)}).encode("utf-8")
    req = urllib.request.Request(URL, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    try:
        resp = urllib.request.urlopen(req, timeout=300)
        data = read_json_response(resp)
        result = (data.get("result") or [{}])[0]
        if not data.get("success", True):
            return {"ok": False, "status": resp.status, "error": json.dumps(data.get("errors"))[:500]}
        return {"ok": True, "results": result.get("results") or [], "meta": result.get("meta") or {}}
    except urllib.error.HTTPError as e:
        return {"ok": False, "status": e.code, "error": e.read().decode("utf-8", "replace")[:500]}
    except Exception as e:  # network etc.
        return {"ok": False, "status": 0, "error": f"{type(e).__name__}: {e}"[:500]}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        out = run(msg.get("sql", ""), msg.get("params") or [])
        out["id"] = msg.get("id")
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
