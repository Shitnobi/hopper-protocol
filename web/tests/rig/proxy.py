#!/usr/bin/env python3
"""Logging + fault-injecting reverse proxy (test rig).

Forwards HTTP to an upstream (ord lives behind it), appends one JSON line per
request to --log, and lets a test inject failures at the edge:

  POST /__fault  {"match": "/r/utxo", "status": 429, "times": 3, "body": "slow down"}
  GET  /__fault  -> current injection state
  DELETE /__fault -> clear

Env overrides: PROXY_LOG, PROXY_FAULT_STATE (path to shared JSON state).
"""
import argparse
import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock = threading.Lock()
fault = {"match": None, "status": 0, "times": 0, "body": ""}
UPSTREAM = ""
LOGPATH = ""


def load_state():
    global fault
    p = os.environ.get("PROXY_FAULT_STATE")
    if p and os.path.exists(p):
        try:
            with open(p) as f:
                fault = json.load(f)
        except Exception:  # noqa: BLE001
            pass


def save_state():
    p = os.environ.get("PROXY_FAULT_STATE")
    if p:
        with open(p, "w") as f:
            json.dump(fault, f)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _log(self, status, ms, nbytes):
        with lock:
            with open(LOGPATH, "a") as f:
                f.write(json.dumps({"t": round(time.time(), 3), "m": self.command,
                                    "p": self.path, "s": status, "ms": ms,
                                    "b": nbytes}) + "\n")

    def _fault_for(self, path):
        with lock:
            if fault["match"] and fault["times"] > 0 and fault["match"] in path:
                fault["times"] -= 1
                save_state()
                return dict(fault)
        return None

    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        return self.rfile.read(n) if n else b""

    def _respond(self, status, body, ctype="application/json", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._respond(204, b"")

    def _forward(self):
        t0 = time.time()
        body = self._body()
        if self.path == "/__fault" and self.command in ("POST", "GET", "DELETE"):
            global fault
            with lock:
                if self.command == "POST":
                    fault.update(json.loads(body or b"{}"))
                    save_state()
                elif self.command == "DELETE":
                    fault = {"match": None, "status": 0, "times": 0, "body": ""}
                    save_state()
                return self._respond(200, json.dumps(fault).encode())
        f = self._fault_for(self.path)
        if f:
            self._log(f["status"], (time.time() - t0) * 1000, 0)
            return self._respond(f["status"], (f.get("body") or "injected").encode(), "text/plain")
        req = urllib.request.Request(UPSTREAM + self.path, data=body if body else None,
                                     method=self.command)
        for h in ("content-type", "accept"):
            if self.headers.get(h):
                req.add_header(h, self.headers[h])
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                data = res.read()
                ctype = res.headers.get("content-type", "application/json")
                status = res.status
        except urllib.error.HTTPError as e:
            data = e.read()
            ctype = e.headers.get("content-type", "text/plain")
            status = e.code
        except Exception as e:  # noqa: BLE001
            data = str(e).encode()
            ctype = "text/plain"
            status = 502
        self._log(status, (time.time() - t0) * 1000, len(data))
        self._respond(status, data, ctype)

    do_GET = _forward
    do_POST = _forward
    do_DELETE = _forward


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", type=int, required=True)
    ap.add_argument("--upstream", required=True, help="host:port")
    ap.add_argument("--log", required=True)
    a = ap.parse_args()
    UPSTREAM = "http://" + a.upstream
    LOGPATH = a.log
    open(LOGPATH, "a").close()
    load_state()
    print("proxy :%d -> %s (log %s)" % (a.listen, a.upstream, a.log), flush=True)
    ThreadingHTTPServer(("127.0.0.1", a.listen), Handler).serve_forever()
