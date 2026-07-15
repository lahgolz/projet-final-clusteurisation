# Conteneurisation et environnement local

Ce document couvre images OCI par composant, environnement Docker Compose local,
smoke test et scan de vulnérabilités.

## Images

| Image                        | Dockerfile                      | Base d'exécution                                         | Port |
| ---------------------------- | ------------------------------- | -------------------------------------------------------- | ---- |
| `microservice-app/catalogue` | `services/catalogue/Dockerfile` | `node:22.23.1-alpine3.24`, utilisateur `node` (non-root) | 4001 |
| `microservice-app/orders`    | `services/orders/Dockerfile`    | `node:22.23.1-alpine3.24`, utilisateur `node` (non-root) | 4002 |
| `microservice-app/frontend`  | `apps/frontend/Dockerfile`      | `nginxinc/nginx-unprivileged:1.29.8-alpine3.23`, uid 101 | 8080 |
| `microservice-app/db-tools`  | `packages/db/Dockerfile`        | `node:22.23.1-alpine3.24`, utilisateur `node` (non-root) | -    |

Toutes les images sont construites **depuis la racine du monorepo** (`context: .`), pas depuis
le dossier du service : `catalogue` et `orders` dépendent du paquet workspace
`@microservice-app/shared`, et les trois applications partagent un unique `pnpm-lock.yaml`.

```bash
docker build -f services/catalogue/Dockerfile -t microservice-app/catalogue:<tag> .
docker build -f services/orders/Dockerfile    -t microservice-app/orders:<tag>    .
docker build -f apps/frontend/Dockerfile      -t microservice-app/frontend:<tag>  .
docker build -f packages/db/Dockerfile        -t microservice-app/db-tools:<tag>  .
```

`<tag>` = SHA Git court du commit (`git rev-parse --short HEAD`), jamais `latest`, conformément
aux règles globales du projet.

### Construction (multi-stage)

Chaque Dockerfile applicatif suit le même schéma :

1. `base` : image Node épinglée (tag + variante alpine précis, pas `node:22-alpine`), active
   corepack/pnpm.
2. `deps` : copie uniquement les `package.json` du workspace puis `pnpm install
--frozen-lockfile --ignore-scripts` (le `--ignore-scripts` évite d'exécuter le `postinstall`
   racine, qui build `@microservice-app/shared`, avant que son code source ne soit copié).
3. `build` : copie le code source, build `@microservice-app/shared` puis le service, puis
   `pnpm --filter <service> deploy --prod --legacy /prod/<service>` : cette commande résout les
   dépendances `workspace:*` en fichiers réels et ne conserve que les dépendances de production,
   produisant un dossier autonome. `--legacy` est nécessaire avec pnpm 10 par défaut (voir
   commentaire dans les Dockerfiles) pour ne pas changer la résolution des dépendances workspace
   utilisée en développement (symlinks, cf. `packages/shared`).
4. `runtime` : repart d'une image Node fraîche, copie uniquement `/prod/<service>` (donc pas de
   `src/`, tests, ni outils de build), tourne en utilisateur `node` (non-root), expose son port,
   `CMD ["node", "dist/server.js"]`.

`packages/db/package.json` déclare `node-pg-migrate` et `tsx` en dépendances (pas
devDependencies) : ce sont les outils réellement exécutés au runtime de `microservice-app/db-tools`,
pas de simples outils de développement. Son Dockerfile installe uniquement
`--prod --filter @microservice-app/db`, sans les devDependencies des autres paquets du workspace.

`apps/frontend/Dockerfile` n'a pas d'étape `deploy` : le build stage produit un dossier statique
(`dist/`), copié dans une image `nginx-unprivileged` (tourne nativement en non-root, écoute par
défaut sur le port 8080, cohérent avec `apps/frontend/nginx.conf`).

### `.dockerignore`

Un seul fichier à la racine (le contexte de build est toujours la racine) : exclut
`node_modules`, `dist`, `.git`, les fichiers `.env*` (sauf `.env.example`), `k8s/`, `docs/`,
`scripts/`, etc. Voir [`../.dockerignore`](../.dockerignore).

### Arrêt propre (SIGTERM)

- `catalogue` et `orders` interceptent `SIGTERM`/`SIGINT` en application (voir
  `src/server.ts`), ferment le serveur HTTP puis le pool PostgreSQL avant de sortir.
