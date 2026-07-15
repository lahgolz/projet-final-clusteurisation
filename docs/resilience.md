# Résilience et scalabilité

## Périmètre

Ce document couvre les mécanismes de haute disponibilité et de scalabilité des services stateless
(`catalogue`, `orders`, `frontend`). La base de données PostgreSQL fait l'objet d'une section
dédiée expliquant ses limites actuelles.

Environnement de démonstration : cluster **Kind** mono-nœud, overlay `dev`.

---

## Architecture de résilience

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

---

## 1. Horizontal Pod Autoscaler (HPA)

### Configuration

| Paramètre         | Valeur (prod/base)     | Valeur (overlay dev)   |
| ----------------- | ---------------------- | ---------------------- |
| Service ciblé     | `catalogue`            | `catalogue`            |
| Métrique          | CPU Utilization        | CPU Utilization        |
| Seuil             | 70 % de `requests.cpu` | 70 % de `requests.cpu` |
| `minReplicas`     | 2                      | 1                      |
| `maxReplicas`     | 5                      | 3                      |
| `requests.cpu`    | 100 m                  | 100 m                  |
| CPU cible absolue | 70 m par pod           | 70 m par pod           |

Manifest : [`k8s/base/hpa.yaml`](../k8s/base/hpa.yaml)

### Algorithme de calcul

```
desiredReplicas = ceil(currentReplicas × currentCPU / targetCPU)
```

Exemple : 2 pods à 130 % CPU cible -> `ceil(2 × 1.30) = ceil(2.6) = 3 pods`.

### Prérequis

`metrics-server` doit être installé et fonctionnel dans le cluster. Sans lui, le HPA reste en
état `<unknown>` et ne scale pas.

```bash
# Vérifier que metrics-server répond
kubectl -n kube-system get deployment metrics-server
kubectl top pods -n microservice-app
```

### Comportements observés

| Phase         | Délai typique | Comportement                                                                                                        |
| ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| Scale up      | 15 – 60 s     | Le HPA détecte le dépassement de seuil après 2 cycles de scrape (15 s chacun) et crée des pods supplémentaires      |
| Stabilisation | 0 s           | Immédiate dès que les nouveaux pods sont Ready                                                                      |
| Scale down    | 5 min         | Fenêtre de stabilisation par défaut (`--horizontal-pod-autoscaler-downscale-stabilization`) pour éviter le flapping |

### Déclenchement de la démo

```bash
# Terminal 1 : observer le HPA en temps réel
kubectl -n microservice-app get hpa -w

# Terminal 2 : générer la charge (20 workers pendant 2 min)
bash scripts/load-test.sh http://microservice-app.local 120 20

# Terminal 3 : observer les pods
kubectl -n microservice-app get pods -l app.kubernetes.io/name=catalogue -w
```

Résultat attendu : le nombre de replicas passe de 2 à 3-5 selon la charge, puis redescend à 2
après 5 minutes de stabilisation.

---

## 2. PodDisruptionBudget (PDB)

Manifest : [`k8s/base/pdb.yaml`](../k8s/base/pdb.yaml)

| Service     | `minAvailable` | Effet avec 2 replicas                                   |
| ----------- | -------------- | ------------------------------------------------------- |
| `catalogue` | 1              | Un drain de nœud peut supprimer au plus 1 pod à la fois |
| `orders`    | 1              | Idem                                                    |
| `frontend`  | 1              | Idem                                                    |

### Rôle du PDB

Le PDB s'applique **uniquement aux disruptions volontaires** (maintenance planifiée) :

- `kubectl drain <node>`, éviction lors d'une mise à jour de nœud
- `kubectl delete pod` avec eviction API
- Mise à l'échelle automatique des nœuds (cluster autoscaler)

Il **ne protège pas** contre les disruptions involontaires (crash OOMKill, panne matérielle).

### Test de validation

```bash
# Avec 2 replicas de catalogue et PDB minAvailable:1
# Tenter d'éviter un pod, doit respecter le PDB
kubectl -n microservice-app get pdb catalogue

# Dry-run d'un drain (cluster multi-nœuds uniquement)
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data --dry-run=client
```

---

## 3. Répartition des replicas (podAntiAffinity)

