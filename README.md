# microservice-app

Une petite app de démonstration (frontend + 2 API + PostgreSQL) déployée sur Kubernetes. C'est un
projet de cours : le but est de montrer une chaîne complète - du code au cluster - plutôt que de
livrer un produit fini.

Pour aller plus loin, la doc est éclatée par sujet dans [`docs/`](./docs) :
[architecture](./docs/architecture.md), [modèle de données](./docs/data-model.md),
[conteneurisation](./docs/containerisation.md), [CI/CD](./docs/ci-cd.md),
[résilience](./docs/resilience.md) et [performance](./docs/performance.md),
[observabilité](./docs/observability.md), [sécurité](./docs/security.md),
[sauvegarde/restauration](./docs/backup-restore.md) et [runbooks](./docs/runbooks.md).

## Structure du dépôt

```text
.
├── apps/
│   └── frontend/       # React + Vite + TypeScript, Dockerfile, nginx.conf
├── services/
│   ├── catalogue/      # API produits (Fastify + TypeScript), Dockerfile
│   └── orders/         # API commandes (Fastify + TypeScript), Dockerfile
├── packages/
│   ├── shared/         # logger JSON, helper HTTP avec timeout, partagés par les services
│   └── db/             # migrations, seed, schéma PostgreSQL, Dockerfile (image outils)
├── k8s/
│   ├── base/           # manifests Kubernetes de base
│   └── overlays/       # variantes Kustomize (dev/prod)
├── docs/                # doc d'architecture, modèle de données, conteneurisation, CI/CD...
├── scripts/             # scripts de dev et de démo
│   └── ci/              # scripts utilisés uniquement par la pipeline
├── docker-compose.yml   # environnement local complet (postgres, migrate, seed, apps, gateway)
├── gateway.nginx.conf   # reverse proxy local (joue le rôle de l'Ingress en local)
└── .github/
    ├── workflows/       # pipeline CI/CD (ci.yml, cd.yml)
    └── actions/         # composite actions réutilisées par les workflows
```

## Prérequis

- Node.js ≥ 20
- pnpm ≥ 10 (`corepack enable` recommandé)
- Docker + Docker Compose (pour PostgreSQL en local et pour la conteneurisation)

## Installation

```bash
pnpm install
```

## Base de données locale

```bash
pnpm dev:db:up      # démarre un PostgreSQL jetable sur localhost:5433
pnpm db:migrate     # applique les migrations
pnpm db:seed        # insère un jeu de données de démonstration (idempotent)
pnpm dev:db:down    # arrête et supprime le conteneur
```

## Développement

```bash
pnpm dev            # démarre catalogue (4001), orders (4002) et frontend (5173) en parallèle
```

Le frontend appelle les API via des chemins relatifs (`/api/catalogue`, `/api/orders`) : en dev,
Vite proxy ces chemins vers les services locaux (voir `apps/frontend/vite.config.ts`).

## Environnement conteneurisé (Docker Compose)

```bash
docker compose up -d --build   # postgres, migrate, seed, catalogue, orders, frontend, gateway
curl http://localhost:8080/api/catalogue/products
docker compose down -v         # arrêt propre + suppression du volume de dev
```

Un smoke test de bout en bout (build, démarrage, migrations, requêtes, persistance après
redémarrage, non-root, arrêt propre) est disponible :

```bash
bash scripts/smoke-test.sh
```

Détails, Dockerfiles et résultats du scan Trivy : [`docs/containerisation.md`](./docs/containerisation.md).

## Scripts racine

| Script             | Effet                                                         |
| ------------------ | ------------------------------------------------------------- |
| `pnpm dev`         | Démarre les 3 applications en local avec rechargement à chaud |
| `pnpm build`       | Build de production de tous les paquets/services/apps         |
| `pnpm test`        | Exécute les suites de tests de tous les paquets/services/apps |
| `pnpm lint`        | ESLint sur l'ensemble du dépôt                                |
| `pnpm format`      | Formatage Prettier de l'ensemble du dépôt                     |
| `pnpm typecheck`   | Vérification TypeScript sans émission                         |
| `pnpm db:migrate`  | Applique les migrations PostgreSQL                            |
| `pnpm db:rollback` | Annule la dernière migration                                  |
| `pnpm db:seed`     | Insère/actualise le jeu de données de démonstration           |

## Tests

```bash
pnpm test        # tests unitaires (Vitest)
pnpm lint        # ESLint
pnpm typecheck   # tsc --noEmit sur tout le monorepo
pnpm build       # build de production
```

