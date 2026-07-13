#!/usr/bin/env bash

set -euo pipefail

CONTAINER_NAME="microshop-postgres-dev"

if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
  docker rm -f "${CONTAINER_NAME}" >/dev/null
  echo "Conteneur ${CONTAINER_NAME} supprimé."
else
  echo "Aucun conteneur ${CONTAINER_NAME} à supprimer."
fi
