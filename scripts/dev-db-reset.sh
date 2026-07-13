#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"${SCRIPT_DIR}/dev-db-down.sh"
"${SCRIPT_DIR}/dev-db-up.sh"

echo "Attente de la disponibilité de PostgreSQL..."
ATTEMPTS=0
until docker exec microshop-postgres-dev pg_isready -U "${POSTGRES_USER:-microshop}" >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "${ATTEMPTS}" -ge 30 ]; then
    echo "PostgreSQL n'est pas prêt après 30 tentatives." >&2
    exit 1
  fi
  sleep 1
done

pnpm --dir "${SCRIPT_DIR}/.." db:migrate
pnpm --dir "${SCRIPT_DIR}/.." db:seed

echo "Base de développement réinitialisée, migrée et peuplée."
