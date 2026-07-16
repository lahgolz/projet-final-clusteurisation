# Runbooks

## Périmètre

Procédures courtes pour les incidents les plus probables sur `microservice-app`, écrites pour être
suivies par une personne qui n'a pas participé au développement. Chaque runbook suit le même plan :
symptômes, diagnostic, décision, correction/rollback, validation du retour à la normale.

Namespace par défaut : `microservice-app`. Remplacer `$NS` si un autre namespace est utilisé.

```bash
NS=microservice-app
```

---

## 1. Pod en CrashLoopBackOff

### Symptômes

- Alerte Prometheus `PodCrashLoopBackOff` (voir [`k8s/observability/alerts.yaml`](../k8s/observability/alerts.yaml)).
- `kubectl -n $NS get pods` affiche `CrashLoopBackOff` ou un nombre de `RESTARTS` qui augmente.

### Diagnostic

```bash
kubectl -n $NS get pods -o wide
kubectl -n $NS describe pod <pod>                 # section Events : OOMKilled ? image manquante ? probe qui échoue ?
kubectl -n $NS logs <pod>                          # dernier essai
kubectl -n $NS logs <pod> --previous               # essai précédent (souvent celui qui explique le crash)
```

Causes fréquentes sur ce projet : `DATABASE_URL` absent/invalide (Secret non appliqué), migration
non jouée (`db-migrate` en échec avant le démarrage de l'API), image avec un tag inexistant,
`readinessProbe`/`livenessProbe` mal configurée, `OOMKilled` (mémoire sous-dimensionnée).

### Décision

| Cause identifiée                              | Action                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| `OOMKilled` (`describe pod` → `Reason: OOMKilled`) | Augmenter `resources.limits.memory` ou corriger une fuite mémoire     |
| Erreur de configuration (Secret/ConfigMap)     | Corriger la valeur, ré-appliquer, `kubectl rollout restart`             |
| Régression applicative après déploiement       | Rollback (§ ci-dessous)                                                 |
| Dépendance indisponible (Postgres, `catalogue`) | Traiter d'abord le runbook « base indisponible » ou vérifier `orders`→`catalogue` |

### Correction / rollback

```bash
# Rollback vers la révision précédente si le crash suit un déploiement récent
kubectl -n $NS rollout history deployment/<service>
kubectl -n $NS rollout undo deployment/<service>
# ou scripts/rollback-k8s.sh pour catalogue+orders+frontend en une fois
bash scripts/rollback-k8s.sh
```

### Validation du retour à la normale

```bash
kubectl -n $NS rollout status deployment/<service> --timeout=120s
kubectl -n $NS get pods -l app.kubernetes.io/name=<service>   # 0 restart depuis le rollback
bash scripts/smoke-test-k8s.sh
```

---

## 2. Taux d'erreur HTTP élevé

### Symptômes

- Alerte Prometheus `HighHttp5xxRate` (> 5 % de 5xx sur 5 min, par service).
- Retours 5xx constatés côté client/frontend.

### Diagnostic

```bash
# Confirmer et quantifier via Prometheus (port-forward, voir docs/observability.md)
kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090:9090 &
# PromQL : sum by (service,status_code) (rate(http_requests_total{status_code=~"5.."}[5m]))

kubectl -n $NS logs deploy/catalogue --tail=200 | grep -i error
kubectl -n $NS logs deploy/orders --tail=200 | grep -i error
kubectl -n $NS get pods                              # un service dégradé (peu de Ready) ?
kubectl -n $NS get events --sort-by='.lastTimestamp' | tail -30
```

Les logs sont structurés JSON avec un `requestId` corrélable entre `orders` et `catalogue` (appel
interne `orders` → `catalogue` lors de la création de commande) — chercher le même `requestId` dans
les deux services pour situer où l'erreur apparaît réellement.

### Décision

| Observation                                          | Action                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Erreurs concentrées sur un seul service, suite à un déploiement | Rollback de ce service                                              |
| Erreurs venant de `orders` lors de l'appel à `catalogue` | Vérifier la santé de `catalogue` et la NetworkPolicy `allow-orders-to-catalogue-egress` |
| 5xx corrélés à une erreur PostgreSQL dans les logs     | Traiter le runbook « base indisponible »                             |
| Pas de déploiement récent, pic isolé                   | Vérifier une charge anormale (§ test de charge, `docs/performance.md`) |

### Correction / rollback

```bash
kubectl -n $NS rollout undo deployment/<service-en-cause>
kubectl -n $NS rollout status deployment/<service-en-cause> --timeout=120s
```

### Validation

```bash
# Le taux d'erreur redescend sous le seuil d'alerte (voir Prometheus/Grafana)
bash scripts/smoke-test-k8s.sh
```

---

## 3. Base PostgreSQL indisponible

### Symptômes

- `catalogue`/`orders` échouent leurs requêtes DB (logs : `ECONNREFUSED`, `timeout`, erreurs `pg`).
- `readinessProbe` de `catalogue`/`orders` en échec si elle vérifie la DB (`/health/ready`).
- `kubectl -n $NS get pods` : `postgres-0` pas `Running`/`Ready`, ou `0/1`.

### Diagnostic

```bash
kubectl -n $NS get pods -l app.kubernetes.io/name=postgres
kubectl -n $NS describe pod postgres-0
kubectl -n $NS logs postgres-0 --previous 2>/dev/null || kubectl -n $NS logs postgres-0
kubectl -n $NS get pvc data-postgres-0                       # PVC toujours Bound ?
kubectl -n $NS exec -it postgres-0 -- pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

Rappel de la limite connue (voir [`docs/resilience.md`](resilience.md#7-limites-de-haute-disponibilité)) :
PostgreSQL est un StatefulSet mono-replica sans HA réelle. Un redémarrage de pod cause une coupure
de 15-30 s ; une corruption du PVC est irrécupérable sans backup.

### Décision

| Cause                                              | Action                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| Pod en cours de redémarrage normal (`Running` bientôt) | Attendre (`kubectl wait --for=condition=ready`), pas d'action corrective  |
| `CrashLoopBackOff` sur `postgres-0`                 | `describe`/`logs --previous` : erreur de configuration (Secret) ou données corrompues |
| PVC perdu/corrompu, base illisible                  | **Restauration depuis la dernière sauvegarde** (§ 5)                    |
| Nœud indisponible (cluster multi-nœuds)             | Le StatefulSet reprogramme `postgres-0` sur un autre nœud dès que possible ; le PVC doit être accessible depuis ce nœud |

### Correction

```bash
# Cas simple : redémarrage du pod (le StatefulSet le recrée avec le même PVC)
kubectl -n $NS delete pod postgres-0
kubectl -n $NS wait --for=condition=ready pod/postgres-0 --timeout=120s

# Cas grave : restauration nécessaire, voir runbook 5 / docs/backup-restore.md
```

### Validation

```bash
kubectl -n $NS exec -it postgres-0 -- pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
bash scripts/smoke-test-k8s.sh
```

---

## 4. Rollout bloqué

### Symptômes

- `kubectl -n $NS rollout status deployment/<service>` ne se termine pas (`Waiting for rollout...`).
- Nouveaux pods en `Pending`, `ImagePullBackOff`, ou jamais `Ready`.

### Diagnostic

```bash
kubectl -n $NS rollout status deployment/<service> --timeout=10s   # confirme le blocage sans attendre indéfiniment
kubectl -n $NS get pods -l app.kubernetes.io/name=<service>
kubectl -n $NS describe pod <nouveau-pod>                          # Events : ImagePullBackOff, Pending (ressources insuffisantes), readiness probe qui échoue
kubectl -n $NS get rs -l app.kubernetes.io/name=<service>          # ancien et nouveau ReplicaSet
```

Cause fréquente sur ce projet : `maxUnavailable: 0` + `readinessProbe` qui échoue en boucle sur le
nouveau pod → l'ancien ReplicaSet n'est jamais réduit, le rollout reste bloqué indéfiniment tant que
le nouveau pod n'est pas `Ready`.

### Décision

| Cause                                    | Action                                                        |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `ImagePullBackOff` (tag inexistant/typo)  | Corriger le tag d'image, ré-appliquer                          |
| Nouveau pod jamais `Ready` (bug applicatif) | **Rollback immédiat**, ne pas attendre                        |
| `Pending` (ressources insuffisantes)      | Vérifier la capacité du cluster (`kubectl describe node`), ajuster `requests` ou scaler le cluster |

### Correction / rollback

```bash
kubectl -n $NS rollout undo deployment/<service>
kubectl -n $NS rollout status deployment/<service> --timeout=120s
```

### Validation

```bash
kubectl -n $NS get pods -l app.kubernetes.io/name=<service>   # tous Ready, un seul ReplicaSet actif
kubectl -n $NS rollout history deployment/<service>
bash scripts/smoke-test-k8s.sh
```

---

## 5. Restauration d'une sauvegarde

Voir [`docs/backup-restore.md`](backup-restore.md) pour l'architecture complète et les RPO/RTO
mesurés. Résumé opérationnel :

### Symptômes déclenchant ce runbook

- Perte de données confirmée (suppression accidentelle, migration destructive ratée, corruption).
- Le runbook 3 (« base indisponible ») conclut qu'un redémarrage simple ne suffit pas.

### Diagnostic préalable

```bash
# Vérifier qu'une sauvegarde récente et exploitable existe avant toute action destructive
# (le namespace est en profil Pod Security "restricted" : le pod ad hoc doit déclarer le même
# securityContext que les CronJobs, voir docs/backup-restore.md)
kubectl -n $NS run list-backups --rm -i --restart=Never \
  --image=postgres:16.6-alpine3.21 --overrides='
{"spec":{"serviceAccountName":"db-backup","securityContext":{"runAsNonRoot":true,"runAsUser":1000,"runAsGroup":1000,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"list","image":"postgres:16.6-alpine3.21","command":["ls","-lh","/backups"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"readOnlyRootFilesystem":true},"volumeMounts":[{"name":"backups","mountPath":"/backups","readOnly":true}]}],"volumes":[{"name":"backups","persistentVolumeClaim":{"claimName":"postgres-backup"}}]}}'
```

### Décision

| Situation                                             | Action                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| Sauvegarde récente disponible, RPO acceptable          | Restaurer la plus récente (`RESTORE_FILE=latest`, comportement par défaut) |
| Besoin d'un point de restauration précis (avant une opération connue) | Restaurer un fichier daté précis (voir `docs/backup-restore.md`, § 3) |
| Aucune sauvegarde exploitable                          | Incident majeur : documenter la perte de données, corriger la cause racine (alerte `PostgresBackupJobFailed` aurait dû prévenir ce cas) |

### Correction

```bash
RESTORE_JOB="restore-manual-$(date +%s)"
kubectl -n $NS create job "$RESTORE_JOB" --from=cronjob/postgres-restore
kubectl -n $NS wait --for=condition=complete "job/$RESTORE_JOB" --timeout=120s
kubectl -n $NS logs "job/$RESTORE_JOB"
```

Script bout-en-bout (création de données de test, backup, suppression, restore, vérification) :
[`scripts/backup-restore-demo.sh`](../scripts/backup-restore-demo.sh).

### Validation du retour à la normale

```bash
# Vérifier un échantillon de données connu (adapter la requête aux données attendues)
kubectl -n $NS exec -it postgres-0 -- psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT count(*) FROM products; SELECT count(*) FROM orders;"

bash scripts/smoke-test-k8s.sh
```

Communiquer la fenêtre de perte de données réelle (écart entre l'heure de l'incident et l'horodatage
du fichier de sauvegarde restauré) aux parties prenantes : c'est le RPO effectif de cet incident,
potentiellement différent du RPO théorique documenté dans `docs/backup-restore.md`.

---

## Commandes de référence transverses

```bash
# Vue d'ensemble
kubectl -n $NS get deploy,sts,pods,svc,ingress,hpa,pdb,cronjob

# Événements récents (toutes causes)
kubectl -n $NS get events --sort-by='.lastTimestamp' | tail -30

# Accès Grafana/Prometheus/Alertmanager (voir docs/observability.md)
kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80
kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090:9090
kubectl -n monitoring port-forward svc/kube-prometheus-stack-alertmanager 9093:9093

# Smoke test de bout en bout après toute intervention
bash scripts/smoke-test-k8s.sh
```
