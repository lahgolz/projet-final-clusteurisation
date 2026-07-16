# Résilience et scalabilité

Ce document couvre la haute disponibilité et la scalabilité des services stateless (`catalogue`,
`orders`, `frontend`). PostgreSQL a sa propre section, plus bas, parce que ses limites actuelles
sont différentes.

Environnement de démo : cluster **Kind** mono-nœud, overlay `dev`.

```
                    ┌─────────────────────────────────────────┐
                    │  Namespace microservice-app                    │
                    │                                         │
  ┌──────────┐     │  ┌──────────┐  ┌──────────┐           │
  │ Ingress  │────▶│  │catalogue │  │catalogue │  ← HPA    │
  │  NGINX   │     │  │  pod-0   │  │  pod-1   │  min 2    │
  └──────────┘     │  └──────────┘  └──────────┘  max 5    │
        │          │       ↑ PDB: minAvailable 1            │
        │          │  ┌──────────┐  ┌──────────┐           │
        └─────────▶│  │ orders   │  │ orders   │           │
                    │  │  pod-0   │  │  pod-1   │           │
                    │  └──────────┘  └──────────┘           │
                    │       ↑ PDB: minAvailable 1            │
                    │  ┌──────────────────────────┐         │
                    │  │  postgres-0 (StatefulSet) │         │
                    │  │  PVC: 5Gi ReadWriteOnce   │         │
                    │  └──────────────────────────┘         │
                    └─────────────────────────────────────────┘
```

## 1. Autoscaling (HPA)

| Paramètre      | prod/base              | overlay dev            |
| -------------- | ---------------------- | ---------------------- |
| Service ciblé  | `catalogue`            | `catalogue`            |
| Métrique       | CPU Utilization        | CPU Utilization        |
| Seuil          | 70 % de `requests.cpu` | 70 % de `requests.cpu` |
| `minReplicas`  | 2                      | 1                      |
| `maxReplicas`  | 5                      | 3                      |
| `requests.cpu` | 100 m                  | 100 m                  |

Manifest : [`k8s/base/hpa.yaml`](../k8s/base/hpa.yaml). Formule utilisée par Kubernetes :
`desiredReplicas = ceil(currentReplicas × currentCPU / targetCPU)` - par exemple 2 pods à 130 % de
la cible donnent `ceil(2 × 1.30) = 3` pods.

Ça a besoin de `metrics-server` dans le cluster ; sans lui, le HPA reste bloqué en `<unknown>` et
ne scale jamais :

```bash
kubectl -n kube-system get deployment metrics-server
kubectl top pods -n microservice-app
```

Comportement observé : le scale up prend 15 à 60s (2 cycles de scrape pour détecter le
dépassement), les nouveaux pods sont pris en compte dès qu'ils sont Ready, et le scale down attend
5 minutes de stabilisation par défaut pour éviter le flapping.

Pour le voir en action :

```bash
# Terminal 1 : observer le HPA
kubectl -n microservice-app get hpa -w

# Terminal 2 : générer de la charge (20 workers pendant 2 min)
bash scripts/load-test.sh http://microservice-app.local 120 20

# Terminal 3 : observer les pods
kubectl -n microservice-app get pods -l app.kubernetes.io/name=catalogue -w
```

Le nombre de replicas devrait monter de 2 à 3-5 selon la charge, puis redescendre à 2 après les
5 minutes de stabilisation. Des chiffres réels mesurés avec k6 sont dans
[`docs/performance.md`](./performance.md).

## 2. PodDisruptionBudget (PDB)

Manifest : [`k8s/base/pdb.yaml`](../k8s/base/pdb.yaml). `minAvailable: 1` sur `catalogue`,
`orders` et `frontend` : avec 2 replicas, un drain de nœud ne peut évincer qu'un seul pod à la
fois.

Ça ne joue que sur les **disruptions volontaires** (drain, éviction, scale-down d'un cluster
autoscaler) - pas sur les crashs ou pannes matérielles, qui ne préviennent personne.

```bash
kubectl -n microservice-app get pdb catalogue

# Dry-run d'un drain (cluster multi-nœuds uniquement)
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data --dry-run=client
```

## 3. Répartition des replicas (anti-affinité)

Manifests : [`k8s/base/catalogue.yaml`](../k8s/base/catalogue.yaml),
[`k8s/base/orders.yaml`](../k8s/base/orders.yaml), [`k8s/base/frontend.yaml`](../k8s/base/frontend.yaml).

Chaque Deployment porte une règle d'anti-affinité **souple** (`preferred`, pas `required`) :

```yaml
affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchLabels:
              app.kubernetes.io/name: catalogue
          topologyKey: kubernetes.io/hostname
```

