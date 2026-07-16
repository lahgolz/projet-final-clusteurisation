# Test de charge et performance

## Périmètre

Ce document couvre le scénario de charge k6, exécuté **dans le cluster** (Job Kubernetes) contre
les Services `catalogue`/`orders`, et l'analyse des résultats mesurés. Vérifié en conditions
réelles sur un cluster **minikube** local (namespace `microservice-app`, overlay `dev` : 1 replica
initial par service, HPA `catalogue` `minReplicas: 1` / `maxReplicas: 3`), le 2026-07-15.

---

## 1. Scénario

Script : [`k8s/load-test/catalogue-orders-load.js`](../k8s/load-test/catalogue-orders-load.js)
(k6). Manifests : [`k8s/load-test/`](../k8s/load-test/) (Job + ConfigMap + NetworkPolicy dédiée,
non inclus dans `k8s/base` — outil de test, pas un composant applicatif).

- **Mix de trafic** : 70 % consultation catalogue (`GET /api/catalogue/products` puis
  `GET /api/catalogue/products/:id` sur un produit aléatoire), 30 % création de commande
  (`POST /api/orders`, qui déclenche en interne un appel `orders` → `catalogue` pour valider le
  prix du produit — voir [`services/orders/src/clients/catalogueClient.ts`](../services/orders/src/clients/catalogueClient.ts)).
- **Profil de charge** : montée progressive → palier → descente (`ramping-vus`), configurable via
  variables d'environnement du Job (`PEAK_VUS`, `RAMP_UP`, `PLATEAU`, `RAMP_DOWN`).
- **Cible** : DNS interne du cluster (`http://catalogue:4001`, `http://orders:4002`) — pas de
  passage par l'Ingress, pour mesurer le comportement des services et de l'HPA sans le bruit du
  port-forward ou du reverse proxy.
- **Exécution** : [`scripts/load-test-k6.sh`](../scripts/load-test-k6.sh) applique les manifests,
  suit les logs k6, et échantillonne toutes les 5 s l'état du HPA, `kubectl top pods`
  (catalogue/orders/postgres) et le nombre de connexions PostgreSQL (`pg_stat_activity`) dans un
  CSV.

```bash
bash scripts/load-test-k6.sh /tmp/k6-load-test-samples.csv
```

---

## 2. Résultats mesurés

Deux exécutions réelles, pour comparer un palier sans réaction de l'HPA et un palier qui déclenche
un scale-up.

### Run A — 30 VUs (30s montée / 90s palier / 30s descente)

| Métrique                     | Valeur mesurée                          |
| ------------------------------ | ------------------------------------------ |
| Débit HTTP                   | 90,2 req/s (13 539 requêtes)              |
| Itérations                   | 53,1/s (7 966 itérations)                 |
| Latence `http_req_duration`  | avg 1,40 ms · p90 5,29 ms · **p95 5,72 ms** · max 92,7 ms |
| Latence catalogue (list+détail) | avg 0,51 ms · p95 0,85 ms               |
| Latence création de commande | avg 5,59 ms · p95 6,82 ms                 |
| Taux d'erreur                | **0,00 %** (0/13 539)                     |
| CPU catalogue (pic)           | 52 % de la requête (52 m / 100 m)          |
| HPA catalogue                | **aucune réaction** (reste à 1 replica)    |
| Connexions PostgreSQL (pic)   | 12                                          |

### Run B — 80 VUs (30s montée / 120s palier / 30s descente)

| Métrique                     | Valeur mesurée                          |
| ------------------------------ | ------------------------------------------ |
| Débit HTTP                   | 250,4 req/s (45 158 requêtes)             |
| Itérations                   | 147,1/s (26 522 itérations)               |
| Latence `http_req_duration`  | avg 1,21 ms · p90 4,69 ms · **p95 5,06 ms** · max 43,8 ms |
| Latence catalogue (list+détail) | avg 0,42 ms · p95 0,68 ms               |
| Latence création de commande | avg 4,93 ms · p95 6,21 ms                 |
| Taux d'erreur                | **0,00 %** (0/45 158)                     |
| CPU catalogue (pic)           | **89 %** de la requête (89 m / 100 m)      |
| HPA catalogue                | **scale-up 1 → 2 replicas**                |
| Connexions PostgreSQL (pic)   | 16                                          |

### Chronologie du scale-up (Run B)

| Heure    | CPU catalogue | Replicas (actuel/désiré) | Événement                                    |
| -------- | -------------- | -------------------------- | ----------------------------------------------- |
| 19:33:10 | 76 %           | 1 / 1                     | Seuil de 70 % dépassé                          |
| 19:34:14 | 89 %           | 1 / 2                     | HPA calcule `desiredReplicas = 2`             |
| 19:34:30 | 89 %           | 2 / 2                     | Second pod `Running`+`Ready`                    |
| 19:35:03 → 19:36:34 | 89 % → 63 % → 2 % | 2 / 2 | Fin du palier, charge retombée, CPU redescend  |
| (non observé, hors fenêtre de mesure) | — | 2 → 1 (attendu) | Stabilisation de descente 5 min (comportement documenté dans [`docs/resilience.md`](resilience.md)) |

