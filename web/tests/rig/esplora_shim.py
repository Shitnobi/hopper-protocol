#!/usr/bin/env python3
"""Minimal Esplora-compatible REST server over Bitcoin Core RPC (regtest).

Test rig, not a product. Serves exactly the Esplora subset HOPPER's live mode
uses, keeps a small in-memory address index built from block scans, and:

  * appends one JSON line per request to $ESPLORA_LOG  -> monitoring
  * POST /__fault {"match","status","times","body"}    -> fault injection
                         (prove backoff / cooldown behaviour)
  * GET  /__fault   current injection     DELETE /__fault   clear

Env:
  ESPLORA_PORT      default 18081
  BITCOIND_DATADIR  cookie at <dir>/regtest/.cookie (required)
  BITCOIND_RPC      default 127.0.0.1:19743
  ESPLORA_LOG       default ./esplora.log
"""
import json
import os
import sys
import time
import urllib.request
import base64
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATADIR = os.path.expanduser(os.environ.get("BITCOIND_DATADIR", ""))
RPC = os.environ.get("BITCOIND_RPC", "127.0.0.1:19743")
RPC_USER = os.environ.get("BITCOIND_RPC_USER", "")
RPC_PASS = os.environ.get("BITCOIND_RPC_PASS", "")
PORT = int(os.environ.get("ESPLORA_PORT", "18081"))
LOG = os.environ.get("ESPLORA_LOG", "./esplora.log")

lock = threading.Lock()
fault = {"match": None, "status": 0, "times": 0, "body": ""}


def logpath():
    return LOG


def cookie():
    if RPC_USER:
        return "%s:%s" % (RPC_USER, RPC_PASS)
    with open(os.path.join(DATADIR, "regtest", ".cookie")) as f:
        return f.read().strip()


def rpc(method, *args):
    body = json.dumps({"jsonrpc": "1.0", "id": "shim", "method": method,
                       "params": list(args)}).encode()
    req = urllib.request.Request("http://%s/" % RPC, data=body, method="POST")
    req.add_header("Authorization", "Basic " + base64.b64encode(cookie().encode()).decode())
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as res:
        out = json.loads(res.read())
    if out.get("error"):
        raise RuntimeError("%s: %s" % (method, out["error"]))
    return out["result"]


