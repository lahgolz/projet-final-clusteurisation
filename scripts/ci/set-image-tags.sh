#!/usr/bin/env bash
# Réécrit, dans la copie de travail éphémère de la CI, les références d'image d'un overlay
# Kustomize vers le registre et le tag immuables construits par le job build-and-push.
#
# Usage : set-image-tags.sh <overlay> <tag> <registry> <namespace>
# Exemple : set-image-tags.sh prod sha-abc123def456 ghcr.io lahgolz

set -euo pipefail

OVERLAY="${1:?overlay requis (ex: prod)}"
TAG="${2:?tag requis (ex: sha-abc123def456)}"
REGISTRY="${3:?registry requis (ex: ghcr.io)}"
NAMESPACE="${4:?namespace requis (propriétaire/organisation du registre)}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OVERLAY_DIR="${ROOT_DIR}/k8s/overlays/${OVERLAY}"

if [ ! -f "${OVERLAY_DIR}/kustomization.yaml" ]; then
  echo "ÉCHEC : overlay introuvable (${OVERLAY_DIR}/kustomization.yaml)" >&2
  exit 1
fi

cd "${OVERLAY_DIR}"

for component in catalogue orders frontend db-tools; do
  kustomize edit set image \
    "ghcr.io/your-org/microservice-app-${component}=${REGISTRY}/${NAMESPACE}/microservice-app-${component}:${TAG}"
done

echo "==> Images fixées sur ${REGISTRY}/${NAMESPACE}/microservice-app-{catalogue,orders,frontend,db-tools}:${TAG}"