Les tests d'intégration HTTP (`test/integration/*.routes.test.ts` dans `services/catalogue` et
`services/orders`) sont automatiquement passés (`skipped`) tant qu'aucune base PostgreSQL de test
n'est accessible : démarrez-en une avec `pnpm dev:db:up` puis relancez `pnpm test`. Détails par
service : [`services/catalogue/README.md`](./services/catalogue/README.md),
[`services/orders/README.md`](./services/orders/README.md).

## Déploiement Kubernetes

Manifests Kustomize dans `k8s/` (`base` + `overlays/dev`/`overlays/prod`), détaillés dans
[`k8s/README.md`](./k8s/README.md). Résumé pour un cluster `minikube` local :

```bash
minikube start
minikube addons enable ingress
minikube addons enable metrics-server

eval $(minikube docker-env)
docker build -f services/catalogue/Dockerfile -t microservice-app/catalogue:dev .
docker build -f services/orders/Dockerfile -t microservice-app/orders:dev .
docker build -f apps/frontend/Dockerfile -t microservice-app/frontend:dev .
docker build -f packages/db/Dockerfile -t microservice-app/db-tools:dev .

cp k8s/overlays/dev/secret.env.example k8s/overlays/dev/secret.env   # puis éditer les valeurs

kubectl apply -k k8s/overlays/dev
kubectl -n microservice-app wait --for=condition=complete job/db-migrate --timeout=180s
kubectl -n microservice-app wait --for=condition=complete job/db-seed --timeout=180s
kubectl -n microservice-app get pods,svc,ingress,hpa
```

Ajoutez `<IP minikube> microservice-app.local` à `/etc/hosts` (`minikube ip` pour l'IP), puis ouvrez
`http://microservice-app.local`.

```bash
bash scripts/smoke-test-k8s.sh          # santé, listing produits, création de commande, self-healing
```

## Observabilité

Prometheus/Grafana (`kube-prometheus-stack` via Helm) et quelques règles d'alerte. Détails dans
[`docs/observability.md`](./docs/observability.md).

```bash
bash scripts/observability-install.sh                      # installe la stack + ServiceMonitors
kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80
# http://127.0.0.1:3000 : dashboard "microservice-app - overview"
bash scripts/observability-alert-demo.sh                   # déclenche puis résout une alerte réelle
```

## Sécurité

RBAC minimal, `SecurityContext` non-root en lecture seule, NetworkPolicies `default-deny`, scan
d'image (Trivy) et de secrets (gitleaks) en CI. Détails et limites : [`docs/security.md`](./docs/security.md).

```bash
kubectl -n microservice-app auth can-i list secrets --as=system:serviceaccount:microservice-app:catalogue
kubectl -n microservice-app get networkpolicy
```

## Nettoyage

```bash
# Docker Compose
docker compose down -v

# Kubernetes
kubectl delete -k k8s/overlays/dev     # ou k8s/overlays/prod
helm -n monitoring uninstall kube-prometheus-stack
kubectl delete ns monitoring

# Cluster local
minikube stop      # conserve le cluster pour une prochaine session
minikube delete    # supprime entièrement le cluster local
```

## Dépannage

| Symptôme                                                | Cause probable / solution                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kubectl -n microservice-app get hpa` reste `<unknown>` | `metrics-server` absent : `minikube addons enable metrics-server`                                                                                      |
| Ingress renvoie 404 pour tout                           | Host manquant : ajoutez `<minikube ip> microservice-app.local` à `/etc/hosts`, ou passez l'en-tête `Host` explicitement avec `curl`                    |
| Pods `ImagePullBackOff` sur l'overlay `dev`             | Images construites hors du daemon Docker vu par le cluster : reconstruire après `eval $(minikube docker-env)` (minikube) ou `kind load docker-image`   |
| `job/db-migrate` ou `job/db-seed` reste `Pending`       | `Secret microservice-app-db` absent ou mal formé : vérifier `k8s/overlays/*/secret.env`                                                                |
| Tests d'intégration HTTP `skipped`                      | Normal sans base de test : `pnpm dev:db:up` puis relancer `pnpm test`                                                                                  |
| `NetworkPolicy` ne bloque aucun flux                    | CNI par défaut de minikube/kind sans support `NetworkPolicy` (voir [`docs/security.md`](./docs/security.md)), utiliser Calico/Cilium pour un test réel |
