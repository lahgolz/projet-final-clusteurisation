# Observabilité

## Périmètre

Ce document couvre les logs, métriques, dashboards et l'alerting pour `catalogue`, `orders` et
leurs dépendances (PostgreSQL, replicas Kubernetes). Environnement de démonstration : cluster
**minikube** mono-nœud, overlay `dev`, stack d'observabilité `kube-prometheus-stack` installée via
Helm dans le namespace `monitoring`.

---

## 1. Logs

### Format structuré

Les deux APIs écrivent des logs JSON sur stdout via [pino](https://getpino.io/), configuré dans
[`packages/shared/src/logger.ts`](../packages/shared/src/logger.ts). Chaque requête HTTP produit
une ligne `http_request` avec les champs :

| Champ        | Exemple                       | Origine                                                        |
| ------------ | ----------------------------- | -------------------------------------------------------------- |
| `timestamp`  | `2026-07-15T16:43:02.205Z`    | `pino.stdTimeFunctions.isoTime`                                |
| `level`      | `30` (info)                   | pino                                                           |
| `service`    | `orders`                      | `base: { service }` à la création du logger                    |
| `requestId`  | `ae4a87be-e2e9-4477-9672-...` | `genReqId` Fastify (voir corrélation ci-dessous)               |
| `method`     | `POST`                        | `request.method`                                               |
| `path`       | `/api/orders`                 | `request.routeOptions.url` (pattern de route, pas l'URL brute) |
| `statusCode` | `201`                         | `reply.statusCode`                                             |
| `durationMs` | `36`                          | `process.hrtime.bigint()` avant/après                          |

Exemple de ligne réelle observée en environnement de démonstration :

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
`authorization`/`cookie`) — voir `REDACT_PATHS` dans `logger.ts`.

### Commandes `kubectl logs`

```bash
# Logs du Deployment (tous les pods du Deployment, agrégés)
kubectl -n microservice-app logs deploy/catalogue
kubectl -n microservice-app logs deploy/orders

# Logs d'un pod précis
kubectl -n microservice-app logs catalogue-547f55f8b4-hdpfm

# Logs du conteneur précédent (après un crash/redémarrage)
kubectl -n microservice-app logs deploy/catalogue --previous

# Suivi en temps réel
kubectl -n microservice-app logs deploy/orders --follow

# Filtrer sur un niveau ou un champ (les logs sont du JSON ligne à ligne)
kubectl -n microservice-app logs deploy/catalogue --since=10m | jq 'select(.level >= 50)'
```

### Corrélation d'une requête entre services (`requestId`)

`orders` appelle `catalogue` en interne (`POST /api/orders` → `GET /api/catalogue/products/:id`).
Pour que les deux services logguent le **même** `requestId`, `genReqId` honore un en-tête entrant
`x-request-id` (sinon il en génère un), l'expose en en-tête de réponse, et
[`catalogueClient.getProduct`](../services/orders/src/clients/catalogueClient.ts) le transmet à
l'appel sortant vers `catalogue` (voir `services/*/src/app.ts` et
`services/orders/src/routes/orders.routes.ts`).

**Démonstration réelle** (commandes exécutées lors de la mise en œuvre) :

```bash
PRODUCT_ID=$(curl -s http://127.0.0.1:4001/api/catalogue/products | jq -r '.products[0].id')

curl -sS -D - -o /tmp/order.json -X POST http://127.0.0.1:4002/api/orders \
  -H 'content-type: application/json' \
  -d "{\"items\":[{\"productId\":\"${PRODUCT_ID}\",\"quantity\":1}]}" \
  | grep -i x-request-id
# x-request-id: ae4a87be-e2e9-4477-9672-d468f50665be

kubectl -n microservice-app logs deploy/orders --tail=50 | grep ae4a87be-e2e9-4477-9672-d468f50665be
kubectl -n microservice-app logs deploy/catalogue --tail=50 | grep ae4a87be-e2e9-4477-9672-d468f50665be
```

Résultat obtenu (une ligne par service, même `requestId`) :

```json
{"level":30,"time":"2026-07-15T16:43:02.192Z","service":"catalogue","method":"GET","path":"/api/catalogue/products/:id","statusCode":200,"durationMs":1,"requestId":"ae4a87be-e2e9-4477-9672-d468f50665be","msg":"http_request"}
{"level":30,"time":"2026-07-15T16:43:02.205Z","service":"orders","method":"POST","path":"/api/orders","statusCode":201,"durationMs":36,"requestId":"ae4a87be-e2e9-4477-9672-d468f50665be","msg":"http_request"}
```

### Stack de logs centralisée (optionnelle, non déployée)

