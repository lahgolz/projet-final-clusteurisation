# Déploiement Kubernetes

Les manifests utilisent Kustomize : `base` contient les ressources communes, et `overlays/dev`
ainsi que `overlays/prod` portent les différences d'environnement.

## Prérequis

- un cluster Kubernetes avec une `StorageClass` par défaut ;
- un contrôleur Ingress NGINX (`ingressClassName: nginx`) ;
- `metrics-server` pour que le HPA récupère l'utilisation CPU ;
- `kubectl` (Kustomize est intégré).

## Images

L'overlay `dev` référence les images locales suivantes :

```bash
docker build -f services/catalogue/Dockerfile -t microshop/catalogue:dev .
docker build -f services/orders/Dockerfile -t microshop/orders:dev .
docker build -f apps/frontend/Dockerfile -t microshop/frontend:dev .
docker build -f packages/db/Dockerfile -t microshop/db-tools:dev .
```

Avec kind, chargez ensuite ces quatre images dans le cluster (`kind load docker-image ...`).
Pour la production, remplacez `ghcr.io/your-org` et le tag `replace-me` via la CI/CD ou la
section `images` de `overlays/prod/kustomization.yaml`.

## Secret de base de données

Le secret n'est pas versionné. Copiez le modèle puis remplacez les valeurs :

```bash
cp k8s/overlays/dev/secret.env.example k8s/overlays/dev/secret.env
cp k8s/overlays/prod/secret.env.example k8s/overlays/prod/secret.env
```

`DATABASE_URL` doit utiliser exactement le même mot de passe que `POSTGRES_PASSWORD`.
Le `secretGenerator` Kustomize crée le Secret Kubernetes `microshop-db` lors du déploiement.

## Déploiement

```bash
kubectl apply -k k8s/overlays/dev
kubectl -n microshop get pods,svc,ingress,hpa
kubectl -n microshop wait --for=condition=complete job/db-migrate --timeout=180s
kubectl -n microshop wait --for=condition=complete job/db-seed --timeout=180s
```

Pour un Ingress local, ajoutez `127.0.0.1 microshop.local` au fichier hosts, puis ouvrez
`http://microshop.local`. En production, remplacez `microshop.example.com` par votre domaine et
ajoutez TLS/cert-manager selon votre cluster.

## Vérifications demandées

```bash
# Logs JSON applicatifs
kubectl -n microshop logs deploy/catalogue

# HPA (metrics-server requis)
kubectl -n microshop get hpa -w

# Résilience : le Deployment recrée le pod ; vérifier l'accès pendant/après l'opération
kubectl -n microshop delete pod -l app.kubernetes.io/name=catalogue
kubectl -n microshop get pods -w
```

Les pods applicatifs utilisent des comptes de service sans jeton monté, s'exécutent sans privilège,
avec profil seccomp `RuntimeDefault`, système de fichiers en lecture seule et NetworkPolicies.
