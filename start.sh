#!/usr/bin/env bash
# Launch the Wargames ADS-B console (and dump1090-fa if needed).
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

LAT="${LAT:-32.9}"
LON="${LON:--97.0}"
PORT="${PORT:-8090}"
DEMO=0
UI_ONLY=0

usage() {
  cat <<EOF
Usage: ./start.sh [--demo] [--ui]

  (default)  Start dump1090-fa if :30003 is free, then open the CRT map.
  --ui       UI only — attach to an already-running dump1090 --net
  --demo     UI only with simulated DFW traffic (no radio)

Env: LAT LON PORT   (defaults 32.9  -97.0  8090)

CubicSDR / GQRX / anything else must release the RTL-SDR first.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --demo) DEMO=1 ;;
    --ui|--ui-only) UI_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; usage; exit 2 ;;
  esac
done

mkdir -p "$ROOT/wargames/run"

listening() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

if listening "$PORT"; then
  echo "port $PORT already in use — opening existing console"
  open "http://127.0.0.1:${PORT}/" 2>/dev/null || true
  exit 0
fi

if [[ "$DEMO" -eq 0 && "$UI_ONLY" -eq 0 ]]; then
  if listening 30003; then
    echo "dump1090 already listening on :30003 — attaching"
  else
    if ! command -v dump1090 >/dev/null 2>&1; then
      echo "dump1090 not on PATH. brew install dump1090-fa   (or use ./start.sh --demo)"
      exit 1
    fi
    echo "starting dump1090-fa  1090 MHz  origin ${LAT} ${LON}"
    echo "(if this fails, quit CubicSDR so it releases the dongle)"
    dump1090 --quiet --net \
      --lat "$LAT" --lon "$LON" \
      --write-json "$ROOT/wargames/run" \
      --write-json-every 0.5 \
      --json-location-accuracy 2 \
      >"$ROOT/wargames/run/dump1090.log" 2>&1 &
    echo $! >"$ROOT/wargames/run/dump1090.pid"
    sleep 1.4
    if ! listening 30003; then
      echo "dump1090 did not come up. Last log:"
      tail -n 25 "$ROOT/wargames/run/dump1090.log" || true
      echo "console will run in SIMULATION until a receiver is available"
    else
      echo "dump1090 up  SBS :30003  Beast :30005  json $ROOT/wargames/run"
    fi
  fi
fi

ARGS=(--lat "$LAT" --lon "$LON" --port "$PORT" --json-dir "$ROOT/wargames/run")
if [[ "$DEMO" -eq 1 ]]; then
  ARGS+=(--demo)
fi

python3 "$ROOT/wargames/server.py" "${ARGS[@]}" &
SERVER_PID=$!
echo "$SERVER_PID" >"$ROOT/wargames/run/server.pid"

cleanup() {
  echo
  echo "stopping console (dump1090 left running if we started it)"
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup INT TERM

for i in 1 2 3 4 5 6 7 8 9 10; do
  if listening "$PORT"; then
    break
  fi
  sleep 0.2
done

echo "Wargames console  http://127.0.0.1:${PORT}/"
if command -v tailscale >/dev/null 2>&1; then
  TS_IP=$(tailscale ip -4 2>/dev/null | awk '/^100\./{print; exit}')
  if [[ -n "${TS_IP:-}" ]]; then
    echo "  tailscale        http://${TS_IP}:${PORT}/"
  fi
fi
open "http://127.0.0.1:${PORT}/" 2>/dev/null || true
wait "$SERVER_PID"
