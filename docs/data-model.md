# Modèle de données — PostgreSQL

Schéma unique, partagé par `catalogue` (propriétaire de `products`) et `orders` (propriétaire de
`orders` et `order_items`). Géré par [`packages/db`](../packages/db) via
[`node-pg-migrate`](https://github.com/salsita/node-pg-migrate).

## Diagramme

```mermaid
erDiagram
    PRODUCTS ||--o{ ORDER_ITEMS : "référencé par"
    ORDERS ||--|{ ORDER_ITEMS : contient

    PRODUCTS {
        uuid id PK
        text name
        text description
        integer price_cents
        text currency
        integer stock
        timestamptz created_at
        timestamptz updated_at
    }

    ORDERS {
        uuid id PK
        text status
        integer total_cents
        text currency
        timestamptz created_at
        timestamptz updated_at
    }

    ORDER_ITEMS {
        uuid id PK
        uuid order_id FK
        uuid product_id FK
        integer quantity
        integer unit_price_cents
        timestamptz created_at
    }
```

## Tables

### `products`

| Colonne       | Type          | Contraintes                                      |
| ------------- | ------------- | ------------------------------------------------ |
| `id`          | `uuid`        | PK, `gen_random_uuid()`                          |
| `name`        | `text`        | NOT NULL                                         |
| `description` | `text`        | nullable                                         |
| `price_cents` | `integer`     | NOT NULL, `>= 0`                                 |
| `currency`    | `text`        | NOT NULL, défaut `'EUR'`                         |
| `stock`       | `integer`     | NOT NULL, défaut `0`, `>= 0`                     |
| `created_at`  | `timestamptz` | NOT NULL, défaut `now()`                         |
| `updated_at`  | `timestamptz` | NOT NULL, défaut `now()`, mis à jour par trigger |

### `orders`

| Colonne       | Type          | Contraintes                                                            |
| ------------- | ------------- | ---------------------------------------------------------------------- |
| `id`          | `uuid`        | PK, `gen_random_uuid()`                                                |
| `status`      | `text`        | NOT NULL, défaut `'created'`, `IN ('created','confirmed','cancelled')` |
| `total_cents` | `integer`     | NOT NULL, `>= 0` — calculé côté serveur, jamais fourni par le client   |
| `currency`    | `text`        | NOT NULL, défaut `'EUR'`                                               |
| `created_at`  | `timestamptz` | NOT NULL, défaut `now()`                                               |
| `updated_at`  | `timestamptz` | NOT NULL, défaut `now()`, mis à jour par trigger                       |

### `order_items`

| Colonne            | Type          | Contraintes                                     |
| ------------------ | ------------- | ----------------------------------------------- |
| `id`               | `uuid`        | PK, `gen_random_uuid()`                         |
| `order_id`         | `uuid`        | NOT NULL, FK → `orders.id`, `ON DELETE CASCADE` |
| `product_id`       | `uuid`        | NOT NULL, FK → `products.id`                    |
| `quantity`         | `integer`     | NOT NULL, `> 0`                                 |
| `unit_price_cents` | `integer`     | NOT NULL, `>= 0` — prix capturé à la commande   |
| `created_at`       | `timestamptz` | NOT NULL, défaut `now()`                        |

Index : `order_items(order_id)`, `order_items(product_id)`, `products(name)`, `orders(created_at)`.

### Choix : montants en centimes entiers

Les montants (`price_cents`, `total_cents`, `unit_price_cents`) sont stockés en centimes sous
forme d'`integer`, jamais en `float`/`numeric` flottant. Cela évite les erreurs d'arrondi lors du
calcul du total et simplifie l'arithmétique côté service (addition d'entiers uniquement). La
devise (`currency`) est stockée à côté pour rester explicite, même si seul `EUR` est utilisé dans
le périmètre actuel.

### `unit_price_cents` capturé, pas recalculé

`order_items.unit_price_cents` capture le prix du produit **au moment de la commande** (fourni par
`catalogue` lors de la validation). Il n'est jamais recalculé après coup : un changement de prix
ultérieur dans `catalogue` ne doit pas modifier le montant d'une commande déjà passée.

## Migrations

- Outil : `node-pg-migrate`, migrations JavaScript versionnées dans `packages/db/migrations/`,
  horodatées (`<timestamp>_<nom>.js`), exécutées dans l'ordre lexicographique de leur nom.
- Ordre d'exécution actuel :
  1. `1783987200000_init-schema.js` — extension `pgcrypto`, fonction `set_updated_at`, tables
     `products`, `orders`, `order_items`, index, triggers `updated_at`.
- Commandes :
  - `pnpm db:migrate` → `node-pg-migrate up`
  - `pnpm db:rollback` → `node-pg-migrate down` (annule la dernière migration appliquée)
  - `pnpm db:seed` → insère/actualise le jeu de données de démonstration (idempotent, basé sur
    des UUID fixes avec `ON CONFLICT ... DO UPDATE`)
- **Exécution en cluster** : les migrations ne doivent jamais être lancées par chaque replica au
  démarrage (risque de migrations concurrentes). Elles sont exécutées par un `Job` Kubernetes
  dédié (`db-migrate`), lancé avant le rollout des Deployments applicatifs. En
  local, elles sont lancées manuellement via `pnpm db:migrate`.
- **Comportement en cas d'échec** : `node-pg-migrate` exécute chaque migration dans une
  transaction ; en cas d'erreur, la transaction est annulée et la table `pgmigrations` ne
  référence pas la migration en échec, donc `pnpm db:migrate` peut être relancé sans laisser la
  base dans un état intermédiaire. Le Job Kubernetes doit être configuré pour ne pas boucler
  indéfiniment (`backoffLimit` borné) et son échec doit bloquer le déploiement
  applicatif suivant.
- **Compatibilité ascendante (RollingUpdate)** : pendant un déploiement progressif, d'anciens et
  de nouveaux pods coexistent brièvement sur le même schéma. Règle appliquée : toute migration
  doit être _additive et non bloquante_ pour l'ancienne version (ajout de colonne nullable ou
  avec valeur par défaut, ajout de table, ajout d'index `CONCURRENTLY` si besoin en production) ;
  toute migration destructive (suppression de colonne/table, changement de type incompatible)
  doit être scindée en plusieurs étapes de déploiement (dépréciation puis suppression), documentée
  explicitement avant d'être exécutée. Aucune migration destructive n'est prévue dans le périmètre
  actuel.

## Tests

`packages/db/test/migrate.test.ts` applique réellement `up` puis `down` sur une base temporaire
désignée par `TEST_DATABASE_URL` (jamais une base de production) et vérifie la présence/absence
des tables attendues. Le test est ignoré (`describe.skip`) si cette variable n'est pas définie,
pour ne pas bloquer `pnpm test` en l'absence de PostgreSQL disponible.

Procédure locale :

```bash
pnpm dev:db:up
TEST_DATABASE_URL=postgresql://microshop:microshop@localhost:5433/microshop pnpm --filter @microshop/db test
```

## Réinitialisation locale (développement uniquement)

`pnpm dev:db:reset` supprime le conteneur PostgreSQL de développement, en recrée un vide, puis
rejoue migrations et seed. Cette procédure est strictement réservée au développement local : elle
n'est pas utilisable telle quelle en production (perte de données).
