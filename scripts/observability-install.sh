#!/usr/bin/env bash

set -euo pipefail

RELEASE="${OBSERVABILITY_RELEASE:-kube-prometheus-stack}"
MONITORING_NS="monitoring"
CHART_VERSION="${KUBE_PROMETHEUS_STACK_VERSION:-66.3.1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "==> Ajout du dépôt Helm prometheus-community"
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null
helm repo update prometheus-community >/dev/null

echo "==> Installation/mise à jour de kube-prometheus-stack (namespace ${MONITORING_NS})"
helm upgrade --install "$RELEASE" prometheus-community/kube-prometheus-stack \
  --version "$CHART_VERSION" \
  --namespace "$MONITORING_NS" \
  --create-namespace \
  --values "${REPO_ROOT}/k8s/observability/kube-prometheus-stack-values.yaml" \
  --wait --timeout 5m

echo "==> Attente de la disponibilité des CRD monitoring.coreos.com"
kubectl wait --for=condition=established --timeout=60s \
  crd/servicemonitors.monitoring.coreos.com crd/prometheusrules.monitoring.coreos.com

echo "==> Application des ServiceMonitor / PrometheusRule / dashboard applicatifs"
kubectl apply -k "${REPO_ROOT}/k8s/observability"

echo ""
echo "==> Stack d'observabilité installée."
echo "    Prometheus : kubectl -n ${MONITORING_NS} port-forward svc/${RELEASE}-prometheus 9090:9090"
echo "    Grafana    : kubectl -n ${MONITORING_NS} port-forward svc/${RELEASE}-grafana 3000:80"
echo "    Identifiants Grafana :"
echo "      kubectl -n ${MONITORING_NS} get secret ${RELEASE}-grafana -o jsonpath='{.data.admin-user}' | base64 -d; echo"
echo "      kubectl -n ${MONITORING_NS} get secret ${RELEASE}-grafana -o jsonpath='{.data.admin-password}' | base64 -d; echo"
