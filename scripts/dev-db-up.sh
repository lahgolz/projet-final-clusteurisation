#!/usr/bin/env bash

set -euo pipefail

CONTAINER_NAME="microshop-postgres-dev"
POSTGRES_USER="${POSTGRES_USER:-microshop}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-microshop}"
POSTGRES_DB="${POSTGRES_DB:-microshop}"
POSTGRES_PORT="${POSTGRES_PORT:-5433}"

if docker ps --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
  echo "Le conteneur ${CONTAINER_NAME} tourne déjà sur le port ${POSTGRES_PORT}."
  exit 0
fi

if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
  docker start "${CONTAINER_NAME}" >/dev/null
  echo "Conteneur ${CONTAINER_NAME} redémarré sur le port ${POSTGRES_PORT}."
  exit 0
fi

docker run -d \
  --name "${CONTAINER_NAME}" \
  -e "POSTGRES_USER=${POSTGRES_USER}" \
  -e "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" \
  -e "POSTGRES_DB=${POSTGRES_DB}" \
  -p "${POSTGRES_PORT}:5432" \
  postgres:16-alpine >/dev/null

echo "PostgreSQL de développement démarré sur localhost:${POSTGRES_PORT} (db=${POSTGRES_DB}, user=${POSTGRES_USER})."
echo "DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}"
