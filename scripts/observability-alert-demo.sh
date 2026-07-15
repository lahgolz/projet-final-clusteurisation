#!/usr/bin/env bash

set -euo pipefail

NS="microservice-app"
MONITORING_NS="monitoring"
RELEASE="${OBSERVABILITY_RELEASE:-kube-prometheus-stack}"
DEPLOYMENT="orders"
PROM_PORT=9090
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

ORIGINAL_REPLICAS=$(kubectl -n "$NS" get deployment "$DEPLOYMENT" -o jsonpath='{.spec.replicas}')
echo "==> Replicas actuels de ${DEPLOYMENT} : ${ORIGINAL_REPLICAS} (restaurés en fin de script)"

echo "==> Ouverture d'un port-forward vers Prometheus (${RELEASE}-prometheus)"
kubectl -n "$MONITORING_NS" port-forward "svc/${RELEASE}-prometheus" "${PROM_PORT}:9090" \
  >"${WORKDIR}/pf-prometheus.log" 2>&1 &
pids+=("$!")

for _ in $(seq 1 30); do
  curl -sS -o /dev/null --max-time 2 "http://127.0.0.1:${PROM_PORT}/-/ready" && break
  sleep 1
done

alert_state() {
  curl -sS --max-time 5 "http://127.0.0.1:${PROM_PORT}/api/v1/alerts" | python3 -c '
import json, sys
data = json.load(sys.stdin)
states = [
    a["state"]
    for a in data["data"]["alerts"]
    if a["labels"].get("alertname") == "ServiceWithoutAvailableReplica"
]
print(states[0] if states else "")
'
}

echo "==> Mise à l'échelle de ${DEPLOYMENT} à 0 replica pour simuler une indisponibilité"
kubectl -n "$NS" scale "deployment/${DEPLOYMENT}" --replicas=0
kubectl -n "$NS" wait --for=delete pod -l "app.kubernetes.io/name=${DEPLOYMENT}" --timeout=60s || true

echo "==> Attente du déclenchement de l'alerte (seuil : for 2m dans alerts.yaml)"
echo "    État observé toutes les 15s pendant au plus 4 minutes :"
FIRED=false
for i in $(seq 1 16); do
  STATE=$(alert_state || true)
  echo "    [t+$((i * 15))s] ServiceWithoutAvailableReplica: ${STATE:-absent (inactive)}"
  if [ "$STATE" = "firing" ]; then
    FIRED=true
    break
  fi
  sleep 15
done

if [ "$FIRED" = true ]; then
  echo "==> Alerte déclenchée avec succès (state=firing)."
else
  echo "==> Alerte non confirmée en firing dans le délai imparti ; vérifiez :"
  echo "    kubectl -n ${MONITORING_NS} port-forward svc/${RELEASE}-prometheus 9090:9090"
  echo "    puis http://127.0.0.1:9090/alerts"
fi

echo "==> Restauration de ${DEPLOYMENT} à ${ORIGINAL_REPLICAS} replica(s)"
kubectl -n "$NS" scale "deployment/${DEPLOYMENT}" --replicas="${ORIGINAL_REPLICAS}"
kubectl -n "$NS" rollout status "deployment/${DEPLOYMENT}" --timeout=120s

echo "==> Démo d'alerte terminée."
