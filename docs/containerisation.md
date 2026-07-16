# Conteneurisation et environnement local

Ce document couvre les images OCI de chaque composant, l'environnement Docker Compose local, le
smoke test et le scan de vulnérabilités.

## Images

| Image                        | Dockerfile                      | Base d'exécution                                         | Port |
| ---------------------------- | ------------------------------- | -------------------------------------------------------- | ---- |
| `microservice-app/catalogue` | `services/catalogue/Dockerfile` | `node:22.23.1-alpine3.24`, utilisateur `node` (non-root) | 4001 |
| `microservice-app/orders`    | `services/orders/Dockerfile`    | `node:22.23.1-alpine3.24`, utilisateur `node` (non-root) | 4002 |
| `microservice-app/frontend`  | `apps/frontend/Dockerfile`      | `nginxinc/nginx-unprivileged:1.29.8-alpine3.23`, uid 101 | 8080 |
| `microservice-app/db-tools`  | `packages/db/Dockerfile`        | `node:22.23.1-alpine3.24`, utilisateur `node` (non-root) | -    |

Toutes les images se construisent **depuis la racine du monorepo** (`context: .`), pas depuis le
dossier du service : `catalogue` et `orders` dépendent du paquet workspace
`@microservice-app/shared`, et les trois apps partagent un seul `pnpm-lock.yaml`.

```bash
docker build -f services/catalogue/Dockerfile -t microservice-app/catalogue:<tag> .
docker build -f services/orders/Dockerfile    -t microservice-app/orders:<tag>    .
docker build -f apps/frontend/Dockerfile      -t microservice-app/frontend:<tag>  .
docker build -f packages/db/Dockerfile        -t microservice-app/db-tools:<tag>  .
```

`<tag>` = SHA Git court du commit (`git rev-parse --short HEAD`), jamais `latest`.

### Build multi-stage

Chaque Dockerfile applicatif suit le même schéma :

1. `base` : image Node épinglée (tag + variante alpine précis, jamais `node:22-alpine`), active
   corepack/pnpm.
2. `deps` : copie les `package.json` du workspace puis `pnpm install --frozen-lockfile
--ignore-scripts` (`--ignore-scripts` évite de lancer le `postinstall` racine - qui build
   `@microservice-app/shared` - avant que son code source soit copié).
3. `build` : copie le code, build `shared` puis le service, puis `pnpm --filter <service> deploy
--prod --legacy /prod/<service>` : cette commande résout les dépendances `workspace:*` en
   fichiers réels et ne garde que les dépendances de prod, pour produire un dossier autonome.
4. `runtime` : repart d'une image Node fraîche, ne copie que `/prod/<service>` (donc pas de
   `src/`, ni tests, ni outils de build), tourne en `node` (non-root), `CMD ["node", "dist/server.js"]`.

`apps/frontend/Dockerfile` n'a pas d'étape `deploy` : le build produit un dossier statique
(`dist/`), copié dans une image `nginx-unprivileged` (non-root nativement, écoute sur 8080).

Un seul [`.dockerignore`](../.dockerignore) à la racine (le contexte de build est toujours la
racine) : exclut `node_modules`, `dist`, `.git`, les `.env*` (sauf `.env.example`), `k8s/`,
`docs/`, `scripts/`, etc.

### Arrêt propre

`catalogue` et `orders` interceptent `SIGTERM`/`SIGINT` (voir `src/server.ts`), ferment le
serveur HTTP puis le pool PostgreSQL avant de sortir. `nginx-unprivileged` gère nativement
`SIGTERM`/`SIGQUIT`, rien à configurer en plus.

## Environnement Docker Compose local

[`docker-compose.yml`](../docker-compose.yml) démarre :

- `postgres` (volume nommé `postgres-data`) ;
- `migrate` puis `seed` : jobs uniques (`restart: "no"`), enchaînés via
  `depends_on: condition: service_completed_successfully`, jamais en parallèle ;
- `catalogue`, `orders`, `frontend` : chacun avec un `healthcheck` applicatif ;
- `gateway` : un reverse proxy nginx simple (image `nginx:1.29.8-alpine3.23`), seul point d'entrée
  publié sur l'hôte (voir [`gateway.nginx.conf`](../gateway.nginx.conf)). `apps/frontend/nginx.conf`
  reste un simple serveur statique, sans routage `/api/*`, pour rester valide tel quel derrière le
  futur Ingress.

Réseau interne dédié, pas de port publié pour `postgres`, `catalogue`, `orders`, `frontend` : seul
`gateway` expose un port sur l'hôte.

```bash
docker compose build           # build les 5 images
docker compose up -d           # démarre postgres -> migrate -> seed -> catalogue/orders/frontend -> gateway
docker compose ps              # état/santé de chaque service
docker compose logs -f <name>  # logs JSON d'un service
curl http://localhost:8080/api/catalogue/products
curl -X POST http://localhost:8080/api/orders -H 'content-type: application/json' \
  -d '{"items":[{"productId":"<uuid>","quantity":1}]}'
docker compose restart orders  # la commande créée reste lisible après redémarrage
docker compose down -v         # arrêt propre + suppression du volume (dev uniquement)
```

## Smoke test

[`scripts/smoke-test.sh`](../scripts/smoke-test.sh) automatise tout le cycle : build, démarrage,
attente que `catalogue`/`orders`/`frontend` passent `healthy`, vérification que `migrate`/`seed`
se terminent avec le code `0`, listing du catalogue et création d'une commande via la gateway,
redémarrage de `orders` avec vérification que la commande persiste, vérification que rien ne
tourne en root, puis arrêt et nettoyage complet même en cas d'échec.

```bash
bash scripts/smoke-test.sh
echo $?   # 0 si tout est passé
```

Utilise un projet compose dédié (`-p microservice-app-smoke`), n'interfère pas avec une stack déjà
lancée manuellement.

## Scan de vulnérabilités (Trivy)

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy:latest image --severity CRITICAL,HIGH --scanners vuln microservice-app/catalogue:<tag>
# idem pour orders, frontend, db-tools
```

### Résultat

Aucune image ne remonte de vulnérabilité **CRITICAL**. Il reste quelques `HIGH`, tous non
exploitables dans notre contexte :

| Image                        | HIGH | Origine                                                                                                                                                     |
| ---------------------------- | :--: | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `microservice-app/catalogue` |  2   | CLI `npm` embarquée dans l'image Node de base, jamais invoquée (le conteneur lance `node dist/server.js` directement)                                       |
| `microservice-app/orders`    |  2   | idem                                                                                                                                                        |
| `microservice-app/frontend`  |  8   | Paquets système Alpine sans correctif publié à la date du scan (`c-ares`, `libssl3`, `libexpat`, `libxml2`)                                                 |
| `microservice-app/db-tools`  |  19  | Dépendances internes du binaire `pnpm` lui-même, jamais exercées : le conteneur exécute juste un script déjà installé sans réinstaller de paquet au runtime |

## Vérifié en pratique

Build des 4 images, `docker compose up -d` jusqu'à `healthy`, listing + création de commande via
la gateway, redémarrage isolé de `catalogue`/`orders` avec commande toujours consultable ensuite
(persistance assurée par le volume PostgreSQL), tous les conteneurs applicatifs tournant en
non-root (`node` pour les API, `nginx` uid 101 pour le frontend), arrêt propre observé dans les
logs, et `scripts/smoke-test.sh` qui sort avec le code 0.
