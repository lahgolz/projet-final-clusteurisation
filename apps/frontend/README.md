# apps/frontend

Interface React + Vite + TypeScript : liste le catalogue de produits et permet de créer une
commande.

## Démarrage local

```bash
pnpm --filter @microservice-app/frontend dev
```

Ouvre `http://localhost:5173`. En dev, Vite proxy `/api/catalogue` vers `http://localhost:4001`
et `/api/orders` vers `http://localhost:4002` (voir `vite.config.ts`) : pensez à démarrer les deux
API avant (ou lancez `pnpm dev` à la racine, qui démarre les trois d'un coup).

## Configuration

Le frontend appelle les API via des **chemins relatifs** (`/api/catalogue/...`,
`/api/orders/...`) : ça passe par l'Ingress une fois déployé, sans jamais exposer d'URL interne au
cluster au navigateur. `VITE_API_BASE_URL` (voir `.env.example`) permet de préfixer ces appels si
les API sont un jour exposées sur une origine différente ; vide par défaut.

## Comportements gérés

- Chargement (`role="status"`) pendant la récupération du catalogue.
- Catalogue vide (message dédié).
- Erreur réseau, timeout (8s) ou erreur serveur à la récupération du catalogue (`role="alert"`).
- Confirmation ou erreur après la création d'une commande, affichée au niveau du produit
  concerné.
- Bouton "Commander" et champ quantité désactivés quand le stock est à 0.

## Build et serveur statique

```bash
pnpm --filter @microservice-app/frontend build     # génère apps/frontend/dist
pnpm --filter @microservice-app/frontend preview   # sert le build localement
```

`nginx.conf` contient la configuration destinée à l'image de production (SPA + route `/healthz`
qui répond `200`).

## Tests

```bash
pnpm --filter @microservice-app/frontend test
```

Couvre : rendu de la liste de produits, état vide, erreur de chargement du catalogue, création
de commande réussie, erreur lors de la création d'une commande, et le client HTTP
(`src/api/client.ts`) sur ses cas 2xx, erreur serveur, erreur réseau et timeout.

## Lint et typecheck

```bash
pnpm --filter @microservice-app/frontend lint
pnpm --filter @microservice-app/frontend typecheck
```