class Index:
    """Address index from block scans. Tiny chains only (this is a rig)."""

    def __init__(self):
        self.tip = -1
        self.outpoint = {}     # "txid:n" -> (script_hex, address, value)
        self.addr_utxos = {}   # address -> {"txid:n": value}
        self.addr_txs = {}     # address -> [txid]
        self.meta = {}         # txid -> {height, block_hash, block_time}
        self.addr_scripts = {}  # address -> script_hex (for /scripthash-free paths)

    def sync(self):
        h = rpc("getblockcount")
        while self.tip < h:
            nxt = self.tip + 1
            bh = rpc("getblockhash", nxt)
            blk = rpc("getblock", bh, 2)
            self._add_block(blk)
            self.tip = nxt

    def _add_block(self, blk):
        for tx in blk["tx"]:
            txid = tx["txid"]
            self.meta[txid] = {"height": blk["height"], "block_hash": blk["hash"],
                               "block_time": blk["time"]}
            for vin in tx.get("vin", []):
                if vin.get("txid"):
                    op = "%s:%d" % (vin["txid"], vin["vout"])
                    prev = self.outpoint.pop(op, None)
                    if prev:
                        script_hex, address, _ = prev
                        if address and self.addr_utxos.get(address):
                            self.addr_utxos[address].pop(op, None)
            for i, vout in enumerate(tx.get("vout", [])):
                spk = vout.get("scriptPubKey", {})
                script_hex = spk.get("hex", "")
                address = spk.get("address") or spk.get("addresses", [None])[0] if isinstance(spk.get("addresses", []), list) else spk.get("address")
                value = int(round(float(vout.get("value", 0)) * 1e8))
                op = "%s:%d" % (txid, i)
                self.outpoint[op] = (script_hex, address, value)
                if address:
                    self.addr_scripts[address] = script_hex
                    self.addr_utxos.setdefault(address, {})[op] = value
                    self.addr_txs.setdefault(address, []).append(txid)

    def mempool(self):
        """{(txid, vout): (script_hex, address, value)}, spent set, tx list."""
        outs, spent, txs = {}, set(), []
        for txid in rpc("getrawmempool"):
            tx = rpc("getrawtransaction", txid, True)
            txs.append(tx)
            for vin in tx.get("vin", []):
                if vin.get("txid"):
                    spent.add("%s:%d" % (vin["txid"], vin["vout"]))
            for i, vout in enumerate(tx.get("vout", [])):
                spk = vout.get("scriptPubKey", {})
                addr = spk.get("address")
                if not addr and isinstance(spk.get("addresses"), list) and spk["addresses"]:
                    addr = spk["addresses"][0]
                outs["%s:%d" % (txid, i)] = (spk.get("hex", ""), addr,
                                             int(round(float(vout.get("value", 0)) * 1e8)))
        return outs, spent, txs

    def status(self, txid):
        if txid in self.meta:
            m = self.meta[txid]
            return {"confirmed": True, "block_height": m["height"],
                    "block_hash": m["block_hash"], "block_time": m["block_time"]}
        return {"confirmed": False}

    def tx_shape(self, tx):
        txid = tx["txid"]
        st = self.status(txid)
        return {
            "txid": txid,
            "version": tx.get("version"),
            "locktime": tx.get("locktime"),
            "vin": [{"txid": v.get("txid"), "vout": v.get("vout")} for v in tx.get("vin", [])],
            "vout": [{
                "scriptpubkey": o.get("scriptPubKey", {}).get("hex", ""),
                "scriptpubkey_address": (o.get("scriptPubKey", {}).get("address")
                                         or (o.get("scriptPubKey", {}).get("addresses") or [None])[0]),
                "value": int(round(float(o.get("value", 0)) * 1e8)),
            } for o in tx.get("vout", [])],
            "status": st,
        }


IDX = Index()


def addr_utxos(addr):
    IDX.sync()
    outs, spent, _txs = IDX.mempool()
    rows = []
    for op, value in (IDX.addr_utxos.get(addr) or {}).items():
        if op in spent:
            continue
        txid, vout = op.rsplit(":", 1)
        rows.append({"txid": txid, "vout": int(vout), "value": value,
                     "status": IDX.status(txid)})
    for op, (script_hex, a, value) in outs.items():
        if a != addr:
            continue
        if op in spent:
            continue
        txid, vout = op.rsplit(":", 1)
        rows.append({"txid": txid, "vout": int(vout), "value": value,
                     "status": {"confirmed": False}})
    return rows


