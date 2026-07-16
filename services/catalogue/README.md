# service catalogue

API Node.js (TypeScript + Fastify) qui gère la lecture du catalogue de produits.

## Démarrage local

```bash
cp .env.example .env   # adapter si besoin
pnpm --filter @microservice-app/catalogue dev
```

Il faut une base PostgreSQL migrée et peuplée au préalable (voir [`packages/db`](../../packages/db)
et le [README racine](../../README.md#base-de-données-locale)).

## Variables d'environnement

| Variable             | Défaut | Description                                           |
| -------------------- | ------ | ----------------------------------------------------- |
| `PORT`               | `4001` | Port d'écoute HTTP                                    |
| `DATABASE_URL`       | -      | Chaîne de connexion PostgreSQL (obligatoire)          |
| `LOG_LEVEL`          | `info` | Niveau de log pino                                    |
| `DB_POOL_MIN`        | `2`    | Connexions ouvertes de manière proactive au démarrage |
| `DB_POOL_MAX`        | `10`   | Taille maximale du pool `pg`                          |
| `REQUEST_TIMEOUT_MS` | `5000` | Timeout de connexion et de requête SQL                |

## Routes

| Méthode | Route                         | Codes possibles                        |
| ------- | ----------------------------- | -------------------------------------- |
| GET     | `/api/catalogue/products`     | `200`, `400`, `500`                    |
| GET     | `/api/catalogue/products/:id` | `200`, `400`, `404`, `500`             |
| GET     | `/health/live`                | `200` (jamais dépendant de PostgreSQL) |
| GET     | `/health/ready`               | `200`, `503` (dépend de PostgreSQL)    |

### `GET /api/catalogue/products`

Paramètres de requête optionnels : `limit` (défaut `50`, max `100`), `offset` (défaut `0`).

```json
{
  "products": [
    {
      "id": "uuid",
      "name": "...",
      "priceCents": 4990,
      "currency": "EUR",
      "stock": 25,
      "description": "...",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

### `GET /api/catalogue/products/:id`

Retourne un produit, ou `404` avec `{"error":{"code":"PRODUCT_NOT_FOUND", ...}}`.

## Enveloppe d'erreur

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": {} } }
```

## Tests

```bash
pnpm --filter @microservice-app/catalogue test
```

Les tests d'intégration qui ont besoin de PostgreSQL sont ignorés automatiquement si
`TEST_DATABASE_URL` n'est pas défini :

```bash
pnpm dev:db:up
TEST_DATABASE_URL=postgresql://microservice-app:microservice-app@localhost:5433/microservice-app pnpm db:migrate
TEST_DATABASE_URL=postgresql://microservice-app:microservice-app@localhost:5433/microservice-app pnpm --filter @microservice-app/catalogue test
```

## Arrêt

Le service intercepte `SIGTERM`/`SIGINT`, ferme le serveur HTTP (`forceCloseConnections: 'idle'`)
puis le pool PostgreSQL avant de sortir, avec un délai de sécurité de 10s.
