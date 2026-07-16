# Runbooks

Des procédures courtes pour les incidents les plus probables sur `microservice-app`, pensées pour
être suivies par quelqu'un qui n'a pas développé le projet. Chaque runbook suit le même plan :
symptômes, diagnostic, décision, correction/rollback, validation.

Namespace par défaut : `microservice-app`.

```bash
NS=microservice-app
```

## 1. Pod en CrashLoopBackOff

**Symptômes** : alerte `PodCrashLoopBackOff`, ou `kubectl -n $NS get pods` qui affiche
`CrashLoopBackOff` avec un compteur `RESTARTS` qui augmente.

**Diagnostic**

```bash
kubectl -n $NS get pods -o wide
kubectl -n $NS describe pod <pod>     # Events : OOMKilled ? image manquante ? probe qui échoue ?
kubectl -n $NS logs <pod>
kubectl -n $NS logs <pod> --previous  # souvent celui qui explique le crash
```

Causes fréquentes ici : `DATABASE_URL` absent/invalide (Secret non appliqué), migration non
jouée avant le démarrage de l'API, tag d'image inexistant, probe mal configurée, `OOMKilled`.

| Cause identifiée                                | Action                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `OOMKilled`                                     | Augmenter `resources.limits.memory` ou corriger la fuite mémoire |
| Erreur de config (Secret/ConfigMap)             | Corriger la valeur, ré-appliquer, `kubectl rollout restart`      |
| Régression après un déploiement récent          | Rollback (voir plus bas)                                         |
| Dépendance indisponible (Postgres, `catalogue`) | Traiter le runbook 3 (« base indisponible »)                     |

**Correction / rollback**

```bash
kubectl -n $NS rollout history deployment/<service>
kubectl -n $NS rollout undo deployment/<service>
# ou en une fois pour catalogue+orders+frontend :
bash scripts/rollback-k8s.sh
```

**Validation**

```bash
kubectl -n $NS rollout status deployment/<service> --timeout=120s
kubectl -n $NS get pods -l app.kubernetes.io/name=<service>   # 0 restart depuis le rollback
bash scripts/smoke-test-k8s.sh
```

## 2. Taux d'erreur HTTP élevé

**Symptômes** : alerte `HighHttp5xxRate` (> 5 % de 5xx sur 5 min), ou des 5xx constatés côté
frontend.

**Diagnostic**

```bash
kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090:9090 &
# PromQL : sum by (service,status_code) (rate(http_requests_total{status_code=~"5.."}[5m]))

kubectl -n $NS logs deploy/catalogue --tail=200 | grep -i error
kubectl -n $NS logs deploy/orders --tail=200 | grep -i error
kubectl -n $NS get pods
kubectl -n $NS get events --sort-by='.lastTimestamp' | tail -30
```

Les logs sont du JSON structuré avec un `requestId` corrélable entre `orders` et `catalogue` -
chercher le même `requestId` dans les deux services pour situer où l'erreur apparaît vraiment.

| Observation                                              | Action                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Erreurs concentrées sur un service, après un déploiement | Rollback de ce service                                                                  |
| Erreurs de `orders` lors de l'appel à `catalogue`        | Vérifier la santé de `catalogue` et la NetworkPolicy `allow-orders-to-catalogue-egress` |
| 5xx corrélés à une erreur PostgreSQL dans les logs       | Traiter le runbook 3                                                                    |
| Pas de déploiement récent, pic isolé                     | Vérifier une charge anormale ([`docs/performance.md`](performance.md))                  |

**Correction / validation**

```bash
kubectl -n $NS rollout undo deployment/<service-en-cause>
kubectl -n $NS rollout status deployment/<service-en-cause> --timeout=120s
bash scripts/smoke-test-k8s.sh
```

## 3. Base PostgreSQL indisponible

**Symptômes** : `catalogue`/`orders` échouent leurs requêtes DB (`ECONNREFUSED`, timeout), la
readiness probe échoue, ou `postgres-0` n'est pas `Running`/`Ready`.

**Diagnostic**

```bash
kubectl -n $NS get pods -l app.kubernetes.io/name=postgres
kubectl -n $NS describe pod postgres-0
kubectl -n $NS logs postgres-0 --previous 2>/dev/null || kubectl -n $NS logs postgres-0
kubectl -n $NS get pvc data-postgres-0
kubectl -n $NS exec -it postgres-0 -- pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

Pour rappel ([`docs/resilience.md`](resilience.md#7-limites-de-haute-disponibilité)) : PostgreSQL
tourne en StatefulSet mono-replica sans vraie HA. Un redémarrage de pod coûte 15-30s
d'indisponibilité ; une corruption du PVC est irrécupérable sans backup.

| Cause                                   | Action                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| Pod en cours de redémarrage normal      | Attendre (`kubectl wait --for=condition=ready`), rien à faire                              |
| `CrashLoopBackOff` sur `postgres-0`     | `describe`/`logs --previous` : erreur de config ou données corrompues                      |
| PVC perdu/corrompu, base illisible      | Restauration depuis la dernière sauvegarde (§ 5)                                           |
| Nœud indisponible (cluster multi-nœuds) | Le StatefulSet reprogramme le pod dès que possible, à condition que le PVC soit accessible |

**Correction**

```bash
# Cas simple : le StatefulSet recrée le pod avec le même PVC
kubectl -n $NS delete pod postgres-0
kubectl -n $NS wait --for=condition=ready pod/postgres-0 --timeout=120s

