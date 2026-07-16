# Déploiement Kubernetes

Les manifests utilisent Kustomize : `base` contient les ressources communes, `overlays/dev` et
`overlays/prod` portent les différences d'environnement.

Ce document couvre le déploiement manuel. Pour le reste, voir [`docs/ci-cd.md`](../docs/ci-cd.md)
(pipeline, build/scan/push, rollback), [`docs/observability.md`](../docs/observability.md)
(Prometheus/Grafana), [`docs/backup-restore.md`](../docs/backup-restore.md) (sauvegarde
PostgreSQL), [`docs/performance.md`](../docs/performance.md) (test de charge k6) et
[`docs/runbooks.md`](../docs/runbooks.md) (procédures d'incident).

## Prérequis

- un cluster Kubernetes avec une `StorageClass` par défaut ;
- un contrôleur Ingress NGINX (`ingressClassName: nginx`) ;
- `metrics-server` pour que le HPA récupère l'utilisation CPU ;
- `kubectl` (Kustomize est intégré).

### Cluster local avec minikube

```bash
minikube start
minikube addons enable ingress          # contrôleur ingress-nginx
minikube addons enable metrics-server   # requis par le HPA
```

Sans `metrics-server`, le HPA reste bloqué en `<unknown>` (`kubectl -n microservice-app get hpa`).
Pour vérifier qu'il tourne bien :

```bash
kubectl -n kube-system get pods -l k8s-app=metrics-server
kubectl -n microservice-app top pods
```

## Images

L'overlay `dev` référence des images locales. Avec minikube, le plus simple est de construire
directement dans le daemon Docker du cluster (pas besoin de registry) :

```bash
eval $(minikube docker-env)
docker build -f services/catalogue/Dockerfile -t microservice-app/catalogue:dev .
docker build -f services/orders/Dockerfile -t microservice-app/orders:dev .
docker build -f apps/frontend/Dockerfile -t microservice-app/frontend:dev .
docker build -f packages/db/Dockerfile -t microservice-app/db-tools:dev .
```

Avec kind, il faut charger ces quatre images dans le cluster après le build
(`kind load docker-image ...`), pas de `docker-env` équivalent.

Le tag `dev` n'étant pas `latest`, Kubernetes applique `imagePullPolicy: IfNotPresent` par défaut :
tant que l'image existe déjà dans le daemon vu par le cluster, pas de tentative de pull distant.

Pour la production, remplacez `ghcr.io/your-org` et le tag `replace-me` via la CI/CD ou la
section `images` de `overlays/prod/kustomization.yaml`.

## Secret de base de données

Le secret n'est pas versionné. Copiez le modèle puis remplacez les valeurs :

```bash
cp k8s/overlays/dev/secret.env.example k8s/overlays/dev/secret.env
cp k8s/overlays/prod/secret.env.example k8s/overlays/prod/secret.env
```

`DATABASE_URL` doit utiliser exactement le même mot de passe que `POSTGRES_PASSWORD`. Le
`secretGenerator` Kustomize crée ensuite le Secret `microservice-app-db` au déploiement.

## Stockage PostgreSQL

Le `StatefulSet` `postgres` ne fixe pas de `storageClassName` : le PVC utilise donc la
`StorageClass` par défaut du cluster (`standard` sur minikube et kind). Pour en imposer une
précise en production (`premium-rwo` sur GKE, `gp3` sur EKS...), ajoutez un patch Kustomize dans
l'overlay concerné :

```yaml
# overlays/prod/storage-class.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: microservice-app
spec:
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        storageClassName: premium-rwo
```

puis référencez-le dans `patches:` de `overlays/prod/kustomization.yaml`.

Deux points à garder en tête pour la production :

- **Rétention** : la plupart des `StorageClass` provisionnées dynamiquement (dont `standard` sur
  minikube/kind) ont `reclaimPolicy: Delete` - supprimer le PVC supprime aussi les données.
  Préférez `Retain` (ou des sauvegardes régulières, voir [`docs/backup-restore.md`](../docs/backup-restore.md)).
- **Stockage local** : sur minikube/kind, le volume est un simple répertoire sur le nœud unique.
  Il ne survit pas à la perte du nœud et ne se réplique pas. Suffisant pour une démo, pas pour la
  prod (alternatives dans [`docs/resilience.md`](../docs/resilience.md) : CloudNativePG, Patroni,
  service managé).

### Vérifier la persistance

```bash
kubectl -n microservice-app exec -it postgres-0 -- \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "CREATE TABLE IF NOT EXISTS persistence_check(id serial primary key, note text);
   INSERT INTO persistence_check(note) VALUES ('before-restart');"

kubectl -n microservice-app delete pod postgres-0
kubectl -n microservice-app wait --for=condition=ready pod/postgres-0 --timeout=120s

kubectl -n microservice-app exec -it postgres-0 -- \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT * FROM persistence_check;"
```

## Déploiement

```bash
kubectl apply -k k8s/overlays/dev
kubectl -n microservice-app get pods,svc,ingress,hpa
kubectl -n microservice-app wait --for=condition=complete job/db-migrate --timeout=180s
kubectl -n microservice-app wait --for=condition=complete job/db-seed --timeout=180s
```

Pour un Ingress local, ajoutez `127.0.0.1 microservice-app.local` au fichier hosts, puis ouvrez
`http://microservice-app.local`. En production, remplacez le domaine et ajoutez TLS/cert-manager
selon votre cluster.

## Quelques vérifications utiles

```bash
# Logs JSON applicatifs
kubectl -n microservice-app logs deploy/catalogue

# HPA (metrics-server requis)
kubectl -n microservice-app get hpa -w

# Résilience : le Deployment recrée le pod supprimé
kubectl -n microservice-app delete pod -l app.kubernetes.io/name=catalogue
kubectl -n microservice-app get pods -w
```

Les pods applicatifs tournent avec des ServiceAccounts sans jeton monté, sans privilège, profil
seccomp `RuntimeDefault`, système de fichiers en lecture seule, et des NetworkPolicies. Détails
dans [`docs/security.md`](../docs/security.md).