def addr_txs(addr):
    IDX.sync()
    outs, spent, mt = IDX.mempool()
    rows, seen = [], set()
    for tx in mt:
        touches = any(op in outs and outs[op][1] == addr for op in outs
                      if op.startswith(tx["txid"] + ":"))
        touches = touches or any(
            v.get("txid") and ("%s:%d" % (v["txid"], v["vout"])) in (IDX.addr_utxos.get(addr) or {})
            for v in tx.get("vin", []))
        if touches:
            rows.append(IDX.tx_shape(tx))
            seen.add(tx["txid"])
    for txid in reversed(IDX.addr_txs.get(addr) or []):
        if txid in seen:
            continue
        seen.add(txid)
        rows.append(IDX.tx_shape(rpc("getrawtransaction", txid, True)))
    return rows


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, status, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else str(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.end_headers()
        self.wfile.write(data)

    def _log(self, status, ms, nbytes):
        with lock:
            with open(logpath(), "a") as f:
                f.write(json.dumps({"t": round(time.time(), 3), "m": self.command,
                                    "p": self.path, "s": status, "ms": ms,
                                    "b": nbytes}) + "\n")

    def do_OPTIONS(self):
        self._send(204, b"")

    def _fault_for(self, path):
        with lock:
            if fault["match"] and fault["times"] > 0 and fault["match"] in path:
                fault["times"] -= 1
                return fault
        return None

    def do_POST(self):
        t0 = time.time()
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        if self.path == "/__fault":
            with lock:
                fault.update(json.loads(raw or b"{}"))
            return self._send(200, json.dumps(fault).encode())
        f = self._fault_for(self.path)
        if f:
            self._log(f["status"], (time.time() - t0) * 1000, 0)
            return self._send(f["status"], (f.get("body") or "injected").encode(), "text/plain")
        if self.path == "/tx":
            try:
                txid = rpc("sendrawtransaction", raw.decode().strip())
                self._log(200, (time.time() - t0) * 1000, 64)
                return self._send(200, txid.encode(), "text/plain")
            except Exception as e:  # noqa: BLE001
                self._log(400, (time.time() - t0) * 1000, 0)
                return self._send(400, str(e).encode(), "text/plain")
        self._log(404, 0, 0)
        self._send(404, b"not found", "text/plain")

    def do_DELETE(self):
        with lock:
            fault.update({"match": None, "status": 0, "times": 0, "body": ""})
        self._send(200, b"{}")

    def do_GET(self):
        t0 = time.time()
        p = self.path.split("?")[0]
        if p == "/__fault":
            return self._send(200, json.dumps(fault).encode())
        f = self._fault_for(p)
        if f:
            self._log(f["status"], (time.time() - t0) * 1000, 0)
            return self._send(f["status"], (f.get("body") or "injected").encode(), "text/plain")
        try:
            body, ctype, status = self.route(p)
        except Exception as e:  # noqa: BLE001
            body, ctype, status = str(e).encode(), "text/plain", 500
        self._log(status, (time.time() - t0) * 1000, len(body))
        self._send(status, body, ctype)

    def route(self, p):
        IDX.sync()
        if p == "/blocks/tip/height":
            return str(IDX.tip).encode(), "text/plain", 200
        if p == "/blocks/tip/hash":
            return rpc("getblockhash", IDX.tip).encode(), "text/plain", 200
        if p.startswith("/block-height/"):
            return rpc("getblockhash", int(p.rsplit("/", 1)[1])).encode(), "text/plain", 200
        if p.startswith("/address/"):
            rest = p[len("/address/"):]
            parts = rest.split("/")
            addr = urllib.parse.unquote(parts[0])
            if len(parts) == 2 and parts[1] == "utxo":
                return json.dumps(addr_utxos(addr)).encode(), "application/json", 200
            if len(parts) >= 2 and parts[1] == "txs":
                if len(parts) >= 3 and parts[2] == "chain":
                    return b"[]", "application/json", 200
                return json.dumps(addr_txs(addr)).encode(), "application/json", 200
        if p.startswith("/tx/"):
            rest = p[len("/tx/"):]
            if rest.endswith("/hex"):
                txid = rest[:-4]
                return rpc("getrawtransaction", txid, False).encode(), "text/plain", 200
            try:
                tx = rpc("getrawtransaction", rest, True)
            except Exception:
                return b"Transaction not found", "text/plain", 404
            return json.dumps(IDX.tx_shape(tx)).encode(), "application/json", 200
        if p == "/fee-estimates":
            return json.dumps({"1": 2, "2": 2, "3": 2, "6": 2, "12": 2}).encode(), "application/json", 200
        return b"not found", "text/plain", 404


if __name__ == "__main__":
    open(LOG, "a").close()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("esplora shim on :%d -> rpc %s (log %s)" % (PORT, RPC, LOG), flush=True)
    srv.serve_forever()
