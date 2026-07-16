# Test de charge et performance

Ce document couvre le scénario de charge k6, exécuté **dans le cluster** (Job Kubernetes) contre
les Services `catalogue`/`orders`, et l'analyse des résultats. Mesuré sur un cluster **minikube**
local (namespace `microservice-app`, overlay `dev` : 1 replica initial par service, HPA
`catalogue` de 1 à 3 replicas).

## Le scénario

Script : [`k8s/load-test/catalogue-orders-load.js`](../k8s/load-test/catalogue-orders-load.js)
(k6). Manifests : [`k8s/load-test/`](../k8s/load-test/) (Job + ConfigMap + NetworkPolicy dédiée,
séparé de `k8s/base` puisque c'est un outil de test, pas un composant applicatif).

- **Mix de trafic** : 70 % consultation catalogue (liste + détail d'un produit aléatoire), 30 %
  création de commande (qui déclenche en interne un appel `orders -> catalogue` pour valider le
  prix).
- **Profil de charge** : montée progressive -> palier -> descente, configurable via variables
  d'environnement du Job (`PEAK_VUS`, `RAMP_UP`, `PLATEAU`, `RAMP_DOWN`).
- **Cible** : DNS interne du cluster (`http://catalogue:4001`, `http://orders:4002`), sans passer
  par l'Ingress, pour mesurer le comportement des services et de l'HPA sans le bruit du
  port-forward ou du reverse proxy.

```bash
bash scripts/load-test-k6.sh /tmp/k6-load-test-samples.csv
```

Le script applique les manifests, suit les logs k6, et échantillonne toutes les 5s l'état du HPA,
`kubectl top pods` et le nombre de connexions PostgreSQL dans un CSV.

## Résultats mesurés

Deux runs, pour comparer un palier qui ne déclenche pas l'HPA et un palier qui le fait scaler.

### Run A : 30 VUs (30s montée / 90s palier / 30s descente)

| Métrique                    | Valeur mesurée                                            |
| --------------------------- | --------------------------------------------------------- |
| Débit HTTP                  | 90,2 req/s (13 539 requêtes)                              |
| Latence `http_req_duration` | avg 1,40 ms · p90 5,29 ms · **p95 5,72 ms** · max 92,7 ms |
| Taux d'erreur               | **0,00 %** (0/13 539)                                     |
| CPU catalogue (pic)         | 52 % de la requête (52 m / 100 m)                         |
| HPA catalogue               | aucune réaction (reste à 1 replica)                       |
| Connexions PostgreSQL (pic) | 12                                                        |

### Run B : 80 VUs (30s montée / 120s palier / 30s descente)

| Métrique                    | Valeur mesurée                                            |
| --------------------------- | --------------------------------------------------------- |
| Débit HTTP                  | 250,4 req/s (45 158 requêtes)                             |
| Latence `http_req_duration` | avg 1,21 ms · p90 4,69 ms · **p95 5,06 ms** · max 43,8 ms |
| Taux d'erreur               | **0,00 %** (0/45 158)                                     |
| CPU catalogue (pic)         | **89 %** de la requête (89 m / 100 m)                     |
| HPA catalogue               | **scale-up de 1 à 2 replicas**                            |
| Connexions PostgreSQL (pic) | 16                                                        |

Sur le run B, le seuil de 70 % CPU a été franchi à 19:33:10 (76 %), l'HPA a demandé un second
replica à 19:34:14 (89 %, `desiredReplicas=2`), et celui-ci était `Running`+`Ready` à 19:34:30 -
soit environ **80s** entre le franchissement du seuil et le pod supplémentaire prêt, cohérent avec
la fenêtre de 15-60s documentée dans [`docs/resilience.md`](./resilience.md).

## Ce qu'on en tire

**Aucune dégradation utilisateur jusqu'à 80 VUs / 250 req/s** : taux d'erreur nul, p95 stable
autour de 5-6 ms, même pendant le scale-up. Le premier phénomène rencontré n'est pas une panne
mais un déclenchement d'autoscaling normal.

- Le CPU de `catalogue` est la première ressource à approcher sa limite. La cible HPA (70 % de
  100m, soit ~70m absolus) est volontairement basse pour rendre l'autoscaling observable sans
  charge massive - en production, ce `requests.cpu` devrait venir d'un vrai profilage plutôt que
  d'une valeur pédagogique.
- PostgreSQL n'a jamais été proche de la saturation (16 connexions au pic contre un
  `max_connections` par défaut de 100).
- `orders` n'a pas d'HPA : seul `catalogue` en a un dans ce dépôt. Il est resté sous sa requête CPU
  dans ce test à dominante lecture, mais un trafic plus orienté écriture (création de commandes)
  le pousserait en premier sans qu'aucun autoscaling ne compense.
- Le cluster mono-nœud limite la suite du test : au-delà de 80-100 VUs, le CPU partagé du nœud
  devient le facteur confondant, impossible de distinguer une limite applicative d'une limite
  d'infra de démo. Trouver la vraie charge de rupture demanderait un cluster multi-nœuds.

## Recommandations

| Constat                                                    | Action proposée                                                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cible HPA basée sur une `requests.cpu` très faible (100 m) | Reprofiler `catalogue`/`orders` sous charge représentative de production                                                                                                                   |
| `orders` non autoscalé                                     | Ajouter un second HPA sur `orders`, surtout si le trafic devient plus écriture-intensif                                                                                                    |
| Scaling basé uniquement sur le CPU                         | Envisager une métrique custom (p95 de latence via Prometheus Adapter) pour aligner le scaling sur l'expérience utilisateur                                                                 |
| Charge de rupture non atteinte sur ce cluster              | Rejouer le test avec un `PEAK_VUS` plus élevé (150-300) sur un cluster multi-nœuds                                                                                                         |
| Aucune alerte sur la latence agrégée                       | Une règle Prometheus sur le p95 de `http_request_duration_seconds` compléterait `HighHttp5xxRate` (déjà présente dans [`k8s/observability/alerts.yaml`](../k8s/observability/alerts.yaml)) |

## Reproduire le test

```bash
# Ajuster l'intensité si besoin (k8s/load-test/job.yaml : PEAK_VUS, RAMP_UP, PLATEAU, RAMP_DOWN)
bash scripts/load-test-k6.sh /tmp/k6-load-test-samples.csv

# Observer en parallèle, dans un autre terminal
kubectl -n microservice-app get hpa catalogue -w
kubectl -n microservice-app top pods
```

Le script nettoie le Job k6 à la fin ; le ConfigMap et les NetworkPolicy restent en place pour la
prochaine exécution.

## Limites connues

- Test lancé depuis l'intérieur du cluster : ne mesure pas la latence ajoutée par l'Ingress ni un
  accès externe réel.
- Un seul produit par commande (`quantity: 1`) : ne représente pas des paniers multi-articles.
- Mesures CPU/mémoire échantillonnées toutes les 5s (`kubectl top`) : suffisant pour une tendance,
  pas pour capturer un pic transitoire de quelques secondes.
