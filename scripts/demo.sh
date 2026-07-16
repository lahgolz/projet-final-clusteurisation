#!/usr/bin/env bash

# Script de démonstration guidée (10-15 min) : architecture, pipeline, application,
# objets Kubernetes, probes, logs/métriques, HPA sous charge, résilience, sécurité,
# limites. Chaque étape est une commande copiable indépendamment ; ce script se contente
# de les enchaîner avec des pauses. Voir agents/15_documentation-et-demonstration.md.
#
# Usage : bash scripts/demo.sh [base_url]
#   base_url par défaut : http://microservice-app.local (nécessite l'entrée dans /etc/hosts,
#   voir k8s/README.md). Sans Ingress accessible, utilisez les commandes de secours affichées
#   à chaque étape (port-forward direct vers les Services).

set -euo pipefail

NS="microservice-app"
MONITORING_NS="monitoring"
BASE_URL="${1:-http://microservice-app.local}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

pids=()
cleanup() {
  local exit_code=$?
  for pid in "${pids[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  exit "$exit_code"
}
trap cleanup EXIT

pause() {
  echo ""
  echo "  [Entrée pour continuer...]"
  read -r _
}

header() {
  echo ""
  echo "══════════════════════════════════════════════════════════════════"
  echo "  $1"
  echo "══════════════════════════════════════════════════════════════════"
}

step() { echo ""; echo "  ▶ $1"; }
fallback() { echo "    (secours si l'UI ne répond pas) $1"; }
run() {
  echo "    \$ $1"
  eval "$1" || echo "    (commande non bloquante en échec, on continue la démo)"
}

echo "Démonstration microservice-app — namespace ${NS}, cible ${BASE_URL}"
echo "Durée indicative : 10-15 minutes. Ctrl+C à tout moment pour interrompre."
pause

# 1. Architecture ------------------------------------------------------------
header "1. Architecture"
step "Vue d'ensemble et diagramme : docs/architecture.md"
echo "    (frontend -> Ingress -> catalogue/orders -> PostgreSQL, cf. schéma mermaid)"
step "Modèle de données : docs/data-model.md"
step "Structure du dépôt :"
run "tree -L 2 -I 'node_modules|dist' '${REPO_ROOT}'"
fallback "ls -R --ignore=node_modules --ignore=dist '${REPO_ROOT}'"
pause

# 2. Pipeline CI/CD -----------------------------------------------------------
header "2. Pipeline CI/CD"
step "Stages : lint, tests, build, scan images (Trivy), scan secrets (gitleaks), push registre,"
echo "         déploiement, attente du rollout, smoke test, rollback documenté."
echo "         Détails : docs/ci-cd.md — workflows : .github/workflows/ci.yml, cd.yml"
run "cat '${REPO_ROOT}/.github/workflows/ci.yml' | head -20"
fallback "gh run list --limit 5   # historique des exécutions si le remote GitHub est configuré"
pause

# 3. Application --------------------------------------------------------------
header "3. Application"
step "Frontend et APIs via l'Ingress :"
run "curl -sS -o /dev/null -w 'frontend: %{http_code}\\n' '${BASE_URL}/'"
run "curl -sS '${BASE_URL}/api/catalogue/products' | head -c 400; echo"
fallback "kubectl -n ${NS} port-forward svc/frontend 8080:80 &  puis ouvrir http://127.0.0.1:8080"
step "Création d'une commande de démonstration :"
PRODUCT_ID=$(curl -sS "${BASE_URL}/api/catalogue/products" | python3 -c 'import json,sys; print(json.load(sys.stdin)["products"][0]["id"])' 2>/dev/null || true)
if [ -n "${PRODUCT_ID:-}" ]; then
  run "curl -sS -X POST '${BASE_URL}/api/orders' -H 'Content-Type: application/json' -d '{\"items\":[{\"productId\":\"${PRODUCT_ID}\",\"quantity\":1}]}'"
else
  echo "    (aucun produit trouvé, vérifier que le job db-seed a bien été exécuté)"
fi
pause

# 4. Objets Kubernetes ---------------------------------------------------------
header "4. Objets Kubernetes"
run "kubectl -n ${NS} get deploy,statefulset,pod,svc,ingress,configmap,secret,pvc -o wide"
run "kubectl -n ${NS} get networkpolicy,pdb,hpa,serviceaccount"
pause

# 5. Probes ---------------------------------------------------------------------
header "5. Probes de santé"
step "Définition des probes (liveness/readiness/startup) :"
run "kubectl -n ${NS} get deploy catalogue -o jsonpath='{.spec.template.spec.containers[0].livenessProbe}{\"\\n\"}'"
run "kubectl -n ${NS} get deploy catalogue -o jsonpath='{.spec.template.spec.containers[0].readinessProbe}{\"\\n\"}'"
step "Endpoints /health/live et /health/ready non exposés par l'Ingress (accès direct au Service) :"
kubectl -n "${NS}" port-forward svc/catalogue 4001:4001 >/dev/null 2>&1 &
pids+=("$!")
sleep 2
run "curl -sS http://127.0.0.1:4001/health/live; echo"
run "curl -sS http://127.0.0.1:4001/health/ready; echo"
kill "${pids[-1]}" 2>/dev/null || true
pause

