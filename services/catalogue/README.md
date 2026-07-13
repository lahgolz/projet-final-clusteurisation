# service catalogue

API Node.js (TypeScript + Fastify) responsable de la lecture du catalogue de produits.

## Démarrage local

```bash
cp .env.example .env   # adapter si besoin
pnpm --filter @microshop/catalogue dev
```

Prérequis : une base PostgreSQL migrée et peuplée (voir [`packages/db`](../../packages/db) et le
[README racine](../../README.md#base-de-données-locale-développement)).

## Variables d'environnement

| Variable             | Défaut | Description                                           |
| -------------------- | ------ | ----------------------------------------------------- |
| `PORT`               | `4001` | Port d'écoute HTTP                                    |
| `DATABASE_URL`       | —      | Chaîne de connexion PostgreSQL (obligatoire)          |
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

Retourne un objet produit unique, ou `404` avec `{"error":{"code":"PRODUCT_NOT_FOUND", ...}}`.

## Enveloppe d'erreur

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": {} } }
```

## Tests

```bash
pnpm --filter @microshop/catalogue test
```

Les tests d'intégration qui nécessitent PostgreSQL sont automatiquement ignorés si
`TEST_DATABASE_URL` n'est pas défini :

```bash
pnpm dev:db:up
TEST_DATABASE_URL=postgresql://microshop:microshop@localhost:5433/microshop pnpm db:migrate
TEST_DATABASE_URL=postgresql://microshop:microshop@localhost:5433/microshop pnpm --filter @microshop/catalogue test
```

## Arrêt

Le service intercepte `SIGTERM`/`SIGINT`, ferme le serveur HTTP (`forceCloseConnections: 'idle'`)
puis le pool PostgreSQL avant de sortir, avec une temporisation de sécurité de 10s.
