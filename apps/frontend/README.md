# apps/frontend

Interface React + Vite + TypeScript : liste le catalogue de produits et permet de créer une
commande.

## Démarrage local

```bash
pnpm --filter @microshop/frontend dev
```

Ouvre `http://localhost:5173`. En développement, Vite proxy `/api/catalogue` vers
`http://localhost:4001` et `/api/orders` vers `http://localhost:4002` (voir `vite.config.ts`) :
démarrer les deux services backend au préalable (`pnpm dev` à la racine les lance tous les
trois).

## Configuration

Le frontend appelle les API via des **chemins relatifs** (`/api/catalogue/...`,
`/api/orders/...`), pensés pour passer par l'Ingress une fois déployé — aucune URL interne au
cluster n'est exposée au navigateur. `VITE_API_BASE_URL` (voir `.env.example`) permet de préfixer
ces appels si les API sont un jour exposées sur une origine différente ; laissé vide par défaut.

## Comportements gérés

- Chargement (`role="status"`) pendant la récupération du catalogue.
- Catalogue vide (message dédié).
- Erreur réseau, timeout (8s) ou erreur serveur à la récupération du catalogue (`role="alert"`).
- Confirmation ou erreur après la création d'une commande, affichée au niveau du produit
  concerné.
- Désactivation du bouton "Commander" et du champ quantité quand le stock est à 0.

## Build et serveur statique

```bash
pnpm --filter @microshop/frontend build     # génère apps/frontend/dist
pnpm --filter @microshop/frontend preview   # sert le build localement
```

`nginx.conf` contient la configuration destinée à l'image de production (SPA + route `/healthz` retournant `200`)

## Tests

```bash
pnpm --filter @microshop/frontend test
```

Couvre : rendu de la liste de produits, état vide, erreur de chargement du catalogue, création
de commande réussie, erreur lors de la création d'une commande, et le client HTTP
(`src/api/client.ts`) : réponse 2xx, erreur serveur, erreur réseau, timeout.

## Lint et typecheck

```bash
pnpm --filter @microshop/frontend lint
pnpm --filter @microshop/frontend typecheck
```
