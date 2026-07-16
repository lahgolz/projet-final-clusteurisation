#!/usr/bin/env bash

# Remet l'environnement de démo dans son état initial pour pouvoir rejouer
# scripts/demo.sh depuis le début, sans redéployer ni reconstruire les images :
#   - stoppe les port-forwards laissés ouverts (catalogue, orders, frontend, Grafana, Prometheus)
#   - stoppe un load-test.sh resté actif
#   - rétablit les replicas de base (catalogue/orders/frontend = 1, cf. k8s/overlays/dev/replicas.yaml)
#   - vide les commandes de démo (orders/order_items) et réinsère le catalogue de référence (job db-seed)
#   - affiche l'état final
#
# Usage : bash scripts/demo-reset.sh [overlay]
#   overlay par défaut : dev (k8s/overlays/dev)

set -euo pipefail

NS="microservice-app"
OVERLAY="${1:-dev}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

header() {
  echo ""
  echo "══════════════════════════════════════════════════════════════════"
  echo "  $1"
  echo "══════════════════════════════════════════════════════════════════"
}

header "1. Arrêt des port-forwards et charges résiduelles"
pkill -f "kubectl.*port-forward.*(catalogue|orders|frontend|grafana|prometheus)" 2>/dev/null \
  && echo "  Port-forwards arrêtés." || echo "  Aucun port-forward actif."
pkill -f "load-test.sh|load-test-k6.sh" 2>/dev/null \
  && echo "  Génération de charge arrêtée." || echo "  Aucune charge en cours."

header "2. Retour aux replicas de base (catalogue=1, orders=1, frontend=1)"
# catalogue est piloté par le HPA : le supprimer avant de scaler manuellement évite qu'il
# ne re-scale pendant la fenêtre de stabilisation (sinon le reset peut rester bloqué à 2-3
# replicas plusieurs minutes). Il est recréé par le kustomize apply de l'étape 4.
kubectl -n "$NS" delete hpa catalogue --ignore-not-found
kubectl -n "$NS" scale deployment/catalogue --replicas=1
kubectl -n "$NS" scale deployment/orders --replicas=1
kubectl -n "$NS" scale deployment/frontend --replicas=1
kubectl -n "$NS" rollout status deployment/catalogue --timeout=120s
kubectl -n "$NS" rollout status deployment/orders --timeout=120s
kubectl -n "$NS" rollout status deployment/frontend --timeout=120s

header "3. Nettoyage des commandes créées pendant la démo"
POSTGRES_USER=$(kubectl -n "$NS" get secret microservice-app-db -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
POSTGRES_DB=$(kubectl -n "$NS" get secret microservice-app-db -o jsonpath='{.data.POSTGRES_DB}' | base64 -d)
kubectl -n "$NS" exec -i postgres-0 -- \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "TRUNCATE TABLE orders CASCADE;"

header "4. Réinsertion du catalogue de référence (stocks d'origine) et du HPA"
overlay_path="k8s/overlays/${OVERLAY}"
# Les Jobs db-migrate/db-seed ont un ttlSecondsAfterFinished : ils peuvent avoir déjà été
# supprimés automatiquement par Kubernetes, ou être restés dans un état "Complete" plus ancien.
# On les supprime puis on les recrée via Kustomize pour forcer une exécution fraîche du seed
# (upsert idempotent, cf. packages/db/seeds/seed.ts, qui réinitialise aussi les stocks) ; le
# même apply recrée le HPA catalogue (minReplicas=1, maxReplicas=3, cf. overlays/dev/hpa.yaml).
kubectl -n "$NS" delete job db-migrate db-seed --ignore-not-found
kubectl apply -k "${REPO_ROOT}/${overlay_path}"
kubectl -n "$NS" wait --for=condition=complete job/db-migrate --timeout=180s
kubectl -n "$NS" wait --for=condition=complete job/db-seed --timeout=180s

header "5. État final"
kubectl -n "$NS" get deploy,hpa,pods -o wide

echo ""
echo "Environnement remis à l'état initial. La démo (bash scripts/demo.sh) peut être rejouée."
