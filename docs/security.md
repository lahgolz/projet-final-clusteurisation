# Sécurité Kubernetes

Ce document couvre le moindre privilège (ServiceAccounts/RBAC), le Pod Security des workloads,
l'isolation réseau (NetworkPolicy) et la chaîne d'approvisionnement (scan d'images, secrets, tags
immuables). Vérifié sur un cluster **minikube** local (namespace `microservice-app`, overlay
`dev`).

## 1. ServiceAccounts et RBAC

Un ServiceAccount dédié par type de workload (plutôt qu'un compte partagé), pour isoler le rayon
d'impact si l'un d'eux était un jour compromis :

| ServiceAccount | Workload(s)                 | `automountServiceAccountToken` |
| -------------- | --------------------------- | ------------------------------ |
| `frontend`     | Deployment `frontend`       | `false`                        |
| `catalogue`    | Deployment `catalogue`      | `false`                        |
| `orders`       | Deployment `orders`         | `false`                        |
| `postgres`     | StatefulSet `postgres`      | `false`                        |
| `db-jobs`      | Jobs `db-migrate`/`db-seed` | `false`                        |

Manifest : [`k8s/base/serviceaccount.yaml`](../k8s/base/serviceaccount.yaml). `db-migrate` et
`db-seed` partagent un ServiceAccount : même image, même périmètre d'accès (aucun), donc rien à
gagner à les séparer.

**Aucun `Role`/`RoleBinding`** n'est créé. Aucun workload n'appelle l'API Kubernetes (pas de
lecture de ConfigMap/Secret via le client K8s, pas de leader election) : la config est injectée
via `envFrom`/`secretKeyRef` au démarrage, pas via l'API. Un Role vide n'aurait ajouté aucune
garantie ; l'absence de binding en est une.

Vérifié pour chaque ServiceAccount - par exemple `catalogue` :

```bash
$ kubectl auth can-i get secrets --as=system:serviceaccount:microservice-app:catalogue -n microservice-app
no
$ kubectl auth can-i get pods --as=system:serviceaccount:microservice-app:catalogue -n microservice-app
no
$ kubectl auth can-i '*' '*' --as=system:serviceaccount:microservice-app:catalogue
no
```

Même résultat pour `frontend`, `orders`, `postgres`, `db-jobs` : aucun accès à `secrets`, `pods`,
ni à rien d'autre au-delà des endpoints publics de découverte. Aucun `cluster-admin`, aucun
wildcard.

## 2. Pod Security Standards

Namespace étiqueté en profil `restricted` ([`k8s/base/namespace.yaml`](../k8s/base/namespace.yaml)) :

```yaml
pod-security.kubernetes.io/enforce: restricted
pod-security.kubernetes.io/audit: restricted
pod-security.kubernetes.io/warn: restricted
```

`kubectl apply --dry-run=server` sur l'overlay `dev` ne remonte aucun avertissement PSA.

Tous les workloads tournent `runAsNonRoot`, sans capability Linux, sans possibilité d'escalade de
privilèges, avec seccomp `RuntimeDefault` et **système de fichiers racine en lecture seule** - y
compris PostgreSQL et les Jobs `db-tools`, les cas les plus contraignants :

- **`postgres`** écrit sa socket Unix dans `/var/run/postgresql` et des fichiers temporaires dans
  `/tmp` : deux `emptyDir` explicites couvrent ces chemins
  ([`k8s/base/postgres.yaml`](../k8s/base/postgres.yaml)), les données persistantes restant sur le
  PVC monté sur `/var/lib/postgresql/data`.
- **`db-migrate`/`db-seed`** : `tsx` et `pnpm` ont besoin d'écrire dans `$HOME`, forcé à `/tmp`
  (`emptyDir`, voir [`k8s/base/db-jobs.yaml`](../k8s/base/db-jobs.yaml)).

Validé en pratique : rollout complet de `postgres` et exécution de `db-migrate`/`db-seed` jusqu'à
`Completed` avec ces contraintes actives, données toujours lisibles ensuite.

## 3. NetworkPolicy

Politique par défaut : tout est refusé, en entrée **et** en sortie (`podSelector: {}`). Seuls les
flux ci-dessous sont explicitement autorisés :

| Flux                                                         | Port(s)    |
| ------------------------------------------------------------ | ---------- |
| Ingress NGINX -> `frontend`                                  | 8080       |
| Ingress NGINX -> `catalogue`/`orders`                        | 4001, 4002 |
| `orders` -> `catalogue`                                      | 4001       |
| `catalogue`/`orders`/`db-migrate`/`db-seed` -> `postgres`    | 5432       |
| tous les pods -> CoreDNS                                     | 53 UDP/TCP |
| `monitoring` (Prometheus) -> `catalogue`/`orders` `/metrics` | 4001, 4002 |

