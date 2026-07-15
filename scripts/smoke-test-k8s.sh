#!/usr/bin/env bash

set -euo pipefail

NS="${K8S_NAMESPACE:-microservice-app}"
WORKDIR="$(mktemp -d)"

pids=()

cleanup() {
  local exit_code=$?
  for pid in "${pids[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  rm -rf "$WORKDIR"
  exit "$exit_code"
}
trap cleanup EXIT

fail() {
  echo "ÉCHEC (smoke test k8s) : $1" >&2
  exit 1
}

forward() {
  local service="$1" local_port="$2" remote_port="$3" log_file="$4"
  kubectl -n "$NS" port-forward "svc/${service}" "${local_port}:${remote_port}" >"$log_file" 2>&1 &
  pids+=("$!")
}

wait_for_http() {
  local port="$1" path="$2"
  for _ in $(seq 1 30); do
    if curl -sS -o /dev/null --max-time 2 "http://127.0.0.1:${port}${path}" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  fail "le port-forward vers 127.0.0.1:${port} n'a jamais répondu"
}

echo "==> Ouverture des port-forwards (catalogue:4001, orders:4002, frontend:8080)"
forward catalogue 4001 4001 "${WORKDIR}/pf-catalogue.log"
forward orders 4002 4002 "${WORKDIR}/pf-orders.log"
forward frontend 8080 80 "${WORKDIR}/pf-frontend.log"
wait_for_http 4001 /health/live
wait_for_http 4002 /health/live
wait_for_http 8080 /healthz

echo "==> Vérification santé catalogue (/health/ready)"
CAT_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:4001/health/ready")
[ "$CAT_STATUS" = "200" ] || fail "catalogue /health/ready a renvoyé ${CAT_STATUS}"

echo "==> Vérification santé orders (/health/ready)"
ORD_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:4002/health/ready")
[ "$ORD_STATUS" = "200" ] || fail "orders /health/ready a renvoyé ${ORD_STATUS}"

echo "==> Vérification frontend (/healthz)"
FRONT_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:8080/healthz")
[ "$FRONT_STATUS" = "200" ] || fail "frontend /healthz a renvoyé ${FRONT_STATUS}"

echo "==> Listing des produits (catalogue)"
PRODUCTS_STATUS=$(curl -sS -o "${WORKDIR}/products.json" -w '%{http_code}' --max-time 5 \
  "http://127.0.0.1:4001/api/catalogue/products")
[ "$PRODUCTS_STATUS" = "200" ] || fail "GET /api/catalogue/products a renvoyé ${PRODUCTS_STATUS}"
grep -q '"products"' "${WORKDIR}/products.json" || fail "réponse catalogue inattendue"
PRODUCT_ID=$(grep -o '"id":"[a-f0-9-]*"' "${WORKDIR}/products.json" | head -1 | cut -d'"' -f4)
[ -n "$PRODUCT_ID" ] || fail "impossible d'extraire un productId depuis le catalogue (base vide/non seedée ?)"
echo "    OK (produit de test : ${PRODUCT_ID})"

echo "==> Création d'une commande (orders)"
ORDER_STATUS=$(curl -sS -o "${WORKDIR}/order.json" -w '%{http_code}' --max-time 5 \
  -X POST "http://127.0.0.1:4002/api/orders" \
  -H 'content-type: application/json' \
  -d "{\"items\":[{\"productId\":\"${PRODUCT_ID}\",\"quantity\":1}]}")
[ "$ORDER_STATUS" = "201" ] || fail "POST /api/orders a renvoyé ${ORDER_STATUS}"
ORDER_ID=$(grep -o '"id":"[a-f0-9-]*"' "${WORKDIR}/order.json" | head -1 | cut -d'"' -f4)
[ -n "$ORDER_ID" ] || fail "impossible d'extraire l'id de la commande créée"
echo "    OK (commande créée : ${ORDER_ID})"

echo "==> Suppression des pods orders (self-healing) et vérification de la persistance"

kubectl -n "$NS" delete pod -l app.kubernetes.io/name=orders --wait=false
kubectl -n "$NS" rollout status deployment/orders --timeout=120s

kill "${pids[1]}" >/dev/null 2>&1 || true
forward orders 4002 4002 "${WORKDIR}/pf-orders-2.log"
wait_for_http 4002 /health/live

GET_ORDER_STATUS=$(curl -sS -o "${WORKDIR}/order-get.json" -w '%{http_code}' --max-time 5 \
  "http://127.0.0.1:4002/api/orders/${ORDER_ID}")
[ "$GET_ORDER_STATUS" = "200" ] || fail "GET /api/orders/${ORDER_ID} après recréation des pods a renvoyé ${GET_ORDER_STATUS}"
grep -q "\"${ORDER_ID}\"" "${WORKDIR}/order-get.json" || fail "la commande n'a pas persisté après recréation des pods"
echo "    OK (commande toujours présente après recréation des pods orders)"

echo "==> Smoke test Kubernetes réussi"
