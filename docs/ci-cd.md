# Pipeline CI/CD

GitHub Actions, deux workflows :

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) : qualité (lint + format), typecheck,
  tests, build applicatif. Déclenché sur chaque pull request, et réutilisé (`workflow_call`)
  comme première étape de `cd.yml`.
- [`.github/workflows/cd.yml`](../.github/workflows/cd.yml) : build des images, scan de
  vulnérabilités, push registre, validation des manifests. Déclenché sur push vers `main` et sur
  tag `vX.Y.Z`. Le déploiement n'est **pas** automatisé par la CI : voir
  [Déploiement manuel](#déploiement-manuel).

## Stages

| Stage                | Où                              | Détail                                                                                                           |
| -------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Installation         | `ci.yml` (chaque job)           | `pnpm install --frozen-lockfile`, cache du store pnpm                                                            |
| Lint                 | `ci.yml` / `lint`               | `pnpm run format:check` + `pnpm run lint`                                                                        |
| Tests                | `ci.yml` / `test`               | Postgres en service container ; voir [Tests](#tests)                                                             |
| Build applicatif     | `ci.yml` / `build`              | `pnpm run build` (tsc + vite build, toutes les briques)                                                          |
| Build image          | `cd.yml` / `build-and-push`     | 1 image par composant (catalogue, orders, frontend, db-tools), `docker buildx build --load` (pas encore poussée) |
| Scan                 | `cd.yml` / `build-and-push`     | Trivy sur l'image locale, avant tout push                                                                        |
| Push registre        | `cd.yml` / `build-and-push`     | GHCR, uniquement si le scan passe                                                                                |
| Validation manifests | `cd.yml` / `validate-manifests` | `kustomize build` + `kubeconform -strict`                                                                        |

## Tests

Le job `test` démarre un service container PostgreSQL et exécute les suites dans un ordre précis
(pas via le script racine `pnpm test`, qui lancerait tout en parallèle) :

1. `@microservice-app/shared` et `@microservice-app/frontend` (aucune dépendance base de données).
2. `@microservice-app/db` : ce paquet teste un cycle complet `migrate up` -> assertions -> `migrate
down` sur `TEST_DATABASE_URL`, et **termine en supprimant le schéma qu'il vient de créer**.
   Il doit donc tourner seul, avant les tests d'intégration API.
3. Ré-application des migrations (`migrate:up`) sur `TEST_DATABASE_URL` pour recréer le schéma.
4. `@microservice-app/catalogue` et `@microservice-app/orders` (tests d'intégration) : ils
   insèrent directement des lignes de fixture dans `products`/`orders` et attendent que le schéma
   existe déjà, d'où l'étape 3.

Si ces suites étaient lancées en parallèle sur la même base (comme le fait `pnpm -r run test`),
l'étape 2 romprait le schéma pendant que 4 s'exécute : c'est pourquoi la CI ne réutilise pas le
script `test` racine tel quel.

## Tags d'image

Chaque image est taguée avec le SHA Git court, préfixé (`sha-<12 caractères>`), jamais `latest`.
Sur un tag Git `vX.Y.Z`, un second tag portant la version est poussé en plus. Le tag utilisé lors
d'un déploiement manuel doit correspondre à un commit qui a été testé et scanné par la CI.

Les images se poussent avec `GITHUB_TOKEN` (permission `packages: write`, déjà accordée dans
`cd.yml`) : **aucun secret à créer pour le build/scan/push**.

### Images GHCR publiques ou privées

Ceci concerne le déploiement (manuel, voir plus bas), pas la CI elle-même.

Par défaut, les paquets GHCR sont **privés** même si le dépôt est public. Deux options :

- **Rendre les paquets publics** (le plus simple pour une démo) : après le premier push, dans
  chaque paquet `ghcr.io/<owner>/microservice-app-*` -> Package settings -> Change visibility ->
  Public.
- **Garder les paquets privés** : créer un `imagePullSecret` dans le namespace
  `microservice-app` (`kubectl create secret docker-registry ...` avec un
  [Personal Access Token `read:packages`](https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-container-registry))
  et le référencer dans `k8s/base/serviceaccount.yaml` (`imagePullSecrets:`) via un patch
  Kustomize dans l'overlay, non fait par défaut pour garder le socle minimal.

## Déploiement manuel

La CI construit, scanne, pousse les images et valide le schéma des manifests, mais ne déploie sur
aucun cluster : le déploiement se fait à la main, avec `KUBECONFIG` pointant sur le cluster cible
(kind/minikube local ou distant).

```bash
# 1. Fixer les références d'image de l'overlay sur un tag immuable déjà poussé par la CI
bash scripts/ci/set-image-tags.sh prod sha-<12-caractères-du-commit> ghcr.io <owner>

# 2. Fournir le secret.env de l'overlay (voir k8s/overlays/prod/secret.env.example)
cp k8s/overlays/prod/secret.env.example k8s/overlays/prod/secret.env
# éditer k8s/overlays/prod/secret.env avec de vraies valeurs

# 3. Supprimer les anciens Jobs db-migrate/db-seed (pod template immuable, cf. limite kubectl apply)
kubectl -n microservice-app delete job db-migrate db-seed --ignore-not-found

# 4. Valider puis appliquer
kubectl apply -k k8s/overlays/prod --dry-run=server
kubectl apply -k k8s/overlays/prod

# 5. Attendre les Jobs puis le rollout
kubectl -n microservice-app wait --for=condition=complete job/db-migrate --timeout=180s
kubectl -n microservice-app wait --for=condition=complete job/db-seed --timeout=180s
kubectl -n microservice-app rollout status deployment/catalogue --timeout=180s
kubectl -n microservice-app rollout status deployment/orders --timeout=180s
kubectl -n microservice-app rollout status deployment/frontend --timeout=180s

# 6. Vérifier
bash scripts/smoke-test-k8s.sh
```

En cas de problème après coup, [`scripts/rollback-k8s.sh`](../scripts/rollback-k8s.sh) revient à
la révision précédente de `catalogue`, `orders` et `frontend` (les Jobs `db-migrate`/`db-seed` ne
sont **jamais** annulés automatiquement, une migration descendante peut être destructive) :

```bash
kubectl -n microservice-app rollout history deployment/catalogue
KUBECONFIG=... bash scripts/rollback-k8s.sh                      # revient d'une révision
KUBECONFIG=... bash scripts/rollback-k8s.sh --to-revision 4      # revient à une révision précise

# si une migration de schéma doit être défaite après le rollback :
pnpm --filter @microservice-app/db run migrate:down
```

## Validation locale avant de pousser

```bash
# Équivalent du job "test" de la CI (nécessite un Postgres local, ex: pnpm dev:db:up)
TEST_DATABASE_URL=postgresql://microservice-app:microservice-app@localhost:5433/microservice-app \
  pnpm --filter @microservice-app/db run test
DATABASE_URL=postgresql://microservice-app:microservice-app@localhost:5433/microservice-app \
  pnpm --filter @microservice-app/db run migrate:up
TEST_DATABASE_URL=postgresql://microservice-app:microservice-app@localhost:5433/microservice-app \
  pnpm --filter @microservice-app/catalogue run test
TEST_DATABASE_URL=postgresql://microservice-app:microservice-app@localhost:5433/microservice-app \
  pnpm --filter @microservice-app/orders run test

# Équivalent du rendu + de la validation de schéma du job "validate-manifests"
cp k8s/overlays/prod/secret.env.example k8s/overlays/prod/secret.env
kubectl kustomize k8s/overlays/prod | docker run --rm -i ghcr.io/yannh/kubeconform:v0.6.4 -strict -summary
rm k8s/overlays/prod/secret.env

# Smoke test contre un cluster déjà déployé (kubeconfig pointant dessus)
bash scripts/smoke-test-k8s.sh
```

## Limites connues

- Pas de déploiement automatisé : `cd.yml` s'arrête après le build/scan/push des images et la
  validation des manifests. Le déploiement reste manuel, voir
  [Déploiement manuel](#déploiement-manuel).
- Images mono-architecture (`linux/amd64`, l'architecture par défaut des runners GitHub-hosted).
  Un cluster de démonstration sur un nœud `arm64` (ex. Apple Silicon) nécessiterait un build
  multi-plateforme (`docker/setup-qemu-action` + `platforms: linux/amd64,linux/arm64`), non fait
  par défaut pour garder le pipeline simple et rapide.
- Pas de remontée SARIF des résultats Trivy vers l'onglet Security de GitHub (nécessite GitHub
  Advanced Security sur dépôt privé) : le scan bloque le pipeline mais les résultats détaillés ne
  sont visibles que dans les logs du job.
