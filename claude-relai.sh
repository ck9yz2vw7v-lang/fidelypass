#!/bin/zsh
# Lance Claude Code via OmniRoute quand la limite d'usage Claude est atteinte.
# Utilise le combo "relai" configure dans le dashboard OmniRoute (http://localhost:20128).
# Usage : ./claude-relai.sh [arguments claude...]

PORT=20128
COMBO="${OMNIROUTE_COMBO:-relai}"

# Demarre OmniRoute s'il ne tourne pas (ecoute uniquement sur cette machine)
if ! curl -s "http://127.0.0.1:$PORT/api/monitoring/health" | grep -q healthy; then
  echo "Demarrage d'OmniRoute..."
  OMNIROUTE_SERVER_HOST=127.0.0.1 omniroute serve --daemon --no-open --no-tray >/dev/null 2>&1
  for i in {1..60}; do
    curl -s "http://127.0.0.1:$PORT/api/monitoring/health" | grep -q healthy && break
    sleep 1
  done
fi

cd "$(dirname "$0")" && exec omniroute launch --port "$PORT" -- --model "$COMBO" "$@"
