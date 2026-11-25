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
node web/tests/rig/live-e2e.mjs          # the real PWA: fund, mint, 429 (14 checks)
node web/tests/rig/full-e2e.mjs          # everything: cache, mint, play, send, 429s
```

Or run the whole thing — backends, browser, E2E, teardown — in one command:

```bash
bash web/tests/rig/run-full-e2e.sh                # 38 checks, exit 1 if any failed
RIG_RESET=1 bash web/tests/rig/run-full-e2e.sh    # same, from an empty chain
```

The rig reuses `~/.hopper-e2e/btc` and its ord index between runs. That is
fine normally, but after many runs the chain grows and ord catch-up can lag
funding; `RIG_RESET=1` wipes the chain (keeping `bitcoin.conf`) and the ord
index so a run starts from block 0.

`full-e2e.mjs` is the regression gate for the product, not just the scheduler:

| phase | what it proves |
| --- | --- |
| P0 | a wallet is created and funded on regtest |
| P1 | idle costs tip bookkeeping only; a new block asks ord **zero** times for cached coins; a reload re-asks nothing |
| P2 | a mint goes through preview → approve → broadcast → pond |
| P3 | TRAVEL TO ROAD stages the state output, a HOP is signed and sealed, 6 blocks settle it with a recorded outcome |
| P4 | an ordinary BTC send previews, broadcasts, moves the balance and lands in History |
| P5 | a genuinely new outpoint reaches ord; a 429 starts the cooldown, later asks stop, and the oracle recovers after it |
| P6 | no unexpected page errors |

`live-e2e.mjs` is the older, smaller harness. Its 429 test now mints a
coinbase to the wallet's own receive address first: with the range cache
shipped, a bare new block correctly asks ord ZERO times, and only a genuinely
new outpoint may ask. It also navigates back to the wallet view before
asserting the balance survived the outage (the balance block exists only
there).

The suite is green (38/38). P3 pins the staging fix: PREPARE seeds the
state outpoint in the ledger (`provisional: true`) before any source can name
it, so warm passes watch the derived state script and the Hopper stays on The
Road with no RESCAN or reload. The seeded card refuses to HOP until its ranges
are proven, and that one question is retried on the 15 s backlog cadence
instead of waiting for the next block.
