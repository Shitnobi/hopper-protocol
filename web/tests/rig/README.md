# Regtest rig — live-mode end-to-end

Real backends, real chain: Bitcoin Core (regtest), `ord` with sat indexing,
and a minimal Esplora REST server over Core RPC that logs every request. A
logging/fault-injecting proxy sits in front of `ord`.

```
# 1. backends
mkdir -p ~/.hopper-e2e/{btc,ord,logs}
# bitcoin.conf: regtest=1 server=1 rpcport=19743 port=19744
#   rpcuser=hoppere2e rpcpassword=e2ehoppere2e txindex=1 blockfilterindex=1 fallbackfee=0.0002
bitcoind -datadir=~/.hopper-e2e/btc -daemonwait
ord -r --data-dir ~/.hopper-e2e/ord --bitcoin-rpc-url http://127.0.0.1:19743 \
    --bitcoin-rpc-username hoppere2e --bitcoin-rpc-password e2ehoppere2e \
    --index-sats --index-addresses --index-transactions \
    server --http-port 18780 --polling-interval 500ms

# 2. monitored Esplora + ord proxy
cd web/tests/rig
BITCOIND_DATADIR=~/.hopper-e2e/btc BITCOIND_RPC=127.0.0.1:19743 \
BITCOIND_RPC_USER=hoppere2e BITCOIND_RPC_PASS=e2ehoppere2e \
ESPLORA_PORT=18081 ESPLORA_LOG=~/.hopper-e2e/logs/esplora.jsonl \
  python3 esplora_shim.py &
python3 proxy.py --listen 18080 --upstream 127.0.0.1:18780 \
  --log ~/.hopper-e2e/logs/ord.log.jsonl &

# 3. app + browser
python3 -m http.server 8130 --bind 127.0.0.1 &            # from web/
chromium --headless=new --no-sandbox --remote-debugging-port=9222 \
  --user-data-dir=~/.hopper-e2e/chrome about:blank &

# 4. tests
node web/tests/rig/query-logic-e2e.mjs   # scheduler logic against the rig (19 checks)
node web/tests/rig/live-e2e.mjs          # the real PWA: fund, mint, monitor
```

`POST /__fault {"match":"/r/utxo","status":429,"times":100}` on either the
shim or the proxy injects failures; `DELETE /__fault` clears them.

`settings.forcePublicSource = true` (test-only, no UI writes it) makes the
public-source paths fire against local endpoints: 10-minute idle cadence,
metered Esplora pacing, the 1-minute failure ladder.
