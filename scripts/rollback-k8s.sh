#!/usr/bin/env bash

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