- `nginx-unprivileged` gère nativement `SIGTERM` (arrêt rapide) et `SIGQUIT` (arrêt
  gracieux, `STOPSIGNAL` par défaut de l'image) ; aucune configuration supplémentaire requise.

## Environnement Docker Compose local

[`docker-compose.yml`](../docker-compose.yml) démarre :

- `postgres` (volume nommé `postgres-data` pour la persistance) ;
- `migrate` puis `seed` : jobs uniques (`restart: "no"`), enchaînés via
  `depends_on: condition: service_completed_successfully`, jamais exécutés en parallèle ;
- `catalogue`, `orders`, `frontend` : chacun avec un `healthcheck` applicatif
  (`/health/ready` ou `/healthz`) ;
- `gateway` : reverse proxy nginx simple (image `nginx:1.29.8-alpine3.23`, pas l'image
  applicative) seul point d'entrée publié sur l'hôte (voir [`gateway.nginx.conf`](../gateway.nginx.conf)).
  `apps/frontend/nginx.conf` reste un simple serveur statique, sans connaissance du routage
  `/api/*`, pour rester valide tel quel derrière le futur Ingress.

Réseau interne dédié (`microservice-app-internal`), pas de port publié pour `postgres`, `catalogue`,
`orders`, `frontend` : seul `gateway` expose un port sur l'hôte.

### Commandes

```bash
docker compose build           # build les 5 images
docker compose up -d           # démarre postgres -> migrate -> seed -> catalogue/orders/frontend -> gateway
docker compose ps              # état/santé de chaque service
docker compose logs -f <name>  # logs JSON d'un service
curl http://localhost:8080/api/catalogue/products
curl -X POST http://localhost:8080/api/orders -H 'content-type: application/json' \
  -d '{"items":[{"productId":"<uuid>","quantity":1}]}'
docker compose restart orders  # persistance : la commande créée reste lisible après redémarrage
docker compose down -v         # arrêt propre + suppression du volume (jetable, dev uniquement)
```

## Smoke test

[`scripts/smoke-test.sh`](../scripts/smoke-test.sh) automatise : build, démarrage, attente de
l'état `healthy` de `catalogue`/`orders`/`frontend`, vérification que `migrate`/`seed` se sont
terminés avec un code de sortie `0`, listing du catalogue et création d'une commande via la
gateway, redémarrage de `orders` avec vérification que la commande persiste, vérification que
`catalogue`/`orders`/`frontend` ne tournent pas en root, vérification de `/healthz`, puis arrêt
et nettoyage complet (`docker compose down -v`), y compris en cas d'échec (`trap ... EXIT`).

```bash
bash scripts/smoke-test.sh
echo $?   # 0 si tout est passé
```

Utilise un projet compose dédié (`-p microservice-app-smoke`), n'interfère pas avec une éventuelle
stack `microservice-app` déjà lancée manuellement.

## Scan de vulnérabilités (Trivy)

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy:latest image --severity CRITICAL,HIGH --scanners vuln microservice-app/catalogue:<tag>
# idem pour orders, frontend, db-tools
```

### Résultat

| Image                        | CRITICAL | HIGH | Origine des findings restants                                                                                                                                                                                                                       |
| ---------------------------- | :------: | :--: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `microservice-app/catalogue` |    0     |  2   | CLI `npm` embarquée dans l'image de base Node, jamais invoquée (le conteneur exécute `node dist/server.js` directement)                                                                                                                             |
| `microservice-app/orders`    |    0     |  2   | idem                                                                                                                                                                                                                                                |
| `microservice-app/frontend`  |    0     |  8   | Paquets système Alpine (`c-ares`, `libssl3`/`libcrypto3`, `libexpat`, `libxml2`) sans correctif Alpine publié à la date du scan                                                                                                                     |
| `microservice-app/db-tools`  |    0     |  19  | Dépendances internes du binaire `pnpm` lui-même (tar/glob/minimatch/sigstore) ; jamais exercées car le conteneur ne fait qu'exécuter un script déjà installé (`pnpm run migrate:up` / `seed`), sans jamais réinstaller/patcher de paquet au runtime |

Aucune vulnérabilité **CRITICAL** non justifiée : toutes les images sont à 0 CRITICAL.

### Décision : image "distroless" évaluée puis écartée

Une image `gcr.io/distroless/nodejs22-debian12:nonroot` a été testée pour `catalogue`/`orders`
(pas de shell, pas de gestionnaire de paquets, surface d'attaque minimale). Écartée : au moment
du build, son `libssl3` embarqué portait une CVE **CRITICAL** (`CVE-2026-31789`, non corrigée en
amont sur le build distroless disponible), alors que l'image `node:22.23.1-alpine3.24` ne
remonte aucune CVE CRITICAL. Réévaluer périodiquement (l'image distroless peut être corrigée par
la suite).

### Décision : version de `nginx-unprivileged` relevée

`nginxinc/nginx-unprivileged:1.27.5-alpine3.21` (choix initial) portait la même CVE OpenSSL
CRITICAL que ci-dessus dans son Alpine de base. `nginxinc/nginx-unprivileged:1.29.8-alpine3.23`
(Alpine plus récente) n'en remonte aucune : c'est la version retenue pour `apps/frontend/Dockerfile`.

## Vérifications effectuées (résumé)

- Build des 4 images : succès.
- `docker compose up -d` : tous les services applicatifs passent `healthy`.
- Listing des produits et création d'une commande via la gateway (`localhost:8080`) : succès.
- Redémarrage de `catalogue`/`orders` isolément : la commande créée reste consultable
  (persistance assurée par le volume PostgreSQL, indépendant du cycle de vie des conteneurs
  applicatifs).
- `docker exec <container> id` / `docker inspect --format '{{.Config.User}}'` : `catalogue` et
  `orders` tournent en `node` (uid 1000), `frontend` en `nginx` (uid 101), aucun conteneur
  applicatif en root.
- Arrêt (`docker stop`, `docker compose down`) : logs `shutting_down` puis `shutdown_complete`
  pour `catalogue`/`orders`, sortie rapide sans dépasser le délai de grâce.
- `scripts/smoke-test.sh` : sortie avec code 0.
