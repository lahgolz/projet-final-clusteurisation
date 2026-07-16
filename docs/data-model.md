# Modèle de données

Un seul schéma, partagé par `catalogue` (propriétaire de `products`) et `orders` (propriétaire de
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
| `total_cents` | `integer`     | NOT NULL, `>= 0`, calculé côté serveur, jamais fourni par le client    |
| `currency`    | `text`        | NOT NULL, défaut `'EUR'`                                               |
| `created_at`  | `timestamptz` | NOT NULL, défaut `now()`                                               |
| `updated_at`  | `timestamptz` | NOT NULL, défaut `now()`, mis à jour par trigger                       |

### `order_items`

| Colonne            | Type          | Contraintes                                      |
| ------------------ | ------------- | ------------------------------------------------ |
| `id`               | `uuid`        | PK, `gen_random_uuid()`                          |
| `order_id`         | `uuid`        | NOT NULL, FK -> `orders.id`, `ON DELETE CASCADE` |
| `product_id`       | `uuid`        | NOT NULL, FK -> `products.id`                    |
| `quantity`         | `integer`     | NOT NULL, `> 0`                                  |
| `unit_price_cents` | `integer`     | NOT NULL, `>= 0`, prix capturé à la commande     |
| `created_at`       | `timestamptz` | NOT NULL, défaut `now()`                         |

Index : `order_items(order_id)`, `order_items(product_id)`, `products(name)`, `orders(created_at)`.

### Pourquoi des centimes en entier

Les montants (`price_cents`, `total_cents`, `unit_price_cents`) sont stockés en centimes, en
`integer`, jamais en flottant. Ça évite les erreurs d'arrondi sur le calcul du total et
simplifie l'arithmétique côté service. La devise est stockée à côté pour rester explicite, même si
seul `EUR` est utilisé aujourd'hui.

### Le prix est capturé, pas recalculé

`order_items.unit_price_cents` capture le prix du produit **au moment de la commande** (fourni par
`catalogue` lors de la validation). Il n'est jamais recalculé ensuite : un changement de prix
ultérieur ne doit pas modifier le montant d'une commande déjà passée.

## Migrations

- Outil : `node-pg-migrate`, migrations JS versionnées dans `packages/db/migrations/`, exécutées
  dans l'ordre de leur nom horodaté.
- Commandes :
  - `pnpm db:migrate` -> `node-pg-migrate up`
  - `pnpm db:rollback` -> `node-pg-migrate down` (annule la dernière migration)
  - `pnpm db:seed` -> insère/actualise le jeu de données de démo (idempotent, UUID fixes avec
    `ON CONFLICT ... DO UPDATE`)
- **En cluster**, les migrations ne doivent jamais être lancées par chaque replica au démarrage
  (risque de collision). Elles passent par un `Job` Kubernetes dédié (`db-migrate`), lancé avant
  le rollout des Deployments. En local, `pnpm db:migrate` suffit.
- **En cas d'échec**, chaque migration tourne dans sa propre transaction : si elle échoue, elle
  est annulée et `pgmigrations` ne la référence pas, donc `pnpm db:migrate` peut être relancé sans
  laisser la base dans un état intermédiaire.
- **Compatibilité ascendante** : pendant un rolling update, anciens et nouveaux pods coexistent
  brièvement sur le même schéma. Règle appliquée : une migration doit être additive et non
  bloquante pour l'ancienne version (colonne nullable ou avec défaut, nouvelle table...). Une
  migration destructive devrait se faire en plusieurs étapes (dépréciation puis suppression) - pas
  de cas de ce genre dans le périmètre actuel.

## Tests

`packages/db/test/migrate.test.ts` applique réellement `up` puis `down` sur une base temporaire
désignée par `TEST_DATABASE_URL` et vérifie que les tables apparaissent/disparaissent comme
attendu. Ignoré (`describe.skip`) si cette variable n'est pas définie.

```bash
pnpm dev:db:up
TEST_DATABASE_URL=postgresql://microservice-app:microservice-app@localhost:5433/microservice-app pnpm --filter @microservice-app/db test
```

## Réinitialisation locale (dev uniquement)

`pnpm dev:db:reset` supprime le conteneur PostgreSQL de dev, en recrée un vide, puis rejoue
migrations et seed. Réservé au développement local : ça efface les données.