Manifest : [`k8s/base/catalogue.yaml`](../k8s/base/catalogue.yaml),
[`k8s/base/orders.yaml`](../k8s/base/orders.yaml),
[`k8s/base/frontend.yaml`](../k8s/base/frontend.yaml)

Chaque Deployment porte une règle d'**anti-affinité souple** :

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

**`preferred`** (et non `required`) : si le cluster ne dispose que d'un seul nœud disponible
(comme Kind mono-nœud), le scheduler place quand même les pods plutôt que de les bloquer en
`Pending`. En production multi-nœuds, les deux replicas atterriront sur des nœuds différents,
limitant l'impact d'une panne matérielle à la moitié du service.

---

## 4. Stratégie de mise à jour (RollingUpdate)

Tous les Deployments appliquent :

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 0 # aucun pod supprimé avant qu'un nouveau soit Ready
    maxSurge: 1 # un pod supplémentaire créé pendant la transition
```

Avec `replicas: 2` :

1. Kubernetes crée le pod v2 -> 3 pods tournent
2. Le pod v2 passe Ready (readiness probe OK)
3. Un pod v1 est supprimé -> 2 pods v2
4. Le second pod v2 est créé, passe Ready, le dernier v1 est supprimé

**Résultat** : zéro interruption de service pendant une mise à jour.

```bash
# Déclencher un rolling restart (simulate un redéploiement)
kubectl -n microservice-app rollout restart deployment/catalogue

# Suivre la progression
kubectl -n microservice-app rollout status deployment/catalogue

# Vérifier la disponibilité en continu
watch -n1 curl -s -o /dev/null -w '%{http_code}' http://microservice-app.local/api/catalogue/products
```

---

## 5. Rollback

```bash
# Voir l'historique
kubectl -n microservice-app rollout history deployment/catalogue

# Revenir à la révision précédente
kubectl -n microservice-app rollout undo deployment/catalogue

# Revenir à une révision précise
kubectl -n microservice-app rollout undo deployment/catalogue --to-revision=2

# Vérifier le statut
kubectl -n microservice-app rollout status deployment/catalogue
```

---

## 6. Scénarios de résilience testés

### 6.1 Suppression d'un pod (self-healing)

**Procédure :**

```bash
# État avant
kubectl -n microservice-app get pods -l app.kubernetes.io/name=catalogue

# Supprimer un pod
POD=$(kubectl -n microservice-app get pods -l app.kubernetes.io/name=catalogue \
  -o jsonpath='{.items[0].metadata.name}')
kubectl -n microservice-app delete pod "$POD"

# Observer la recréation
kubectl -n microservice-app get pods -l app.kubernetes.io/name=catalogue -w
```

**Résultats attendus :**

| Mesure                             | Valeur typique                                    |
| ---------------------------------- | ------------------------------------------------- |
| Détection de la suppression        | < 1 s                                             |
| Création du nouveau pod            | < 2 s                                             |
| Pod en état `Running`              | 5 – 10 s                                          |
| Pod en état `Ready` (readiness OK) | 10 – 15 s                                         |
| Erreurs HTTP pendant l'opération   | 0 (grace à `maxUnavailable: 0` et au pod restant) |

Le Service Kubernetes retire immédiatement le pod supprimé de son endpoint, empêchant tout
routage vers un pod mort. Le second replica continue de servir les requêtes pendant toute la
durée de la recréation.

### 6.2 HPA sous charge CPU

**Procédure :**

```bash
# Terminal 1
kubectl -n microservice-app get hpa catalogue -w

# Terminal 2
bash scripts/load-test.sh http://microservice-app.local 120 20
```

**Résultats attendus :**

| Phase            | Temps       | Replicas | CPU moyen   |
| ---------------- | ----------- | -------- | ----------- |
| Avant charge     | t=0         | 2        | ~5 %        |
| Montée en charge | t=30 s      | 2        | 80 – 120 %  |
| Scale up         | t=45 – 60 s | 3 – 4    | en descente |
| Stabilisation    | t=90 s      | 3 – 4    | ~60 %       |
| Fin charge       | t+5 min     | 2        | ~5 %        |

### 6.3 Rolling restart sans interruption

**Procédure :**

```bash
# Lancer en parallèle une sonde de disponibilité
while true; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' http://microservice-app.local/api/catalogue/products)
  echo "$(date +%T) HTTP $CODE"
  sleep 1
