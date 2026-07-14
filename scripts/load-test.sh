#!/usr/bin/env bash
# Génère de la charge HTTP sur le service catalogue pour déclencher le HPA.
# Nécessite : curl, bc
#
# Usage: bash scripts/load-test.sh [BASE_URL] [DURÉE_SECONDES] [CONCURRENCE]
#   BASE_URL     URL de base du cluster (défaut: http://microservice-app.local)
#   DURÉE        durée de la charge en secondes (défaut: 120)
#   CONCURRENCE  nombre de workers parallèles (défaut: 20)
#
# Exemple soutenance :
#   Terminal 1 : kubectl -n microservice-app get hpa -w
#   Terminal 2 : bash scripts/load-test.sh

set -euo pipefail

BASE_URL="${1:-http://microservice-app.local}"
DURATION="${2:-120}"
CONCURRENCY="${3:-20}"
TARGET="${BASE_URL}/api/catalogue/products"

# Fichier de signal d'arrêt partagé entre les workers
STOP_FILE="$(mktemp)"

cleanup() {
  touch "$STOP_FILE"
  wait 2>/dev/null || true
  rm -f "$STOP_FILE"
  echo ""
  echo "==> Charge arrêtée."
}
trap cleanup EXIT INT TERM

worker() {
  while [ ! -f "$STOP_FILE" ]; do
    curl -s -o /dev/null "$TARGET" || true
  done
}

echo "==> Load test sur ${TARGET}"
echo "    Concurrence : ${CONCURRENCY} workers | Durée : ${DURATION}s"
echo "    Surveiller le HPA dans un autre terminal :"
echo "      kubectl -n microservice-app get hpa -w"
echo ""

# Lancer les workers en arrière-plan
for i in $(seq 1 "$CONCURRENCY"); do
  worker &
done

# Compteur de progression
START=$(date +%s)
END=$((START + DURATION))
while [ "$(date +%s)" -lt "$END" ]; do
  ELAPSED=$(( $(date +%s) - START ))
  REMAINING=$((DURATION - ELAPSED))
  printf "\r    %3ds écoulées, %3ds restantes — %d workers actifs" \
    "$ELAPSED" "$REMAINING" "$CONCURRENCY"
  sleep 2
done

touch "$STOP_FILE"
