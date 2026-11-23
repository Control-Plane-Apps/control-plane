#!/usr/bin/env bash
# Two fresh test servers ("mini", "macbook") and a mock Task Sync cloud, to
# check task authority, the task tools' refusal, rollover handover and the
# rollover gap. Never touches ~/.t3 or the real cloud.
#
#   run.sh up        start mock cloud + both servers, link both ways, seed
#   run.sh status    print each server's Task Sync status (authority block)
#   run.sh signin <server>   sign that server in to the mock cloud
#   run.sh cloud     print the mock cloud's membership pushes per device
#   run.sh down      stop everything
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(cd "$HERE/../.." && pwd)"
DIR="${TA_E2E_DIR:-/tmp/cs-ta}"
CLOUD_PORT=47790
port() { if [ "$1" = mini ]; then echo 47781; else echo 47782; fi; }
export CPLANE_TASK_SYNC_URL="http://127.0.0.1:$CLOUD_PORT"
export CPLANE_TASK_SYNC_CLIENT_KEY_ID="e2e-key"
export CPLANE_TASK_SYNC_CLIENT_SECRET="$(printf 'a%.0s' {1..64})"

url() { echo "http://127.0.0.1:$(port "$1")"; }
t3() { (cd "$SERVER_DIR" && node src/bin.ts "$@"); }
rpc() { (cd "$SERVER_DIR" && node scripts/task-authority-e2e/rpc.ts "$(url "$1")" "$(cat "$DIR/$1.op")" "${@:2}"); }

start_server() {
  local name=$1
  (cd "$SERVER_DIR" && nohup node src/bin.ts serve --base-dir "$DIR/$name" \
    --port "$(port "$name")" --host "${TA_E2E_HOST:-127.0.0.1}" "$DIR/ws-$name" >"$DIR/$name.log" 2>&1 &
    echo $! >"$DIR/$name.pid")
  for _ in $(seq 1 120); do
    curl -sf -m 3 "$(url "$name")/.well-known/t3/environment" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "server $name did not come up" >&2
  exit 1
}

stop_server() {
  local name=$1
  pkill -f "serve --base-dir $DIR/$name " 2>/dev/null || true
  rm -f "$DIR/$name.pid"
  for _ in $(seq 1 30); do
    pgrep -f "serve --base-dir $DIR/$name " >/dev/null || return 0
    sleep 1
  done
}

case "${1:-}" in
up)
  mkdir -p "$DIR/ws-mini" "$DIR/ws-macbook"
  nohup python3 -I "$HERE/mockcloud.py" "$CLOUD_PORT" >"$DIR/cloud.log" 2>&1 &
  echo $! >"$DIR/cloud.pid"
  for name in mini macbook; do start_server "$name"; done
  for name in mini macbook; do
    t3 auth session issue --base-dir "$DIR/$name" --token-only --ttl 1d >"$DIR/$name.op"
  done
  # Link both ways, then restart so each reads its new settings.
  (cd "$SERVER_DIR" && node scripts/reach-e2e/link.ts "$DIR/mini" "$(url macbook)" \
    "$(t3 auth pairing create --base-dir "$DIR/macbook" --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["credential"])')" MacBook)
  (cd "$SERVER_DIR" && node scripts/reach-e2e/link.ts "$DIR/macbook" "$(url mini)" \
    "$(t3 auth pairing create --base-dir "$DIR/mini" --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["credential"])')" "Mac mini")
  for name in mini macbook; do stop_server "$name"; start_server "$name"; done
  echo "up: $DIR"
  ;;
status)
  for name in mini macbook; do echo "== $name"; rpc "$name" taskSync.status; done
  ;;
signin)
  rpc "$2" taskSync.requestCode '{"email":"e2e@example.com"}' >/dev/null
  rpc "$2" taskSync.verify '{"email":"e2e@example.com","code":"123456"}'
  ;;
restart)
  stop_server "$2"; start_server "$2"
  ;;
cloud)
  curl -s "http://127.0.0.1:$CLOUD_PORT/_mock/state"
  ;;
down)
  for name in mini macbook; do stop_server "$name"; done
  [ -f "$DIR/cloud.pid" ] && kill "$(cat "$DIR/cloud.pid")" 2>/dev/null || true
  rm -f "$DIR/cloud.pid"
  ;;
*)
  sed -n '2,10p' "$0"
  exit 1
  ;;
esac
