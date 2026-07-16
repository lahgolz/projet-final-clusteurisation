# Sécurité Kubernetes

## Périmètre

Ce document couvre le moindre privilège (ServiceAccounts/RBAC), le Pod Security des workloads,
l'isolation réseau (NetworkPolicy) et la chaîne d'approvisionnement (scan d'images, secrets,
tags immuables). Vérifié en conditions réelles sur un cluster **minikube** local (namespace
`microservice-app`, overlay `dev`), le 2026-07-15.

---

## 1. ServiceAccounts et RBAC

### ServiceAccounts

Un ServiceAccount dédié par type de workload (au lieu d'un compte unique partagé), pour isoler le
rayon d'impact si l'un d'eux était un jour compromis ou mal configuré :

| ServiceAccount | Workload(s)                                                                                                                                                                      | `automountServiceAccountToken` |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `frontend`     | Deployment `frontend`                                                                                                                                                            | `false`                        |
| `catalogue`    | Deployment `catalogue`                                                                                                                                                           | `false`                        |
| `orders`       | Deployment `orders`                                                                                                                                                              | `false`                        |
| `postgres`     | StatefulSet `postgres`                                                                                                                                                           | `false`                        |
| `db-jobs`      | Jobs `db-migrate`/`db-seed` (même image `db-tools`, même périmètre d'accès : partager un compte entre les deux évite une multiplication de ressources sans bénéfice de sécurité) | `false`                        |

Manifest : [`k8s/base/serviceaccount.yaml`](../k8s/base/serviceaccount.yaml).

### RBAC : volontairement vide

Aucun `Role`/`RoleBinding` n'est créé. Aucun workload applicatif n'appelle l'API Kubernetes (pas de
lecture de ConfigMap/Secret via le client K8s, pas de leader election, pas de découverte de pods) :
la configuration est injectée via `envFrom`/`secretKeyRef` au démarrage du pod, pas via l'API. Créer
un Role vide ou fictif n'aurait ajouté aucune garantie ; l'absence de binding est la garantie.

Vérifié avec `kubectl auth can-i` pour chaque ServiceAccount :

```bash
$ kubectl auth can-i --list --as=system:serviceaccount:microservice-app:catalogue -n microservice-app
Resources   ...   Non-Resource URLs   ...   Verbs
                   [/api/*] [/healthz] [/version] ...   [get]   # endpoints de découverte publics uniquement
selfsubjectreviews.authentication.k8s.io ...                     [create]

$ kubectl auth can-i get secrets --as=system:serviceaccount:microservice-app:catalogue -n microservice-app
no
$ kubectl auth can-i get pods --as=system:serviceaccount:microservice-app:catalogue -n microservice-app
no
$ kubectl auth can-i '*' '*' --as=system:serviceaccount:microservice-app:catalogue
no
```

Résultat identique pour `frontend`, `orders`, `postgres`, `db-jobs` : aucun accès à `secrets`,
`pods`, ni à aucune autre ressource au-delà des endpoints de découverte non authentifiants exposés
par défaut à toute identité. Aucun `cluster-admin`, aucun wildcard, aucun ClusterRole.

---

## 2. Pod Security Standards

Namespace étiqueté en profil `restricted` ([`k8s/base/namespace.yaml`](../k8s/base/namespace.yaml)) :

```yaml
pod-security.kubernetes.io/enforce: restricted
pod-security.kubernetes.io/audit: restricted
pod-security.kubernetes.io/warn: restricted
```

`kubectl apply --dry-run=server` sur l'overlay `dev` ne remonte aucun avertissement PSA : tous les
pods du namespace sont conformes au profil `restricted`.

### `securityContext` par workload

| Workload               | `runAsNonRoot` | `runAsUser` | `allowPrivilegeEscalation` | Capabilities | `readOnlyRootFilesystem` | seccomp        |
| ---------------------- | :------------: | :---------: | :------------------------: | ------------ | :----------------------: | -------------- |
| `frontend`             |       ✅       |   (image)   |          ✅ false          | drop ALL     |            ✅            | RuntimeDefault |
| `catalogue`            |       ✅       |    1000     |          ✅ false          | drop ALL     |            ✅            | RuntimeDefault |
| `orders`               |       ✅       |    1000     |          ✅ false          | drop ALL     |            ✅            | RuntimeDefault |
| `postgres`             |       ✅       |     70      |          ✅ false          | drop ALL     |            ✅            | RuntimeDefault |
| `db-migrate`/`db-seed` |       ✅       |    1000     |          ✅ false          | drop ALL     |            ✅            | RuntimeDefault |

Aucun workload applicatif ne tourne root, n'a de capability Linux, ni ne peut escalader ses
privilèges. Le système de fichiers racine est en lecture seule pour **tous** les workloads, y
compris PostgreSQL et les Jobs `db-tools` — le cas le plus contraignant à faire fonctionner :

- **`postgres`** : écrit sa socket Unix (`.s.PGSQL.5432`) dans `/var/run/postgresql` et des
  fichiers temporaires dans `/tmp`. Deux volumes `emptyDir` explicites sont montés à ces chemins
  ([`k8s/base/postgres.yaml`](../k8s/base/postgres.yaml)) ; les données persistantes restent sur le
  PVC monté sur `/var/lib/postgresql/data`.
- **`db-migrate`/`db-seed`** : `tsx` (utilisé par le script de seed) et `pnpm` peuvent écrire dans
  `$HOME`. `HOME` est forcé à `/tmp`, monté en `emptyDir`
  ([`k8s/base/db-jobs.yaml`](../k8s/base/db-jobs.yaml)).

Validé en conditions réelles : rollout complet de `postgres` (StatefulSet) et exécution de
`db-migrate`/`db-seed` jusqu'à `Completed` avec ces contraintes actives, données de la table
`products` toujours lisibles après coup (persistance non affectée par le passage en lecture seule).

---

## 3. NetworkPolicy

Politique par défaut : tout est refusé, en entrée **et** en sortie
(`default-deny-ingress` / `default-deny-egress`, `podSelector: {}`). Seuls les flux listés
ci-dessous sont explicitement autorisés.

| Flux                                                        | Politique                                                                      | Port(s)    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------- |
| Ingress NGINX → `frontend`                                  | `allow-ingress-to-web`                                                         | 8080       |
| Ingress NGINX → `catalogue`/`orders`                        | `allow-ingress-to-apis`                                                        | 4001, 4002 |
| `orders` → `catalogue`                                      | `allow-ingress-to-apis` (entrée) + `allow-orders-to-catalogue-egress` (sortie) | 4001       |
| `catalogue`/`orders`/`db-migrate`/`db-seed` → `postgres`    | `allow-apps-to-postgres` (entrée) + `allow-apps-to-postgres-egress` (sortie)   | 5432       |
| tous les pods → CoreDNS (`kube-system`)                     | `allow-dns-egress`                                                             | 53 UDP/TCP |
| `monitoring` (Prometheus) → `catalogue`/`orders` `/metrics` | `allow-monitoring-to-apis`                                                     | 4001, 4002 |

`frontend` ne fait aucun appel serveur-à-serveur (fichiers statiques servis par nginx ; les appels
`/api/*` sont faits par le navigateur, hors cluster, via l'Ingress) : aucune règle d'egress
supplémentaire ne lui est accordée.

Manifest : [`k8s/base/networkpolicy.yaml`](../k8s/base/networkpolicy.yaml).

### Tests de flux (conditions réelles)

```bash
# Autorisé : orders -> catalogue:4001
$ kubectl -n microservice-app exec deploy/orders -- wget -qT5 -O- http://catalogue:4001/health/live
{"status":"ok","service":"catalogue"}

# Autorisé : orders -> postgres:5432
$ kubectl -n microservice-app exec deploy/orders -- nc -zv -w5 postgres 5432
postgres (10.244.0.56:5432) open

# DNS : résolution du nom de service depuis orders
$ kubectl -n microservice-app exec deploy/orders -- nslookup catalogue
Name: catalogue.microservice-app.svc.cluster.local
Address: 10.103.47.111
```

### Limite constatée : non-enforcement sur ce cluster de démo

Les objets `NetworkPolicy` sont acceptés par l'API, syntaxiquement valides (`kubeconform`) et
listés (`kubectl get networkpolicy`), mais **non appliqués par le plan de données** sur ce cluster :
minikube utilise par défaut `kindnet`/`bridge` + `kube-proxy`, qui ne relit pas l'API
`NetworkPolicy`. Preuve : un flux qui devrait être refusé (aucune règle ne l'autorise) passe malgré
tout —

```bash
$ kubectl -n microservice-app exec deploy/catalogue -- nc -zv -w5 orders 4002
orders (10.109.189.72:4002) open        # devrait être bloqué (catalogue n'a pas de règle vers orders)

$ kubectl -n microservice-app exec deploy/orders -- nc -zv -w5 1.1.1.1 443
1.1.1.1 (1.1.1.1:443) open              # devrait être bloqué (pas de règle d'egress vers Internet)
```

**Cause** : absence de CNI compatible `NetworkPolicy` (Calico, Cilium, Antrea...) sur ce cluster de
démo. Ce n'est pas un défaut des manifests, mais du plan de données choisi pour la démonstration
locale.

**Recommandation pour un cluster réel** : déployer avec un CNI qui implémente l'API
`NetworkPolicy` — `minikube start --cni=calico`, `kind` avec Calico installé après création, ou un
cluster managé dont le CNI la supporte nativement (GKE, EKS+Calico/Cilium add-on, AKS+Calico/Cilium
add-on). Non fait par défaut dans ce dépôt pour garder l'environnement de démonstration simple et
rapide à démarrer (voir [Limites connues](#limites-connues)).

---

## 4. Chaîne d'approvisionnement (supply chain)

### Scan de vulnérabilités des images

`cd.yml` / `build-and-push` : Trivy scanne chaque image **avant** le push registre, échoue le
pipeline sur toute vulnérabilité `CRITICAL` corrigeable non ignorée explicitement
(`.trivyignore`, actuellement vide). Validé localement (image `catalogue` reconstruite à
l'identique de la CI) :

```bash
$ trivy image --severity CRITICAL --ignore-unfixed --exit-code 1 catalogue:local
Total: 0 (CRITICAL: 0)
# exit code 0
```

### Images de base épinglées

Aucun tag flottant (`latest`, `alpine`, `lts`) dans les Dockerfiles :

| Image de base                         | Tag épinglé                                     |
| ------------------------------------- | ----------------------------------------------- |
| Node.js (build + runtime)             | `node:22.23.1-alpine3.24`                       |
| PostgreSQL                            | `postgres:16.6-alpine3.21`                      |
| nginx (frontend, non-root par défaut) | `nginxinc/nginx-unprivileged:1.29.8-alpine3.23` |

### Interdiction du tag `latest` dans les manifests

Nouveau job CI `manifest-checks` (`ci.yml`, exécuté sur chaque pull request) : recherche toute ligne
`image:`/`newTag:` se terminant par `:latest` dans `k8s/`. Aucune occurrence aujourd'hui ; le job
échoue si une venait à être introduite.

### Scan de secrets

Nouveau job CI `secret-scan` (`ci.yml`, gitleaks, historique complet via `fetch-depth: 0`), exécuté
sur chaque pull request. Validé localement sur l'historique complet du dépôt :

```bash
$ gitleaks detect --source . --redact
7 commits scanned.
no leaks found
```

---

## 5. Rotation des secrets

Le Secret Kubernetes `microservice-app-db` est généré par Kustomize (`secretGenerator`) à partir
d'un fichier `secret.env` non versionné, par overlay (voir
[`docs/ci-cd.md`](ci-cd.md#déploiement-manuel) et [`k8s/README.md`](../k8s/README.md)). Procédure de
rotation du mot de passe PostgreSQL :

```bash
# 1. Changer le mot de passe côté PostgreSQL en premier (le Secret K8s ne le fait pas tout seul :
#    POSTGRES_PASSWORD n'est lu par l'image officielle qu'à l'initialisation d'un PGDATA vide)
kubectl -n microservice-app exec -it postgres-0 -- \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "ALTER USER \"$POSTGRES_USER\" WITH PASSWORD 'nouveau-mot-de-passe';"

# 2. Mettre à jour secret.env (POSTGRES_PASSWORD et DATABASE_URL, même mot de passe) puis réappliquer
#    (le secretGenerator recrée le Secret avec le même nom, disableNameSuffixHash: true)
kubectl apply -k k8s/overlays/<env>

# 3. Redémarrer les pods qui consomment le Secret : les variables d'environnement issues d'un
#    secretKeyRef ne sont pas rechargées à chaud
kubectl -n microservice-app rollout restart deployment/catalogue deployment/orders

# 4. Vérifier qu'aucun pod ne tourne encore avec l'ancien secret monté
kubectl -n microservice-app get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.creationTimestamp}{"\n"}{end}'
```

Fréquence recommandée : au moindre soupçon de fuite (ex. alerte du scanner de secrets sur un commit
passé), et au changement de personnel ayant eu accès à `secret.env` en clair. Aucune automatisation
de rotation périodique n'est mise en place (hors périmètre d'une démo : nécessiterait un
gestionnaire de secrets externe — Vault, External Secrets Operator — voir
[Limites connues](#limites-connues)).

---

## Limites connues

- **NetworkPolicy non appliquée sur le cluster de démo** : voir
  [section dédiée](#limite-constatée--non-enforcement-sur-ce-cluster-de-démo). Les règles sont
  correctes et prêtes pour un CNI compatible.
- **RBAC volontairement vide** : correct pour l'état actuel de l'application (aucun appel à l'API
  Kubernetes). Si un futur workload en avait besoin (ex. un contrôleur maison), il faudrait alors
  un Role namespacé dédié à ce seul workload — jamais un ClusterRole ni `cluster-admin`.
- **Pas de gestionnaire de secrets externe** : les secrets restent des `Secret` Kubernetes
  (encodés base64, pas chiffrés at-rest par défaut sans chiffrement etcd activé côté cluster) generés
  depuis un fichier local non versionné. Suffisant pour la démonstration, insuffisant pour un
  environnement réglementé (préférer Vault, External Secrets Operator, ou le chiffrement etcd natif
  du fournisseur cloud).
- **Pas de remontée SARIF** des résultats Trivy/gitleaks vers l'onglet Security de GitHub (nécessite
  GitHub Advanced Security sur dépôt privé) : les scans bloquent le pipeline mais les résultats
  détaillés ne sont visibles que dans les logs du job, cohérent avec la limite déjà documentée dans
  [`docs/ci-cd.md`](ci-cd.md#limites-connues).
- **`db-migrate`/`db-seed` partagent un ServiceAccount** (`db-jobs`) plutôt que d'en avoir un
  chacun : même image, même périmètre d'accès (aucun), donc aucune isolation supplémentaire à
  gagner d'une séparation.