# 6. Logs et métriques ------------------------------------------------------------
header "6. Logs et métriques"
step "Logs JSON structurés :"
run "kubectl -n ${NS} logs deploy/orders --tail=5"
step "Consommation ressources :"
run "kubectl -n ${NS} top pods"
step "Dashboard Grafana (identifiants et installation : docs/observability.md) :"
echo "    kubectl -n ${MONITORING_NS} port-forward svc/kube-prometheus-stack-grafana 3000:80"
echo "    puis http://127.0.0.1:3000 (dashboard \"microservice-app - overview\")"
fallback "kubectl -n ${NS} port-forward svc/catalogue 4001:4001 & curl -sS http://127.0.0.1:4001/metrics | grep -m5 http_request"
pause

# 7. HPA sous charge ------------------------------------------------------------
header "7. HPA sous charge"
step "État initial du HPA :"
run "kubectl -n ${NS} get hpa catalogue"
step "Génération de charge (90s, voir k8s/load-test/ pour le scénario k6 complet analysé"
echo "    dans docs/performance.md) :"
echo "    \$ bash '${SCRIPT_DIR}/load-test.sh' '${BASE_URL}' 90 20 &"
bash "${SCRIPT_DIR}/load-test.sh" "${BASE_URL}" 90 20 &
LOAD_PID="$!"
pids+=("$LOAD_PID")
step "Observer le scale-up en direct (60s) :"
echo "    \$ kubectl -n ${NS} get hpa catalogue -w"
timeout 60 kubectl -n "${NS}" get hpa catalogue -w || true
wait "$LOAD_PID" 2>/dev/null || true
pause

# 8. Suppression d'un pod (résilience) ---------------------------------------------
header "8. Suppression d'un pod"
step "Commande créée avant suppression, pour vérifier la persistance après recréation :"
run "kubectl -n ${NS} get pods -l app.kubernetes.io/name=orders"
run "kubectl -n ${NS} delete pod -l app.kubernetes.io/name=orders"
run "kubectl -n ${NS} rollout status deploy/orders --timeout=60s"
step "Le PodDisruptionBudget garantit qu'au moins 1 replica reste disponible durant l'opération :"
run "kubectl -n ${NS} get pdb"
echo "    Détails et scénarios supplémentaires (rollout, PostgreSQL) : scripts/resilience-demo.sh"
pause

# 9. Sécurité -----------------------------------------------------------------------
header "9. Sécurité"
step "RBAC minimal (réponse attendue : no — aucun accès large) :"
echo "    \$ kubectl -n ${NS} auth can-i list secrets --as=system:serviceaccount:${NS}:catalogue"
kubectl -n "${NS}" auth can-i list secrets --as="system:serviceaccount:${NS}:catalogue" || true
echo "    \$ kubectl -n ${NS} auth can-i list pods --as=system:serviceaccount:${NS}:catalogue"
kubectl -n "${NS}" auth can-i list pods --as="system:serviceaccount:${NS}:catalogue" || true
step "SecurityContext non-root, lecture seule :"
run "kubectl -n ${NS} get deploy catalogue -o jsonpath='{.spec.template.spec.securityContext}{\"\\n\"}'"
step "NetworkPolicy default-deny + flux explicitement autorisés :"
run "kubectl -n ${NS} get networkpolicy"
echo "    Scan d'image (Trivy) et de secrets (gitleaks) : voir docs/security.md et"
echo "    .github/workflows/ci.yml. Limite connue (NetworkPolicy non appliquée par le CNI"
echo "    minikube par défaut) documentée dans docs/security.md."
pause

# 10. Limites et améliorations --------------------------------------------------------
header "10. Limites et améliorations"
cat <<'EOF'
  - PostgreSQL mono-replica (StatefulSet à 1 pod) : pas de haute disponibilité native,
    alternatives documentées (CloudNativePG, Patroni, service managé) — docs/resilience.md.
  - Cluster de démonstration mono-nœud (minikube/kind) : pas de tolérance à la perte d'un nœud.
  - Stockage local (hostPath / local-path) : ne survit pas à la suppression du nœud/PVC selon la
    politique de rétention — docs/architecture.md, k8s/README.md.
  - Pas de TLS/cert-manager en local ; à activer avant un déploiement public — docs/security.md.
  - Alerting Prometheus limité aux règles de démonstration (pas d'astreinte réelle) —
    docs/observability.md.
  - Dépendances externes (registre d'images, Helm charts kube-prometheus-stack) hors du contrôle
    du dépôt.
  - Coûts non modélisés (cluster local uniquement, pas de test sur cloud managé).
  - Améliorations envisageables : Helm par environnement, opérateur PostgreSQL HA, CNI avec
    NetworkPolicy effective (Calico/Cilium), TLS automatisé, astreinte réelle.
EOF
pause

echo ""
echo "Démonstration terminée. Nettoyage de l'environnement de démonstration :"
echo "  kubectl delete -k k8s/overlays/dev   # ou k8s/overlays/prod"
echo "  minikube stop   # ou : minikube delete"
