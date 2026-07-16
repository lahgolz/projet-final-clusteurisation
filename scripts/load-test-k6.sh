#!/usr/bin/env bash

set -euo pipefail

NS="${K8S_NAMESPACE:-microservice-app}"
REPORT_FILE="${1:-/tmp/k6-load-test-samples.csv}"
MONITOR_INTERVAL=5

echo "==> Suppression d'un éventuel Job k6 précédent (le pod template d'un Job est immuable)"
kubectl -n "$NS" delete job k6-load-test --ignore-not-found --wait=true

echo "==> Application des manifests de test de charge (Job k6 + ConfigMap + NetworkPolicy)"
kubectl apply -k k8s/load-test

echo "timestamp,catalogue_current_replicas,catalogue_desired_replicas,catalogue_cpu_pct,catalogue_top,orders_top,postgres_top,postgres_connections" > "$REPORT_FILE"

sample() {
  local ts current desired cpu cat_top ord_top pg_top pg_conn
  ts=$(date -u +%H:%M:%S)
  current=$(kubectl -n "$NS" get hpa catalogue -o jsonpath='{.status.currentReplicas}' 2>/dev/null || echo "?")
  desired=$(kubectl -n "$NS" get hpa catalogue -o jsonpath='{.status.desiredReplicas}' 2>/dev/null || echo "?")
  cpu=$(kubectl -n "$NS" get hpa catalogue -o jsonpath='{.status.currentMetrics[0].resource.current.averageUtilization}' 2>/dev/null || echo "?")
  cat_top=$(kubectl -n "$NS" top pods -l app.kubernetes.io/name=catalogue --no-headers 2>/dev/null | awk '{printf "%s/%s;",$2,$3}')
  ord_top=$(kubectl -n "$NS" top pods -l app.kubernetes.io/name=orders --no-headers 2>/dev/null | awk '{printf "%s/%s;",$2,$3}')
  pg_top=$(kubectl -n "$NS" top pods -l app.kubernetes.io/name=postgres --no-headers 2>/dev/null | awk '{print $2"/"$3}')
  pg_conn=$(kubectl -n "$NS" exec postgres-0 -- sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM pg_stat_activity;"' 2>/dev/null || echo "?")
  echo "${ts},${current},${desired},${cpu},${cat_top},${ord_top},${pg_top},${pg_conn}" >> "$REPORT_FILE"
}

echo "==> Échantillon initial (avant charge)"
sample

echo "==> Démarrage de l'échantillonnage en arrière-plan (toutes les ${MONITOR_INTERVAL}s)"
(
  while kubectl -n "$NS" get job k6-load-test -o jsonpath='{.status.active}' 2>/dev/null | grep -q 1; do
    sample
    sleep "$MONITOR_INTERVAL"
  done
) &
MONITOR_PID=$!

echo "==> Attente que le pod k6 démarre..."
kubectl -n "$NS" wait --for=condition=ready pod -l app.kubernetes.io/name=k6-load-test --timeout=60s || true

echo "==> Suivi des logs k6 (le scénario dure ~2-3 minutes : montée, palier, descente)"
kubectl -n "$NS" logs -f job/k6-load-test || true

kubectl -n "$NS" wait --for=condition=complete job/k6-load-test --timeout=300s || \
  echo "AVERTISSEMENT : le Job ne s'est pas terminé avec succès, voir 'kubectl -n $NS get job k6-load-test'"

kill "$MONITOR_PID" 2>/dev/null || true
wait "$MONITOR_PID" 2>/dev/null || true

echo "==> Échantillons supplémentaires après la charge (retour au minimum, jusqu'à ~2 min)"
for _ in 1 2 3 4; do
  sleep 30
  sample
done

echo ""
echo "==> Échantillons enregistrés dans : $REPORT_FILE"
column -t -s, "$REPORT_FILE"

echo ""
echo "==> Nettoyage du Job de charge (le ConfigMap/NetworkPolicy restent pour une prochaine exécution)"
kubectl -n "$NS" delete job k6-load-test --ignore-not-found
