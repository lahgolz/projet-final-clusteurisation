#!/usr/bin/env bash

set -euo pipefail

NS="${K8S_NAMESPACE:-microservice-app}"

header() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

psql_exec() {
  kubectl -n "$NS" exec postgres-0 -- sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"$1\""
}

header "0. Création d'une donnée de test"
psql_exec "CREATE TABLE IF NOT EXISTS backup_check(id serial primary key, note text, created_at timestamptz default now());
           INSERT INTO backup_check(note) VALUES ('backup-restore-demo-$(date -u +%Y%m%dT%H%M%SZ)');
           SELECT * FROM backup_check;"

header "1. Backup à la demande (Job depuis le CronJob postgres-backup)"
BACKUP_JOB="manual-backup-$(date +%s)"
kubectl -n "$NS" create job "$BACKUP_JOB" --from=cronjob/postgres-backup
kubectl -n "$NS" wait --for=condition=complete "job/$BACKUP_JOB" --timeout=120s
kubectl -n "$NS" logs "job/$BACKUP_JOB"

header "2. Simulation de perte de données (DROP TABLE)"
psql_exec "DROP TABLE backup_check;"
echo "  Table supprimée. Vérification :"
psql_exec "\\dt backup_check" || echo "  Confirmé : la table n'existe plus."

header "3. Restauration à la demande (Job depuis le CronJob postgres-restore, suspendu par défaut)"
T0=$(date +%s)
RESTORE_JOB="restore-manual-$(date +%s)"
kubectl -n "$NS" create job "$RESTORE_JOB" --from=cronjob/postgres-restore
kubectl -n "$NS" wait --for=condition=complete "job/$RESTORE_JOB" --timeout=120s
T1=$(date +%s)
kubectl -n "$NS" logs "job/$RESTORE_JOB" | tail -5

header "4. Vérification des données restaurées"
psql_exec "SELECT * FROM backup_check;"

echo ""
echo "  RTO mesuré (déclenchement de la restauration -> restauration terminée) : $((T1 - T0))s"
echo ""
echo "  Nettoyage de la table de démonstration..."
psql_exec "DROP TABLE IF EXISTS backup_check;" >/dev/null

header "Démonstration terminée"
echo "  kubectl -n $NS get cronjob"
echo "  kubectl -n $NS get jobs -l app.kubernetes.io/name=postgres-backup"
echo "  kubectl -n $NS exec -it postgres-0 -- sh -c 'ls -lh /backups' # nécessite un pod avec le PVC monté"
