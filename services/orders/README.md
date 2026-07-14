# service orders

API Node.js (TypeScript + Fastify) responsable de la création et de la consultation des
commandes.

## Démarrage local

```bash
cp .env.example .env   # adapter si besoin
pnpm --filter @microshop/orders dev
```

Prérequis : une base PostgreSQL migrée (voir [`packages/db`](../../packages/db)) et le service
`catalogue` démarré et accessible via `CATALOGUE_BASE_URL`.

## Variables d'environnement

| Variable               | Défaut | Description                                    |
| ---------------------- | ------ | ---------------------------------------------- |
| `PORT`                 | `4002` | Port d'écoute HTTP                             |
| `DATABASE_URL`         | —      | Chaîne de connexion PostgreSQL (obligatoire)   |
| `CATALOGUE_BASE_URL`   | —      | URL de base du service catalogue (obligatoire) |
| `LOG_LEVEL`            | `info` | Niveau de log pino                             |
| `REQUEST_TIMEOUT_MS`   | `5000` | Timeout de connexion et de requête SQL         |
| `CATALOGUE_TIMEOUT_MS` | `2000` | Timeout de l'appel HTTP vers catalogue         |

## Dépendance au service catalogue

`orders` ne lit jamais directement la table `products` : à la création d'une commande, il
appelle `GET /api/catalogue/products/:id` pour chaque produit référencé (dédupliqué), avec un
timeout borné (`CATALOGUE_TIMEOUT_MS`) et **sans retry** (une seule tentative). Ce choix privilégie la démonstration
explicite de la communication inter-services par rapport à un accès direct à une table partagée.

Comportement selon la réponse de catalogue :

| Résultat catalogue              | Effet sur la commande                                 |
| ------------------------------- | ----------------------------------------------------- |
| `200` avec le produit           | Le prix est capturé (`unitPriceCents`) pour la ligne  |
| `404`                           | `POST /api/orders` répond `404 PRODUCT_NOT_FOUND`     |
| timeout / erreur réseau / `5xx` | `POST /api/orders` répond `502 CATALOGUE_UNAVAILABLE` |

`GET /health/ready` ne vérifie que PostgreSQL, volontairement pas la disponibilité de catalogue
(voir `docs/architecture.md`), pour ne pas transformer une panne de catalogue en panne d'orders.

## Routes

| Méthode | Route             | Codes possibles                   |
| ------- | ----------------- | --------------------------------- |
| POST    | `/api/orders`     | `201`, `400`, `404`, `502`, `500` |
| GET     | `/api/orders/:id` | `200`, `400`, `404`, `500`        |
| GET     | `/health/live`    | `200`                             |
| GET     | `/health/ready`   | `200`, `503`                      |

### `POST /api/orders`

```json
{ "items": [{ "productId": "uuid", "quantity": 1 }] }
```

Contraintes : `items` non vide, au plus 50 lignes, `productId` UUID valide, `quantity` entier
strictement positif. Le total (`totalCents`) et le prix unitaire capturé (`unitPriceCents`) sont
calculés côté serveur à partir du prix retourné par catalogue au moment de la commande — jamais
fournis par le client.

Réponse `201` :

```json
{
  "id": "uuid",
  "status": "created",
  "totalCents": 7500,
  "currency": "EUR",
  "items": [{ "id": "uuid", "productId": "uuid", "quantity": 3, "unitPriceCents": 2500 }],
  "createdAt": "...",
  "updatedAt": "..."
}
```

### `GET /api/orders/:id`

Retourne la commande et ses lignes, ou `404 ORDER_NOT_FOUND`.

## Enveloppe d'erreur

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": {} } }
```

## Tests

```bash
pnpm --filter @microshop/orders test
```

Les tests unitaires (schémas, client catalogue simulé via `fetch` stubbé) s'exécutent toujours.
Les tests d'intégration (transaction, rollback, dépendances réelles à PostgreSQL) nécessitent
`TEST_DATABASE_URL` et sont sinon automatiquement ignorés :

```bash
pnpm dev:db:up
TEST_DATABASE_URL=postgresql://microshop:microshop@localhost:5433/microshop pnpm db:migrate
TEST_DATABASE_URL=postgresql://microshop:microshop@localhost:5433/microshop pnpm --filter @microshop/orders test
```

## Arrêt

Le service intercepte `SIGTERM`/`SIGINT`, ferme le serveur HTTP puis le pool PostgreSQL avant de
sortir, avec une temporisation de sécurité de 10s.
