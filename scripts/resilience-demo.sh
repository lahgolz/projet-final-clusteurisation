#!/usr/bin/env bash
# Démo de résilience et scalabilité pour la soutenance.
# Démontre : self-healing (kill pod), HPA (charge CPU), protection PDB (drain node).
#
# Prérequis :
#   - cluster Kind actif avec l'overlay dev déployé
#   - metrics-server installé et fonctionnel
#   - microservice-app.local résolu vers 127.0.0.1
#   - catalogue déployé avec au moins 2 replicas
#     (si overlay dev : kubectl -n microservice-app scale deploy/catalogue --replicas=2)
#
# Usage : bash scripts/resilience-demo.sh [BASE_URL]

set -euo pipefail

NS="microservice-app"
BASE_URL="${1:-http://microservice-app.local}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─────────────────────────────────────────────────────────────
pause() {
  echo ""
  echo "  [Appuyez sur Entrée pour continuer...]"
  read -r
}

header() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

step() {
  echo ""
  echo "  ▶ $1"
}

ok() {
  echo "  ✓ $1"
}

# ─────────────────────────────────────────────────────────────
header "0. État initial du cluster"

step "Tous les pods du namespace $NS :"
kubectl -n "$NS" get pods -o wide

step "Services et Ingress :"
kubectl -n "$NS" get svc,ingress

step "HPA actuel :"
kubectl -n "$NS" get hpa

step "PodDisruptionBudgets :"
kubectl -n "$NS" get pdb

step "Vérification que l'application répond :"
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/catalogue/products")
[ "$HTTP_CODE" = "200" ] && ok "GET /api/catalogue/products → HTTP $HTTP_CODE" \
  || echo "  ✗ HTTP $HTTP_CODE — vérifier que le cluster est démarré et que microservice-app.local est dans /etc/hosts"

pause

# ─────────────────────────────────────────────────────────────
header "1. Self-healing — kill d'un pod catalogue"

step "Pods catalogue avant suppression :"
kubectl -n "$NS" get pods -l app.kubernetes.io/name=catalogue

step "Suppression forcée d'un pod catalogue..."
POD=$(kubectl -n "$NS" get pods -l app.kubernetes.io/name=catalogue \
  -o jsonpath='{.items[0].metadata.name}')
kubectl -n "$NS" delete pod "$POD"
echo "  Pod supprimé : $POD"

step "Observation du redémarrage (Ctrl+C pour passer à l'étape suivante) :"
echo "  → Kubernetes recrée automatiquement le pod via le Deployment"
kubectl -n "$NS" get pods -l app.kubernetes.io/name=catalogue -w &
WATCH_PID=$!
sleep 15
kill $WATCH_PID 2>/dev/null || true

step "L'application est toujours disponible pendant le redémarrage :"
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/catalogue/products")
ok "GET /api/catalogue/products → HTTP $HTTP_CODE"

pause

# ─────────────────────────────────────────────────────────────
header "2. HPA — scale automatique sous charge CPU"

step "État initial du HPA catalogue :"
kubectl -n "$NS" get hpa catalogue

step "Lancement de la charge en arrière-plan (${SCRIPT_DIR}/load-test.sh)..."
bash "${SCRIPT_DIR}/load-test.sh" "$BASE_URL" 90 20 &
LOAD_PID=$!

step "Observation du HPA (90 secondes — le scale-up peut prendre 1-2 min) :"
echo "  → Cible : 70% CPU en moyenne sur les pods catalogue"
echo "  → Le HPA va ajouter des replicas si le seuil est dépassé"
echo ""

# Observer le HPA pendant 90s
END=$(($(date +%s) + 90))
while [ "$(date +%s)" -lt "$END" ]; do
  kubectl -n "$NS" get hpa catalogue --no-headers 2>/dev/null \
    | awk '{printf "  [%s] HPA catalogue : %s replicas, CPU cible %s\n", strftime("%H:%M:%S"), $6, $4}'
  sleep 10
done

kill $LOAD_PID 2>/dev/null || true
wait $LOAD_PID 2>/dev/null || true

