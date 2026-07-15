# Déploiement Kubernetes

Les manifests utilisent Kustomize : `base` contient les ressources communes, et `overlays/dev`
ainsi que `overlays/prod` portent les différences d'environnement.

Ce document couvre le déploiement manuel. Pour le déploiement automatisé (CI/CD GitHub Actions,
build/scan/push des images, secrets à configurer, rollback), voir
[`docs/ci-cd.md`](../docs/ci-cd.md).

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

Sans `metrics-server`, le HPA reste en état `<unknown>` (`kubectl -n microservice-app get hpa`) et ne
scale jamais. Vérifiez avec :

```bash
kubectl -n kube-system get pods -l k8s-app=metrics-server
kubectl -n microservice-app top pods
```

## Images

L'overlay `dev` référence les images locales suivantes :

```bash
docker build -f services/catalogue/Dockerfile -t microservice-app/catalogue:dev .
docker build -f services/orders/Dockerfile -t microservice-app/orders:dev .
docker build -f apps/frontend/Dockerfile -t microservice-app/frontend:dev .
docker build -f packages/db/Dockerfile -t microservice-app/db-tools:dev .
```

Avec kind, chargez ensuite ces quatre images dans le cluster (`kind load docker-image ...`).
Avec minikube, construisez directement dans le daemon Docker du cluster pour éviter un registry :

```bash
eval $(minikube docker-env)
docker build -f services/catalogue/Dockerfile -t microservice-app/catalogue:dev .
docker build -f services/orders/Dockerfile -t microservice-app/orders:dev .
docker build -f apps/frontend/Dockerfile -t microservice-app/frontend:dev .
docker build -f packages/db/Dockerfile -t microservice-app/db-tools:dev .
```

Le tag `dev` n'étant pas `latest`, Kubernetes applique par défaut `imagePullPolicy: IfNotPresent` :
tant que l'image existe déjà dans le daemon Docker vu par le cluster (`minikube docker-env`),
aucune tentative de pull vers un registry distant n'a lieu.

Pour la production, remplacez `ghcr.io/your-org` et le tag `replace-me` via la CI/CD ou la
section `images` de `overlays/prod/kustomization.yaml`.

## Secret de base de données

Le secret n'est pas versionné. Copiez le modèle puis remplacez les valeurs :

```bash
cp k8s/overlays/dev/secret.env.example k8s/overlays/dev/secret.env
cp k8s/overlays/prod/secret.env.example k8s/overlays/prod/secret.env
```

`DATABASE_URL` doit utiliser exactement le même mot de passe que `POSTGRES_PASSWORD`.
Le `secretGenerator` Kustomize crée le Secret Kubernetes `microservice-app-db` lors du déploiement.

## Stockage PostgreSQL

Le `StatefulSet` `postgres` ne fixe pas de `storageClassName` sur son `volumeClaimTemplate` : le
PVC utilise donc la `StorageClass` marquée par défaut sur le cluster (`standard` sur minikube et
kind). C'est ce qui rend la classe de stockage configurable par environnement, pour en imposer
une précise (ex. `premium-rwo` sur GKE, `gp3` sur EKS), ajoutez un patch Kustomize dans l'overlay
concerné :

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

**Politique de rétention.** La plupart des `StorageClass` provisionnées dynamiquement (dont
`standard` sur minikube/kind) ont `reclaimPolicy: Delete` : supprimer le PVC supprime aussi le
volume sous-jacent et les données. En production, préférez une `StorageClass` avec
`reclaimPolicy: Retain` (ou activez des sauvegardes régulières) pour survivre à
une suppression accidentelle du PVC.

**Limite `hostPath` / provisioner local.** Sur minikube (`k8s.io/minikube-hostpath`) comme sur kind
(`rancher.io/local-path`), le volume est un répertoire local au nœud unique : il ne survit pas à la
suppression du nœud/VM, ne se réplique pas, et un cluster multi-nœuds ne garantit pas que le pod
`postgres-0` sera reprogrammé sur le nœud qui détient les données. C'est acceptable pour une démo
mono-nœud, mais inadapté à la production, voir [`docs/resilience.md`](../docs/resilience.md)
pour les alternatives (CloudNativePG, Patroni, service managé).

### Vérifier la persistance

```bash
# Insérer une donnée de test
kubectl -n microservice-app exec -it postgres-0 -- \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "CREATE TABLE IF NOT EXISTS persistence_check(id serial primary key, note text);
   INSERT INTO persistence_check(note) VALUES ('before-restart');"

# Redémarrer le pod (le StatefulSet le recrée avec le même PVC)
kubectl -n microservice-app delete pod postgres-0
kubectl -n microservice-app wait --for=condition=ready pod/postgres-0 --timeout=120s

# Vérifier que la ligne existe toujours
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
`http://microservice-app.local`. En production, remplacez `microservice-app.example.com` par votre domaine et
ajoutez TLS/cert-manager selon votre cluster.

## Vérifications demandées

```bash
# Logs JSON applicatifs
kubectl -n microservice-app logs deploy/catalogue

# HPA (metrics-server requis)
kubectl -n microservice-app get hpa -w

# Résilience : le Deployment recrée le pod ; vérifier l'accès pendant/après l'opération
kubectl -n microservice-app delete pod -l app.kubernetes.io/name=catalogue
kubectl -n microservice-app get pods -w
```

Les pods applicatifs utilisent des comptes de service sans jeton monté, s'exécutent sans privilège,
avec profil seccomp `RuntimeDefault`, système de fichiers en lecture seule et NetworkPolicies.