`frontend` ne fait aucun appel serveur-à-serveur (les appels `/api/*` viennent du navigateur, via
l'Ingress) : aucune règle d'egress supplémentaire ne lui est accordée. Manifest :
[`k8s/base/networkpolicy.yaml`](../k8s/base/networkpolicy.yaml).

```bash
$ kubectl -n microservice-app exec deploy/orders -- wget -qT5 -O- http://catalogue:4001/health/live
{"status":"ok","service":"catalogue"}
$ kubectl -n microservice-app exec deploy/orders -- nc -zv -w5 postgres 5432
postgres (10.244.0.56:5432) open
```

### Limite constatée : non appliquée sur ce cluster de démo

Les objets `NetworkPolicy` sont acceptés par l'API et syntaxiquement valides, mais **pas appliqués
par le plan de données** sur minikube : le CNI par défaut (`kindnet`/`bridge` + `kube-proxy`) ne
lit pas l'API `NetworkPolicy`. Un flux censé être bloqué passe quand même :

```bash
$ kubectl -n microservice-app exec deploy/catalogue -- nc -zv -w5 orders 4002
orders (10.109.189.72:4002) open   # devrait être bloqué : catalogue n'a pas de règle vers orders
```

Ce n'est pas un défaut des manifests, c'est le CNI de démo qui ne les fait pas respecter. Sur un
cluster réel, il suffit d'un CNI compatible (Calico, Cilium, Antrea...) - `minikube
start --cni=calico`, Calico sur kind, ou un cluster managé qui le supporte nativement.

## 4. Chaîne d'approvisionnement

**Scan d'images** : `cd.yml` / `build-and-push` fait tourner Trivy sur chaque image avant le push
registre, et échoue le pipeline sur toute vulnérabilité CRITICAL corrigeable non ignorée
explicitement (`.trivyignore`, vide aujourd'hui).

**Images de base épinglées**, aucun tag flottant (`latest`, `alpine`, `lts`) : Node.js
`22.23.1-alpine3.24`, PostgreSQL `16.6-alpine3.21`, nginx `nginxinc/nginx-unprivileged:1.29.8-alpine3.23`.

**Tag `latest` interdit dans les manifests** : le job CI `manifest-checks` (`ci.yml`) cherche toute
ligne `image:`/`newTag:` finissant par `:latest` dans `k8s/`.

**Scan de secrets** : le job CI `secret-scan` (`ci.yml`, gitleaks, historique complet) tourne sur
chaque pull request.

```bash
$ trivy image --severity CRITICAL --ignore-unfixed --exit-code 1 catalogue:local
Total: 0 (CRITICAL: 0)
$ gitleaks detect --source . --redact
no leaks found
```

## 5. Rotation des secrets

Le Secret `microservice-app-db` est généré par Kustomize (`secretGenerator`) à partir d'un fichier
`secret.env` non versionné, par overlay (voir [`docs/ci-cd.md`](ci-cd.md#déploiement-manuel)).
Pour changer le mot de passe PostgreSQL :

```bash
# 1. Changer le mot de passe côté PostgreSQL en premier (POSTGRES_PASSWORD n'est lu par l'image
#    officielle qu'à l'initialisation d'un PGDATA vide, le Secret K8s seul ne suffit pas)
kubectl -n microservice-app exec -it postgres-0 -- \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "ALTER USER \"$POSTGRES_USER\" WITH PASSWORD 'nouveau-mot-de-passe';"

# 2. Mettre à jour secret.env (même mot de passe pour POSTGRES_PASSWORD et DATABASE_URL) et réappliquer
kubectl apply -k k8s/overlays/<env>

# 3. Redémarrer les pods : un secretKeyRef ne se recharge pas à chaud
kubectl -n microservice-app rollout restart deployment/catalogue deployment/orders
```

À faire au moindre soupçon de fuite (alerte du scanner de secrets sur un commit passé) ou au
changement de personnel ayant eu accès à `secret.env` en clair. Aucune rotation automatique
périodique : ça demanderait un gestionnaire de secrets externe (Vault, External Secrets Operator).

## Limites connues

- **NetworkPolicy non appliquée sur le cluster de démo** - voir la section dédiée plus haut. Les
  règles sont correctes, prêtes pour un CNI compatible.
- **RBAC volontairement vide** : correct tant qu'aucun workload n'appelle l'API Kubernetes. Un
  futur besoin de ce genre demanderait un Role namespacé dédié, jamais un ClusterRole.
- **Pas de gestionnaire de secrets externe** : les secrets restent des `Secret` Kubernetes
  (base64, pas chiffrés at-rest sans chiffrement etcd côté cluster). Suffisant pour la démo,
  insuffisant pour un environnement réglementé.
- **Pas de remontée SARIF** de Trivy/gitleaks vers l'onglet Security de GitHub (demande GitHub
  Advanced Security sur dépôt privé) : les scans bloquent le pipeline, les détails restent dans
  les logs du job.