L'énoncé qualifie Loki + Promtail (ou équivalent) de facultatif. Ce projet s'en tient à
`kubectl logs` pour rester minimal (règle globale : conserver une solution minimale avant
d'ajouter les bonus). Pour l'ajouter plus tard sans remettre en cause l'existant :

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm upgrade --install loki grafana/loki-stack \
  --namespace monitoring --create-namespace \
  --set grafana.enabled=false \
  --set promtail.enabled=true
```

Promtail collecterait automatiquement les logs JSON déjà émis sur stdout (aucun changement
applicatif requis) ; il suffirait ensuite d'ajouter Loki comme datasource dans le Grafana existant
de `kube-prometheus-stack`.

---

## 2. Métriques

### Endpoints `/metrics`

`catalogue` et `orders` exposent chacun `GET /metrics` (format texte Prometheus, via
[`prom-client`](https://github.com/siimon/prom-client)), implémenté dans
[`packages/shared/src/metrics.ts`](../packages/shared/src/metrics.ts) et branché dans
`services/*/src/app.ts`. Le registre inclut :

| Métrique                                                                 | Type      | Labels                                        | Description                                            |
| ------------------------------------------------------------------------ | --------- | --------------------------------------------- | ------------------------------------------------------ |
| `http_requests_total`                                                    | Counter   | `service`, `method`, `route`, `status_code`   | Nombre de requêtes HTTP                                |
| `http_request_duration_seconds`                                          | Histogram | `service`, `method`, `route`, `status_code`   | Latence HTTP (buckets 5ms → 5s)                        |
| `db_pool_connections`                                                    | Gauge     | `service`, `state` (`total`/`idle`/`waiting`) | État du pool `pg` (rafraîchi toutes les 5s)            |
| `process_cpu_seconds_total`, `process_resident_memory_bytes`, `nodejs_*` | —         | `service`                                     | Métriques par défaut Node.js (`collectDefaultMetrics`) |

**Cardinalité bornée** : le label `route` utilise le **pattern** de route Fastify
(`request.routeOptions.url`, ex. `/api/catalogue/products/:id`), jamais l'URL brute — un
`productId` ou `orderId` concret n'apparaît donc jamais comme valeur de label. Un test unitaire
(`packages/shared/src/metrics.test.ts`) vérifie explicitement qu'un UUID de commande n'apparaît
pas dans la sortie `/metrics`.

Vérification réelle (port-forward local) :

```bash
kubectl -n microservice-app port-forward svc/catalogue 4001:4001 &
curl -s http://127.0.0.1:4001/metrics | grep http_requests_total
# http_requests_total{method="GET",route="/health/ready",status_code="200",service="catalogue"} 9
# http_requests_total{method="GET",route="/api/catalogue/products",status_code="200",service="catalogue"} 1
```

### Stack Prometheus / Grafana

Installée via Helm (`kube-prometheus-stack`, namespace `monitoring`), avec un fichier de valeurs
minimal dédié à la démo : [`k8s/observability/kube-prometheus-stack-values.yaml`](../k8s/observability/kube-prometheus-stack-values.yaml).

```bash
bash scripts/observability-install.sh
```

Ce script :

1. ajoute le dépôt Helm `prometheus-community` ;
2. installe/actualise `kube-prometheus-stack` (Prometheus, Alertmanager, Grafana,
   kube-state-metrics, node-exporter) ;
3. attend que les CRD `ServiceMonitor`/`PrometheusRule` soient disponibles ;
4. applique `kubectl apply -k k8s/observability` (ServiceMonitor, PrometheusRule, dashboard).

Composants désactivés dans les values (non pertinents ou inaccessibles sur un cluster local
mono-nœud type minikube/kind) : `kubeControllerManager`, `kubeScheduler`, `kubeEtcd`, `kubeProxy`.

### Découverte des cibles (ServiceMonitor)

[`k8s/observability/service-monitors.yaml`](../k8s/observability/service-monitors.yaml) déclare un
`ServiceMonitor` par API, scrapant `GET /metrics` toutes les 15s. Le Prometheus Operator est
configuré (`serviceMonitorSelector: {}`, `serviceMonitorNamespaceSelector: {}` dans les values)
pour surveiller tout le cluster sans exiger le label `release` habituel du chart Helm.

Un `NetworkPolicy` dédié
([`k8s/base/networkpolicy.yaml`](../k8s/base/networkpolicy.yaml), règle
`allow-monitoring-to-apis`) autorise explicitement le trafic entrant depuis le namespace
`monitoring` vers les ports 4001/4002 — sans lui, `default-deny-ingress` bloquerait le scraping.

Vérification réelle (les deux cibles sont `up`) :

```bash
kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090:9090 &
curl -s http://127.0.0.1:9090/api/v1/targets | jq -r \
  '.data.activeTargets[] | select(.labels.job=="catalogue" or .labels.job=="orders") | "\(.labels.job) \(.health) \(.scrapeUrl)"'
# catalogue up http://10.244.0.33:4001/metrics
# orders up http://10.244.0.34:4002/metrics
```

### Métriques mesurées (récapitulatif des exigences)

| Exigence              | Source                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| Nombre de requêtes    | `http_requests_total` (applicatif)                                                                     |
| Erreurs 4xx / 5xx     | `http_requests_total{status_code=~"4..                                                                 | 5.."}` (applicatif) |
| Durée des requêtes    | `http_request_duration_seconds` (applicatif)                                                           |
| Connexions/erreurs DB | `db_pool_connections` (applicatif, pool `pg`)                                                          |
| CPU                   | `process_cpu_seconds_total` (applicatif) + `container_cpu_usage_seconds_total` (kubelet/cAdvisor)      |
| Mémoire               | `process_resident_memory_bytes` (applicatif) + `container_memory_working_set_bytes` (kubelet/cAdvisor) |
| Nombre de replicas    | `kube_deployment_spec_replicas` / `kube_deployment_status_replicas_available` (kube-state-metrics)     |

---

## 3. Dashboard Grafana

Dashboard [`k8s/observability/dashboards/microservice-app-overview.json`](../k8s/observability/dashboards/microservice-app-overview.json),
appliqué comme `ConfigMap` (label `grafana_dashboard: "1"`) et chargé automatiquement par le
sidecar Grafana (`sidecar.dashboards.searchNamespace: ALL` dans les values). Panneaux :

1. **Trafic par service** — `sum by (service) (rate(http_requests_total[5m]))`
2. **Taux d'erreur 5xx par service** — ratio `status_code=~"5.."` / total
3. **Latence p50/p95/p99** — `histogram_quantile(..., http_request_duration_seconds_bucket)`
4. **Connexions au pool PostgreSQL** — `db_pool_connections`
5. **CPU par pod**
6. **Mémoire par pod**
7. **Replicas désirés vs disponibles**
8. **État des pods** (table, `kube_pod_status_phase`)

Accès :

```bash
kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80
kubectl -n monitoring get secret kube-prometheus-stack-grafana -o jsonpath='{.data.admin-user}' | base64 -d; echo
kubectl -n monitoring get secret kube-prometheus-stack-grafana -o jsonpath='{.data.admin-password}' | base64 -d; echo
# puis http://127.0.0.1:3000/d/microservice-app-overview
```

Vérifié via l'API Grafana lors de la mise en œuvre :

```bash
curl -s -u "$ADMIN_USER:$ADMIN_PASS" 'http://127.0.0.1:3000/api/search?query=microservice-app'
# [{"uid":"microservice-app-overview","title":"microservice-app – Overview", ...}]
```

### Limite observée : cAdvisor sans label `container` sur ce cluster minikube

Sur ce cluster précis (minikube, driver `docker`, Kubernetes v1.35.1), le kubelet expose
`container_cpu_usage_seconds_total` / `container_memory_working_set_bytes` **sans label
`container`** (uniquement l'agrégat par pod). Le filtre standard des dashboards
`kube-prometheus-stack` (`container!="", container!="POD"`) exclut donc silencieusement toutes les
métriques applicatives. Les requêtes des panneaux CPU/mémoire ont été adaptées en
`container!="POD"` (sans exiger `container!=""`) pour rester correctes sur un cluster avec
labellisation complète _et_ fonctionner sur ce cluster de démonstration. Vérifié :

```bash
curl -s --data-urlencode \
  'query=sum by (pod) (container_memory_working_set_bytes{namespace="microservice-app", container!="POD"})' \
  http://127.0.0.1:9090/api/v1/query
# catalogue-547f55f8b4-hdpfm  26152960
# orders-5ff956c8db-8q794     25739264
# frontend-6764c44c4f-gm4dh   13905920
# postgres-0                  40501248
```

---

## 4. Alerting

Règles définies dans [`k8s/observability/alerts.yaml`](../k8s/observability/alerts.yaml)
(`PrometheusRule`, groupe `microservice-app.rules`) :

| Alerte                           | Condition                                                                  | Seuil     | Durée (`for`) | Gravité  | Action attendue                                      |
| -------------------------------- | -------------------------------------------------------------------------- | --------- | ------------- | -------- | ---------------------------------------------------- |
| `HighHttp5xxRate`                | ratio 5xx / total requêtes par service                                     | > 5 %     | 5 min         | critical | Vérifier logs/DB ; envisager un rollback             |
| `ServiceWithoutAvailableReplica` | `kube_deployment_status_replicas_available == 0`                           | 0 replica | 2 min         | critical | Vérifier pods/events/probes ; redémarrer ou rollback |
| `PodCrashLoopBackOff`            | `kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"} == 1` | —         | 2 min         | critical | `kubectl logs --previous` + `describe pod`           |
| `PodMemoryNearLimit`             | mémoire conteneur / limite mémoire                                         | > 90 %    | 5 min         | warning  | Vérifier fuite mémoire ou ajuster la limite          |

`PodMemoryNearLimit` fait une jointure `on (namespace, pod, container)` avec
`kube_pod_container_resource_limits` (métrique de kube-state-metrics, toujours labellisée par
conteneur). Sur ce cluster minikube, la limite cAdvisor décrite ci-dessus (absence de label
`container`) empêche cette jointure de matcher — l'alerte reste donc valide et se déclenchera
normalement sur un cluster standard (GKE/EKS/AKS ou cgroup v1), mais ne peut pas être démontrée
localement pour cette raison précise.

### Démonstration réelle : déclenchement de `ServiceWithoutAvailableReplica`

```bash
bash scripts/observability-alert-demo.sh
```

Le script met `orders` à 0 replica, interroge l'API Prometheus (`/api/v1/alerts`) toutes les 15s,
puis restaure le replica initial. Résultat obtenu lors de l'exécution :

```
==> Mise à l'échelle de orders à 0 replica pour simuler une indisponibilité
==> Attente du déclenchement de l'alerte (seuil : for 2m dans alerts.yaml)
    [t+15s] ServiceWithoutAvailableReplica: pending
    [t+30s] ServiceWithoutAvailableReplica: pending
    [t+45s] ServiceWithoutAvailableReplica: pending
    [t+60s] ServiceWithoutAvailableReplica: pending
    [t+75s] ServiceWithoutAvailableReplica: pending
    [t+90s] ServiceWithoutAvailableReplica: firing
==> Alerte déclenchée avec succès (state=firing).
==> Restauration de orders à 1 replica(s)
deployment "orders" successfully rolled out
```

L'alerte passe `pending` dès que `kube_deployment_status_replicas_available{deployment="orders"}`
atteint 0, puis `firing` après les 2 minutes de `for` configurées (ici ~90s, l'horloge ayant déjà
commencé à courir avant le premier point observé à t+15s). Le service est ensuite automatiquement
restauré par le script.

---

## 5. Limites connues

- **Cluster mono-nœud (minikube)** : les métriques `container_cpu_usage_seconds_total` /
  `container_memory_working_set_bytes` n'exposent pas de label `container` sur ce cluster précis
  (voir §3) ; les dashboards ont été adaptés en conséquence, mais toute jointure exigeant ce label
  (ex. `PodMemoryNearLimit`) ne peut pas être démontrée localement.
- **Rétention Prometheus réduite** (`retention: 6h` dans les values) pour limiter l'empreinte
  disque sur un cluster de démonstration ; à augmenter en production avec un stockage persistant
  dédié (`storageSpec`).
- **Alertmanager sans routage externe configuré** (pas de Slack/e-mail/PagerDuty) : les alertes
  sont visibles dans l'UI Prometheus/Alertmanager mais ne notifient personne. À configurer via
  `alertmanager.config` dans les values pour un usage réel.
- **Loki/Promtail non déployés** (facultatif selon l'énoncé) — voir §1 pour l'ajouter.
- **Pas d'exporter PostgreSQL dédié** : les métriques DB se limitent à l'état du pool applicatif
  (`db_pool_connections`) et aux métriques Kubernetes du pod `postgres-0` (CPU/mémoire), sans
  métriques internes PostgreSQL (requêtes/s, locks, etc.). Un `postgres_exporter` pourrait être
  ajouté si nécessaire.

---

## 6. Commandes de référence

```bash
# Installation de la stack d'observabilité
bash scripts/observability-install.sh

# Démonstration d'alerte (ServiceWithoutAvailableReplica)
bash scripts/observability-alert-demo.sh

# Metrics-server (prérequis HPA, déjà couvert par l'étape 10)
kubectl top nodes
kubectl top pods -n microservice-app

# Endpoints /metrics applicatifs
kubectl -n microservice-app port-forward svc/catalogue 4001:4001
kubectl -n microservice-app port-forward svc/orders 4002:4002
curl -s http://127.0.0.1:4001/metrics
curl -s http://127.0.0.1:4002/metrics

# Prometheus / Alertmanager / Grafana
kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090:9090
kubectl -n monitoring port-forward svc/kube-prometheus-stack-alertmanager 9093:9093
kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80

# Logs applicatifs
kubectl -n microservice-app logs deploy/catalogue --follow
kubectl -n microservice-app logs deploy/orders --previous
```