# Cas grave : voir le runbook 5 / docs/backup-restore.md
```

**Validation**

```bash
kubectl -n $NS exec -it postgres-0 -- pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
bash scripts/smoke-test-k8s.sh
```

## 4. Rollout bloqué

**Symptômes** : `rollout status` ne se termine jamais, nouveaux pods en `Pending`,
`ImagePullBackOff`, ou qui ne passent jamais `Ready`.

**Diagnostic**

```bash
kubectl -n $NS rollout status deployment/<service> --timeout=10s   # confirme le blocage sans attendre indéfiniment
kubectl -n $NS get pods -l app.kubernetes.io/name=<service>
kubectl -n $NS describe pod <nouveau-pod>
kubectl -n $NS get rs -l app.kubernetes.io/name=<service>
```

Cause fréquente ici : `maxUnavailable: 0` + readiness probe qui échoue en boucle sur le nouveau
pod -> l'ancien ReplicaSet n'est jamais réduit, le rollout reste bloqué tant que le nouveau pod
n'est pas `Ready`.

| Cause                                       | Action                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `ImagePullBackOff` (tag inexistant/typo)    | Corriger le tag, ré-appliquer                                                |
| Nouveau pod jamais `Ready` (bug applicatif) | Rollback immédiat, ne pas attendre                                           |
| `Pending` (ressources insuffisantes)        | Vérifier la capacité du cluster, ajuster les `requests` ou scaler le cluster |

**Correction / validation**

```bash
kubectl -n $NS rollout undo deployment/<service>
kubectl -n $NS rollout status deployment/<service> --timeout=120s
kubectl -n $NS get pods -l app.kubernetes.io/name=<service>   # tous Ready, un seul ReplicaSet actif
bash scripts/smoke-test-k8s.sh
```

## 5. Restauration d'une sauvegarde

Voir [`docs/backup-restore.md`](backup-restore.md) pour l'architecture complète et les RPO/RTO
mesurés. À déclencher quand une perte de données est confirmée (suppression accidentelle,
migration ratée, corruption) et que le runbook 3 conclut qu'un simple redémarrage ne suffit pas.

Avant toute action destructive, vérifier qu'une sauvegarde récente existe (le namespace est en
profil `restricted`, ce pod ad hoc doit donc reprendre le même `securityContext` que les CronJobs) :

```bash
kubectl -n $NS run list-backups --rm -i --restart=Never \
  --image=postgres:16.6-alpine3.21 --overrides='
{"spec":{"serviceAccountName":"db-backup","securityContext":{"runAsNonRoot":true,"runAsUser":1000,"runAsGroup":1000,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"list","image":"postgres:16.6-alpine3.21","command":["ls","-lh","/backups"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"readOnlyRootFilesystem":true}, "volumeMounts":[{"name":"backups","mountPath":"/backups","readOnly":true}]}],"volumes":[{"name":"backups","persistentVolumeClaim":{"claimName":"postgres-backup"}}]}}'
```

| Situation                                     | Action                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| Sauvegarde récente disponible, RPO acceptable | Restaurer la plus récente (`RESTORE_FILE=latest`, comportement par défaut) |
| Besoin d'un point de restauration précis      | Restaurer un fichier daté précis (voir `docs/backup-restore.md`, § 3)      |
| Aucune sauvegarde exploitable                 | Incident majeur : documenter la perte, corriger la cause racine            |

**Correction**

```bash
RESTORE_JOB="restore-manual-$(date +%s)"
kubectl -n $NS create job "$RESTORE_JOB" --from=cronjob/postgres-restore
kubectl -n $NS wait --for=condition=complete "job/$RESTORE_JOB" --timeout=120s
kubectl -n $NS logs "job/$RESTORE_JOB"
```

Script bout-en-bout (données de test, backup, suppression, restore, vérification) :
[`scripts/backup-restore-demo.sh`](../scripts/backup-restore-demo.sh).

**Validation**

```bash
kubectl -n $NS exec -it postgres-0 -- psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT count(*) FROM products; SELECT count(*) FROM orders;"
bash scripts/smoke-test-k8s.sh
```

Pensez à communiquer la fenêtre de perte de données réelle (écart entre l'heure de l'incident et
l'horodatage du fichier restauré) aux parties prenantes : c'est le RPO effectif de cet incident,
potentiellement différent du RPO théorique.

## Commandes transverses

```bash
kubectl -n $NS get deploy,sts,pods,svc,ingress,hpa,pdb,cronjob
kubectl -n $NS get events --sort-by='.lastTimestamp' | tail -30

kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80
kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090:9090
kubectl -n monitoring port-forward svc/kube-prometheus-stack-alertmanager 9093:9093

bash scripts/smoke-test-k8s.sh   # après toute intervention
```
