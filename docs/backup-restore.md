# Sauvegarde et restauration PostgreSQL

Ce document couvre la sauvegarde (`pg_dump`), la rétention, la restauration et les RPO/RTO pour la
base `postgres` du namespace `microservice-app`. Vérifié sur un cluster **minikube** local
(overlay `dev`).

## Architecture

```
┌─────────────────────────────┐        ┌─────────────────────────────┐
│ CronJob postgres-backup     │        │ CronJob postgres-restore     │
│ schedule: 0 3 * * *          │        │ suspend: true (jamais auto)  │
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

- **`postgres-backup`** (CronJob planifié) : `pg_dump --clean --if-exists --no-owner`, compression
  gzip, écriture sur le PVC avec un nom horodaté, puis suppression des fichiers au-delà de
  `RETENTION_COUNT` (7 par défaut).
- **`postgres-restore`** : même PVC, `suspend: true` en permanence, **jamais exécuté
  automatiquement** - une restauration écrase les données courantes. Se déclenche uniquement à la
  demande via `kubectl create job --from=cronjob/postgres-restore`.
- Les deux partagent le ServiceAccount `db-backup` et l'image `postgres:16.6-alpine3.21` déjà
  utilisée par le StatefulSet (mêmes binaires `pg_dump`/`psql`, rien de plus à maintenir), avec un
  `securityContext` non-root et lecture seule.

### Pourquoi un PVC et pas un stockage objet

L'idéal serait un stockage objet (S3/GCS/MinIO). Ici, on utilise un **PVC de démonstration**, avec
des limites assumées : il est local au nœud (ne survit pas à une panne de nœud), sans réplication
hors cluster (perdre le PVC emporte aussi les sauvegardes), et sans chiffrement dédié au repos.

En production, l'idée serait d'ajouter un job qui pousse chaque `.sql.gz` vers un bucket S3/GCS/MinIO
avec versioning, ou d'utiliser un opérateur qui l'intègre nativement (CloudNativePG + Barman par
exemple). Pas fait par défaut ici pour garder la démo exécutable sans compte cloud.

## Sauvegarde

Le dump utilise `--clean --if-exists`, ce qui le rend **idempotent** : on peut restaurer sans
avoir à vider la base au préalable, même si le schéma cible existe déjà.

La rétention se fait par nombre de fichiers (7 par défaut), pas par durée - plus simple à auditer
sur un volume de démo de taille fixe.

Le script tourne avec `set -eu` : toute commande en échec (ex. `pg_dump` qui ne joint pas
PostgreSQL) fait échouer le Job, visible via `kubectl get jobs`/`get cronjob` ou dans les logs. Une
alerte Prometheus dédiée (`PostgresBackupJobFailed`) se déclenche immédiatement, en criticité
`critical` : un backup manqué dégrade silencieusement le RPO sans que personne ne le remarque
avant qu'une restauration soit nécessaire.

Déclenchement manuel, hors planification :

```bash
kubectl -n microservice-app create job "manual-backup-$(date +%s)" --from=cronjob/postgres-backup
kubectl -n microservice-app wait --for=condition=complete job/manual-backup-<ts> --timeout=120s
kubectl -n microservice-app logs job/manual-backup-<ts>
```

## Restauration

### La sauvegarde la plus récente (par défaut)

```bash
kubectl -n microservice-app create job "restore-manual-$(date +%s)" --from=cronjob/postgres-restore
kubectl -n microservice-app wait --for=condition=complete job/restore-manual-<ts> --timeout=120s
kubectl -n microservice-app logs job/restore-manual-<ts>
```

### Un fichier précis

Le CronJob fixe `RESTORE_FILE=latest`. Pour cibler un fichier particulier, il faut générer le Job
en `dry-run`, patcher la variable, puis l'appliquer (le pod template d'un Job est immuable une
fois créé) :

```bash
kubectl -n microservice-app create job restore-manual-precis \
  --from=cronjob/postgres-restore --dry-run=client -o yaml > /tmp/restore-job.yaml
# éditer /tmp/restore-job.yaml : env.RESTORE_FILE = "<db>-20260715T191734Z.sql.gz"
kubectl apply -f /tmp/restore-job.yaml
kubectl -n microservice-app wait --for=condition=complete job/restore-manual-precis --timeout=120s
```

Pour lister les sauvegardes disponibles sans rien restaurer (pod jetable montant le même PVC en
lecture seule - le namespace est en profil Pod Security `restricted`, donc ce pod doit déclarer le
même `securityContext` que les CronJobs) :

```bash
kubectl -n microservice-app run list-backups --rm -i --restart=Never \
  --image=postgres:16.6-alpine3.21 --overrides='
{"spec":{"serviceAccountName":"db-backup","securityContext":{"runAsNonRoot":true,"runAsUser":1000,"runAsGroup":1000,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"list","image":"postgres:16.6-alpine3.21","command":["ls","-lh","/backups"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"readOnlyRootFilesystem":true},"volumeMounts":[{"name":"backups","mountPath":"/backups","readOnly":true}]}],"volumes":[{"name":"backups","persistentVolumeClaim":{"claimName":"postgres-backup"}}]}}'
```

## Test réel effectué

Script reproductible : [`scripts/backup-restore-demo.sh`](../scripts/backup-restore-demo.sh).

```bash
bash scripts/backup-restore-demo.sh
```

Déroulé : insertion d'une ligne marqueur, backup à la demande (`Complete` en quelques secondes,
fichier de 2,4 Ko écrit sur le PVC), simulation de perte de données (`DROP TABLE`), restauration à
la demande (`Complete`, logs montrant le rejeu complet du dump), puis vérification que la ligne
marqueur et les produits seedés sont bien de retour.

### RPO et RTO mesurés

| Mesure  | Valeur mesurée (démo) | Explication                                                                                                                                    |
| ------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **RPO** | jusqu'à 24h           | Borné par l'intervalle entre deux sauvegardes planifiées (`0 3 * * *`). Un backup à la demande avant une opération risquée ramène le RPO à ~0. |
| **RTO** | **4s** mesuré         | Sur une base de démo (5 produits + fixtures). Le RTO croît avec la taille du dump : à prévoir un test à l'échelle réelle en production.        |

Ces chiffres caractérisent l'environnement de démo (base de quelques Ko), pas un engagement de
production - à rejouer sur un volume représentatif avant de s'y fier.

## Commandes de référence

```bash
kubectl -n microservice-app get cronjob postgres-backup postgres-restore
kubectl -n microservice-app get jobs -l app.kubernetes.io/name=postgres-backup

# Logs du dernier backup
kubectl -n microservice-app logs job/$(kubectl -n microservice-app get jobs \
  -l app.kubernetes.io/name=postgres-backup --sort-by=.metadata.creationTimestamp \
  -o jsonpath='{.items[-1].metadata.name}')

# Forcer une exécution immédiate
kubectl -n microservice-app create job "postgres-backup-now" --from=cronjob/postgres-backup
```
