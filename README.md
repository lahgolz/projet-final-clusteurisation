# MicroShop

Application microservices de démonstration (frontend + 2 API + PostgreSQL) déployée sur
Kubernetes. Voir [`docs/architecture.md`](./docs/architecture.md) pour la vue d'ensemble et
[`docs/data-model.md`](./docs/data-model.md) pour le modèle de données.

## Structure du dépôt

```text
.
├── apps/
│   └── frontend/       # React + Vite + TypeScript
├── services/
│   ├── catalogue/      # API produits (Fastify + TypeScript)
│   └── orders/         # API commandes (Fastify + TypeScript)
├── packages/
│   ├── shared/         # logger JSON, helper HTTP avec timeout, partagés par les services
│   └── db/             # migrations, seed et schéma PostgreSQL
├── k8s/
│   ├── base/           # manifests Kubernetes de base (à partir de l'étape 7)
│   └── overlays/       # variantes Kustomize (dev/prod, à partir de l'étape 7)
├── docs/                # documentation d'architecture et de modèle de données
├── scripts/             # scripts de développement (base de données locale, etc.)
└── .github/workflows/   # pipeline CI/CD (à partir de l'étape 11)
```

## Prérequis

- Node.js ≥ 20
- pnpm ≥ 10 (`corepack enable` recommandé)
- Docker (pour PostgreSQL en local et pour la conteneurisation)

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

## Conventions

- TypeScript strict partout.
- Logs JSON structurés sur stdout (voir `packages/shared/src/logger.ts`).
- Aucune image ne doit être taguée `latest` dans les manifests Kubernetes : tag = SHA Git court.
- Aucun secret réel n'est commité : `.env.example` documente les variables attendues, les valeurs
  réelles restent locales ou dans des Secrets Kubernetes (voir étape 8).

## Étapes du projet

Le détail du plan d'exécution par étape se trouve dans [`agents/`](./agents/00_README.md).