`preferred` plutôt que `required` : sur un cluster mono-nœud (comme Kind ici), le scheduler place
quand même les pods au lieu de les bloquer en `Pending`. En production multi-nœuds, les deux
replicas atterriront sur des nœuds différents, ce qui limite l'impact d'une panne matérielle à la
moitié du service.

## 4. Mise à jour sans interruption (RollingUpdate)

Tous les Deployments utilisent :

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 0 # aucun pod supprimé avant qu'un nouveau soit Ready
    maxSurge: 1 # un pod supplémentaire créé pendant la transition
```

Avec `replicas: 2`, Kubernetes crée le nouveau pod (3 pods tournent brièvement), attend qu'il soit
Ready, supprime un ancien pod, puis répète pour le second. Résultat : zéro interruption de
service pendant une mise à jour.

```bash
kubectl -n microservice-app rollout restart deployment/catalogue
kubectl -n microservice-app rollout status deployment/catalogue

# Vérifier la disponibilité pendant l'opération
watch -n1 curl -s -o /dev/null -w '%{http_code}' http://microservice-app.local/api/catalogue/products
```

Vérifié en pratique : tous les codes HTTP restent à `200` pendant tout le rollout (~20-30s avec
2 replicas).

## 5. Rollback

```bash
kubectl -n microservice-app rollout history deployment/catalogue
kubectl -n microservice-app rollout undo deployment/catalogue                  # révision précédente
kubectl -n microservice-app rollout undo deployment/catalogue --to-revision=2  # révision précise
kubectl -n microservice-app rollout status deployment/catalogue
```

## 6. Self-healing testé en pratique

```bash
POD=$(kubectl -n microservice-app get pods -l app.kubernetes.io/name=catalogue \
  -o jsonpath='{.items[0].metadata.name}')
kubectl -n microservice-app delete pod "$POD"
kubectl -n microservice-app get pods -l app.kubernetes.io/name=catalogue -w
```

Le Service retire immédiatement le pod supprimé de ses endpoints (aucun routage vers un pod mort),
et le second replica continue de servir pendant toute la recréation. Chiffres typiques observés :
suppression détectée en moins d'1s, nouveau pod créé en moins de 2s, `Running` en 5-10s, `Ready`
(readiness OK) en 10-15s - zéro erreur HTTP côté client pendant l'opération.

## 7. Limites de haute disponibilité

### PostgreSQL n'a pas de vraie HA

PostgreSQL tourne en StatefulSet mono-replica (`replicas: 1`) avec un PVC `ReadWriteOnce`. Ce que
ça implique concrètement :

| Scénario                         | Impact                                                |
| -------------------------------- | ----------------------------------------------------- |
| Redémarrage du pod postgres      | ~15-30s d'indisponibilité DB                          |
| Panne du nœud portant postgres-0 | Indisponibilité jusqu'au reschedule sur un autre nœud |
| Corruption du PVC                | Perte de données irrémédiable sans backup             |

Un pod unique avec PVC `ReadWriteOnce` ne tolère aucune panne sans interruption de service. Pour
une vraie HA PostgreSQL en production, les options les plus courantes sont
[**CloudNativePG**](https://cloudnative-pg.io/) (opérateur avec réplication synchrone et failover
automatique - la plus accessible dans un contexte Kubernetes), Patroni + etcd (plus complexe, plus
de contrôle), un PostgreSQL managé (RDS, Cloud SQL - délègue tout au fournisseur cloud) ou Crunchy
Data PGO. Pour cette démo, l'approche mono-replica + PVC est suffisante et documentée comme telle.

### Limites du cluster mono-nœud

Un seul nœud physique veut dire : pas de `kubectl drain` démontrable (le pod doit bien atterrir
quelque part), pas de StorageClass répliquée (le PVC est local au nœud), ressources CPU/mémoire
partagées avec la machine hôte, et anti-affinité ignorée (les deux replicas finissent sur le même
nœud). Ces limites disparaissent sur un vrai cluster multi-nœuds (GKE, EKS, AKS).

## 8. Script de démonstration

[`scripts/resilience-demo.sh`](../scripts/resilience-demo.sh) enchaîne tous les scénarios
ci-dessus de façon interactive : état initial, kill d'un pod, charge CPU, PDB, rolling restart,
rollback.

```bash
bash scripts/resilience-demo.sh http://microservice-app.local
```

## Commandes de référence

```bash
kubectl -n microservice-app get deploy,hpa,pdb
kubectl -n microservice-app get hpa -w
kubectl -n microservice-app top pods
kubectl -n microservice-app describe hpa catalogue
kubectl -n microservice-app get events --sort-by='.lastTimestamp'

while true; do
  curl -s -o /dev/null -w "$(date +%T) %{http_code}\n" http://microservice-app.local/api/catalogue/products
  sleep 1
done
```
