# Observabilité

Ce document couvre les logs, métriques, dashboards et l'alerting pour `catalogue`, `orders` et
leurs dépendances (PostgreSQL, replicas Kubernetes). Environnement de démo : cluster
**minikube** mono-nœud, overlay `dev`, stack `kube-prometheus-stack` installée via Helm dans le
namespace `monitoring`.

## 1. Logs

Les deux API écrivent des logs JSON sur stdout via [pino](https://getpino.io/), configuré dans
[`packages/shared/src/logger.ts`](../packages/shared/src/logger.ts). Chaque requête produit une
ligne `http_request` avec `timestamp`, `level`, `service`, `requestId`, `method`, `path` (le
pattern de route, pas l'URL brute), `statusCode` et `durationMs`. Exemple réel :

```json
{
  "level": 30,
  "time": "2026-07-15T16:43:02.205Z",
  "service": "orders",
  "method": "POST",
  "path": "/api/orders",
  "statusCode": 201,
  "durationMs": 36,
  "requestId": "ae4a87be-e2e9-4477-9672-d468f50665be",
  "msg": "http_request"
}
```

Le logger redige automatiquement les champs sensibles (`password`, `DATABASE_URL`, en-têtes
`authorization`/`cookie`) - voir `REDACT_PATHS` dans `logger.ts`.

```bash
kubectl -n microservice-app logs deploy/catalogue
kubectl -n microservice-app logs deploy/catalogue --previous   # conteneur précédent, après un crash
kubectl -n microservice-app logs deploy/orders --follow
kubectl -n microservice-app logs deploy/catalogue --since=10m | jq 'select(.level >= 50)'
```

### Corréler une requête entre les deux services

`orders` appelle `catalogue` en interne à la création d'une commande. Pour que les deux logguent
le **même** `requestId`, `genReqId` honore un en-tête entrant `x-request-id` (sinon il en génère
un) et [`catalogueClient.getProduct`](../services/orders/src/clients/catalogueClient.ts) le
transmet à l'appel sortant. Il suffit donc de récupérer le `x-request-id` de la réponse et de le
chercher dans les deux services :

```bash
curl -sS -D - -o /tmp/order.json -X POST http://127.0.0.1:4002/api/orders \
  -H 'content-type: application/json' \
  -d '{"items":[{"productId":"<uuid>","quantity":1}]}' | grep -i x-request-id

kubectl -n microservice-app logs deploy/orders --tail=50 | grep <request-id>
kubectl -n microservice-app logs deploy/catalogue --tail=50 | grep <request-id>
```

### Stack de logs centralisée (pas déployée)

`kubectl logs` suffit pour cette démo - pas de Loki/Promtail par défaut, pour rester minimal.
Pour l'ajouter plus tard sans rien changer côté applicatif (les logs JSON sont déjà sur stdout) :

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm upgrade --install loki grafana/loki-stack \
  --namespace monitoring --create-namespace \
  --set grafana.enabled=false \
  --set promtail.enabled=true
```

Il suffirait ensuite d'ajouter Loki comme datasource dans le Grafana déjà installé.

## 2. Métriques

`catalogue` et `orders` exposent chacun `GET /metrics` (format Prometheus, via
[`prom-client`](https://github.com/siimon/prom-client)), implémenté dans
[`packages/shared/src/metrics.ts`](../packages/shared/src/metrics.ts) :

| Métrique                                                                 | Type      | Labels                                        | Description                                 |
| ------------------------------------------------------------------------ | --------- | --------------------------------------------- | ------------------------------------------- |
| `http_requests_total`                                                    | Counter   | `service`, `method`, `route`, `status_code`   | Nombre de requêtes HTTP                     |
| `http_request_duration_seconds`                                          | Histogram | `service`, `method`, `route`, `status_code`   | Latence HTTP (buckets 5ms à 5s)             |
| `db_pool_connections`                                                    | Gauge     | `service`, `state` (`total`/`idle`/`waiting`) | État du pool `pg` (rafraîchi toutes les 5s) |
| `process_cpu_seconds_total`, `process_resident_memory_bytes`, `nodejs_*` | -         | `service`                                     | Métriques par défaut Node.js                |

Plus les métriques infra habituelles : `container_cpu_usage_seconds_total` /
`container_memory_working_set_bytes` (kubelet/cAdvisor) pour le CPU/mémoire par pod, et
`kube_deployment_status_replicas_available` (kube-state-metrics) pour le nombre de replicas.

**Cardinalité bornée** : le label `route` utilise le pattern de route Fastify (ex.
`/api/catalogue/products/:id`), jamais l'URL brute - un `productId` ou `orderId` concret n'apparaît
donc jamais comme valeur de label. Un test unitaire (`packages/shared/src/metrics.test.ts`) vérifie
qu'un UUID de commande n'apparaît pas dans la sortie `/metrics`.

```bash
kubectl -n microservice-app port-forward svc/catalogue 4001:4001 &
curl -s http://127.0.0.1:4001/metrics | grep http_requests_total
```

### Installer la stack Prometheus/Grafana

```bash
bash scripts/observability-install.sh
```

Ce script ajoute le dépôt Helm `prometheus-community`, installe/actualise
`kube-prometheus-stack` (Prometheus, Alertmanager, Grafana, kube-state-metrics, node-exporter),
attend les CRD `ServiceMonitor`/`PrometheusRule`, puis applique
`k8s/observability/` (ServiceMonitor, PrometheusRule, dashboard). Les values
([`k8s/observability/kube-prometheus-stack-values.yaml`](../k8s/observability/kube-prometheus-stack-values.yaml))
désactivent `kubeControllerManager`/`kubeScheduler`/`kubeEtcd`/`kubeProxy`, pas accessibles sur un
cluster local type minikube/kind.

[`k8s/observability/service-monitors.yaml`](../k8s/observability/service-monitors.yaml) déclare un
`ServiceMonitor` par API, scrapant `/metrics` toutes les 15s. Un `NetworkPolicy` dédié
(`allow-monitoring-to-apis` dans [`k8s/base/networkpolicy.yaml`](../k8s/base/networkpolicy.yaml))
autorise explicitement ce trafic - sans lui, `default-deny-ingress` bloquerait le scraping.

```bash
kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090:9090 &
curl -s http://127.0.0.1:9090/api/v1/targets | jq -r \
  '.data.activeTargets[] | select(.labels.job=="catalogue" or .labels.job=="orders") | "\(.labels.job) \(.health)"'
```

## 3. Dashboard Grafana

Dashboard [`k8s/observability/dashboards/microservice-app-overview.json`](../k8s/observability/dashboards/microservice-app-overview.json),
chargé automatiquement via ConfigMap (sidecar Grafana). Panneaux : trafic par service, taux
d'erreur 5xx, latence p50/p95/p99, connexions au pool PostgreSQL, CPU/mémoire par pod, replicas
désirés vs disponibles, état des pods.

```bash
kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80
kubectl -n monitoring get secret kube-prometheus-stack-grafana -o jsonpath='{.data.admin-user}' | base64 -d; echo
kubectl -n monitoring get secret kube-prometheus-stack-grafana -o jsonpath='{.data.admin-password}' | base64 -d; echo
# puis http://127.0.0.1:3000/d/microservice-app-overview
```

### Particularité de ce cluster : cAdvisor sans label `container`

Sur ce cluster précis (minikube, driver Docker), le kubelet expose les métriques cAdvisor **sans
label `container`** (seulement l'agrégat par pod). Le filtre standard des dashboards
`kube-prometheus-stack` (`container!="", container!="POD"`) exclut donc silencieusement les
métriques applicatives. Les panneaux CPU/mémoire ont été adaptés en `container!="POD"` pour
fonctionner ici tout en restant corrects sur un cluster labellisé normalement.

## 4. Alerting

Règles dans [`k8s/observability/alerts.yaml`](../k8s/observability/alerts.yaml) :

| Alerte                           | Condition                                              | Seuil     | `for` | Gravité  |
| -------------------------------- | ------------------------------------------------------ | --------- | ----- | -------- |
| `HighHttp5xxRate`                | ratio 5xx / total par service                          | > 5 %     | 5 min | critical |
| `ServiceWithoutAvailableReplica` | `kube_deployment_status_replicas_available == 0`       | 0 replica | 2 min | critical |
| `PodCrashLoopBackOff`            | `kube_pod_container_status_waiting_reason{reason=...}` | -         | 2 min | critical |
| `PodMemoryNearLimit`             | mémoire conteneur / limite mémoire                     | > 90 %    | 5 min | warning  |

`PodMemoryNearLimit` fait une jointure par conteneur avec `kube_pod_container_resource_limits` :
sur ce cluster minikube, la limite cAdvisor décrite plus haut (pas de label `container`) empêche
cette jointure de matcher. L'alerte est correcte et fonctionnera sur un cluster standard
(GKE/EKS/AKS), mais ne peut pas être démontrée localement pour cette raison précise.

### Démonstration

```bash
bash scripts/observability-alert-demo.sh
```

Le script met `orders` à 0 replica, surveille `/api/v1/alerts` toutes les 15s jusqu'à voir
`ServiceWithoutAvailableReplica` passer de `pending` à `firing` (~90s, cohérent avec le `for: 2m`
configuré), puis restaure le replica initial.

## Limites connues

- **Cluster mono-nœud** : les métriques cAdvisor n'exposent pas de label `container` ici (voir
  §3) ; les dashboards ont été adaptés, mais une jointure qui exige ce label (`PodMemoryNearLimit`)
  ne peut pas être démontrée localement.
- **Rétention Prometheus réduite** (`retention: 6h`) pour limiter l'empreinte disque en démo - à
  augmenter en production avec un stockage persistant dédié.
- **Alertmanager sans routage externe** (pas de Slack/e-mail/PagerDuty configuré) : les alertes
  sont visibles dans l'UI mais ne notifient personne pour l'instant.
- **Pas d'exporter PostgreSQL dédié** : les métriques DB se limitent au pool applicatif
  (`db_pool_connections`) et aux métriques Kubernetes du pod `postgres-0`, sans métriques internes
  PostgreSQL (requêtes/s, locks...).

## Commandes de référence

```bash
bash scripts/observability-install.sh
bash scripts/observability-alert-demo.sh

kubectl top nodes
kubectl top pods -n microservice-app

kubectl -n microservice-app port-forward svc/catalogue 4001:4001
kubectl -n microservice-app port-forward svc/orders 4002:4002

kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090:9090
kubectl -n monitoring port-forward svc/kube-prometheus-stack-alertmanager 9093:9093
kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80
```
