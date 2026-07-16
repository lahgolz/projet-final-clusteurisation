# microservice-app

Application microservices de démonstration (frontend + 2 API + PostgreSQL) déployée sur
Kubernetes. Voir [`docs/architecture.md`](./docs/architecture.md) pour la vue d'ensemble,
[`docs/data-model.md`](./docs/data-model.md) pour le modèle de données,
[`docs/containerisation.md`](./docs/containerisation.md) pour les images Docker et
l'environnement local, [`docs/ci-cd.md`](./docs/ci-cd.md) pour la pipeline CI/CD (stages,
secrets GitHub à configurer, rollback), [`docs/resilience.md`](./docs/resilience.md) et
[`docs/performance.md`](./docs/performance.md) pour la scalabilité/résilience et le test de
charge, [`docs/observability.md`](./docs/observability.md) pour le monitoring,
[`docs/security.md`](./docs/security.md) pour la sécurité Kubernetes, et
[`docs/backup-restore.md`](./docs/backup-restore.md) / [`docs/runbooks.md`](./docs/runbooks.md)
pour la sauvegarde/restauration et les procédures d'incident.

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
├── docs/                # documentation d'architecture, modèle de données, conteneurisation, CI/CD
├── scripts/             # scripts de développement (base de données locale, smoke test)
│   └── ci/              # scripts utilisés uniquement par la pipeline CI/CD
├── docker-compose.yml   # environnement local complet (postgres, migrate, seed, apps, gateway)
├── gateway.nginx.conf   # reverse proxy local (rôle d'Ingress, cf. docker-compose.yml)
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

## Base de données locale (développement)

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

Le frontend appelle les API via des chemins relatifs (`/api/catalogue`, `/api/orders`) ; en
développement, Vite proxy ces chemins vers les services locaux (voir
`apps/frontend/vite.config.ts`).

## Environnement conteneurisé (Docker Compose)

```bash
docker compose up -d --build   # postgres, migrate, seed, catalogue, orders, frontend, gateway
curl http://localhost:8080/api/catalogue/products
docker compose down -v         # arrêt propre + suppression du volume de développement
```

Smoke test de bout en bout (build, démarrage, migrations, requêtes, persistance après
redémarrage, vérification non-root, arrêt) :

```bash
bash scripts/smoke-test.sh
```

Détails, Dockerfiles, choix de versions et résultats du scan Trivy :
[`docs/containerisation.md`](./docs/containerisation.md).

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
pnpm test        # tests unitaires de tous les paquets/services/apps (Vitest)
pnpm lint        # ESLint, zéro avertissement toléré
pnpm typecheck   # tsc --noEmit sur tout le monorepo
pnpm build       # build de production de tout le monorepo
```

Les tests d'intégration HTTP (`test/integration/*.routes.test.ts` dans `services/catalogue` et
`services/orders`) sont ignorés (`skipped`) tant qu'aucune base PostgreSQL de test n'est
accessible : démarrez-en une avec `pnpm dev:db:up` puis relancez `pnpm test` pour les exécuter.
Détails des suites par service : [`services/catalogue/README.md`](./services/catalogue/README.md),
[`services/orders/README.md`](./services/orders/README.md).

## Déploiement Kubernetes

Manifests Kustomize dans `k8s/` (`base` + `overlays/dev`/`overlays/prod`). Prérequis, construction
des images, secret de base de données, stockage et commandes de déploiement détaillés dans
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

Prometheus/Grafana (`kube-prometheus-stack` via Helm) et les règles d'alerte applicatives. Détails,
capture d'écran du dashboard et scénario d'alerte : [`docs/observability.md`](./docs/observability.md).

```bash
bash scripts/observability-install.sh                      # installe kube-prometheus-stack + ServiceMonitors
kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80
# http://127.0.0.1:3000 — dashboard "microservice-app - overview"
bash scripts/observability-alert-demo.sh                   # déclenche puis résout une alerte réelle
```

## Sécurité

RBAC minimal, `SecurityContext` non-root en lecture seule, NetworkPolicies `default-deny`, scan
d'image (Trivy) et de secrets (gitleaks) en CI. Détails, limites et preuves :
[`docs/security.md`](./docs/security.md).

```bash
kubectl -n microservice-app auth can-i list secrets --as=system:serviceaccount:microservice-app:catalogue
kubectl -n microservice-app get networkpolicy
```

## Démonstration

Script guidé (10-15 min) couvrant architecture, pipeline, application, objets Kubernetes, probes,
logs/métriques, HPA sous charge, résilience, sécurité et limites :

```bash
bash scripts/demo.sh                     # cible http://microservice-app.local par défaut
bash scripts/demo.sh http://<autre-host> # cible alternative (ex. port-forward local)
```

Chaque étape affiche une commande de secours si l'interface web correspondante (navigateur,
Grafana) n'est pas accessible depuis l'environnement de démonstration.

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
minikube delete     # supprime entièrement le cluster local
```

## Versions d'outils testées

| Outil           | Version testée   |
| --------------- | ----------------- |
| Node.js         | v24.12.0 (`>=20` requis) |
| pnpm            | 10.28.2            |
| Docker          | 29.6.1             |
| Docker Compose  | v5.3.1             |
| kubectl         | v1.36.2 (Kustomize v5.8.1 intégré) |
| minikube        | v1.38.1            |
| Helm            | v3.21.3            |
| Trivy (CI)      | via `aquasecurity/trivy-action@v0.36.0` |
| gitleaks (CI)   | v8.21.2            |

## Dépannage

| Symptôme                                             | Cause probable / solution                                                                                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kubectl -n microservice-app get hpa` reste `<unknown>` | `metrics-server` absent : `minikube addons enable metrics-server`                                                                                              |
| Ingress renvoie 404 pour tout                          | Host manquant : ajoutez `<minikube ip> microservice-app.local` à `/etc/hosts`, ou envoyez l'en-tête `Host` explicitement avec `curl`                             |
| Pods `ImagePullBackOff` sur l'overlay `dev`            | Images construites hors du daemon Docker vu par le cluster : reconstruire après `eval $(minikube docker-env)` (minikube) ou `kind load docker-image` (kind)     |
| `job/db-migrate` ou `job/db-seed` reste `Pending`      | `Secret microservice-app-db` absent ou mal formé : vérifier `k8s/overlays/*/secret.env` (copié depuis `secret.env.example`, `DATABASE_URL` cohérent avec `POSTGRES_PASSWORD`) |
| Tests d'intégration HTTP `skipped`                     | Comportement attendu sans base de test : `pnpm dev:db:up` puis relancer `pnpm test`                                                                              |
| CronJob `postgres-backup` en `Error` transitoire        | Résolution DNS du Service `postgres` pas encore prête juste après un (re)démarrage du cluster ; le Job retente automatiquement (`backoffLimit`), vérifier `kubectl -n microservice-app get jobs` |
| `NetworkPolicy` ne bloque aucun flux                    | CNI par défaut de minikube/kind sans support `NetworkPolicy` : limite documentée dans [`docs/security.md`](./docs/security.md), utiliser Calico/Cilium pour un test réel |
