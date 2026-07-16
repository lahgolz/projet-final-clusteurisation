# Pipeline CI/CD

GitHub Actions, deux workflows :

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) : qualité (lint + format), typecheck,
  tests, build. Se déclenche sur chaque pull request, et est réutilisé (`workflow_call`) comme
  première étape de `cd.yml`.
- [`.github/workflows/cd.yml`](../.github/workflows/cd.yml) : build des images, scan de
  vulnérabilités, push registre, validation des manifests. Se déclenche sur push vers `main` et
  sur tag `vX.Y.Z`. Le déploiement lui-même n'est **pas** automatisé, voir
  [Déploiement manuel](#déploiement-manuel).

## Étapes

| Étape                | Où                              | Détail                                                                   |
| -------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| Installation         | `ci.yml` (chaque job)           | `pnpm install --frozen-lockfile`, cache du store pnpm                    |
| Lint                 | `ci.yml` / `lint`               | `pnpm run format:check` + `pnpm run lint`                                |
| Tests                | `ci.yml` / `test`               | Postgres en service container ; voir [Tests](#tests) ci-dessous          |
| Build applicatif     | `ci.yml` / `build`              | `pnpm run build` (tsc + vite build, toutes les briques)                  |
| Build image          | `cd.yml` / `build-and-push`     | 1 image par composant, `docker buildx build --load` (pas encore poussée) |
| Scan                 | `cd.yml` / `build-and-push`     | Trivy sur l'image locale, avant tout push                                |
| Push registre        | `cd.yml` / `build-and-push`     | GHCR, uniquement si le scan passe                                        |
| Validation manifests | `cd.yml` / `validate-manifests` | `kustomize build` + `kubeconform -strict`                                |

## Tests

Le job `test` démarre un Postgres en service container et exécute les suites dans un ordre précis,
pas via `pnpm test` à la racine qui lancerait tout en parallèle :

1. `@microservice-app/shared` et `@microservice-app/frontend` (pas de dépendance base de données).
2. `@microservice-app/db` : ce paquet teste un cycle complet `migrate up` -> assertions ->
   `migrate down` et **termine en supprimant le schéma qu'il vient de créer**. Il doit donc tourner
   seul, avant les tests d'intégration.
3. Ré-application des migrations pour recréer le schéma.
4. `@microservice-app/catalogue` et `@microservice-app/orders` (intégration) : ils insèrent des
   fixtures directement et attendent que le schéma existe déjà, d'où l'étape 3.

Lancer ces suites en parallèle sur la même base romprait le schéma pendant que l'étape 4 tourne -
c'est pourquoi la CI ne réutilise pas le script `test` racine tel quel.

## Tags d'image

Chaque image est taguée avec le SHA Git court (`sha-<12 caractères>`), jamais `latest`. Sur un tag
Git `vX.Y.Z`, un second tag portant la version est poussé en plus. Le tag utilisé pour un
déploiement manuel doit correspondre à un commit déjà testé et scanné par la CI.

Les images se poussent avec `GITHUB_TOKEN` (permission `packages: write`, déjà accordée dans
`cd.yml`) : aucun secret à créer pour build/scan/push.

### Images GHCR publiques ou privées

Par défaut, les paquets GHCR sont **privés** même si le dépôt est public. Deux options pour le
déploiement (pas la CI elle-même) :

- **Rendre les paquets publics** (le plus simple pour une démo) : après le premier push, dans
  chaque paquet `ghcr.io/<owner>/microservice-app-*` -> Package settings -> Change visibility -> Public.
- **Garder les paquets privés** : créer un `imagePullSecret` dans le namespace
  `microservice-app` et le référencer dans `k8s/base/serviceaccount.yaml` via un patch Kustomize
  de l'overlay (non fait par défaut, pour garder le socle minimal).

## Déploiement manuel

La CI construit, scanne, pousse les images et valide les manifests, mais ne déploie sur aucun
cluster : ça se fait à la main, `KUBECONFIG` pointant sur le cluster cible.

```bash
# 1. Fixer les images de l'overlay sur un tag immuable déjà poussé par la CI
bash scripts/ci/set-image-tags.sh prod sha-<12-caractères-du-commit> ghcr.io <owner>

# 2. Fournir le secret.env de l'overlay
cp k8s/overlays/prod/secret.env.example k8s/overlays/prod/secret.env
# éditer k8s/overlays/prod/secret.env avec de vraies valeurs

# 3. Supprimer les anciens Jobs db-migrate/db-seed (pod template immuable)
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

En cas de problème, [`scripts/rollback-k8s.sh`](../scripts/rollback-k8s.sh) revient à la révision
précédente de `catalogue`, `orders` et `frontend` (les Jobs `db-migrate`/`db-seed` ne sont
**jamais** annulés automatiquement - une migration descendante peut être destructive) :

```bash
kubectl -n microservice-app rollout history deployment/catalogue
KUBECONFIG=... bash scripts/rollback-k8s.sh                      # revient d'une révision
KUBECONFIG=... bash scripts/rollback-k8s.sh --to-revision 4      # revient à une révision précise

# si une migration de schéma doit être défaite après le rollback :
pnpm --filter @microservice-app/db run migrate:down
```

## Valider en local avant de pousser

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

# Équivalent du rendu + validation de schéma du job "validate-manifests"
cp k8s/overlays/prod/secret.env.example k8s/overlays/prod/secret.env
kubectl kustomize k8s/overlays/prod | docker run --rm -i ghcr.io/yannh/kubeconform:v0.6.4 -strict -summary
rm k8s/overlays/prod/secret.env

# Smoke test contre un cluster déjà déployé
bash scripts/smoke-test-k8s.sh
```

## Limites connues

- Pas de déploiement automatisé : `cd.yml` s'arrête après build/scan/push et validation des
  manifests. Le déploiement reste manuel (voir ci-dessus).
- Images mono-architecture (`linux/amd64`, celle des runners GitHub-hosted). Un cluster sur nœud
  `arm64` (Apple Silicon) demanderait un build multi-plateforme, pas fait par défaut pour garder
  le pipeline simple.
- Pas de remontée SARIF de Trivy vers l'onglet Security de GitHub (ça demande GitHub Advanced
  Security sur dépôt privé) : le scan bloque le pipeline, mais les détails ne sont visibles que
  dans les logs du job.
