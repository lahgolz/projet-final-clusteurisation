#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${1:-http://microservice-app.local}"
DURATION="${2:-120}"
CONCURRENCY="${3:-20}"
TARGET="${BASE_URL}/api/catalogue/products"

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

for i in $(seq 1 "$CONCURRENCY"); do
  worker &
done

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