Délai observé entre le franchissement du seuil et le pod supplémentaire `Ready` : **~80 s**,
cohérent avec la fenêtre de 15-60 s documentée dans `docs/resilience.md` (l'écart s'explique par la
granularité d'échantillonnage du script, 5 s, et par le nombre de cycles de scrape `metrics-server`
nécessaires pour confirmer un dépassement soutenu).

---

## 3. Analyse du goulot d'étranglement

**Aucune dégradation utilisateur n'a été observée jusqu'à 80 VUs / 250 req/s** : taux d'erreur nul,
p95 stable autour de 5-6 ms, même pendant le scale-up. Le premier phénomène rencontré n'est **pas
une panne mais un déclenchement d'autoscaling** :

1. **Le CPU du pod `catalogue` est la première ressource à approcher sa limite planifiée.** La
   cible HPA (70 % de `requests.cpu: 100m`, soit ~70 m absolus,
   [`k8s/base/hpa.yaml`](../k8s/base/hpa.yaml)) est volontairement basse pour rendre l'autoscaling
   observable en démonstration sans générer une charge massive. En production, ce `requests.cpu`
   devrait être calibré sur un profilage réel plutôt que sur une valeur pédagogique.
2. **PostgreSQL n'a jamais été proche de la saturation** : 16 connexions au pic (contre un
   `max_connections` par défaut de 100), CPU/mémoire du pod `postgres` restés très en dessous de
   ses limites (500 m / 512 Mi). Le pool de connexions applicatif (`DB_POOL_MAX=10` par service,
   [`k8s/base/configmap.yaml`](../k8s/base/configmap.yaml)) n'a pas non plus été un facteur limitant
   à ce niveau de charge.
3. **`orders` n'est pas autoscalé** : seul `catalogue` a un objet `HorizontalPodAutoscaler` dans ce
   dépôt. Le CPU d'`orders` est resté sous sa propre requête (67 m / 100 m au pic) dans ce test à
   dominante lecture (70 % catalogue / 30 % commandes), mais un trafic à dominante écriture
   (création de commandes, qui appelle `catalogue` en interne en plus d'écrire en base) pousserait
   `orders` en premier sans qu'aucun mécanisme d'autoscaling ne le compense actuellement.
4. **Le cluster mono-nœud limite la suite du test.** Au-delà d'environ 80-100 VUs, le CPU partagé
   du nœud minikube devient le facteur confondant : il n'est plus possible de distinguer une
   limite applicative d'une limite d'infrastructure de démonstration. Trouver la charge de rupture
   réelle (dégradation de latence ou erreurs HTTP) nécessite un cluster multi-nœuds avec plus de
   capacité CPU dédiée.

---

## 4. Recommandations

| Constat                                                    | Action proposée                                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Cible HPA basée sur une `requests.cpu` très faible (100 m)   | Reprofiler `catalogue`/`orders` sous charge représentative de production avant de fixer `requests.cpu` |
| `orders` non autoscalé                                       | Ajouter un second `HorizontalPodAutoscaler` sur `orders`, surtout si le trafic devient plus écriture-intensif |
| Scaling basé uniquement sur le CPU                           | Envisager une métrique custom (p95 de latence via Prometheus Adapter) pour aligner le scaling sur l'expérience utilisateur plutôt que sur la seule consommation CPU |
| Charge de rupture non atteinte sur ce cluster de démonstration | Rejouer `scripts/load-test-k6.sh` avec un `PEAK_VUS` plus élevé (150-300) sur un cluster multi-nœuds pour identifier la vraie limite de débit/latence |
| Aucune alerte sur la latence agrégée                          | Une règle Prometheus sur `http_request_duration_seconds` (p95) compléterait `HighHttp5xxRate` déjà présente ([`k8s/observability/alerts.yaml`](../k8s/observability/alerts.yaml)) pour détecter une dégradation de latence sans erreurs HTTP |

---

## 5. Reproduire le test

```bash
# Ajuster l'intensité si besoin (k8s/load-test/job.yaml : PEAK_VUS, RAMP_UP, PLATEAU, RAMP_DOWN)
bash scripts/load-test-k6.sh /tmp/k6-load-test-samples.csv

# Observer en parallèle, dans un autre terminal
kubectl -n microservice-app get hpa catalogue -w
kubectl -n microservice-app top pods
```

Le script nettoie le Job k6 à la fin (`ttlSecondsAfterFinished` sert de filet de sécurité en cas
d'interruption) ; le ConfigMap et les NetworkPolicy dédiées restent en place pour une prochaine
exécution.

## Limites connues

- Test exécuté depuis l'intérieur du cluster (DNS de Service) : ne mesure pas la latence ajoutée
  par l'Ingress NGINX ni par un accès externe réel.
- Un seul produit catalogue par requête de commande (`quantity: 1`) : ne représente pas des paniers
  multi-articles, qui augmenteraient le nombre d'appels internes `orders` → `catalogue` par
  commande.
- Mesures CPU/mémoire échantillonnées toutes les 5 s (`kubectl top`) : granularité suffisante pour
  observer une tendance, pas pour capturer un pic transitoire de quelques secondes.
