#!/usr/bin/env python3
"""In-memory stand-in for the Task Sync cloud, for two-server task authority tests.

Never talks to production. Accepts any email and the code 123456, keeps one
account's planning rows, and records every membership push per device so a test
can see which server rolled a commitment and whether two did.

  mockcloud.py <port>
  GET /_mock/state        -> rows, pushes per device
  POST /_mock/seed        -> {"tasks": [...], "periods": [...], "memberships": [...]}
"""
import json
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

LOCK = threading.Lock()
STATE = {
    "seq": 0,
    "tasks": {},
    "periods": {},
    "memberships": {},
    "tokens": {},  # token -> device name
    "pushes": [],  # {device, kind, id, row}
}


def bump(row):
    STATE["seq"] += 1
    return {**row, "seq": STATE["seq"]}


def store(kind, row, device):
    table = STATE[kind]
    current = table.get(row["id"])
    if current is not None and current.get("updatedAt", "") > row.get("updatedAt", ""):
        return
    table[row["id"]] = bump(row)
    STATE["pushes"].append({"device": device, "kind": kind, "id": row["id"], "row": row})


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def body(self):
        length = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def device(self):
        auth = self.headers.get("authorization", "")
        return STATE["tokens"].get(auth.removeprefix("Bearer ").strip())

    def do_GET(self):
        url = urlparse(self.path)
        with LOCK:
            if url.path == "/api/task-sync/availability":
                return self.reply(200, {"available": True})
            if url.path == "/_mock/state":
                return self.reply(200, STATE)
            if self.device() is None:
                return self.reply(401, {"error": "unauthorized"})
            if url.path == "/api/entitlements/task-sync":
                return self.reply(200, {"status": "active", "canManage": True})
            if url.path == "/api/planning/changes":
                since = int(parse_qs(url.query).get("since", ["0"])[0])
                pick = lambda kind: [r for r in STATE[kind].values() if r["seq"] > since]
                return self.reply(200, {
                    "tasks": pick("tasks"),
                    "periods": pick("periods"),
                    "memberships": pick("memberships"),
                    "nextSince": STATE["seq"],
                    "hasMore": False,
                    "settings": {"weekStartsOn": 1},
                })
        self.reply(404, {"error": "not_found"})

    def do_POST(self):
        url = urlparse(self.path)
        body = self.body()
        with LOCK:
            if url.path == "/api/client/handshake":
                return self.reply(200, {"token": "client-token", "expiresIn": 3600})
            if url.path == "/api/auth/request-code":
                return self.reply(200, {"ok": True})
            if url.path == "/api/auth/verify":
                if body.get("code") != "123456":
                    return self.reply(401, {"error": "invalid_code"})
                token = f"device-{uuid.uuid4()}"
                STATE["tokens"][token] = f"{body.get('device', {}).get('name', '?')}#{len(STATE['tokens']) + 1}"
                return self.reply(200, {"token": token, "user": {"email": body["email"]}})
            if url.path == "/api/auth/revoke":
                return self.reply(200, {})
            if url.path == "/_mock/seed":
                for kind in ("tasks", "periods", "memberships"):
                    for row in body.get(kind, []):
                        store(kind, row, "seed")
                return self.reply(200, {"seq": STATE["seq"]})
            device = self.device()
            if device is None:
                return self.reply(401, {"error": "unauthorized"})
            if url.path == "/api/planning/push":
                for kind in ("tasks", "periods", "memberships"):
                    for row in body.get(kind, []):
                        store(kind, row, device)
                return self.reply(200, {})
        self.reply(404, {"error": "not_found"})


if __name__ == "__main__":
    port = int(sys.argv[1])
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