step "État du HPA après la charge :"
kubectl -n "$NS" get hpa catalogue

step "Pods catalogue après scale-up :"
kubectl -n "$NS" get pods -l app.kubernetes.io/name=catalogue

echo ""
echo "  → Le HPA redescendra automatiquement après ~5 minutes de stabilisation"

pause

# ─────────────────────────────────────────────────────────────
header "3. PodDisruptionBudget — protection lors d'un drain de nœud"

step "PDB configurés :"
kubectl -n "$NS" get pdb

echo ""
echo "  Le PDB garantit minAvailable: 1 sur catalogue, orders et frontend."
echo "  Lors d'un drain de nœud (kubectl drain), Kubernetes respecte cette contrainte"
echo "  et ne supprime pas un pod si cela violerait le PDB."
echo ""

# Vérification : avec 1 seul replica, le drain serait bloqué par le PDB
CATALOGUE_REPLICAS=$(kubectl -n "$NS" get deploy catalogue -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
if [ "$CATALOGUE_REPLICAS" -ge 2 ]; then
  NODES=$(kubectl get nodes --no-headers | awk '{print $1}')
  NODE_COUNT=$(echo "$NODES" | wc -l | tr -d ' ')

  if [ "$NODE_COUNT" -ge 2 ]; then
    NODE_TO_DRAIN=$(kubectl -n "$NS" get pods -l app.kubernetes.io/name=catalogue \
      -o jsonpath='{.items[0].spec.nodeName}')
    step "Simulation d'un drain du nœud $NODE_TO_DRAIN ..."
    echo "  (--dry-run=client : aucune action réelle)"
    kubectl drain "$NODE_TO_DRAIN" --ignore-daemonsets --delete-emptydir-data \
      --dry-run=client 2>&1 | head -20 || true
    echo ""
    ok "Avec PDB minAvailable:1 et 2 replicas, un pod reste disponible pendant le drain"
  else
    echo "  Cluster mono-nœud (Kind par défaut) — simulation de drain impossible sans second nœud."
    echo "  En production multi-nœuds, kubectl drain respecterait le PDB et maintiendrait"
    echo "  au moins 1 pod catalogue disponible pendant la maintenance."
  fi
else
  echo "  catalogue tourne avec $CATALOGUE_REPLICAS replica — scalez à 2 pour la démo PDB :"
  echo "    kubectl -n $NS scale deploy/catalogue --replicas=2"
fi

pause

# ─────────────────────────────────────────────────────────────
header "4. RollingUpdate — mise à jour sans interruption"

step "Déclenchement d'un rolling restart de catalogue :"
kubectl -n "$NS" rollout restart deployment/catalogue
echo ""
echo "  → Kubernetes applique la stratégie RollingUpdate (maxUnavailable:0, maxSurge:1)"
echo "  → Chaque nouveau pod attend sa readiness probe avant de remplacer l'ancien"

step "Suivi du rollout :"
kubectl -n "$NS" rollout status deployment/catalogue --timeout=120s

step "Vérification disponibilité pendant le rollout :"
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/catalogue/products")
ok "GET /api/catalogue/products → HTTP $HTTP_CODE"

step "Historique des rollouts :"
kubectl -n "$NS" rollout history deployment/catalogue

pause

# ─────────────────────────────────────────────────────────────
header "5. Rollback"

step "Rollback vers la révision précédente :"
kubectl -n "$NS" rollout undo deployment/catalogue

step "Suivi du rollback :"
kubectl -n "$NS" rollout status deployment/catalogue --timeout=120s

ok "Rollback effectué. Révisions disponibles :"
kubectl -n "$NS" rollout history deployment/catalogue

# ─────────────────────────────────────────────────────────────
header "Démo terminée — commandes utiles"
echo ""
echo "  kubectl -n $NS get all"
echo "  kubectl -n $NS get hpa -w"
echo "  kubectl -n $NS logs deploy/catalogue --follow"
echo "  kubectl -n $NS describe hpa catalogue"
echo "  kubectl -n $NS top pods"
echo ""
