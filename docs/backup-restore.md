# Sauvegarde et restauration PostgreSQL

## Périmètre

Ce document couvre la sauvegarde (`pg_dump`), la rétention, la restauration et les RPO/RTO de
démonstration pour la base `postgres` du namespace `microservice-app`. Vérifié en conditions
réelles sur un cluster **minikube** local (overlay `dev`), le 2026-07-15.

---

## 1. Architecture

```
┌─────────────────────────────┐        ┌─────────────────────────────┐
│ CronJob postgres-backup     │        │ CronJob postgres-restore     │
│ schedule: 0 3 * * *          │        │ suspend: true (jamais auto)  │
│ concurrencyPolicy: Forbid    │        │ concurrencyPolicy: Forbid     │
└──────────────┬───────────────┘        └──────────────┬────────────────┘
               │ pg_dump --clean --if-exists            │ gunzip | psql
               ▼                                         ▼
        ┌─────────────┐                           ┌─────────────┐
        │  postgres-0  │◀─────────────────────────│  postgres-0  │
        └─────────────┘                           └─────────────┘
               │ écrit                                    ▲ lit
               ▼                                          │
        ┌───────────────────────── PVC postgres-backup (2Gi, RWO) ─────┐
        │  <db>-<timestamp>.sql.gz  (rétention : 7 fichiers max)        │
        └────────────────────────────────────────────────────────────┘
```

Manifest : [`k8s/base/backup.yaml`](../k8s/base/backup.yaml).

- **`postgres-backup`** : `CronJob` planifié, exécute `pg_dump --clean --if-exists --no-owner`
  vers un fichier temporaire, le compresse (`gzip -9`), l'écrit sur le PVC `postgres-backup` avec
  un nom horodaté (`<POSTGRES_DB>-<UTC ISO8601 compact>.sql.gz`), puis supprime les fichiers
  excédant la rétention (`RETENTION_COUNT=7`).
- **`postgres-restore`** : même PVC, `suspend: true` en permanence — **jamais exécuté
  automatiquement** (une restauration écrase les données courantes). Se déclenche uniquement à la
  demande via `kubectl create job --from=cronjob/postgres-restore`.
- Les deux CronJobs partagent le ServiceAccount `db-backup` (`automountServiceAccountToken:
false`) et l'image `postgres:16.6-alpine3.21` déjà utilisée par le StatefulSet (mêmes binaires
  `pg_dump`/`psql`, aucune image supplémentaire à maintenir).
- `securityContext` non-root (`runAsUser: 1000`), `readOnlyRootFilesystem: true`, capabilities
  droppées : le script (monté en ConfigMap `postgres-backup-scripts`, lecture seule) n'écrit que
  sur le PVC et `/tmp` (`emptyDir`).

### Pourquoi un PVC et pas un stockage objet

L'énoncé recommande un stockage objet (S3/GCS/MinIO) en priorité. Choix fait ici : **PVC de
démonstration**, limite documentée explicitement :

| Limite du PVC de démonstration                               | Impact                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `ReadWriteOnce`, provisioner `hostPath`-like (minikube/kind) | Le volume est local au nœud unique ; ne survit pas à une panne de nœud                |
| Pas de réplication hors cluster                              | Une perte du PVC (corruption, suppression accidentelle) emporte aussi les sauvegardes |
| Pas de chiffrement dédié au repos                            | Dépend uniquement du chiffrement (éventuel) du disque sous-jacent                     |

**Recommandation production** : un job/CronJob supplémentaire (ou un sidecar `mc`/`aws s3 cp`)
poussant chaque `.sql.gz` vers un bucket S3/GCS/MinIO avec versioning et réplication inter-région,
ou un opérateur dédié (CloudNativePG intègre nativement des sauvegardes vers stockage objet via
Barman). Non fait par défaut ici pour garder la démonstration exécutable sans compte cloud.

---

## 2. Sauvegarde

### Contenu du dump

`pg_dump --clean --if-exists --no-owner` : dump SQL texte incluant `DROP ... IF EXISTS` avant
chaque `CREATE`, ce qui rend la restauration **idempotente** même si le schéma cible existe déjà
(cas du scénario de démonstration : restaurer sans avoir à vider la base au préalable).

### Rétention

Le script conserve les `RETENTION_COUNT` (7 par défaut) fichiers les plus récents sur le PVC et
supprime les plus anciens à chaque exécution — rétention par nombre de sauvegardes, pas par durée
(plus simple à auditer sur un volume de démonstration de taille fixe).

### Échec visible

- Le script utilise `set -eu` : toute commande en échec (ex. `pg_dump` ne pouvant joindre
  PostgreSQL) interrompt le script et fait échouer le Job.
- Un Job en échec est visible directement : `kubectl -n microservice-app get jobs`,
  `kubectl -n microservice-app get cronjob postgres-backup` (`lastScheduleTime` avance mais aucun
  `lastSuccessfulTime` récent), `kubectl -n microservice-app logs job/<nom>`.
- Alerte Prometheus dédiée `PostgresBackupJobFailed`
  ([`k8s/observability/alerts.yaml`](../k8s/observability/alerts.yaml)), basée sur
  `kube_job_status_failed{job_name=~"postgres-backup-.*"}` : déclenchement immédiat (`for: 0m`),
  criticité `critical`, car un backup manqué dégrade silencieusement le RPO sans qu'aucun
  utilisateur ne le remarque avant qu'une restauration soit nécessaire.

### Déclenchement manuel (hors planification)

