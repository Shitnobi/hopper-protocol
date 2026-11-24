#!/usr/bin/env bash
# Start the whole regtest rig, run the full browser E2E, then tear it down.
#
#   bash web/tests/rig/run-full-e2e.sh
#
# One call owns every process, so nothing depends on a daemon surviving
# between shells. Only processes matching this rig's own datadirs/ports are
# ever killed — never a desktop browser or another project's node.
set -uo pipefail

RIG=${RIG:-$HOME/AI/.hopper-e2e}
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
BB=$HOME/AI/bitcoin/bitcoin-31.1/bin
LOG=$RIG/logs
PORT_STATIC=${PORT_STATIC:-8130}
PORT_DEBUG=${PORT_DEBUG:-9223}
mkdir -p "$LOG"


# Kill only blinkers that were started from this rig's own profile dirs.
kill_rig_chrome() {
  for cmd in /proc/[0-9]*/cmdline; do
    [ -r "$cmd" ] || continue
    line=$(tr '\0' ' ' <"$cmd" 2>/dev/null) || continue
    case "$line" in
      *"--user-data-dir=$RIG/"*) pid=${cmd#/proc/}; kill "${pid%/cmdline}" 2>/dev/null ;;
    esac
  done
}

# A previous run can leave a CDP browser on the port; the new one would then
# fail to bind and every test would silently drive the old profile.
free_debug_port() {
  for cmd in /proc/[0-9]*/cmdline; do
    [ -r "$cmd" ] || continue
    line=$(tr '\0' ' ' <"$cmd" 2>/dev/null) || continue
    case "$line" in
      *"--remote-debugging-port=$PORT_DEBUG"*)
        case "$line" in
          *"--user-data-dir=$RIG/"*) pid=${cmd#/proc/}; kill "${pid%/cmdline}" 2>/dev/null ;;
          *) echo "    port $PORT_DEBUG is held by a browser outside this rig — aborting"; exit 2 ;;
        esac ;;
    esac
  done
  for i in $(seq 1 20); do
    curl -fsS --max-time 1 "http://127.0.0.1:$PORT_DEBUG/json/version" >/dev/null 2>&1 || return 0
    sleep 0.5
  done
}

pids=()
cleanup() {
  echo "--- tearing down"
  for p in "${pids[@]:-}"; do [ -n "${p:-}" ] && kill "$p" 2>/dev/null; done
  pkill -f -- "--data-dir $RIG/ord" 2>/dev/null
  pkill -f -- "esplora_shim.py" 2>/dev/null
  pkill -f -- "proxy.py --listen 18080" 2>/dev/null
  pkill -f -- "http.server $PORT_STATIC" 2>/dev/null
  kill_rig_chrome
  $BB/bitcoin-cli -datadir=$RIG/btc stop >/dev/null 2>&1
  sleep 2
}
trap cleanup EXIT

echo "--- clearing whatever the previous run left behind"
pkill -f -- "--data-dir $RIG/ord" 2>/dev/null
pkill -f -- "esplora_shim.py" 2>/dev/null
pkill -f -- "proxy.py --listen 18080" 2>/dev/null
pkill -f -- "http.server $PORT_STATIC" 2>/dev/null
kill_rig_chrome
$BB/bitcoin-cli -datadir=$RIG/btc stop >/dev/null 2>&1
sleep 2

echo "--- bitcoind (regtest, rpc 19743)"
setsid nohup "$BB/bitcoind" -datadir=$RIG/btc -daemonwait >"$LOG/bitcoind.out" 2>&1 </dev/null &
pids+=($!)
for i in $(seq 1 40); do
  $BB/bitcoin-cli -datadir=$RIG/btc getblockcount >/dev/null 2>&1 && break
  sleep 0.5
done
tip=$($BB/bitcoin-cli -datadir=$RIG/btc getblockcount)
echo "    height $tip"

echo "--- ord (sat + address + transaction index, http 18780)"
setsid nohup ord -r --data-dir "$RIG/ord" --bitcoin-rpc-url http://127.0.0.1:19743 \
  --bitcoin-rpc-username hoppere2e --bitcoin-rpc-password e2ehoppere2e \
  --index-sats --index-addresses --index-transactions \
  server --http-port 18780 --polling-interval 500ms >"$LOG/ord.out" 2>&1 </dev/null &
pids+=($!)
for i in $(seq 1 80); do
  curl -fsS --max-time 2 http://127.0.0.1:18780/status >/dev/null 2>&1 && break
  sleep 0.5
done

echo "--- Esplora shim (18081) + ord proxy (18080)"
rm -f "$LOG/esplora.jsonl" "$LOG/ord.log.jsonl"
( cd "$ROOT/web/tests/rig" && \
  BITCOIND_DATADIR=$RIG/btc BITCOIND_RPC=127.0.0.1:19743 \
  BITCOIND_RPC_USER=hoppere2e BITCOIND_RPC_PASS=e2ehoppere2e \
  ESPLORA_PORT=18081 ESPLORA_LOG=$LOG/esplora.jsonl \
  setsid nohup python3 esplora_shim.py >"$LOG/shim.out" 2>&1 </dev/null & echo $! ) > /tmp/rig_pid
pids+=($(cat /tmp/rig_pid)); rm -f /tmp/rig_pid
( cd "$ROOT/web/tests/rig" && \
  setsid nohup python3 proxy.py --listen 18080 --upstream 127.0.0.1:18780 --log "$LOG/ord.log.jsonl" \
  >"$LOG/proxy.out" 2>&1 </dev/null & echo $! ) > /tmp/rig_pid
pids+=($(cat /tmp/rig_pid)); rm -f /tmp/rig_pid
for i in $(seq 1 40); do
  curl -fsS --max-time 2 http://127.0.0.1:18081/blocks/tip/height >/dev/null 2>&1 \
    && curl -fsS --max-time 2 http://127.0.0.1:18080/status >/dev/null 2>&1 && break
  sleep 0.5
done

echo "--- static server ($PORT_STATIC) + headless chromium ($PORT_DEBUG)"
( cd "$ROOT/web" && setsid nohup python3 -m http.server "$PORT_STATIC" --bind 127.0.0.1 \
  >"$LOG/http.out" 2>&1 </dev/null & echo $! ) > /tmp/rig_pid
pids+=($(cat /tmp/rig_pid)); rm -f /tmp/rig_pid
free_debug_port
rm -rf "$RIG/chrome-live"
setsid nohup chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --remote-debugging-port="$PORT_DEBUG" --user-data-dir="$RIG/chrome-live" about:blank \
  >"$LOG/chrome-live.out" 2>&1 </dev/null &
pids+=($!)
ok_browser=0
for i in $(seq 1 40); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT_DEBUG/json" >/dev/null 2>&1; then ok_browser=1; break; fi
  sleep 0.5
done
[ "$ok_browser" = 1 ] || { echo "    chromium did not expose CDP on $PORT_DEBUG"; exit 2; }

echo "--- running the full browser E2E"
node "$ROOT/web/tests/rig/full-e2e.mjs" "http://127.0.0.1:$PORT_STATIC" "$PORT_DEBUG"
status=$?
echo "--- exit $status"
exit $status
