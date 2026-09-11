#!/usr/bin/env bash
# Pi Web UI — istanza autonoma (add-on HA)
# Avvia il server pi-web-ui su :8888 e il proxy ingress su :3000.

set -e
echo "Pi Web addon avvio: $(date -Is)"

CWD="${PI_ADDON_CWD:-/data/workspace}"
DATA_DIR="${PI_ADDON_DATA:-/data/pi-web-data}"
AGENT_DIR="${PI_ADDON_AGENT:-/data/pi-web-agent}"
mkdir -p "$CWD" "$DATA_DIR" "$AGENT_DIR"

# 1. pi-web-ui su :8888 (foreground; shutdown pulito su TERM/INT)
PI_WEB_PORT=8888 PI_WEB_HOST=127.0.0.1 \
  pi-web-ui --port 8888 --host 127.0.0.1 --no-browser \
  --cwd "$CWD" --data-dir "$DATA_DIR" --agent-dir "$AGENT_DIR" \
  > /data/pi-web.log 2>&1 &
SERVER_PID=$!
echo "pi-web-ui PID=$SERVER_PID"

# 2. proxy ingress: :3000 -> 127.0.0.1:8888 (gestisce X-Ingress-Path e WS)
LISTEN_PORT=3000 node /proxy.mjs > /data/pi-web-proxy.log 2>&1 &
PROXY_PID=$!
echo "proxy PID=$PROXY_PID"

trap 'kill $PROXY_PID $SERVER_PID 2>/dev/null; exit' TERM INT
wait $SERVER_PID