```bash
kubectl -n microservice-app create job "manual-backup-$(date +%s)" --from=cronjob/postgres-backup
kubectl -n microservice-app wait --for=condition=complete job/manual-backup-<ts> --timeout=120s
kubectl -n microservice-app logs job/manual-backup-<ts>
```

---

## 3. Restauration

### Restaurer la sauvegarde la plus récente (comportement par défaut)

```bash
kubectl -n microservice-app create job "restore-manual-$(date +%s)" --from=cronjob/postgres-restore
kubectl -n microservice-app wait --for=condition=complete job/restore-manual-<ts> --timeout=120s
kubectl -n microservice-app logs job/restore-manual-<ts>
```

### Restaurer un fichier précis

Le CronJob fixe `RESTORE_FILE=latest`. Pour cibler un fichier particulier, générer le Job en
`dry-run`, patcher la variable, puis l'appliquer (le pod template d'un Job est immuable après
création, donc `kubectl set env job/...` échouerait une fois le pod démarré) :

```bash
kubectl -n microservice-app create job restore-manual-precis \
  --from=cronjob/postgres-restore --dry-run=client -o yaml > /tmp/restore-job.yaml
# éditer /tmp/restore-job.yaml : env.RESTORE_FILE = "<db>-20260715T191734Z.sql.gz"
kubectl apply -f /tmp/restore-job.yaml
kubectl -n microservice-app wait --for=condition=complete job/restore-manual-precis --timeout=120s
```

Lister les sauvegardes disponibles sans déclencher de restauration (pod jetable montant le même
PVC en lecture seule) :

Le namespace applique le profil Pod Security `restricted` ([`docs/security.md`](security.md)) :
un pod ad hoc doit donc déclarer le même `securityContext` que les CronJobs, sous peine d'un rejet
`Forbidden` à la création.

```bash
kubectl -n microservice-app run list-backups --rm -i --restart=Never \
  --image=postgres:16.6-alpine3.21 --overrides='
{"spec":{"serviceAccountName":"db-backup","securityContext":{"runAsNonRoot":true,"runAsUser":1000,"runAsGroup":1000,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"list","image":"postgres:16.6-alpine3.21","command":["ls","-lh","/backups"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"readOnlyRootFilesystem":true},"volumeMounts":[{"name":"backups","mountPath":"/backups","readOnly":true}]}],"volumes":[{"name":"backups","persistentVolumeClaim":{"claimName":"postgres-backup"}}]}}'
```

---

## 4. Test réel effectué

Script reproductible : [`scripts/backup-restore-demo.sh`](../scripts/backup-restore-demo.sh).

```bash
bash scripts/backup-restore-demo.sh
```

Déroulé validé sur le cluster minikube local :

1. Insertion d'une ligne marqueur dans une table `backup_check` (en plus des données seedées,
   `products`/`orders`).
2. Backup à la demande (`manual-backup-<ts>`) : `Complete` en quelques secondes, fichier
   `<db>-<timestamp>.sql.gz` de 2,4 Ko écrit et listé sur le PVC.
3. Simulation de perte de données : `DROP TABLE backup_check;` — table absente, confirmé par
   `\dt backup_check`.
4. Restauration à la demande (`restore-manual-<ts>`) : `Complete`, logs montrant le rejeu complet
   du dump (`DROP`/`CREATE TABLE`/`COPY` pour `products`, `orders`, `backup_check`, etc.).
5. Vérification : la ligne marqueur et les 5 produits seedés sont de nouveau présents.

### RPO et RTO mesurés

| Mesure  | Valeur mesurée (démo)                                          | Explication                                                                                                                                                                                                                                                                             |
| ------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RPO** | jusqu'à 24 h (planification `0 3 * * *`)                       | Le RPO est borné par l'intervalle entre deux sauvegardes planifiées. Un backup à la demande avant une opération risquée ramène le RPO à ~0. Pour un RPO plus strict en continu, augmenter la fréquence (ex. `0 * * * *` toutes les heures) — compromis avec l'espace occupé sur le PVC. |
| **RTO** | **4 s** (mesuré, `T0` déclenchement du Job -> `T1` `Complete`) | Mesuré sur une base de démonstration (5 produits + fixtures). Le RTO croît avec la taille du dump : sur un jeu de données de production, prévoir un test de restauration à l'échelle réelle plutôt que d'extrapoler cette valeur.                                                       |

**Limite explicite** : ces RPO/RTO caractérisent l'environnement de démonstration (base de
quelques Ko), pas un engagement de production. Pour un chiffrage réel, il faut rejouer ce test sur
un volume de données représentatif du futur système en production.

---

## 5. Commandes de référence

```bash
# État des CronJobs
kubectl -n microservice-app get cronjob postgres-backup postgres-restore

# Historique des Jobs de backup/restore
kubectl -n microservice-app get jobs -l app.kubernetes.io/name=postgres-backup
kubectl -n microservice-app get jobs -l app.kubernetes.io/name=postgres-restore

# Logs du dernier backup
kubectl -n microservice-app logs job/$(kubectl -n microservice-app get jobs \
  -l app.kubernetes.io/name=postgres-backup --sort-by=.metadata.creationTimestamp \
  -o jsonpath='{.items[-1].metadata.name}')

# Forcer une exécution immédiate du CronJob planifié (au lieu d'un Job ad-hoc identique)
kubectl -n microservice-app create job "postgres-backup-now" --from=cronjob/postgres-backup
```
