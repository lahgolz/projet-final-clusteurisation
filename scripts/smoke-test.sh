#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

GATEWAY_URL="http://localhost:${GATEWAY_PORT:-8080}"
COMPOSE_PROJECT="microshop-smoke"
COMPOSE="docker compose -p ${COMPOSE_PROJECT}"

cleanup() {
  local exit_code=$?
  echo "==> Arrêt et nettoyage de la stack (docker compose down -v)"
  ${COMPOSE} down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$exit_code"
}
trap cleanup EXIT

fail() {
  echo "ÉCHEC: $1" >&2
  ${COMPOSE} logs --tail=50
  exit 1
}

echo "==> Construction des images"
${COMPOSE} build

echo "==> Démarrage de la stack (postgres, migrate, seed, catalogue, orders, frontend, gateway)"
${COMPOSE} up -d

echo "==> Attente que tous les services applicatifs soient en bonne santé"
ATTEMPTS=0
until [ "$(${COMPOSE} ps --format '{{.Health}}' catalogue orders frontend 2>/dev/null | sort -u)" = "healthy" ]; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge 60 ]; then
    fail "les services ne sont pas devenus healthy à temps"
  fi
  sleep 2
done
echo "    tous les services applicatifs sont healthy (${ATTEMPTS}x2s)"

echo "==> Vérification: migrate et seed se sont terminés avec succès"
[ "$(${COMPOSE} ps -a --format '{{.State}}' migrate)" = "exited" ] || fail "le job migrate n'est pas terminé"
[ "$(${COMPOSE} ps -a --format '{{.ExitCode}}' migrate)" = "0" ] || fail "le job migrate a échoué"
[ "$(${COMPOSE} ps -a --format '{{.State}}' seed)" = "exited" ] || fail "le job seed n'est pas terminé"
[ "$(${COMPOSE} ps -a --format '{{.ExitCode}}' seed)" = "0" ] || fail "le job seed a échoué"

echo "==> Listing des produits via la gateway"
PRODUCTS_STATUS=$(curl -sS -o /tmp/smoke-products.json -w '%{http_code}' "${GATEWAY_URL}/api/catalogue/products")
[ "$PRODUCTS_STATUS" = "200" ] || fail "GET /api/catalogue/products a renvoyé ${PRODUCTS_STATUS}"
grep -q '"products"' /tmp/smoke-products.json || fail "réponse catalogue inattendue"
PRODUCT_ID=$(grep -o '"id":"[a-f0-9-]*"' /tmp/smoke-products.json | head -1 | cut -d'"' -f4)
[ -n "$PRODUCT_ID" ] || fail "impossible d'extraire un productId depuis le catalogue"
echo "    OK (produit de test: ${PRODUCT_ID})"

echo "==> Création d'une commande via la gateway"
ORDER_STATUS=$(curl -sS -o /tmp/smoke-order.json -w '%{http_code}' -X POST "${GATEWAY_URL}/api/orders" \
  -H 'content-type: application/json' \
  -d "{\"items\":[{\"productId\":\"${PRODUCT_ID}\",\"quantity\":1}]}")
[ "$ORDER_STATUS" = "201" ] || fail "POST /api/orders a renvoyé ${ORDER_STATUS}"
ORDER_ID=$(grep -o '"id":"[a-f0-9-]*"' /tmp/smoke-order.json | head -1 | cut -d'"' -f4)
[ -n "$ORDER_ID" ] || fail "impossible d'extraire l'id de la commande créée"
echo "    OK (commande créée: ${ORDER_ID})"

echo "==> Redémarrage de l'API orders et vérification de la persistance de la commande"
${COMPOSE} restart orders >/dev/null
ATTEMPTS=0
until [ "$(${COMPOSE} ps --format '{{.Health}}' orders 2>/dev/null)" = "healthy" ]; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge 30 ]; then
    fail "orders n'est pas redevenu healthy après redémarrage"
  fi
  sleep 2
done
GET_ORDER_STATUS=$(curl -sS -o /tmp/smoke-order-get.json -w '%{http_code}' "${GATEWAY_URL}/api/orders/${ORDER_ID}")
[ "$GET_ORDER_STATUS" = "200" ] || fail "GET /api/orders/${ORDER_ID} après redémarrage a renvoyé ${GET_ORDER_STATUS}"
grep -q "\"${ORDER_ID}\"" /tmp/smoke-order-get.json || fail "la commande n'a pas persisté après redémarrage"
echo "    OK (commande toujours présente après redémarrage)"

echo "==> Vérification: aucun conteneur applicatif ne tourne en root"

for service in catalogue orders frontend; do
  CONTAINER_ID=$(${COMPOSE} ps -q "$service")
  CONTAINER_USER=$(docker inspect --format '{{.Config.User}}' "$CONTAINER_ID")
  case "$CONTAINER_USER" in
    "" | "0" | "root" | "0:0")
      fail "le conteneur ${service} tourne en root (user='${CONTAINER_USER}')"
      ;;
  esac
done
echo "    OK (catalogue, orders, frontend tournent en non-root)"

echo "==> Healthz du frontend via la gateway"
HEALTHZ_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' "${GATEWAY_URL}/healthz" || true)

[ "$HEALTHZ_STATUS" = "200" ] || fail "GET /healthz via la gateway a renvoyé ${HEALTHZ_STATUS}"
echo "    OK"

rm -f /tmp/smoke-products.json /tmp/smoke-order.json /tmp/smoke-order-get.json

echo "==> Smoke test réussi"