done &

# Déclencher le rolling restart
kubectl -n microservice-app rollout restart deployment/catalogue
kubectl -n microservice-app rollout status deployment/catalogue
```

**Résultat attendu** : tous les codes HTTP restent à `200` pendant toute la durée du rollout
(~20-30 secondes avec 2 replicas).

---

## 7. Limites de haute disponibilité

### PostgreSQL : absence de HA réelle

**Situation actuelle :** PostgreSQL est déployé en StatefulSet mono-replica (`replicas: 1`) avec
un PVC `ReadWriteOnce`.

**Ce que cela signifie concrètement :**

| Scénario                         | Impact                                                |
| -------------------------------- | ----------------------------------------------------- |
| Redémarrage du pod postgres      | ~15-30 s d'indisponibilité DB (health checks)         |
| Panne du nœud portant postgres-0 | Indisponibilité jusqu'au reschedule sur un autre nœud |
| Corruption du PVC                | Perte de données irrémédiable sans backup             |

**Ce n'est pas de la haute disponibilité.** Un pod unique avec PVC `ReadWriteOnce` ne tolère
aucune panne sans interruption de service.

### Solutions pour une HA PostgreSQL en production

| Solution                               | Complexité | Description                                                                                      |
| -------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| **CloudNativePG** (opérateur)          | Moyenne    | Opérateur Kubernetes gérant la réplication synchrone, le failover automatique et les sauvegardes |
| **Patroni + etcd**                     | Élevée     | Gestionnaire de HA PostgreSQL avec consensus distribué                                           |
| **PostgreSQL managé** (RDS, Cloud SQL) | Faible     | Délègue la HA au fournisseur cloud, hors cluster K8s                                             |
| **Crunchy Data PGO**                   | Moyenne    | Opérateur open-source avec réplication et sauvegardes intégrées                                  |

**Recommandation pour ce projet :** En environnement de démonstration, l'approche mono-replica
avec PVC est suffisante et documentée comme telle. Pour une mise en production réelle, CloudNativePG
est la solution la plus accessible dans un contexte Kubernetes.

### Limites du cluster Kind mono-nœud

| Limite                                    | Impact sur la démo                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| Un seul nœud physique                     | Le `kubectl drain` ne peut pas être démontré (le pod doit atterrir quelque part) |
| Pas de StorageClass avec réplication      | Le PVC est local au nœud                                                         |
| Ressources partagées avec la machine hôte | Les limites CPU/mémoire peuvent être atteintes plus tôt                          |
| Anti-affinité ignorée                     | Les deux replicas catalogue atterrissent sur le même nœud                        |

Ces limites sont inhérentes à l'environnement de démonstration local et sont explicitement
documentées. En production sur un cluster multi-nœuds (GKE, EKS, AKS), elles disparaissent.

---

## 8. Script de démonstration

Le script [`scripts/resilience-demo.sh`](../scripts/resilience-demo.sh) enchaîne les scénarios
3 à 7 de manière interactive, avec des pauses entre chaque étape.

```bash
bash scripts/resilience-demo.sh http://microservice-app.local
```

Étapes couvertes :

1. État initial (pods, HPA, PDB)
2. Kill d'un pod -> self-healing
3. Charge CPU -> HPA scale-up
4. PDB -> protection lors d'un drain
5. Rolling restart -> zéro interruption
6. Rollback -> retour en arrière

---

## 9. Commandes de référence

```bash
# État global de la résilience
kubectl -n microservice-app get deploy,hpa,pdb

# Surveiller le HPA en temps réel
kubectl -n microservice-app get hpa -w

# Métriques CPU des pods (nécessite metrics-server)
kubectl -n microservice-app top pods

# Décrire le HPA pour voir les événements de scaling
kubectl -n microservice-app describe hpa catalogue

# Voir les événements du namespace (crashs, OOMKill, etc.)
kubectl -n microservice-app get events --sort-by='.lastTimestamp'

# Tester la disponibilité en continu
while true; do
  curl -s -o /dev/null -w "$(date +%T) %{http_code}\n" http://microservice-app.local/api/catalogue/products
  sleep 1
done
```
