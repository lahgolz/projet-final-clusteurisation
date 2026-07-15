#!/usr/bin/env bash
# Stratégie de rollback : revient à la révision précédente de chaque Deployment applicatif.
# Utilisé automatiquement par la CD quand le smoke test échoue après un déploiement, et
# utilisable manuellement en cas d'incident constaté après coup.
#
# Usage :
#   KUBECONFIG=... bash scripts/rollback-k8s.sh                 # revient d'une révision
#   KUBECONFIG=... bash scripts/rollback-k8s.sh --to-revision 4 # revient à une révision précise
#
# Consulter l'historique avant de choisir une révision :
#   kubectl -n microservice-app rollout history deployment/catalogue

set -euo pipefail

NS="${K8S_NAMESPACE:-microservice-app}"
DEPLOYMENTS=(catalogue orders frontend)

TO_REVISION_ARGS=()
if [ "${1:-}" = "--to-revision" ]; then
  TO_REVISION_ARGS=(--to-revision "${2:?numéro de révision requis après --to-revision}")
fi

for deployment in "${DEPLOYMENTS[@]}"; do
  echo "==> Rollback de deployment/${deployment}"
  kubectl -n "$NS" rollout undo "deployment/${deployment}" "${TO_REVISION_ARGS[@]}"
done

for deployment in "${DEPLOYMENTS[@]}"; do
  echo "==> Attente de la fin du rollback pour deployment/${deployment}"
  kubectl -n "$NS" rollout status "deployment/${deployment}" --timeout=180s
done

echo "==> Rollback terminé. Les Jobs db-migrate/db-seed ne sont PAS annulés automatiquement :"
echo "    une migration descendante doit être rejouée manuellement si nécessaire, voir"
echo "    docs/ci-cd.md#rollback."
