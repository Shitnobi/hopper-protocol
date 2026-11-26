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
mkdir -p "$LOG"

# A process leaked by an earlier sandbox can hold a port and be invisible to
# pkill in this one (different PID namespace), so never assume the default
# port is ours: pick the first free one and tell the tests where it is.
port_busy() {
  python3 - "$1" <<'PY' >/dev/null 2>&1
import socket, sys
s = socket.socket(); s.settimeout(0.25)
sys.exit(0 if s.connect_ex(('127.0.0.1', int(sys.argv[1]))) == 0 else 1)
PY
}
free_port() {
  local p=$1 n=0
  while [ $n -lt 50 ]; do
    port_busy "$p" || { echo "$p"; return 0; }
    p=$((p + 1)); n=$((n + 1))
  done
  echo "$1"
}
PORT_STATIC=${PORT_STATIC:-$(free_port 8130)}
PORT_DEBUG=${PORT_DEBUG:-$(free_port 9223)}
PORT_ORD=${PORT_ORD:-$(free_port 18080)}
# Start the shim above the ord port so the two can never pick the same one.
PORT_ESPLORA=${PORT_ESPLORA:-$(free_port $(( PORT_ORD > 18080 ? PORT_ORD + 1 : 18081 )))}
export ESPLORA="http://127.0.0.1:$PORT_ESPLORA"
export ORD="http://127.0.0.1:$PORT_ORD"


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
  pkill -f -- "proxy.py" 2>/dev/null
  pkill -f -- "http.server $PORT_STATIC" 2>/dev/null
  kill_rig_chrome
  $BB/bitcoin-cli -datadir=$RIG/btc stop >/dev/null 2>&1
  sleep 2
}
trap cleanup EXIT

echo "--- clearing whatever the previous run left behind"
# RIG_RESET=1 starts from an empty chain and a fresh ord index (the RPC
# config is kept). A datadir reused across many runs accumulates blocks and
# wallets; ord catch-up then lags the tests and funding looks broken even
# though the app is fine.
if [ "${RIG_RESET:-0}" = "1" ]; then
  echo "    RIG_RESET=1: wiping chain state and ord index"
  $BB/bitcoin-cli -datadir=$RIG/btc stop >/dev/null 2>&1
  sleep 2
  rm -rf "$RIG/btc/regtest" "$RIG/ord" "$RIG/chrome-live" "$RIG/chrome-live2"
fi
pkill -f -- "--data-dir $RIG/ord" 2>/dev/null
pkill -f -- "esplora_shim.py" 2>/dev/null
pkill -f -- "proxy.py" 2>/dev/null
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

echo "--- Esplora shim ($PORT_ESPLORA) + ord proxy ($PORT_ORD)"
rm -f "$LOG/esplora.jsonl" "$LOG/ord.log.jsonl"
( cd "$ROOT/web/tests/rig" && \
  BITCOIND_DATADIR=$RIG/btc BITCOIND_RPC=127.0.0.1:19743 \
  BITCOIND_RPC_USER=hoppere2e BITCOIND_RPC_PASS=e2ehoppere2e \
  ESPLORA_PORT=$PORT_ESPLORA ESPLORA_LOG=$LOG/esplora.jsonl \
  setsid nohup python3 esplora_shim.py >"$LOG/shim.out" 2>&1 </dev/null & echo $! ) > /tmp/rig_pid
pids+=($(cat /tmp/rig_pid)); rm -f /tmp/rig_pid
( cd "$ROOT/web/tests/rig" && \
  setsid nohup python3 proxy.py --listen $PORT_ORD --upstream 127.0.0.1:18780 --log "$LOG/ord.log.jsonl" \
  >"$LOG/proxy.out" 2>&1 </dev/null & echo $! ) > /tmp/rig_pid
pids+=($(cat /tmp/rig_pid)); rm -f /tmp/rig_pid
shim_up=0
for i in $(seq 1 40); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT_ESPLORA/blocks/tip/height" >/dev/null 2>&1; then
    shim_up=1; break
  fi
  sleep 0.5
done
[ "$shim_up" = 1 ] || { echo "    shim did not come up on $PORT_ESPLORA"; tail -3 "$LOG/shim.out"; exit 2; }
proxy_up=0
for i in $(seq 1 40); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT_ORD/status" >/dev/null 2>&1; then
    proxy_up=1; break
  fi
  sleep 0.5
done
[ "$proxy_up" = 1 ] || { echo "    ord proxy did not come up on $PORT_ORD"; tail -5 "$LOG/proxy.out"; exit 2; }

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
