# microservice-app

Application microservices de démonstration (frontend + 2 API + PostgreSQL) déployée sur
Kubernetes. Voir [`docs/architecture.md`](./docs/architecture.md) pour la vue d'ensemble,
[`docs/data-model.md`](./docs/data-model.md) pour le modèle de données,
[`docs/containerisation.md`](./docs/containerisation.md) pour les images Docker et
l'environnement local, et [`docs/ci-cd.md`](./docs/ci-cd.md) pour la pipeline CI/CD (stages,
secrets GitHub à configurer, rollback).

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
