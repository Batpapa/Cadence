# Campagne v3 — journal de bord (2026-09-13, nuit)

**Ce fichier est le point de reprise.** Tenu à jour au fil de la nuit, pour
qu'une session relancée après une coupure reprenne sans rien refaire. Le plus
récent est en bas de la section « Journal ».

## SYNTHÈSE — état à 06:47 (heure `date`)

**Établi**
0. **RÉSULTAT PRINCIPAL — les choix MOTEUR + plancher d'absence se généralisent hors
   échantillon (09:09).** Validation une-session-dehors sur 220 candidats (10 bras × 22
   configurations d'E5/E6), sélection par rappel − λ·fp sur 6 sessions, mesure sur la 7e :
   **λ = 0,5 → 317,3 / 13,8 contre production 311 / 20 (+6,3 morceaux, −6,2 fp)** ; λ = 1 →
   311,9 / 12,9 ; λ = 2 → 309,8 / 12,2. Score − production : +9,4 / +8,0 / +14,3. Choix stable :
   **t200 + L20 + a = 0,8 retenu dans 5 plis sur 7 à λ = 0,5**. C'est l'inverse du recuit sur
   la chaîne aval (point 1), qui ne battait pas la production hors échantillon au λ bas.
   **Étendu à l'IoU (09:20)** : sélection par rappel − λ·fp + κ·IoU (points) sur 6 sessions →
   **κ = 0,5, λ = 0,5 : 318,0 / 12,5, IoU 88,2 % hors échantillon** contre production
   311 / 20, 79,5 % (**+7 morceaux, −7,5 fp, +8,7 points d'IoU**) ; le choix est alors
   **t180 + rep4000 + L20 + a = 0,8** dans presque tous les plis.
1. **Le post-traitement est saturé.** Plafond de rappel des listes de candidats : 329
   (≥ 2 rangs 1 : 323) contre 312 en production. Recuit (5 020 évaluations, budget égal)
   validé hors échantillon (une session dehors, deux règles de sélection) : **au λ bas,
   rien ne bat la production** ; seul gain généralisable = échange vers moins de fp.
2. **Le moteur est le goulot.** Polkas 68 % de rappel contre 96 % en reel (p = 1e-3),
   déficit déjà présent dans les listes de candidats.
3. **Le sélecteur de tempo de FolkFriend surestime** (biais de résolution de grille,
   H6). Expérience naturelle : quand il peut aller plus vite, le rang du bon morceau
   empire 97 fois contre 20 (p ≈ 1e-13). **Plafonner le tempo à 180-200 : +59 à +70 rangs
   1 nets** sur le corpus complet (p ~ 1e-8), dose-réponse monotone (E2).
4. **Contrepartie et remède** : un tempo plus lent raccourcit les contours du bruit
   (quartile bas 37 → 12 symboles) et gonfle ses faux alignements. **Une porte sur la
   longueur du contour (L = 20) supprime cette contrepartie sans toucher la musique**
   (0 rang 1 perdu) ; sur le témoin elle retire déjà 1-2 fp sans perte de rappel (E4).
5. **Plancher d'absence (post-traitement) : optimum temporel a = 0,75 → 314/18
   (+3 morceaux, −2 fp), IoU 79,5 → 85,0 % (+5,5 points), erreur de fin p90 43 → 18 s.**
   ⚠️ CORRIGÉ à 06:51 : la hausse de « couverture » à a ≥ 0,9 (jusqu'à 93,5 %) est un
   **DÉBORDEMENT** — erreur de début p90 76-88 s, IoU retombée à 80,7 %. La couverture
   seule était trompeuse ; **toujours juger le recouvrement à l'IoU + erreurs de bornes**.
6. **Présélection 4 000 réglages au lieu de 2 000 : +58 rangs 1 nets (65 gagnés / 7
   perdus, p = 7e-13), +74 en top 10, bruit inchangé (0,1151 → 0,1168)** — gain quasi
   gratuit, au coût de calcul près (requête ×1,5 mesuré). 8 000 en crible.
7. **Combinaison tempo 180 + présélection 4 000 + porte L=20 = meilleur candidat moteur** :
   **+105 rangs 1 nets (153 / 48, p = 6e-14)**, +110 en top 10 ; rang 1 73,3 → 76,2 % ;
   polka 36,4 → 45,7 % (top 10 47,8 → 60,3 %) ; morceaux sans rang 1 18 → 13 ; la porte ne
   touche aucune fenêtre de musique et ramène le bruit top 1 à 0,071 (témoin 0,115).
   Sous-additif (70 + 58 = 128 attendu, 105 obtenu). À juger sur la chaîne complète.
8. **E5 — CHAÎNE COMPLÈTE (07:09)** : **tempo 200 + porte L20 + plancher d'absence a = 0,8
   → 319 / 13, IoU 87,0 %, erreur de début p90 14 s, de fin p90 17 s**, contre la production
   actuelle 311 / 20, IoU 79,5 %, 25 s / 43 s : **+8 morceaux, −7 fp, +7,5 points d'IoU**.
   Part du moteur seul (même post-traitement a = 0,8, porte L20 des deux côtés) : +4
   morceaux, −3 fp, +0,5 point d'IoU ; t180 + L20 : 318 / 13, IoU 87,6 %.
9. **E6 (09:06) — présélection 4 000 sur la chaîne complète** : à a = 0,8, **t180 + rep4000 +
   L20 → 318 / 12, IoU 88,2 %, bornes p90 14 s / 15 s** = meilleur bras à ce jour en fp, IoU et
   bornes (contre production 311 / 20, 79,5 %, 25 / 43 s : **+7 morceaux, −8 fp, +8,7 points
   d'IoU**). rep4000 seul + L20 : 316 / 14, 87,5 %. Crible **présélection 8 000 : +85 rangs 1
   nets (100/15, p = 1e-16), bruit inchangé** → régénérations complètes t200 + rep8000 et
   t180 + rep8000 lancées à 09:07.

**Réfuté** : élargir la plage de tempo (E1, sans effet) ; H4 écrêtage ; attracteurs
appris sur la fixture de bruit (H2) ; porte en proportion des rangs 1 (inerte) ; notes
≥ 2 trames (E3, −41 rangs 1, bruit catastrophique) ; seuil d'octave 0,50 (sans effet).

**En cours à 06:47** : régénération complète des bornes 180 et 200 → **E5** (chaîne
complète avec porte L=20, configurations figées + balayage du plancher, rappel / fp /
**couverture**) via `v3/e5-run.sh` ; H6 (pentes du modèle de tempo) ; E3 présélection
4 000, notes ≥ 4 trames, puissance 0,15.

**Non commité, à signaler** : setters ajoutés à `folkfriend-src/rust` (tempo, filtre de
notes, modèle de tempo, présélection), comportement par défaut contrôlé identique au
bit ; originaux dans `v3/ff-backup/`. Rien dans `Cadence/src/`.

## Mandat (donné par l'utilisateur le 2026-09-13 vers 05:00)

- Repartir **frais** : historique `.out/` et `.out-6sessions/` **supprimés** (fait, 05:11).
- Recuit simulé sur l'espace joint, **limite 30 000 évaluations**.
- Donner une estimation du temps restant au bout de 500 points.
- Puis **autonomie ~7 h** : analyse, couverture, optimisation sur le plateau,
  tests supplémentaires, jusqu'à toucher au WASM FolkFriend si justifié.
- Invariant : la philosophie reste **FolkFriend (custom) → traitement → Viterbi → traitement**.
- Ne pas commiter (l'utilisateur gère git). Rien dans `src/` sans raison forte.

## Plan de recherche

1. **Campagne équitable** (en cours) : 10 transformations × filtre plat on/off ×
   6 λ = 120 chaînes × 200 pas = **24 000 évaluations**, budget égal par groupe.
   Réserve de **6 000** pour l'affinage ciblé.
2. **Plafond de rappel** (fait, voir Résultats) : ce que le post-traitement peut
   atteindre au mieux.
3. **Analyse** : front de Pareto, meilleur rappel par groupe à budget de fp égal,
   **validation croisée une-session-dehors** (LOSO) pour mesurer l'optimisme de
   sélection, diagnostic de convergence du recuit.
4. **Affinage** sur le plateau des groupes qui gagnent hors échantillon (réserve).
5. **Robustesse** : choisir un point au centre d'un plateau plutôt qu'un pic
   (voisinage perturbé, résultat stable).
6. Si le plafond de rappel devient le goulot : piste WASM (9 morceaux jamais
   dans le top 10), régénération via `experiments/noise-study/regenerate-fixtures.js`
   (audio présent dans `test-fixtures/audio/`, ~1 h de calcul).

## Lancement exact de la campagne

Depuis `Cadence/`, 6 processus (la machine est un i7-13700H : **6 cœurs P** +
8 E ; le plafond de débit à 6 processus mesuré les nuits précédentes correspond
très probablement à ça, pas à la bande passante mémoire — hypothèse non vérifiée) :

```bash
for s in 0 1 2 3 4 5; do
  ANNEAL_STEPS=200 ANNEAL_ROUND=10 ANNEAL_SHARDS=6 ANNEAL_SHARD=$s SEARCH_SEED=11 \
  npx vitest run --config vitest.ranking.config.ts experiments/ranking-study/anneal.test.ts \
    > <logdir>/anneal-$s.log 2>&1 &
done; wait
```

Lancée à **05:11:40 heure locale** (03:11:40 UTC).

## Données générées — où elles sont

| quoi | où |
|---|---|
| évaluations de la campagne | `.out/search-seed11-anneal0{0..5}.json` (gitignoré, sur disque) |
| une évaluation | `transform, flat, floorQ, floor, minSeg, confirm, weights, found, total, fp, noise, coverage, lambda, chain, step, temp, accepted, per` |
| `per` | `[found, total, fp]` par session, dans l'ordre de `SESSIONS` : Korea, Anglade, tabac, auberge, OneBest, 13thMoon, AudioF |
| référence production par session | `v3/prod.json` → `31/0 35/4 21/5 29/0 25/0 36/1 135/10` = **312/341, fp 20, bruit 0** |

Chaque shard réécrit son fichier toutes les 20 évaluations et à chaque fin de
ronde : **tuer les processus ne perd rien**. Les chaînes avancent par rondes
entrelacées de 10 pas, donc une campagne interrompue reste une comparaison à
budget égal.

**Reprendre une campagne interrompue n'est PAS implémenté** : relancer repartirait
de zéro et écraserait les fichiers de la graine 11. Pour compléter, lancer une
autre graine (`SEARCH_SEED=12`) et fusionner les deux — `v3/analyze.js` lit
`search-seed11-*` ; élargir le filtre si besoin.

## Outils (tous dans ce dossier)

| outil | rôle |
|---|---|
| `anneal.test.ts` | recuit v3 (par session, rondes entrelacées, bornes élargies : chg≤3, autres≤2, floorQ≤0,60, λ ∈ {0.1,0.25,0.5,1,2,4}) |
| `evalset.test.ts` | rejoue une liste de configurations JSON, résultats par session (`EVAL_IN=… EVAL_OUT=…`) |
| `ceiling.test.ts` | plafond de rappel des listes de candidats (`CEILING=1`, `CEILING=v` verbeux) |
| `anatomy.test.ts` | faux positifs et manqués un par un pour une configuration (`ANATOMY=v3/prod.json ANATOMY_INDEX=0`) ; sortie production dans `v3/anatomy-prod.txt` |
| `v3/analyze.js` | `node v3/analyze.js [fichiers de rejeu…]`, `MODE=front|groups|loso|sa` |
| `v3/count.js` | nombre d'évaluations écrites par shard |

## Résultats partiels

### Plafond de rappel (05:15) — `ceiling.test.ts`

Fenêtre comptée pour un morceau si son centre tombe dans la plage annotée.

| session | n | top10 | top1 | top1 ×2 consécutifs |
|---|---|---|---|---|
| Korea | 31 | 31 | 31 | 31 |
| Anglade | 36 | 36 | 35 | 35 |
| tabac | 27 | 24 | 24 | 24 |
| auberge | 30 | 30 | 30 | 30 |
| OneBest | 26 | 25 | 25 | 25 |
| 13th Moon | 42 | 40 | 40 | 38 |
| Audio F | 149 | 146 | 144 | 137 |
| **total** | **341** | **332** | **329** | **320** |

Production : 312. **Le post-traitement ne peut gagner au mieux que 17 morceaux
(329), ~8 à la forme « deux rangs 1 consécutifs ».** Le terrain de la campagne
est donc surtout les faux positifs. Les 9 jamais dans le top 10 : tabac 1535,
2191, 739 ; OneBest 6319 (2 fenêtres seulement) ; 13th Moon 9366, 5478 ;
Audio F 1534, 265, 3544 — seul levier pour eux : le moteur.

## Journal

- **05:11** historique supprimé ; essai à blanc OK ; campagne lancée.
- **05:13** production rejouée : 312/341 fp 20, identique à la référence connue.
- **05:15** plafond de rappel mesuré (ci-dessus).
- **05:17** 360 évaluations. Journal créé.
- **05:20** débit propre mesuré : 480 → 720 évaluations en 145 s = **1,66 éval/s**.
  Reste 23 280 → **~3 h 55, fin estimée ~09:15 locale**.
- **05:21** demande utilisateur : tester « rang 1 sur N fenêtres, pas forcément
  consécutives, dans une même détection Viterbi ». **Constat : c'est DÉJÀ la règle
  de production** — `countTop1Windows` (`src/session/recognition/viterbiDetector.ts`)
  compte les rangs 1 n'importe où dans le segment ; `minSeg` de la campagne EST ce N.
  Non exploré par la campagne, donc à faire en affinage (réserve) :
  (a) N ≥ 3, exclu jusqu'ici à la demande de l'utilisateur ;
  (b) variante en proportion : rangs 1 ≥ p × fenêtres du segment ;
  (c) éventuellement compter « rang ≤ 2 ». Le plafond « top1 ×2 consécutifs »
  ci-dessus est plus strict que la règle réelle → remesuré en non consécutif.
- **05:24** plafond remesuré à la forme réelle de la porte (rangs 1 comptés dans
  la plage annotée, non consécutifs) : **≥1 → 329, ≥2 → 323, ≥3 → 318**
  (consécutifs ×2 : 320). Production 312 avec N=2 : **11 morceaux de marge au
  plus à N=2**, 17 à N≤1. Par session, les pertes ≥2 vs ≥1 : 13th Moon −1, Audio F −5.
  Audio F est la seule session où N pèse vraiment.
- **05:28** porte en proportion ajoutée au harnais (rien dans `src/`) :
  `decode(..., confirm, topFrac)` exige max(N, ⌈topFrac × fenêtres du segment⌉)
  rangs 1, via deux appels à `filterShortSegments` de production (par segment,
  puis à 0 pour fusionner les UNKNOWN voisins). `evalset` accepte `topFrac`.
  Sonde : `v3/probe-gate.json` (production, contrôle d'identité à 1e-9, N=3, p ∈ 0,1..0,5).
  ⚠️ la campagne en cours tourne sur l'ANCIEN `pipeline.ts` chargé au lancement :
  sans effet sur elle (topFrac=0 = chemin inchangé de toute façon).
- **05:30** sonde de la porte, sur la configuration de production (identity, plat on, 0,20) :

  | porte | rappel | fp | par session (trouvés/fp) |
  |---|---|---|---|
  | production N=2 | 312 | 20 | 31/0 35/4 21/5 29/0 25/0 36/1 135/10 |
  | N=2, topFrac=1e-9 | 312 | 20 | **identique au bit** → chemin segment par segment validé |
  | N=3 | 287 | 6 | 30/0 34/0 18/0 27/0 24/0 30/0 124/6 |
  | N=1, p=0,1 / 0,2 / 0,3 | 317 | 118 | les trois **identiques** |
  | N=2, p=0,2 / 0,3 | 312 | 20 | identiques à la production |
  | N=2, p=0,5 | 312 | 19 | −1 fp (Audio F) |

  **Lecture : la porte en proportion est quasi inerte.** Les faux positifs qu'elle
  filtre sont des segments de ≤3 fenêtres (⌈p×fenêtres⌉ y vaut 1) : toute la
  puissance de la porte est dans le N absolu, c.-à-d. c'est un filtre de segments
  COURTS. N=1 → N=2 : −98 fp pour −5 morceaux ; N=2 → N=3 : −14 fp pour −25
  morceaux. À réévaluer sur les configurations du front (autre transformation,
  autres poids), mais la piste (b) est à faible espérance.
- **05:35** anatomie de la production (`v3/anatomy-prod.txt`, 6 000-éval réveil armé) :
  - **FP : 24 segments** (20 ids). **14 pendant un morceau annoté** = confusions
    d'identité (dont 5 *remplacements* : 4598→3382, 1535→3206, 250→249 « road to
    lisdoonvarna » = réglage voisin, 8516→19397+3115, 1113→2044 ; le reste = courtes
    intrusions de 2-3 fenêtres dans un morceau trouvé). **10 hors annotation**, dont
    **5 fois le même 2265** (« out the door and over the wall ») en fin d'Audio F,
    4:20→5:26 — suspect : morceau réellement joué mais non annoté, ou motif récurrent.
  - **Manqués : 29.** 9 jamais dans le top 10 (moteur). **7 ont 5-6 rangs 1 et sont
    pourtant manqués** : 931, 5654, 966 (tabac), 9412 (auberge, remplacé par 1082),
    2828 (13th Moon, 6 rangs 1 / 19 fen.), 1669, 1310 (Audio F). Signature commune :
    rangs 1 **éparpillés**, entrecoupés de fenêtres où le morceau est ABSENT du top 10.
  - **Hypothèse H1 (à vérifier)** : une fenêtre d'absence coûte bien plus à Viterbi
    (observation 0 → plancher) qu'un rang 1 ne rapporte, donc une preuve intermittente
    est écrasée par UNKNOWN. Levier dans la philosophie : un **traitement pré-Viterbi
    de maintien temporel** (une observation persiste, atténuée, sur ±k fenêtres), ou
    un plancher d'absence moins punitif. La campagne n'explore NI l'un NI l'autre.
- **05:40** H1 confirmée à l'arithmétique : `epsilon = 1e-6` → absent = log(1e-6) =
  **−13,8** ; UNKNOWN = log(0,20) = −1,6 ; rang 1 à 0,30 = −1,2. **Une absence coûte
  12,2 nats, un rang 1 en rapporte 0,4** → Viterbi sort vers UNKNOWN (aller-retour
  1,0), le segment se fragmente, N=2 tue les fragments. `.empty` n'est lu par aucun
  décodeur. Deux remèdes ajoutés au harnais (rien dans `src/`) :
  (A) `decode(..., topFrac, absentRatio)` : absent = log(absentRatio × plancher UNKNOWN),
  via le crochet de production `observationScoreFn` ; 0 = production.
  (B) `buildTimeline(..., { hold: { k, decay } })` : max de l'observation sur ±k
  fenêtres atténuée par decay^d ; candidats ajoutés APRÈS le top 10 (rang > 10, donc
  la porte des rangs 1 ne compte toujours que ce que FolkFriend a classé premier).
  `evalset` accepte `absentRatio` et `hold`.
- **05:45** sonde H1 (`v3/probe-h1.json`), à la configuration de production :

  | variante | rappel | fp | par session |
  |---|---|---|---|
  | production | 312 | 20 | 31/0 35/4 21/5 29/0 25/0 36/1 135/10 |
  | hold k=0 | 312 | 20 | identique au bit (contrôle) |
  | absent 0,02 / 0,1 / 0,25 | 312 | 20 | identiques à la production |
  | absent 0,5 | 312 | 20 | 31/0 35/4 22/5 29/1 25/0 36/1 134/9 |
  | **absent 0,75** | **314** | **18** | 31/0 35/4 23/5 30/1 25/0 36/1 134/7 — **domine strictement** |
  | absent 0,25 / 0,5 + N=3 | 287 / 292 | 6 / 6 | |
  | hold k1 d0,7 | 319 | 145 | |
  | hold k1 d0,9 | 319 | 177 | |
  | hold k2 d0,8 | 320 | 142 | |
  | hold k2 d0,8 + N=3 | 319 | 136 | |
  | hold k3 d0,85 | 317 | 135 | |

  **Lecture.** Le plancher d'absence n'agit qu'au-delà de a ≈ 0,37, là où −log(a)
  passe sous le coût d'aller-retour UNKNOWN (0,5 + 0,5) : c'est le mécanisme de H1,
  confirmé par son seuil. Mais l'amplitude est faible au plancher de production :
  H1 est vraie, pas le seul verrou (les rangs 1 à score < 0,20 sont une preuve
  CONTRE le morceau, indépendamment de l'absence). Le maintien temporel atteint
  320/323 de rappel mais ouvre ~140 fp, que N=3 n'arrête pas : inutilisable seul,
  à chercher conjointement avec le plancher. **Décision : les deux dimensions vont
  dans la réserve, en recherche conjointe** (`ANNEAL_ABSENT=1`, `ANNEAL_HOLDS=…`).
- **05:50** plancher d'absence sur des configurations non-identity
  (`v3/probe-absent-transforms.json` ; points repris de `breakdown.test.ts`, poids
  arrondis à 2 décimales, donc pas exactement les chiffres v2 — simple sonde
  d'interaction, aucune conclusion v2 réutilisée) :

  | configuration | a=0 | a=0,5 | a=0,75 | a=0,9 | a=0,95 |
  |---|---|---|---|---|---|
  | share 0,1101 N2 | 312/17 | 312/17 | 313/17 | 313/18 | |
  | nullRatioTailMean 1,0197 N0 | 305/10 | 306/10 | 311/15 | 314/15 (bruit 1) | |
  | share 0,0959 N2 | 294/3 | | 302/4 | 305/7 | |
  | production | 312/20 | 312/20 | 314/18 | 314/17 | **312/15** |

  **Le plancher d'absence déplace les points le long des courbes**, et le long
  d'un meilleur front : share 294/3 → 302/4 (+8 morceaux pour +1 fp) ; production
  −5 fp à rappel égal. Gains portés surtout par Audio F et tabac. **Dimension de
  front réelle → réserve.** Recuit étendu en conséquence (`ANNEAL_ABSENT`,
  `ANNEAL_HOLDS`, désactivés par défaut sans consommer d'aléa).
- **05:55** validation du code modifié :
  - **rejeu au bit** des 20 premières évaluations du shard 0 de la graine 11
    (`ANNEAL_STEPS=200 ANNEAL_ROUND=10 ANNEAL_SHARDS=6 ANNEAL_SHARD=0
    ANNEAL_MAX_EVALS=20 ANNEAL_TAG=check`) : **0 différence** sur tous les champs
    (floor, poids, found, fp, noise, coverage, per, temp, accepted…). Le recuit
    étendu, la porte en proportion, le plancher d'absence et le maintien temporel
    sont donc neutres quand ils sont désactivés.
  - essai à blanc étendu (`ANNEAL_ABSENT=1 ANNEAL_HOLDS=0:1,2:0.8`, graine 998) :
    tourne, écrit `absentRatio` et `hold`.
  - fichiers de vérification supprimés ; `v3/count.js` et `v3/analyze.js` ignorent
    de toute façon les suffixes `-check` / `-dry`.
  - Nouveaux réglages du recuit : `ANNEAL_TAG` (suffixe de fichier),
    `ANNEAL_MAX_EVALS` (arrêt anticipé pour rejeu).
  - ⚠️ mes rejeux ralentissent la campagne (20 évaluations = 117 s en contention) :
    le débit mesuré à 1,66 éval/s est celui de la campagne SEULE.
- **06:00** les 10 FP « hors annotation » de la production, confrontés aux CSV :
  **tous tombent dans un blanc ENTRE DEUX SETS**, jamais dans un trou d'annotation
  au milieu de la musique.
  - Anglade 108 / 243 / 22257 : blancs 10:20→11:58, 17:42→20:47, 35:55→37:27.
  - tabac 1335 / 2232 : blancs 2:03→4:12, 13:20→14:29.
  - **Audio F, 2265 « out the door and over the wall » ×5** : blancs de 25-45 s
    4:20:20→4:21:04, 4:50:39→4:51:05, 4:57:18→4:57:47, 5:22:29→5:24:04, et après
    la fin du dernier morceau (5:25:36). Même morceau, toujours dans une transition
    (applaudissements / paroles / accordage probables) → **attracteur de bruit**.
  - Tous courts (2-3 fenêtres, 1-2 rangs 1).
  **Hypothèse H2** : certains morceaux de l'index sont des attracteurs de bruit
  (contour que le bruit imite). Si ceux qui s'allument dans les blancs des sessions
  sont AUSSI ceux qui s'allument sur la fixture de bruit pur (enregistrement
  indépendant, sans vérité terrain), une pénalité par morceau apprise sur le bruit
  est **hors échantillon par construction**. Mesure : `v3/attractors.js`.
- **06:05** H2 mesurée (`v3/attractors-out.txt`) — **réfutée sous sa forme « bruit pur »** :
  - la fixture de bruit n'a AUCUN attracteur : 338 fenêtres, **323 morceaux distincts**
    au rang 1 (quasi aléatoire) ; ses « attracteurs » (T≥2) couvrent 0,1 % des rangs 1
    des blancs. Bruit de bar ≠ bruit de transition de session.
  - les blancs des sessions sont au contraire **très concentrés et reproductibles
    d'une session à l'autre** : 19481 « michael's lament » 121 fenêtres (5 sessions),
    **2265 111 (4 sessions)**, 6058 « romanian fantasy » 105 (4), 9236 32, 13978 27…
    sur 1 480 fenêtres de blanc et 785 morceaux.
  - Un a priori appris sur les blancs des SESSIONS serait validable en LOSO (les
    attracteurs reviennent dans 4-5 sessions), mais **son gain métrique est minime** :
    les 5 fantômes 2265 comptent pour **1 seul fp** (`fp` = ids distincts). Angle mort
    de la métrique, réel pour l'utilisateur (5 clics). **Dépriorisé** ; `misplaced`
    (compte par segment) ajouté en 4e colonne de `per` pour la réserve.
- **06:12** les 9 jamais-top-10 face à l'index FolkFriend (cache
  `experiments/noise-study/.cache/tune-index.json`, 55 084 réglages, 23 223 morceaux,
  médiane 1 réglage/morceau, contour médian 193) : **tous présents, 2 à 12 réglages**
  → pas un problème d'index. Motif : **4/9 sont des polkas 2/4** (1535, 6319, 1534,
  265 ; contours ~128, les plus courts), 5478 reel à contours 128. Les témoins
  trouvés sont jigs / slip jigs / reels à contours 144-383. **Hypothèse H3** : les
  contours courts sont désavantagés par le moteur (normalisation de l'alignement
  sur une fenêtre de 10 s ?) — si elle tient, argument pour toucher au WASM.
  Mesure : rappel et plafond par type de danse, `v3/dance.js`.
- **06:15** **H3 confirmée** (`v3/dance-out.txt`) :

  | type | n | trouvés (production) | dans le top 10 au moins une fois |
  |---|---|---|---|
  | reel | 177 | 170 (96 %) | 174 (98 %) |
  | jig | 85 | 76 (89 %) | 83 (98 %) |
  | slip jig | 23 | 22 (96 %) | 23 (100 %) |
  | **polka** | **22** | **15 (68 %)** | **18 (82 %)** |
  | hornpipe | 18 | 16 (89 %) | 18 (100 %) |

  | contour médian du morceau | n | trouvés | top 10 |
  |---|---|---|---|
  | ≤ 130 | 46 | 36 (78 %) | 41 (89 %) |
  | 131-200 | 108 | 100 (93 %) | 106 (98 %) |
  | 201-300 | 150 | 142 (95 %) | 148 (99 %) |
  | > 300 | 37 | 34 (92 %) | 37 (100 %) |

  Polkas = 6,5 % du corpus mais **7 des 29 manqués** ; le déficit est **déjà dans les
  listes de candidats** (82 % contre 98 %) → c'est le MOTEUR, pas Viterbi. Piste de
  cause : la recherche de tempo (croches ~4,5/s en polka contre ~7,5/s en reel ;
  erreur d'octave de tempo ?). Mesure : `v3/tempo.js` sur `debug.features.best_bpm`
  et `tempo_candidates`. **C'est le candidat le plus sérieux à un travail WASM.**
- **06:20** mesure du tempo (`v3/tempo-out.txt`). Fisher bilatéral : manqués polka
  7/22 contre 22/319, **p = 1,1e-3** ; jamais-top-10 polka 4/22 contre 5/319, p = 1,3e-3.
  Plage des `tempo_candidates` : **60 → 235 bpm**. **Découverte H4 : `best_bpm` sature
  à la borne haute**, pour TOUS les types :

  | type | fenêtres | rang 1 | au bac 230 (borne) | rang 1 au bac 230 | rang 1 au meilleur bac |
  |---|---|---|---|---|---|
  | reel | 4 085 | 77 % | **1 932 (47 %)** | 70 % | 88 % (200) |
  | jig | 1 873 | 70 % | 471 (25 %) | **52 %** | 94 % (140-160) / 82 % (190) |
  | polka | 367 | 40 % | 74 (20 %) | **12 %** | 69 % (150) / 63 % (170) |

  **Hypothèse H4** : les sessions sont jouées plus vite que la plage de recherche de
  tempo de FolkFriend ; le tempo est écrêté à 235, la quantification des notes se
  dégrade, le classement avec. Faiblesse du MOTEUR, localisée, qui touche tout le
  corpus (la moitié des fenêtres de reel). Prochaine étape : trouver la plage dans
  `folkfriend-src`, vérifier la chaîne de build WASM, et régénérer les fenêtres avec
  une plage élargie. ⚠️ Régénérer change le corpus : les évaluations de la campagne
  deviennent incomparables aux nouvelles — comparer à configuration FIXE (production
  + quelques points du front) avant / après, jamais par recombinaison de fronts.
- ⚠️ **Correction d'horodatage** : les entrées marquées « 06:00 » à « 06:20 » ci-dessus
  sont en avance d'environ 40 min (estimées à la louche). Heure réelle au relevé
  suivant : **05:40 locale = 03:38 UTC** (1 960 évaluations). À partir d'ici, les
  heures sont prises sur l'horodatage UTC de `v3/count.js`, +2 h.
- **05:42** localisation dans le moteur : `folkfriend-src/rust/src/decode/contour.rs`
  l. 160-173 : `low_bpm = 60`, `high_bpm = 240`, `step_by(5)` → 36 candidats 60..235.
  **Unité = la noire** (`bpm_to_num_frames` : croches/s = bpm/60 × 2 ; une note du
  contour = une croche). Donc 235 = 7,8 croches/s : **un reel de session à 120 à la
  blanche (240 à la noire) est au-delà → écrêté**. Pour les polkas, les bons bacs
  (140-170) SONT le vrai tempo à la noire : leurs fenêtres au bac 230 sont plutôt
  de **mauvais choix de tempo** que de l'écrêtage — élargir la plage pourrait aider
  les reels et nuire aux polkas ; seule une régénération tranche.
  Sélection du tempo : `combined = quant_score × probability_model_score`, modèle
  linéaire `3 − 0,5 × croches` normalisé par le nombre de notes.
  État : `folkfriend-src` est un dépôt git, optimisations custom NON commitées
  (11 fichiers, dont `contour.rs`, `nw.rs`, `nw_simd.rs`). Chaîne installée :
  `cargo`, `wasm-pack`, `rustc` (`~/.cargo/bin`). Scripts `rust/wasm_build.sh`,
  nombreuses variantes `rust/pkg-node-*`. La régénération lit
  `Cadence/experiments/noise-study/wasm-node/`.
  **Règles pour l'expérience WASM** : ne JAMAIS écraser `test-fixtures/sessions/`
  ni `noise-study/wasm-node/` ; build dans un dossier à part, fenêtres dans un
  dossier à part, harnais pointé dessus par variable d'environnement.
- **05:48** identité du moteur des fixtures : `noise-study/wasm-node/folkfriend_bg.wasm`
  (18 août, sha256 `aefc8cc2c80779ad…`) **ne correspond à AUCUNE** variante
  `rust/pkg-node-*` et précède les optimisations du 1er sept. (annoncées identiques au
  bit). Le client (`noise-study/lib/wasmClient.js`) : 48 kHz, fenêtres PCM de 1024,
  `transcribe_pcm_buffer_debug`, repli d'octave si top1 < 0,40, top 10 gardé.

  **Conception de l'expérience E1 (plage de tempo)** :
  1. ajouter au source un réglage exporté `set_tempo_range(low, high)` (défaut 60/240,
     donc comportement inchangé) → UN binaire, variantes pilotées depuis JS ;
  2. build `--target nodejs --release` dans `rust/pkg-node-tempo/` (nouveau dossier) ;
  3. **contrôle** : ce binaire au défaut doit reproduire AU BIT une fixture existante
     (One_of_the_Best, la plus courte) — sinon rien de ce qui suit n'est interprétable ;
  4. régénérer les 7 sessions + bruit avec `high = 320` (et éventuellement 280) dans
     `experiments/ranking-study/v3/fixtures-t320/` (+ copie des CSV) ;
  5. comparer à configuration FIXE : production, puis quelques points du front de la
     campagne, via `evalset` pointé sur le nouveau dossier ; puis plafond et tempo
     par type de danse.
  Sauvegarde des fichiers source modifiés : `v3/ff-backup/`.
- **05:52** (2 340 évaluations à 03:42 UTC) E1 mis en œuvre :
  - **Rust** (sauvegardes sha256 dans `v3/ff-backup/`, originaux : contour.rs
    `d8fb915f…`, lib.rs `613d6136…`, Cargo.toml `a1f4ae2e…`) :
    `decode/contour.rs` → statiques `TEMPO_LOW_BPM`/`TEMPO_HIGH_BPM` (AtomicU32,
    défaut 60/240) lues à la place des littéraux + `pub fn set_tempo_range` ;
    `decode/mod.rs` → réexport ; `lib.rs` → méthode `FolkFriendWASM::set_tempo_range`.
    La boucle de tempo n'existe qu'à UN endroit (chemins debug et normal partagés).
    **Pour revenir à l'état d'avant : recopier les trois fichiers de `v3/ff-backup/`
    et retirer `set_tempo_range` de `decode/mod.rs`.**
  - Build : `wasm-pack build --target nodejs --release --out-dir pkg-node-tempo`
    (profil release : LTO, codegen-units 1, wasm-opt -O3 ; pas de SIMD forcé).
  - `v3/regen-tempo.js --wasm <pkg> --low L --high H --out <dir> [noms…]` : client
    recopié de `wasmClient.js` (octave < 0,40, top 10, debug), refuse d'écrire dans
    `test-fixtures/sessions/`, copie les CSV.
  - `v3/compare-windows.js a b` : comparaison au bit (géométrie, vide, top 10 id+score,
    best_bpm, octave).
  - `pipeline.ts` : `DIR` surchargeable par `RANKING_FIXTURES_DIR` (défaut inchangé).
- **05:45** build `pkg-node-tempo` OK en 38 s (wasm-opt appliqué ; un seul
  avertissement préexistant, `mem::forget` sur `[f32; 1024]`, lib.rs:197).
  `set_tempo_range` exporté dans `folkfriend.js`. Contrôle au bit lancé : One_of_the_Best
  + bruit régénérés à 60/240 dans `v3/fixtures-ctl/`, comparés aux fixtures commitées.
  **Tant que ce contrôle n'est pas IDENTICAL, aucune variante n'est interprétable.**
- **05:49** (2 820 évaluations) **contrôle au bit : DIFFÉRENT.** `best_bpm` identique
  dans 100 % des fenêtres (la décodification du tempo est reproduite), mais les
  **candidats** diffèrent : One_of_the_Best 106/435 fenêtres, bruit 314/338. L'écart
  est côté **requête** (Needleman-Wunsch / heuristique : source custom non commité ≠
  binaire du 18 août). Coût mesuré : 435 fenêtres en 141 s, 338 en 100 s, soit
  **~0,3 s/fenêtre en contention → ~45 min par variante** pour tout le corpus, un
  processus. Caractérisation de l'écart en cours (`v3/diff-detail.js`) : si ce ne
  sont que des ex-aequo ou des epsilons flottants, le binaire est équivalent en
  pratique ; sinon **E1 devra comparer la variante à un témoin régénéré avec le MÊME
  binaire**, jamais aux fixtures commitées.
- **05:52** écart caractérisé (`v3/diff-detail.js`) :
  - **musique** (One_of_the_Best) : contours **identiques (0 diff)**, **top 1 identique
    dans 100 % des fenêtres** ; 43 fenêtres = même top 10 dans un autre ordre
    (ex-aequo à score égal, ex. 18214/1286 à 0,277027), 63 = un membre du top 10
    change en queue, 102/435 = liste complète des 100 différente. Scores sur ids
    communs : 5 non nuls sur 995 (0,03-0,04). → **l'heuristique de présélection de la
    requête a changé** (quels réglages sont alignés) et l'ordre des ex-aequo avec.
  - **bruit** : scores minuscules massivement ex-aequo (0,076923 partout) → ordre et
    top 1 arbitraires (79 top 1 différents), 19 contours changés via le repli d'octave.
  - **Décision : E1 en A/B avec le même binaire.** Régénération complète en témoin
    `v3/fixtures-ctl/` (60/240) ET variante `v3/fixtures-t320/` (60/320 = 10,7 croches/s).
    Le témoin contre les fixtures commitées donne en prime le **bruit de fond du
    moteur** (effet de l'ordre des ex-aequo sur les métriques) = taille d'effet
    minimale en dessous de laquelle E1 ne prouve rien.
  - Processeur : la campagne sature les 6 cœurs P ; 4 processus de régénération
    (Audio F isolée dans chaque bras) sur les 8 cœurs E. Journaux :
    `v3/logs/regen-{ctl,t320}-{F,rest}.log`.
- **05:53** (3 020 évaluations à 03:51 UTC) les 4 régénérations tournent (lancées
  ~05:51, fin attendue ~06:20). Configurations d'évaluation d'E1 figées AVANT de voir
  les résultats : `v3/e1-configs.json` (production, production a=0,95, production N=3,
  share 0,1101 N2, nullRatioTailMean 1,0197 N0, share 0,0959 N2, idem a=0,9).
  Commandes prévues, une fois les deux dossiers complets :
  `RANKING_FIXTURES_DIR=<dossier> EVAL_IN=experiments/ranking-study/v3/e1-configs.json
  EVAL_OUT=experiments/ranking-study/v3/e1-<bras>.json npx vitest run --config
  vitest.ranking.config.ts experiments/ranking-study/evalset.test.ts`, puis
  `CEILING=1` et `node v3/tempo.js` avec le même `RANKING_FIXTURES_DIR`. Bras :
  `committed` (défaut), `ctl`, `t320`. Critère : écart t320−ctl comparé à l'écart
  ctl−committed (bruit de fond du moteur).
- **05:55** bras `committed` d'E1 (`v3/e1-committed.json`) — reproduit les sondes :

  | configuration | rappel | fp | par session |
  |---|---|---|---|
  | production | 312 | 20 | 31/0 35/4 21/5 29/0 25/0 36/1 135/10 |
  | production a=0,95 | 312 | 15 | 31/0 35/2 23/6 28/1 25/0 36/1 134/5 |
  | production N=3 | 287 | 6 | 30/0 34/0 18/0 27/0 24/0 30/0 124/6 |
  | share 0,1101 N2 | 312 | 17 | 31/0 35/5 22/3 29/0 25/0 36/0 134/9 |
  | nullRatioTailMean 1,0197 N0 | 305 | 10 | 31/0 35/0 20/1 29/0 24/0 33/1 133/8 |
  | share 0,0959 N2 | 294 | 3 | 31/0 35/0 18/0 28/0 24/0 33/0 125/3 |
  | share 0,0959 N2 a=0,9 | 305 | 7 | 31/0 35/0 20/1 30/0 25/0 34/1 130/5 |
- **05:54** (horloge réelle ; mes entrées précédentes avaient ~3 min d'avance)
  régénération : 400 fenêtres en ~122 s par processus (0,3 s/fenêtre), Audio F encore
  en décodage audio → **fin estimée ~06:22**. Campagne ralentie à ~1,24 éval/s pendant
  la régénération (3 140 à 03:52:55 UTC) → **6 000 vers ~06:30**.
  `v3/e1-compare.js` prêt : lit `e1-{committed,ctl,t320}.json`, donne par configuration
  et par session le bruit moteur (ctl−committed) et l'effet tempo (t320−ctl).
  Première lecture de la campagne à ~3 100 points : `v3/analysis-3k.txt` (tendance
  seulement — 13 % du budget, chaînes encore chaudes).
- **05:56** lecture précoce à **3 180 évaluations** (`v3/analysis-3k.txt`) :
  - dans l'échantillon, **5 évaluations dominent strictement la production**
    (nullRatio5|off ×4, share|off ×1) ; front de 264/0 à 321/66.
  - **hors échantillon (LOSO, ex-aequo moyennés), rien ne bat encore la production** :
    sélection « meilleur rappel sous fp ≤ α × fp_prod » → α=1 : **309/25** (production
    312/20) ; α=0,5 : 305/14 ; α=0,25 : 301/10 ; α=0,1 : 285/6,3. Dans l'échantillon, la
    même règle à α=1 donne ≥312/≤20 : **c'est l'optimisme de sélection**, que la v2
    n'avait pas pu mesurer. La courbe hors échantillon est un échange d'environ
    **1 morceau par faux positif** autour du point de production.
  - par groupe, rien ne se détache nettement ; quasi-front dominé par minSeg=2 (241/343)
    et confirm=none (258/343).
  - À confirmer au point de contrôle de 6 000 et en fin de campagne.
- **05:57** seconde règle de sélection hors échantillon, pour vérifier que le verdict
  ne tient pas à la règle du budget (`MODE=loso2`, `v3/analysis-3k-loso2.txt`, 3 280
  évaluations) : max (rappel − λ·fp) sur les 6 sessions d'entraînement, score sur la
  7e, ex-aequo moyennés ; comparé à la production au même λ.

  | λ | tous groupes, hors échantillon | score − production |
  |---|---|---|
  | 0,25 | 311 / 34,5 | −5,1 |
  | 0,5 | 306 / 19,7 | −5,8 |
  | 1 | 304 / 12,9 | −1,1 |
  | **2** | **301 / 8,7** | **+11,2** |

  **Les deux règles s'accordent** : hors échantillon, le seul gain qui se généralise est
  un **échange vers moins de faux positifs** (−11 morceaux pour −11 fp). Au taux de
  change qui correspond à la préférence produit connue (un fp se rejette en un clic,
  un manqué est invisible → λ bas), **rien ne bat la production** à ce stade. Par
  groupe, λ=2 monte à +18 (relLeaderXMargin|on) ou +17,7 (share|off), mais choisir le
  groupe APRÈS avoir vu ces chiffres est une sélection de second niveau, avec son
  propre optimisme — à ne pas présenter comme un résultat.
- **05:58** régénération : Audio F à 200/3 914 après 177 s (décodage audio compris),
  le reste à 600/1 060 → fins estimées ~06:20 (témoin) et ~06:25 (t320).
- **06:00** précision de méthode : la ligne **« tous »** des deux validations croisées
  choisit la transformation, le filtre plat ET les paramètres sur les seules sessions
  d'entraînement de chaque pli. **C'est déjà l'estimation IMBRIQUÉE** de « tout choisir
  par les données » — aucun calcul supplémentaire n'est nécessaire. Seules les lignes
  par groupe portent l'optimisme de second niveau (choisir le groupe après coup).
  **Conséquence pour la réserve** : si la campagne complète confirme qu'au λ bas le
  réglage fin des dimensions actuelles ne se généralise pas, la réserve de 6 000 doit
  aller aux dimensions qui changent la PREUVE elle-même — plancher d'absence
  (`ANNEAL_ABSENT`), tempo du moteur si E1 le confirme — et non à davantage de réglage
  des mêmes paramètres. Critère d'évaluation de la réserve : validation croisée « tous »,
  jamais le front dans l'échantillon.
- **06:02** `v3/e1-run.sh` prêt (depuis `Cadence/` : `bash experiments/ranking-study/v3/e1-run.sh`).
  Vérifie que les 8 fenêtres + 7 CSV existent dans `fixtures-ctl` et `fixtures-t320`
  (s'arrête sinon), puis pour chaque bras : `evalset` sur `v3/e1-configs.json` →
  `v3/e1-{ctl,t320}.json`, plafond → `v3/e1-ceiling-{bras}.txt`, tempo →
  `v3/e1-tempo-{bras}.txt` ; enfin `v3/e1-compare.js` → `v3/e1-compare.txt`.
  **Reprise après coupure** : si `v3/logs/regen-*.log` se terminent tous par une ligne
  « wrote … », lancer ce script ; sinon relancer les régénérations manquantes avec
  `v3/regen-tempo.js` (mêmes arguments que dans l'entrée de 05:52) pour les seuls
  noms absents.
- ⚠️ **Deuxième correction d'horodatage** : horloge réelle **05:56:11** (03:56:11 UTC)
  au relevé qui suit l'entrée « 06:02 ». Les entrées marquées **05:57 à 06:02 ont ~5 min
  d'avance**. L'ordre des entrées, lui, est exact. Désormais : heure = sortie de `date`.
- **05:56** (3 400 évaluations) Anglade régénérée dans les deux bras (témoin 299 s,
  t320 302 s : le surcoût de 16 candidats de tempo en plus est négligeable). Audio F
  200 → 600 fenêtres en 115 s = 0,29 s/fenêtre. **Fins recalées : Audio F ~06:12,
  reste du témoin ~06:15, reste de t320 ~06:19.** Campagne à 1,26 éval/s pendant la
  régénération → **6 000 vers ~06:30**.
- **~05:58 — DÉCISION (validée par l'utilisateur) : priorité à FolkFriend, recuit mis en
  pause.** Message de l'utilisateur : améliorer les fenêtres issues de FolkFriend est
  forcément une bonne piste ; si elles sont saturées, le reste de la chaîne l'est aussi ;
  si le goulot est FolkFriend, y aller à 100 % et remettre le recuit à plus tard.
  Justification déjà en main, sans attendre E1 :
  (1) plafond du post-traitement 329 contre 312 en production (17 morceaux au plus) ;
  (2) hors échantillon, aucune configuration ne bat la production au λ bas, par deux
  règles de sélection ; (3) les manqués et les faiblesses par type de danse sont DÉJÀ
  dans les listes de candidats (polkas 82 % contre 98 %) ; (4) le tempo sature la borne
  du moteur sur la moitié des fenêtres de reel.
  **Action : campagne de la graine 11 arrêtée** pour libérer les cœurs P. Les rondes
  étant entrelacées, les points écrits forment une comparaison à budget égal ; ils
  restent dans `.out/search-seed11-anneal0*.json`. **Reprise plus tard : nouvelle
  graine (12), jamais relancer la 11** (elle écraserait ses fichiers).
  ⚠️ Heure réelle de cette décision : **~06:20** (et non 05:58 ; `date` = 06:20:49 au
  relevé qui a suivi l'arrêt).
- **06:21** campagne arrêtée : 12 processus liés à `anneal.test.ts` tués avec leur arbre,
  0 restant. **Les 4 régénérations étaient TERMINÉES** (chaque journal finit par
  « wrote ») : Audio F 1 407 s (témoin) / 1 424 s (t320) ; 8 fichiers de fenêtres dans
  `v3/fixtures-ctl/` et dans `v3/fixtures-t320/`. Les fichiers t320 sont 8 à 10 % plus
  gros (listes de tempo candidats plus longues dans le debug). `v3/e1-run.sh` lancé →
  `v3/logs/e1-run.log`.
  **Campagne graine 11, état final à l'arrêt : 5 020 évaluations**, 6 fichiers JSON tous
  valides, 20 chaînes par shard, pas 0 à 49 atteints (840 évaluations par shard, 820
  pour le shard 5) — donc **120 chaînes × ~42 pas, budget égal** entre les 20 groupes
  (transformation × filtre plat) et les 6 λ. Réveil « 6 000 » arrêté.
- **06:23** carte du moteur (`folkfriend-src/rust/src`), pour cibler la suite :
  1. caractéristiques : autocorrélation, MIDI 48-95 × 3 bacs, trame de 1024 échantillons
     (46,9 trames/s à 48 kHz), 5 caractéristiques retenues par trame ;
  2. `decode/beam_search.rs` → chemin de hauteurs par trame ;
  3. `contour.rs::notes_from_lattice_path` : trames consécutives de même hauteur =
     une note ; **filtre** `MIN_NOTE_POWER = 0,10` et `MIN_NOTE_DURATION = 3` trames
     (64 ms) ; ≤ 3 notes → fenêtre vide ;
  4. `contour_from_notes` : **UN seul tempo retenu** parmi 60..235 (pas de 5), note
     quantifiée en croches (arrondi, min 1 si > 0,2 croche), contour = hauteur répétée
     par croche ;
  5. `octave.rs` : correction d'octave ;
  6. requête : présélection par quadrigrammes, `QUERY_REPASS_SIZE = 2000` réglages
     réalignés (Needleman-Wunsch), dédoublonnage par morceau (meilleur réglage).
  **Leviers candidats** : (a) plage de tempo — E1 en cours ; (b) **un second tempo
  interrogé** quand le top 1 est faible, sur le modèle du repli d'octave : les polkas
  au bac 230 ont probablement un vrai tempo ~150 (rapport 1,5 = confusion
  pointé / triolet), qu'un seul choix de tempo ne rattrape jamais ; (c) filtres de notes
  (ornements des reels rapides < 64 ms) ; (d) normalisation du score d'alignement par
  la longueur (H3, contours courts) — à lire dans `query/`.
- **06:26** **E1 : VERDICT — la plage de tempo élargie n'a PAS d'effet mesurable. H4
  réfutée comme cause.** (`v3/logs/e1-run.log`, `v3/e1-compare.txt`,
  `v3/e1-ceiling-*.txt`, `v3/e1-tempo-*.txt`)
  - Bruit de fond du moteur, |ctl − committed| moyen sur les 7 configurations :
    rappel 0,4, fp 0,3. Effet tempo moyen t320 − ctl : **rappel −0,6, fp −0,4** —
    même ordre que le bruit, signe défavorable sur le rappel.
  - Production : committed 312/20, ctl 311/20, t320 312/20. Seul écart > bruit :
    share 0,1101 N2 ctl 312/18 → t320 312/13 (Anglade −3) — une configuration sur
    sept, non interprétable seule.
  - Plafond : ctl top10 332 / top1 329 / ≥2 rangs 1 323 ; t320 331 / 328 / 322.
  - Tempo : la plage s'étale bien (reel p90 230 → 260, hornpipe 230 → 255, polka
    230 → 250) mais les taux de rang 1 ne bougent pas (reel 77 → 76 %, jig 70 → 69 %,
    polka 40 → 40 %).
  **Lecture** : l'accumulation au bac 230 était une CORRÉLATION (passages rapides, plus
  difficiles), pas un écrêtage qui dégraderait le classement. La plage 60-240 reste.
  Question suivante, distincte : le CHOIX du tempo (et non sa borne) est-il causal ?
  Expérience naturelle gratuite : les fenêtres dont `best_bpm` change entre ctl et t320,
  à audio identique — `v3/tempo-natural.js`.
- **06:30** notation de la requête (`query/nw.rs`) : Needleman-Wunsch **semi-global**
  (la fenêtre s'aligne n'importe où dans le réglage), +2 / −2 / −1, score =
  **0,5 × meilleur / n, n = longueur de la PLUS COURTE séquence** (en pratique la
  fenêtre). Une fenêtre courte (polka ~50 notes en 10 s, reel ~77) trouve plus
  facilement un alignement fortuit → bruit de fond plus haut, discrimination plus
  faible : mécanisme compatible avec H3.
  **Changement de méthode pour le moteur** : les manqués viennent surtout de preuves
  INTERMITTENTES. La métrique à optimiser au niveau du moteur est donc le **taux de
  rangs 1 (et de top 10) par fenêtre dans les plages annotées**, par type de danse —
  des milliers de fenêtres, forte puissance, sans Viterbi. Les fenêtres étant
  indépendantes (flush à chaque fenêtre), une régénération **sous-échantillonnée**
  (1 fenêtre sur k) est exacte pour cette métrique → crible rapide de plusieurs
  variantes en parallèle ; seule la meilleure passe en régénération complète + chaîne
  complète. Leviers à cribler : longueur de fenêtre (10 → 15 s), taille de
  présélection (2 000 → plus), seuil du repli d'octave (0,40), filtres de notes,
  second tempo.
- **06:33** **expérience naturelle (`v3/tempo-natural-out.txt`) : le CHOIX du tempo est
  causal, dans le sens INVERSE de H4.** 7 414 fenêtres annotées ; 1 015 (14 %) changent
  de tempo entre ctl et t320, **toutes vers ≥ 240**. Rang du bon morceau : **pire 97,
  meilleur 20** ; rang 1 **perdu 59, gagné 9**. Test du signe 97 contre 20 : p ≈ 1e-13.
  Par type : reel 63/16 (rang 1 −34/+9), jig 22/2 (−16/0), hornpipe 5/2, polka 3/0.
  **Le sélecteur de tempo SURESTIME** : quand il peut aller plus vite, il le fait, et
  c'est le plus souvent faux. **Hypothèse H5** : resserrer la borne haute (200-220), ou
  débiaiser le sélecteur (le modèle `3 − 0,5 × croches` normalisé favorise les notes
  courtes, donc les tempos rapides), améliore le classement. → **E2** : bornes hautes
  180 / 200 / 220 en crible sous-échantillonné, binaire actuel.
  Autres constats : `num_repass` (présélection 2 000) n'est PAS réglable depuis JS
  (champ de `query/mod.rs`) ; l'étude du 1er sept. (commentaire de `sessionConfig.ts`)
  a déjà montré que la longueur de fenêtre n'achète ni détection ni précision → piste
  reléguée.
- **06:33 — DEMANDE UTILISATEUR** : se concentrer aussi sur la **qualité temporelle** —
  le but final est une bonne détection ET un bon recouvrement de la durée des morceaux
  avec la vérité terrain. **Conséquences** : (1) le crible moteur mesure aussi, par
  morceau annoté, le **retard de la première fenêtre en rang 1** sur le début réel,
  l'**avance de la dernière** sur la fin réelle, et la **fraction de la plage couverte
  par des rangs 1** (bornes supérieures de ce que Viterbi peut restituer) ; (2) toute
  comparaison de chaîne complète rapporte `coverage` à côté de rappel et fp ;
  (3) la réserve du recuit, quand elle reprendra, devra inclure la couverture dans
  l'objectif, pas seulement (rappel, fp).
- **06:37** outillage du crible moteur :
  - `v3/regen-tempo.js` : `--stride k` (fenêtres 0, k, 2k… — exact pour le crible,
    PAS pour la chaîne Viterbi) et `--call methode:a,b` répétable (réglages du moteur).
  - `v3/screen.js dirA [dirB…]` : sur les fenêtres COMMUNES aux dossiers — taux de
    rang 1 / top 10 par type de danse dans les plages annotées ; par morceau, retard de
    la 1re fenêtre en rang 1 sur le début réel, avance de la dernière sur la fin réelle
    (p50/p75/p90), fraction de fenêtres en rang 1 (p25/p50), morceaux sans aucun rang 1 ;
    moyenne du top 1 sur la fixture de bruit. Validation lancée sur
    committed / ctl / t320 → `v3/screen-e1.txt`.
  - **E2 lancé** (crible de la borne haute du tempo) : 180 / 200 / 220, stride 2,
    7 sessions + bruit, `pkg-node-tempo` → `v3/screen-t{180,200,220}/`, journaux
    `v3/logs/screen-t*-{F,rest}.log`. 6 processus.
  - **Binaire « à boutons » en préparation** (dossier séparé `pkg-node-knobs`, E2 n'est
    pas affecté) : `set_note_filter(min_power, min_duration_frames)` (défauts 0,10 / 3)
    dans `decode/contour.rs`, `set_num_repass(n)` (défaut 2 000) via `QueryEngine`.
    Sauvegardes supplémentaires : `v3/ff-backup/query-mod.rs` (original) et
    `v3/ff-backup/decode-mod.after-tempo.rs` (état après la seule réexportation de
    `set_tempo_range`).
- **06:39** `screen.js` validé (`v3/screen-e1.txt`), 7 414 fenêtres annotées communes :

  | dossier | rang 1 / top 10 (tous) | reel | jig | polka | sans rang 1 | retard début p50/p75/p90 | avance fin p50/p75/p90 | fraction rang 1 p25/p50 | bruit top 1 |
  |---|---|---|---|---|---|---|---|---|---|
  | committed | 73,4 / 78,7 % | 76,9 % | 70,1 % | 40,1 % | 12/341 | 5 / 10 / 21 s | 4 / 7 / 17 s | 0,60 / 0,86 | 0,1153 |
  | ctl | 73,3 / 78,7 % | 76,8 % | 70,1 % | 40,1 % | 12/341 | 5 / 10 / 21 s | 4 / 7 / 17 s | 0,60 / 0,86 | 0,1151 |
  | t320 | 72,7 / 77,9 % | 76,2 % | 69,2 % | 39,5 % | 13/341 | 5 / 10 / 20 s | 4 / 7 / 17 s | 0,59 / 0,84 | 0,1138 |

  **Bruit de fond du moteur au niveau fenêtre : 0,1 point** de taux de rang 1 ; t320 :
  −0,6 point, cohérent avec l'expérience naturelle → l'outil résout des effets de cet
  ordre. **Référence temporelle** : la preuve en rang 1 démarre ~5 s après le début
  annoté (médiane ; 1 fenêtre = pas de 5 s) et s'arrête ~4 s avant la fin ; au 9e
  décile 21 s et 17 s — ce sont ces queues qui limitent le recouvrement.
- **06:42** binaire à boutons compilé : `folkfriend-src/rust/pkg-node-knobs/` (65 s),
  exporte `set_tempo_range`, `set_note_filter(min_power, min_duration_frames)`,
  `set_num_repass(n)`. Modifications Rust supplémentaires : `decode/contour.rs`
  (statiques `MIN_NOTE_POWER_BITS` = 0x3DCCCCCD = 0,10 f32, `MIN_NOTE_DURATION_FRAMES`
  = 3, lues dans `contour_from_notes`), `decode/mod.rs` (réexport), `query/mod.rs`
  (`QueryEngine::set_num_repass`), `lib.rs` (deux méthodes WASM). `regen-tempo.js` :
  option `--octave t` (seuil JS du repli d'octave, défaut 0,40).
  - **Contrôle lancé** : `pkg-node-knobs` aux défauts sur One_of_the_Best, comparé au bit
    à `fixtures-ctl` → `v3/logs/knobs-default.log`. Si IDENTICAL, `fixtures-ctl` sert de
    référence commune à tous les cribles (mêmes indices de fenêtres en stride 2).
  - **E3, 1re vague lancée** (stride 2, 7 sessions + bruit, 6 processus à côté d'E2) :
    `screen-rep4000` (présélection 4 000), `screen-dur2` (notes ≥ 2 trames au lieu de 3,
    garde les ornements), `screen-oct050` (repli d'octave sous 0,50 au lieu de 0,40).
    2e vague prévue après E2 : présélection 8 000, notes ≥ 4 trames, puissance 0,05 et
    0,15, repli d'octave 0,30.
- **06:45** **Hypothèse H6 — biais de résolution de grille dans le choix du tempo**
  (mécanisme de l'expérience naturelle). `score_quantised_notes` : `quant_score =
  1 − Σ|exacte − arrondie|·puissance × trames_par_croche / trames_totales`, c.-à-d.
  l'erreur d'arrondi **en trames**. Un tempo candidat plus rapide = grille plus fine =
  erreur mécaniquement plus petite : **ce terme favorise TOUJOURS les tempos rapides**.
  Seul contrepoids : `probability_model_score = moyenne(3 − 0,5 × croches)`, qui
  pénalise les notes longues. Les 97 pire / 20 meilleur disent que ce contrepoids est
  trop faible. **Réglage ajouté** : `set_tempo_model(intercept, slope)` (statiques f32,
  défauts 3,0 = 0x40000000 et 0,5 = 0x3F000000), lu dans `score_quantised_notes` ;
  réexport + méthode WASM. À compiler dans `pkg-node-knobs2` (les processus en cours
  ont chargé `pkg-node-knobs` et `pkg-node-tempo`). Crible prévu : pente 0,6 / 0,75 /
  1,0 (défaut 0,5), contrôle au bit aux défauts.
- ⚠️ **Troisième correction d'horodatage** : `date` = **06:31:29** juste après l'entrée
  « 06:45 ». Les entrées marquées **06:26 à 06:45 ont 5 à 15 min d'avance** ; leur
  ORDRE est exact. Repères réels : arrêt de la campagne 06:20:49 ; E2 lancé ~06:24 ;
  E3 1re vague et contrôle des boutons ~06:28. **À partir d'ici, seules les heures
  issues de `date` sont écrites.**
- **06:31** `pkg-node-knobs2` compilé (19 s) : exporte `set_tempo_model`,
  `set_note_filter`, `set_num_repass`, `set_tempo_range`. Contrôle au bit aux défauts
  lancé (One_of_the_Best contre `fixtures-ctl`) → `v3/logs/knobs2-default.log`.
  Crible H6 reporté à la fin d'E2 (sinon 19 processus sur 20 cœurs logiques).
- **06:32** contrôle `pkg-node-knobs` aux défauts contre `fixtures-ctl` (One_of_the_Best,
  435 fenêtres, 126 s) : **IDENTICAL** (0 fenêtre différente, candidats et best_bpm).
  → `fixtures-ctl` est une référence valable pour toutes les variantes d'E3 (mêmes
  indices en stride 2). Avancement : E2 Audio F 400/1 957 après ~300 s (13 processus en
  parallèle, ~0,75 s/fenêtre) → fin E2 estimée ~06:50 ; E3 1re vague un peu après.
- **06:32** lecture PRÉCOCE d'E2 (`v3/screen-e2-partial.txt`), seules sessions écrites
  dans les trois bras : Anglade + tabac, **681 fenêtres annotées** communes (stride 2) :

  | borne haute | rang 1 / top 10 | reel | jig | fraction rang 1 p25/p50 | avance fin p90 |
  |---|---|---|---|---|---|
  | 240 (ctl) | 75,6 / 80,2 % | 78,9 % | 69,9 % | 0,62 / 0,92 | 31 s |
  | **180** | **77,8** / 81,2 % | 81,1 % | 72,6 % | 0,70 / 0,93 | **22 s** |
  | 200 | 76,7 / 81,1 % | 79,6 % | 72,6 % | 0,67 / 0,92 | 31 s |
  | 220 | 77,1 / 80,9 % | 80,2 % | 72,0 % | 0,70 / 0,93 | 31 s |

  **Sens conforme à H5/H6** (tempo plafonné plus bas → meilleur classement), +1,1 à
  +2,2 points. Tendance seulement (2 sessions, n = 681). Ajout d'un **test apparié** à
  `screen.js` : rangs 1 gagnés / perdus fenêtre par fenêtre contre le premier dossier,
  test du signe (McNemar exact) — le bruit commun aux deux bras s'annule.
- **06:33** test apparié **validé** sur ctl contre t320 (corpus complet) : rangs 1
  gagnés / perdus **9 / 59** (p = 3,9e-10), top 10 12 / 68 (p = 1,2e-10). **Identique au
  compte de l'expérience naturelle** (9 / 59) — attendu exactement, puisqu'un contour
  (donc ses candidats) ne peut changer que si le tempo choisi change. Le code apparié
  de `screen.js` est donc juste. Lanceur du crible H6 préparé : `v3/h6-launch.sh`.
- **06:34** **contrôle `knobs2` aux défauts : DIFFÉRENT — bug de ma part, trouvé par le
  contrôle.** Défaut de l'ordonnée écrit `0x4000_0000` = **2,0** f32, au lieu de 3,0 =
  `0x4040_0000` (la pente 0x3F00_0000 = 0,5 était juste ; le filtre de notes aussi, cf.
  contrôle `knobs` IDENTICAL). Effet : tempos choisis plus lents (230 → 190-210),
  180/435 fenêtres changées. **Corrigé** dans `decode/contour.rs` ; recompilation et
  nouveau contrôle à suivre. `h6-launch.sh` passe l'ordonnée explicitement (`3,$S`) et
  n'aurait pas été faussé, mais le chemin par défaut doit rester le moteur d'origine.
  L'échantillon accidentel (ordonnée 2,0 = pénalité relative des notes longues plus
  forte, donc la direction H6) est gardé : `v3/knobs2-intercept2-onebest/`
  (One_of_the_Best seul, stride 1). **Leçon** : écrire les défauts f32 via
  `f32::to_bits` dans un test, jamais un motif hexadécimal tapé à la main.
- **06:35** échantillon accidentel (ordonnée 2,0, One_of_the_Best seul, 433 fenêtres
  annotées) contre ctl : rang 1 91,0 → 91,2 %, apparié **2 gagnés / 1 perdu (p = 1)**,
  top 10 4 / 2. **Non informatif** : session déjà à 91 % de rang 1, presque rien à
  gagner. Le crible H6 doit porter sur le corpus complet (les sessions difficiles :
  Audio F, tabac, 13th Moon). Recompilation de `knobs2` + nouveau contrôle en cours.
- **06:36** lecture élargie d'E2 (`v3/screen-e2-partial5.txt`) : 5 sessions communes
  (Korea, Anglade, tabac, auberge, One_of_the_Best — **sans Audio F**), 1 266 fenêtres
  annotées, stride 2 :

  | borne haute | rang 1 / top 10 | apparié rang 1 gagnés / perdus | p | apparié top 10 | polka | fraction rang 1 p25 | avance fin p90 | **top 1 moyen, bruit** |
  |---|---|---|---|---|---|---|---|---|
  | 240 (ctl) | 78,8 / 83,6 % | — | — | — | 37,0 % | 0,71 | 22 s | **0,1151** |
  | **180** | **80,9** / 85,5 % | **41 / 15 (+26)** | **6,9e-4** | 34 / 11 | 44,4 % | 0,77 | 20 s | **0,1905** |
  | 200 | 80,0 / 84,7 % | 26 / 11 (+15) | 2,0e-2 | 20 / 7 | 37,0 % | 0,73 | 22 s | 0,1434 |
  | 220 | 79,8 / 84,4 % | 15 / 3 (+12) | 7,5e-3 | 12 / 2 | 37,0 % | 0,73 | 22 s | 0,1256 |

  **Dose-réponse monotone** : plus la borne haute est basse, meilleur est le classement
  (H5 confirmée sur 5 sessions). **MAIS le top 1 moyen sur le bruit monte fortement**
  (0,115 → 0,191 à 180). Mécanisme présumé : tempo plus lent → contour plus COURT → le
  score NW normalisé par la plus courte longueur gonfle pour tout, alignements fortuits
  compris → pression vers plus de fp, surtout avec un plancher absolu (identity).
  → le gain de classement doit être jugé sur la CHAÎNE COMPLÈTE (rappel, fp, couverture),
  pas au niveau fenêtre. Mécanisme à vérifier : longueur moyenne de contour ajoutée à
  `screen.js`. Audio F (le gros des manqués et des fp) encore en cours.
- **06:37** mécanisme VÉRIFIÉ (même 5 sessions) — longueur du contour, en symboles :

  | borne haute | musique annotée p25/p50/p75 | bruit p25/p50/p75 |
  |---|---|---|
  | 240 (ctl) | 65 / 70 / 74 | 37 / 45 / 49 |
  | 180 | 62 / 65 / 68 | **12** / 35 / 47 |
  | 200 | 64 / 67 / 71 | 29 / 43 / 49 |
  | 220 | 65 / 69 / 72 | 34 / 45 / 50 |

  Sur la musique, le contour ne raccourcit que de ~7 % ; **sur le bruit, le quartile bas
  s'effondre (37 → 12 symboles à 180)**. Un contour de 12 symboles trouve un alignement
  fortuit dans 55 000 réglages → top 1 du bruit gonflé. **Idée E4 — porte sur la
  longueur du contour** (fenêtre vidée si contour < L) : garderait le gain de classement
  d'une borne basse sans la pression sur le bruit. **Testable SANS régénérer** :
  `debug.contour` est dans chaque fenêtre → `v3/gate-contour.js` dérive un dossier.
  (Correction de lecture : `regen-tempo.js` suit l'ordre de sa table FIXTURES, pas
  celui des arguments : bruit avant Audio F, 13th Moon et Korea en dernier.)
- **06:37** `knobs2` recompilé avec l'ordonnée corrigée : contrôle au bit contre
  `fixtures-ctl` (One_of_the_Best) **IDENTICAL**. Crible H6 lancé (`v3/h6-launch.sh` :
  pentes 0,6 / 0,75 / 1,0, ordonnée 3, stride 2, corpus complet → `v3/screen-slope{06,075,10}/`).
  E4 : porte de longueur appliquée à `fixtures-ctl`, L = 20 et 30 → `v3/gate-ctl-L{20,30}/`.
- **06:38** E4 sur le témoin (tempo 240) : **L=20 vide 428/9 482 fenêtres (4,5 %), dont
  6/338 du bruit ; L=30 vide 956 (10,1 %), dont 41/338 du bruit.** À 240 le bruit a peu
  de contours courts (p25 = 37) : la porte y coûte surtout des fenêtres de musique ; elle
  est pensée pour les bornes basses (180 : p25 bruit = 12). Crible fenêtre →
  `v3/screen-e4-ctl.txt` ; chaîne complète (configurations figées) → `v3/e4-ctl-L{20,30}.json`.
- **06:43** **E4 sur le témoin — la porte L=20 est un gain quasi gratuit.**
  - Fenêtre (7 414 annotées) : **L=20 → 0 rang 1 gagné / 0 perdu, 0 / 0 en top 10** :
    aucune des 428 fenêtres vidées ne portait le bon morceau, même en top 10. Bruit top 1
    0,1151 → 0,1095. L=30 → 0 / **20** rangs 1 perdus (p = 1,9e-6), 0 / 27 top 10 ;
    bruit 0,0953.
  - Chaîne complète (fp ; ctl entre parenthèses) :

    | configuration | ctl | L=20 | L=30 |
    |---|---|---|---|
    | production | 311/20 | **311/18** | 311/17 |
    | production a=0,95 | 312/15 | **312/13** | 312/13 |
    | production N=3 | 287/6 | 287/6 | 287/6 |
    | share 0,1101 N2 | 312/18 | 312/17 | 312/16 |
    | nullRatioTailMean 1,0197 N0 | 304/10 | 304/10 | 304/8 |
    | share 0,0959 N2 | 294/4 | 294/4 | 293/4 |
    | share 0,0959 N2 a=0,9 | 304/7 | 304/7 | 304/6 |

    **L=20 : fp −2, −2, 0, −1, 0, 0, 0 — jamais une hausse, rappel inchangé** ; les fp
    retirés sont surtout à Anglade (4 → 2 en production = fantômes des blancs entre sets).
    L=30 : fp −1 à −3, un morceau perdu sur une configuration. Effet absolu modeste mais
    au-dessus du bruit moteur (0,3) et de signe constant.
  - E2 terminé (tous les bras stride 2 complets) → crible complet et porte sur t180 lancés.
- **06:44** **E2 COMPLET (Audio F comprise)** — `v3/screen-e2-full.txt`, 3 692 fenêtres
  annotées communes (stride 2) :

  | borne haute | apparié rang 1 gagnés / perdus | net | p | rang 1 / top 10 | polka | hornpipe | sans rang 1 | retard début p90 | bruit top 1 |
  |---|---|---|---|---|---|---|---|---|---|
  | 240 (ctl) | — | — | — | 73,3 / 78,6 % | 36,4 % | 70,5 % | 18/341 | 26 s | 0,1151 |
  | **180** | **120 / 50** | **+70** | **8,0e-8** | **75,2** / 80,3 % | 40,8 % | 74,6 % | 14/341 | 25 s | 0,1905 |
  | 200 | 86 / 27 | +59 | 2,3e-8 | 74,9 / 80,1 % | 40,2 % | 73,1 % | 14/341 | 22 s | 0,1434 |
  | 220 | 41 / 9 | +32 | 5,6e-6 | 74,2 / 79,6 % | 37,5 % | 71,5 % | 16/341 | 26 s | 0,1256 |

  **H5 confirmée sur tout le corpus, dose-réponse monotone.** 200 perd moitié moins de
  rangs 1 que 180 (27 contre 50) pour un gain net proche : candidat sérieux aussi.
- **06:44** **E4 sur t180** (`v3/screen-e4-t180.txt`) : **la porte L=20 conserve
  EXACTEMENT le gain** (+70, 120/50, mêmes fenêtres) et fait tomber le bruit top 1 de
  0,1905 à **0,0699 — sous le témoin (0,1151)**. 60/169 fenêtres de bruit vidées
  (stride 2), aucune fenêtre porteuse du bon morceau. L=30 : +61 (9 rangs 1 perdus de
  plus), bruit 0,0593.
  **→ « borne 180 + porte L=20 » améliore le classement sur la musique ET réduit la
  pression sur le bruit par rapport à la production.** À juger sur la chaîne complète.
  Régénération complète (stride 1) de 180 et 200 lancée (`pkg-node-tempo`, cohérent avec
  le crible) → `v3/fixtures-t180/`, `v3/fixtures-t200/`, journaux
  `v3/logs/regen-t{180,200}-{F,rest}.log`. Ensuite : porte L=20, configurations figées +
  couverture, contre `gate-ctl-L20` et `fixtures-ctl`.
- **06:45** outillage de l'évaluation finale E5, écrit AVANT de voir les résultats :
  - `v3/arms-compare.js ref.json armB.json …` : par configuration (appariée par label),
    rappel, fp, bruit, **couverture**, écarts au premier bras, détail par session.
  - `v3/e5-floor-sweep.json` : identity, filtre plat on, N=2, plancher 0,16 → 0,32 (pas
    0,02). **Raison** : les bornes basses gonflent aussi les scores sur la musique ; un
    plancher absolu réglé pour l'ancien moteur handicaperait les nouveaux bras. On
    compare donc les COURBES (rappel, fp, couverture) par bras, pas un point.
  - `v3/e5-run.sh` (depuis `Cadence/`) : vérifie les fenêtres de t180 et t200, applique
    la porte L=20 (`gate-t{180,200}-full-L20/`), puis pour 6 bras (ctl, ctl+L20, t180,
    t180+L20, t200, t200+L20) configurations figées → `v3/e5-fixed-<bras>.json` et
    balayage → `v3/e5-floors-<bras>.json` ; comparaisons → `v3/e5-fixed-compare.txt`,
    `v3/e5-floors-compare.txt`. **Reprise après coupure : lancer ce script dès que les
    4 journaux `regen-t180/t200` finissent par « wrote ».**
  - Mémoire mise à jour : la fiche `project_ranking_study.md` signale la bascule moteur.
  - Avancement 06:44 : E3 dur2 et oct050 ont écrit Audio F (768 s), reste Korea ;
    rep4000 Audio F 1 600/1 957 ; H6 Audio F 800-1 000/1 957 ; régénération t180/t200
    démarrée.
- **06:46** **E3, 1re vague, deux bras sur trois** (`v3/screen-e3-partial.txt`, 3 692
  fenêtres annotées, stride 2, contre ctl) :

  | variante | apparié rang 1 gagnés / perdus | net | p | rang 1 | polka | bruit top 1 | contour bruit p25/p50/p75 |
  |---|---|---|---|---|---|---|---|
  | notes ≥ 2 trames (`set_note_filter:0.1,2`) | 102 / 143 | **−41** | 1,0e-2 | 72,2 % | 40,2 % | **0,2531** | **10 / 14 / 22** |
  | repli d'octave < 0,50 | 4 / 0 | +4 | 0,13 | 73,4 % | 36,4 % | 0,1151 | 37 / 45 / 49 |

  **Notes ≥ 2 trames REJETÉ** : classement dégradé (reels, hornpipes, slides), polkas
  +3,8 points seulement, et bruit catastrophique (contours de 14 symboles en médiane :
  les notes très courtes sont surtout du bruit). **Octave 0,50 : sans effet** (non
  significatif). Direction inverse à tester : filtres PLUS stricts — **2e vague E3
  lancée** : notes ≥ 4 trames (`set_note_filter:0.1,4`) et puissance ≥ 0,15
  (`set_note_filter:0.15,3`), `knobs2`, stride 2 → `v3/screen-dur4/`, `v3/screen-pow015/`.
- **06:48** `arms-compare.js` validé sur des sorties connues (production ctl 311/20 →
  L=20 311/18 → L=30 311/17, identique aux tableaux ci-dessus). **Il révèle la COUVERTURE,
  jamais regardée jusqu'ici dans ce journal** :

  | configuration (ctl) | rappel / fp | couverture |
  |---|---|---|
  | production | 311 / 20 | **80,4 %** |
  | **production a=0,95** | **312 / 15** | **92,8 %** |
  | production N=3 | 287 / 6 | 78,7 % |
  | share 0,1101 N2 | 312 / 18 | 81,7 % |
  | nullRatioTailMean 1,0197 N0 | 304 / 10 | 82,3 % |

  **Le plancher d'absence à 0,95 ajoute +12,4 points de couverture**, en plus de −5 fp à
  rappel égal. La porte L=20 est neutre sur la couverture (±0,1 point). Mécanisme H1 :
  une fenêtre où le morceau est absent ne coupe plus le segment, qui couvre alors toute
  la durée au lieu de se fragmenter. **Risque à vérifier** : une couverture qui monte peut
  aussi venir de segments débordant sur le morceau suivant → courbe complète
  a ∈ {0 ; 0,5 ; 0,75 ; 0,9 ; 0,95 ; 0,98} lancée (`v3/absent-curve.json` →
  `v3/absent-curve-ctl.json`).
- **06:48** courbe du plancher d'absence (ctl, production) :

  | a | rappel / fp | couverture | mal placés (Σ sessions) |
  |---|---|---|---|
  | 0 | 311 / 20 | 80,4 % | 24 |
  | 0,5 | 312 / 20 | 81,5 % | 24 |
  | 0,75 | 314 / 18 | 86,1 % | 24 |
  | **0,9** | **314 / 17** | **92,4 %** | 20 |
  | 0,95 | 312 / 15 | 92,8 % | 17 |
  | 0,98 | 310 / 13 | 93,5 % | 17 |

  Monotone, saturée vers 0,9-0,95 ; **à 0,9 les trois objectifs progressent ensemble**
  (+3 morceaux, −3 fp, +12 points de couverture). **Réserve méthodologique** : la
  couverture mesure la part de la durée RÉELLE couverte, pas le DÉBORDEMENT ; un segment
  qui mord sur le morceau suivant garde 100 % et n'est pas « mal placé » (il recouvre
  toujours sa ligne). → ajout à `evalset` de l'**IoU** détection/vérité et des **erreurs
  absolues de début et de fin** (médiane, p90) par morceau trouvé ; courbe rejouée avec.
  E3 1re vague terminée → crible de `screen-rep4000`.
- **06:49** **E3 — présélection 4 000 (`set_num_repass:4000`) : le résultat le plus
  propre de la nuit.** 3 692 fenêtres annotées, stride 2, contre ctl : **rangs 1 gagnés /
  perdus 65 / 7 (+58, p = 7,0e-13)** ; top 10 89 / 15 (+74, p = 5,6e-14). Rang 1 73,3 →
  74,9 % ; polka 36,4 → 41,8 % (top 10 47,8 → 56,5 %) ; jig 70,5 → 72,1 % ; hornpipe
  70,5 → 72,5 %. **Presque aucune perte** : mécanisme du commentaire de `ff_config.rs` (un
  morceau populaire a beaucoup de réglages ; en aligner davantage relève le MEILLEUR
  score du bon morceau). Pas un échange : un coût de calcul (la 2e passe, ~80 % d'une
  requête, double). **Mécanisme distinct du tempo → gains possiblement additifs** :
  crible de la combinaison **borne 180 + présélection 4 000** lancé (`knobs2`, stride 2
  → `v3/screen-t180-rep4000/`), porte L=20 à appliquer ensuite hors ligne.
  `evalset` : qualité temporelle ajoutée à la sortie (`temporal` = IoU moyenne, erreurs
  absolues de début/fin p50/p90) ; `arms-compare.js` l'affiche.
- **06:49** présélection 4 000, lignes bruit et temporelles : **bruit top 1 0,1151 →
  0,1168 (négligeable)**, contours inchangés (seule la requête change) ; sans rang 1
  18 → 16/341 ; fraction de rangs 1 p25 0,60 → 0,64, p50 0,86 → 0,88 ; retard de début
  p90 26 → 25 s. **Gain sans contrepartie mesurable hors coût de calcul.** Courbe du
  plancher d'absence rejouée avec IoU / erreurs de bornes → `v3/absent-curve-ctl-iou.json`.
- **06:51** **courbe du plancher d'absence avec IoU — la réserve était fondée, la
  conclusion change.** (ctl, production ; `evalset` émet désormais `temporal`, validé)

  | a | rappel / fp | couverture | **IoU** | erreur début p50/p90 | erreur fin p50/p90 |
  |---|---|---|---|---|---|
  | 0 | 311 / 20 | 80,4 % | 79,5 % | 4 / 25 s | 3 / 43 s |
  | 0,5 | 312 / 20 | 81,5 % | 80,6 % | 4 / 24 s | 3 / 41 s |
  | **0,75** | **314 / 18** | 86,1 % | **85,0 %** | **3 / 19 s** | **3 / 18 s** |
  | 0,9 | 314 / 17 | 92,4 % | 80,7 % | 5 / **76 s** | 3 / 18 s |
  | 0,95 | 312 / 15 | 92,8 % | 80,7 % | 5 / **88 s** | 3 / 17 s |
  | 0,98 | 310 / 13 | 93,5 % | 80,4 % | 5 / 85 s | 3 / 18 s |

  À a ≥ 0,9, la couverture monte parce que les détections **commencent 76 à 88 s trop tôt**
  au 9e décile (débordement sur le blanc ou le morceau précédent) ; l'IoU retombe au niveau
  de la production. **Optimum temporel : a = 0,75** — IoU +5,5 points, erreur de fin p90
  divisée par plus de deux (43 → 18 s), +3 morceaux, −2 fp. L'entrée de 06:48 et la
  synthèse sont corrigées en conséquence. Affinage 0,6-0,85 lancé.
- **06:52** affinage (`v3/absent-fine-ctl.json`) :

  | a | rappel / fp | couverture | IoU | début p50/p90 | fin p50/p90 |
  |---|---|---|---|---|---|
  | 0,6 | 312 / 18 | 83,0 % | 82,0 % | 4 / 24 s | 3 / 36 s |
  | 0,65 | 313 / 18 | 83,5 % | 82,5 % | 4 / 21 s | 3 / 32 s |
  | 0,7 | 313 / 17 | 85,3 % | 84,3 % | 3 / 19 s | 3 / 20 s |
  | 0,75 | 314 / 18 | 86,1 % | 85,0 % | 3 / 19 s | 3 / 18 s |
  | **0,8** | **315 / 19** | 87,7 % | **86,5 %** | **3 / 18 s** | **3 / 17 s** |
  | 0,85 | 315 / 19 | 92,1 % | 81,9 % | 5 / **65 s** | 3 / 17 s |

  **Loi du seuil (explique la falaise entre 0,80 et 0,85)** : dans une fenêtre d'absence,
  rester sur un morceau coûte −log(a) de plus que son observation présente, rester en
  UNKNOWN coûte `unknownStayPenalty` = 0,2. **−log(0,80) = 0,223 > 0,2 mais −log(0,85) =
  0,163 < 0,2** : au-delà de **a = e^(−unknownStay) = 0,819**, attendre « dans » un morceau
  devient moins cher qu'attendre en UNKNOWN, et les détections s'étalent sur les blancs.
  → **Paramétrer par la marge : −log(a) = unknownStay + ε**, pas par a brut (la règle
  suit les poids s'ils changent). Production : a = 0,8 est le meilleur point (IoU 86,5 %,
  +4 morceaux, −1 fp, bornes p90 18/17 s) mais colle au seuil ; a = 0,75 garde de la marge
  (IoU 85,0 %). **H6 terminé** → crible. Régénération complète du bras présélection 4 000
  lancée (`knobs2`, tempo par défaut) → `v3/fixtures-rep4000/`.
- **06:52** **H6 (pente du modèle de tempo) — mécanisme réel, mauvais remède.**
  (`v3/screen-h6.txt`, 3 692 fenêtres annotées, stride 2, contre ctl)

  | variante | apparié rang 1 | net | p | rang 1 | polka | slip jig | slide | bruit top 1 | contour bruit p50 |
  |---|---|---|---|---|---|---|---|---|---|
  | ctl (pente 0,5) | — | — | — | 73,3 % | 36,4 % | 84,0 % | 69,6 % | 0,1151 | 45 |
  | pente 0,6 | 33 / 19 | +14 | 7,0e-2 | 73,7 % | 38,0 % | 84,5 % | 64,3 % | 0,1330 | 45 |
  | pente 0,75 | 77 / 59 | +18 | 0,14 | 73,8 % | 40,8 % | 83,0 % | 60,7 % | 0,1796 | 38 |
  | pente 1,0 | 116 / 122 | −6 | 0,75 | 73,2 % | 44,0 % | 79,6 % | 55,4 % | **0,2615** | **13** |
  | borne 180 | 120 / 50 | **+70** | 8,0e-8 | 75,2 % | 40,8 % | 86,9 % | 67,9 % | 0,1905 | 35 |
  | présélection 4 000 | 65 / 7 | **+58** | 7,0e-13 | 74,9 % | 41,8 % | 86,9 % | 69,6 % | 0,1168 | 45 |

  La pente pénalise les notes longues PARTOUT : les polkas y gagnent (36 → 44 %), mais les
  mesures composées lentes, dont le tempo était juste, chutent (slip jig 84 → 80 %, slide
  70 → 55 %) et le bruit s'effondre en contours de 13 symboles. **La borne haute ne coupe
  que la queue où le sélecteur se trompe → elle domine.** H6 : mécanisme confirmé (gain
  polka), remède par repondération rejeté.
- **06:53** E5 étendu AVANT résultats : `v3/e5-configs-temporal.json` (production,
  a = 0,75, a = 0,8, N=3 a=0,75, planchers 0,22 / 0,24 / 0,26 à a=0,75) ; `e5-run.sh`
  ajoute le bras `rep4000` (+ porte L=20) s'il est complet, et un 3e jeu de sorties
  `v3/e5-temporal-<bras>.json` → `v3/e5-temporal-compare.txt`. Première régénération
  complète de rep4000 **échouée** (commande lancée depuis `v3/`, chemins relatifs
  invalides, journaux non créés) → **relancée depuis `Cadence/`** à 06:53.
  Avancement 06:52 : t180/t200 Audio F 2 000/3 914 ; E3 dur4/pow015 Audio F 1 600/1 957 ;
  combinaison t180+rep4000 démarrée.
- **06:56** **E3, 2e vague — filtres de notes plus stricts : REJETÉS.**
  (`v3/screen-e3-wave2.txt`, 3 692 fenêtres annotées, stride 2, contre ctl)

  | variante | apparié rang 1 | net | p | rang 1 | polka | bruit top 1 | contour musique p50 | contour bruit p50 |
  |---|---|---|---|---|---|---|---|---|
  | ctl (3 trames, 0,10) | — | — | — | 73,3 % | 36,4 % | 0,1151 | 65 | 45 |
  | notes ≥ 4 trames | 105 / 163 | −58 | 4,8e-4 | 71,7 % | 42,9 % | 0,1864 | 56 | 23 |
  | puissance ≥ 0,15 | 55 / 119 | −64 | 1,4e-6 | 71,6 % | 35,3 % | 0,1528 | 61 | 33 |
  | (rappel) notes ≥ 2 trames | 102 / 143 | −41 | 1,0e-2 | 72,2 % | 40,2 % | 0,2531 | 73 | 14 |

  **Les filtres de notes par défaut sont un optimum local dans les deux directions.** Le
  bruit empire dans les trois variantes : filtrer plus retire des notes et RACCOURCIT les
  contours (4 trames : bruit p50 23) — encore la longueur du contour qui pilote le score
  sur le bruit. Seul signal secondaire : les polkas aiment les notes ≥ 4 trames (+6,5
  points) — cohérent avec leurs notes plus longues, mais payé partout ailleurs.
  Processeur libéré → crible **présélection 8 000** lancé (plateau ou encore du gain ?)
  → `v3/screen-rep8000/`.
- **06:59** **coût de la présélection** (`v3/bench-repass.js`, `v3/bench-repass-out.txt`) :
  mesure APPARIÉE dans une seule instance `knobs2`, 60 fenêtres de tabac (1 sur 7), tailles
  alternées fenêtre par fenêtre (la contention pèse pareil), requêtes seules (repli
  d'octave compris), machine chargée par ~14 autres processus :

  | num_repass | médiane / fenêtre | facteur |
  |---|---|---|
  | 2 000 | 168 ms | ×1,00 |
  | 4 000 | 252 ms | **×1,50** |
  | 8 000 | 404 ms | ×2,40 |

  Pas ×2 à 4 000 : la présélection par quadrigrammes a un coût fixe, seule la 2e passe
  croît linéairement. **Pour l'app** : loin du pas de 5 s, même sur un téléphone plusieurs
  fois plus lent. Chiffres absolus gonflés par la contention, rapports fiables.
  Avancement 06:57 : t180/t200 Audio F 3 600/3 914 (fin imminente → `e5-run.sh`) ;
  combinaison t180+rep4000 Audio F 1 600/1 957 ; rep4000 complet Audio F 600/3 914 ;
  rep8000 démarré.
- **06:59** **lanceur automatique d'E5 armé** (tâche de fond depuis `Cadence/`) : attend
  8 fichiers de fenêtres dans `fixtures-t180/` ET `fixtures-t200/` et plus aucun
  `regen-tempo.js` écrivant dans ces dossiers, puis exécute `v3/e5-run.sh` →
  `v3/logs/e5-run.log`. (Chaque fichier de fenêtres n'est écrit qu'une fois sa session
  entièrement analysée : le compte suffit comme garde-fou.) Le bras rep4000 ne sera pas
  inclus (encore incomplet) : à évaluer séparément une fois fini.
  **Reprise après coupure** : si `v3/logs/e5-run.log` est absent ou ne se termine pas par
  les tableaux de `arms-compare`, relancer `bash experiments/ranking-study/v3/e5-run.sh`
  depuis `Cadence/`.
- **07:02** **COMBINAISON tempo 180 + présélection 4 000** (`v3/screen-combo.txt`, 3 692
  fenêtres annotées, stride 2, contre ctl) :

  | variante | apparié rang 1 | net | p | top 10 net | rang 1 | polka rang 1 / top 10 | sans rang 1 | bruit top 1 |
  |---|---|---|---|---|---|---|---|---|
  | ctl | — | — | — | — | 73,3 % | 36,4 / 47,8 % | 18 | 0,1151 |
  | t180 | 120 / 50 | +70 | 8,0e-8 | +63 | 75,2 % | 40,8 / 54,3 % | 14 | 0,1905 |
  | rep4000 | 65 / 7 | +58 | 7,0e-13 | +74 | 74,9 % | 41,8 / 56,5 % | 16 | 0,1168 |
  | **t180 + rep4000** | **153 / 48** | **+105** | **5,7e-14** | **+110** | **76,2 %** | **45,7 / 60,3 %** | **13** | 0,1934 |
  | **t180 + rep4000 + L20** | 153 / 48 | +105 | 5,7e-14 | +110 | 76,2 % | 45,7 / 60,3 % | 13 | **0,0706** |

  **Les deux leviers se cumulent** (sous-additif : 128 attendu, 105 obtenu — une partie des
  fenêtres rattrapées sont communes). La porte L=20 ne touche AUCUNE fenêtre de musique et
  ramène le bruit sous le témoin. **Meilleur candidat moteur.** Régénération complète
  (stride 1) de la combinaison lancée → `v3/fixtures-t180-rep4000/`, journaux
  `v3/logs/regen-t180-rep4000-{F,rest}.log`. Régénération t180/t200 TERMINÉE → E5 en route.
- **07:02** **E5 démarré automatiquement à 07:02:09** (`v3/logs/e5-run.log`). Porte L=20 sur
  les régénérations COMPLÈTES : **t180 → 600/9 482 fenêtres vidées (6,3 %), dont 121/338 du
  bruit** ; **t200 → 504/9 482 (5,3 %), dont 44/338 du bruit** (témoin : 428, dont 6 du
  bruit). Durée attendue ~6-8 min (6 bras × 3 jeux de configurations). Lanceur **E6** écrit
  avant résultats : `v3/e6-run.sh` (bras rep4000 et t180+rep4000, avec et sans porte, mêmes
  trois jeux, comparés à ctl / ctlL20 / t180L20).
- **07:09** **E5 TERMINÉ — premier verdict sur la chaîne complète** (`v3/e5-fixed-compare.txt`,
  `v3/e5-temporal-compare.txt`, `v3/e5-floors-compare.txt`, `v3/logs/e5-run.log`).
  Extraits (rappel / fp, IoU moyenne, erreurs de début et de fin p50/p90) :

  | configuration | ctl | ctl + L20 | t180 | t180 + L20 | t200 | t200 + L20 |
  |---|---|---|---|---|---|---|
  | production | 311/20 · 79,5 % · 4/25 · 3/43 | 311/18 · 79,5 % | 312/16 · 81,1 % · 4/24 · 3/37 | 312/15 · 81,1 % | 315/15 · 80,2 % · 4/23 · 3/43 | 315/14 · 80,2 % |
  | production a=0,75 | 314/18 · 85,0 % · 3/19 · 3/18 | 314/16 · 85,0 % | 315/14 · 86,4 % | 315/13 · 86,4 % · 3/18 · 3/17 | 318/14 · 85,6 % | 318/13 · 85,6 % · 3/18 · 3/17 |
  | **production a=0,8** | 315/19 · 86,5 % · 3/18 · 3/17 | 315/16 · 86,5 % | 318/13 · 87,7 % | **318/13 · 87,6 %** · 3/18 · 3/17 | 319/15 · 87,0 % · 3/14 | **319/13 · 87,0 % · 3/14 · 3/17** |
  | production N=3 a=0,75 | 306/7 · 86,6 % · 3/18 · 3/16 | 306/7 | 307/7 · 88,1 % · 3/17 · 3/15 | 307/7 · 88,1 % | 307/7 · 87,8 % · 3/14 · 3/15 | 307/7 · 87,8 % |
  | plancher 0,26 a=0,75 | 309/13 · 84,3 % | 309/12 | 309/11 · 85,8 % | 309/11 | 312/10 · 85,1 % | 312/10 · 85,1 % |
  | production a=0,95 | 312/15 · 80,7 % · 5/**88** | 312/13 · 79,8 % · 5/96 | 316/11 · 81,9 % · 4/74 | 316/12 · 80,4 % | 315/13 · 81,8 % · 4/78 | 315/12 · 81,1 % · 4/90 |
  | production N=3 | 287/6 · 77,7 % | 287/6 | 291/4 · 80,1 % | 291/4 | 287/5 · 79,8 % | 287/5 |
  | share 0,1101 N2 | 312/18 · 80,9 % | 312/17 | 314/14 · 82,4 % | 314/13 | 315/17 · 81,8 % | 315/16 |
  | nullRatioTailMean 1,0197 N0 | 304/10 · 80,8 % | 304/10 | 305/13 · 82,2 % | 305/12 | 305/8 · 81,6 % | 305/7 |

  **Lecture.**
  1. **Meilleur point global : t200 + L20 + a = 0,8 → 319 / 13, IoU 87,0 %, bornes p90
     14 s / 17 s** contre la production actuelle 311 / 20, IoU 79,5 %, 25 s / 43 s :
     **+8 morceaux, −7 fp, +7,5 points d'IoU, erreur de début p90 ÷1,8, de fin ÷2,5.**
     t180 + L20 + a = 0,8 est à égalité : 318 / 13, IoU 87,6 %.
  2. **Part du MOTEUR seul** (même post-traitement, porte L20 des deux côtés), a = 0,8 :
     ctl+L20 315/16 · 86,5 % → t200+L20 319/13 · 87,0 % (+4, −3, +0,5 pt) ; t180+L20
     318/13 · 87,6 % (+3, −3, +1,1 pt). **Sur les configurations identity, le moteur gagne
     partout** (rappel ≥, fp ≤, IoU +0,5 à +2,4 points), au-dessus du bruit de fond (±1).
  3. **La porte L20 retire 1 à 3 fp sans jamais toucher le rappel ni l'IoU**, sauf à
     a = 0,95 où les détections débordent déjà (IoU −0,8 point).
  4. **Exception** : nullRatioTailMean sans porte N (N0) prend +2 à +3 fp avec t180 — une
     transformation relative, sensible au changement d'échelle des scores ; t200 lui
     retire au contraire 2 à 3 fp.
  5. **a = 0,95 confirme le débordement sur tous les bras** (erreur de début p90 74-96 s).
  Reste à vérifier sur les courbes du balayage de plancher que ce n'est pas un simple
  décalage du point de fonctionnement.
- **07:10** **courbes du balayage de plancher** (`v3/floors-curves.js` →
  `v3/e5-floors-curves.txt` ; identity, filtre plat on, N=2, SANS plancher d'absence) :

  | budget fp | ctl | ctl + L20 | t180 | t180 + L20 | t200 | t200 + L20 |
  |---|---|---|---|---|---|---|
  | ≤ 10 | — | — | 299 · 81,0 % | 299 · 81,0 % | 291 · 81,5 % | 291 · 81,5 % |
  | ≤ 12 | 291 · 79,5 % | 291 · 79,5 % | **307** · 81,4 % | 307 · 81,4 % | **308** · 80,5 % | 308 · 80,5 % |
  | ≤ 15 | 305 · 79,2 % | 305 · 79,2 % | 311 · 81,4 % | 312 · 81,4 % | **315** · 80,4 % | **315** · 80,4 % |
  | ≤ 20 | 311 · 79,6 % | 311 · 79,6 % | 312 · 81,4 % | 312 · 81,4 % | **315** · 80,4 % | 315 · 80,4 % |

  (meilleur rappel sous le budget, IoU du point retenu.) **Le gain du moteur DÉPLACE TOUTE
  LA COURBE** : à fp ≤ 12, +16 (t180) à +17 (t200) morceaux ; t180 garde +1,5 à +2,5 points
  d'IoU à tous les planchers. Ce n'est pas un décalage du point de fonctionnement.
  **Réserve (validité hors échantillon)** : borne 180/200 et L = 20 ont été choisis sur le
  corpus qui les juge. Peu de choix discrets → optimisme de sélection faible, mais les gains
  sont **concentrés** : à a = 0,8 avec L20 des deux côtés, t200 contre ctl par session —
  Korea =, Anglade =, **tabac −1 morceau**, auberge −1 fp, One_of_the_Best =, **13th Moon
  +2 morceaux**, **Audio F +3 morceaux −2 fp**. Majoritairement positif, pas uniforme ;
  à revalider sur une session nouvelle avant toute mise en production.
- **07:09** avancement (`date` 07:08:55) : régénération rep4000 Audio F 3 600/3 914, reste
  bruit / 13th Moon / Korea (fin ~07:15) ; régénération t180+rep4000 Audio F 1 400/3 914
  (fin ~07:25) ; crible rep8000 Audio F 1 600/1 957 (fin ~07:14). **Lanceur automatique
  d'E6 armé** (depuis `Cadence/`) : attend 8 fichiers de fenêtres dans `fixtures-rep4000/`
  ET `fixtures-t180-rep4000/` et plus aucun `regen-tempo.js` écrivant dedans, puis
  exécute `v3/e6-run.sh` → `v3/logs/e6-run.log`, `v3/e6-{fixed,floors,temporal}-compare.txt`.
  **Reprise après coupure** : si `v3/logs/e6-run.log` est absent ou incomplet, relancer
  `bash experiments/ranking-study/v3/e6-run.sh` depuis `Cadence/` une fois les deux
  dossiers complets.
- **09:06** (reprise après une pause de ~2 h côté utilisateur ; tous les calculs de fond
  étaient terminés) **crible présélection 8 000** (`screen.js`, 3 692 fenêtres annotées,
  stride 2, contre ctl) :

  | variante | apparié rang 1 | net | p | top 10 net | sans rang 1 | retard début p90 | fraction rang 1 p25 | bruit top 1 |
  |---|---|---|---|---|---|---|---|---|
  | rep4000 | 65 / 7 | +58 | 7,0e-13 | +74 | 16 | 25 s | 0,64 | 0,1168 |
  | **rep8000** | **100 / 15** | **+85** | **1,4e-16** | **+114** | 15 | 23 s | 0,67 | 0,1176 |
  | t180 + rep4000 | 153 / 48 | +105 | 5,7e-14 | +110 | 13 | 25 s | 0,64 | 0,1934 |

  **Pas de plateau à 4 000** : 8 000 ajoute encore +27 rangs 1 nets (+40 en top 10), toujours
  sans effet sur le bruit. Coût : requête ×2,4 (mesuré à 06:59).
- **09:06** **E6 TERMINÉ** (`v3/e6-{fixed,floors,temporal}-compare.txt`, `v3/logs/e6-run.log`) :

  | configuration | ctl | ctl + L20 | t180 + L20 | rep4000 + L20 | t180 + rep4000 | **t180 + rep4000 + L20** |
  |---|---|---|---|---|---|---|
  | production | 311/20 · 79,5 % · 25/43 s | 311/18 · 79,5 % | 312/15 · 81,1 % · 24/37 s | 313/17 · 79,8 % · 27/43 s | 313/15 · 82,1 % | **313/14 · 82,1 % · 24/31 s** |
  | production a=0,75 | 314/18 · 85,0 % · 19/18 s | 314/16 | 315/13 · 86,4 % | 314/15 · 86,3 % · 16/17 s | 315/13 · 87,2 % | **315/12 · 87,2 % · 16/16 s** |
  | **production a=0,8** | 315/19 · 86,5 % · 18/17 s | 315/16 | 318/13 · 87,6 % · 18/17 s | 316/14 · 87,5 % · 16/16 s | 318/13 · 88,3 % · 14/14 s | **318/12 · 88,2 % · 14/15 s** |

  (rappel/fp · IoU moyenne · erreurs de début/fin p90.) Courbes du plancher (sans plancher
  d'absence) : fp ≤ 15 → t180+rep4000+L20 313/14 · 82,4 % contre t180+L20 312/15 · 81,4 % et
  ctl 305/15 · 79,2 %.
  **Lecture** : au niveau fenêtre rep4000 valait +58 rangs 1 ; sur la chaîne il ne vaut plus
  que ~+1 morceau, mais **−1 fp, +0,6 à +1,0 point d'IoU et des bornes plus nettes** (début
  p90 18 → 14 s, fin 17 → 15 s en combinaison) : la chaîne est près de son plafond de rappel
  (329), les rangs 1 supplémentaires servent surtout à tenir les segments. **Meilleur bras à
  ce jour : t180 + rep4000 + L20 + a = 0,8 → 318 / 12, IoU 88,2 %, bornes p90 14 / 15 s**
  (t200 + L20 + a = 0,8 garde le meilleur rappel : 319 / 13, 87,0 %, 14 / 17 s).
  Régénérations complètes **t200 + rep8000** et **t180 + rep8000** lancées (`knobs2`, 3
  processus chacune) → `v3/fixtures-t{200,180}-rep8000/`, journaux
  `v3/logs/regen-t{200,180}-rep8000-{F,A,B}.log`. `e6-run.sh` rendu paramétrable
  (`ARMS="t200-rep8000 t180-rep8000"`).
- **09:08** **robustesse par session du meilleur bras** (t180 + rep4000 + L20 + a = 0,8), lue
  dans `v3/e6-temporal-compare.txt` (trouvés / fp) :

  | session | production actuelle (ctl, a = 0) | ctl, a = 0,8 | **t180 + rep4000 + L20, a = 0,8** |
  |---|---|---|---|
  | Korea | 31 / 0 | 31 / 0 | 31 / 0 |
  | Anglade | 35 / 4 | 35 / 4 | 35 / **2** |
  | tabac | 21 / 5 | 23 / 6 | 22 / 5 |
  | auberge | 29 / 0 | 30 / 1 | 30 / 0 |
  | One_of_the_Best | 25 / 0 | 25 / 0 | 25 / 0 |
  | 13th Moon | 35 / 1 | 37 / 1 | **39** / 1 |
  | Audio F | 135 / 10 | 134 / 7 | **136 / 4** |

  **Contre la production actuelle, AUCUNE session ne recule** (rappel ≥ et fp ≤ partout) ;
  les gains viennent surtout de 13th Moon (+4), Audio F (+1, −6 fp) et Anglade (−2 fp).
  Contre ctl au même plancher d'absence (part du moteur seul) : tabac −1 morceau −1 fp,
  les autres ≥. Le moteur est donc robuste par session face à la production ; son apport
  propre reste concentré sur 13th Moon et Audio F.
- **09:08** **E7 armé** : lanceur automatique (depuis `Cadence/`) qui attend 8 fichiers dans
  `fixtures-t200-rep8000/` et `fixtures-t180-rep8000/` et plus aucun `regen-tempo.js … rep8000`,
  puis exécute `ARMS="t200-rep8000 t180-rep8000" OUT=e7 EXTRA_REF="t200L20 t180-rep4000L20"
  bash v3/e6-run.sh` → `v3/logs/e7-run.log`, `v3/e7-{fixed,floors,temporal}-compare.txt`
  (les comparaisons d'E6 ne sont pas écrasées : préfixe de sortie `OUT`). **Reprise après
  coupure** : même commande depuis `Cadence/`.
- **09:09** **validation hors échantillon des choix moteur** (`v3/loso-arms.js` →
  `v3/loso-arms-out.txt`). Candidats : les 220 couples (bras, configuration) évalués en E5/E6
  (ctl, ctlL20, t180, t180L20, t200, t200L20, rep4000, rep4000L20, t180-rep4000,
  t180-rep4000L20 × configurations figées, balayage du plancher, configurations temporelles).
  Une session dehors ; sélection du meilleur rappel − λ·fp sur les 6 autres (ex-aequo
  moyennés) ; mesure sur la 7e. La production (ctl, production) ne demande aucune sélection.

  | λ | hors échantillon | production | score − production | choix par pli |
  |---|---|---|---|---|
  | 0,5 | **317,3 / 13,8** | 311 / 20 | **+9,4** | t200L20 a=0,8 ×5, t200L20 a=0,75 ×1, 4 ex-aequo ×1 |
  | 1 | 311,9 / 12,9 | 311 / 20 | +8,0 | {t200L20, t180-rep4000L20} dans tous les plis |
  | 2 | 309,8 / 12,2 | 311 / 20 | +14,3 | t200 / t200L20 ×4, t180-rep4000 ×2, … |

  **Les choix moteur + plancher d'absence se GÉNÉRALISENT à tous les λ**, y compris au λ bas
  qui correspond à la préférence produit (+6,3 morceaux, −6,2 fp sur des sessions jamais
  vues). Contraste direct avec la campagne de recuit sur la chaîne aval (09-13 05:56-06:00),
  qui ne battait pas la production hors échantillon au λ bas. Sélection stable d'un pli à
  l'autre → faible optimisme de sélection. Limite : l'IoU n'est stockée qu'en agrégat, la
  validation hors échantillon porte sur (rappel, fp) seulement.
- **09:11** pour lever cette limite : `evalset.test.ts` écrit désormais aussi `perT` = pour
  chaque session [somme des IoU des morceaux trouvés, nombre de morceaux trouvés avec une
  plage]. Rejeu des 10 bras d'E5/E6 × 3 jeux de configurations lancé en tâche de fond, qui
  réécrit `v3/e5-{fixed,floors,temporal}-<bras>.json` (calcul déterministe : mêmes chiffres +
  le nouveau champ). Sauvegarde préalable : `v3/e5-backup-before-perT/`. Vérification
  automatique en fin de rejeu (`v3/check-perT.js`) : label, rappel, fp, bruit, couverture,
  `per` et `temporal` doivent être identiques à la sauvegarde. E7 utilisera le même code.
  Ensuite : validation hors échantillon étendue à l'IoU.
- **09:20** rejeu terminé (09:10 → 09:19) : **30 fichiers comparés, 0 différence, 230 lignes
  avec `perT`**. **Validation hors échantillon avec IoU** (`v3/loso-arms-iou.js` →
  `v3/loso-arms-iou-out.txt`, 220 candidats, 10 bras ; sélection sur 6 sessions par
  rappel − λ·fp + κ·IoU moyenne en points ; IoU hors échantillon regroupée sur les morceaux
  trouvés des 7 sessions laissées dehors) :

  | κ | λ | hors échantillon rappel / fp | IoU hors échantillon | choix dominant |
  |---|---|---|---|---|
  | — | — | production 311 / 20 | 79,5 % | (aucune sélection) |
  | 0 | 0,5 | 317,3 / 13,8 | 86,8 % | t200L20 a=0,8 (5 plis sur 7) |
  | 0 | 1 | 311,9 / 12,9 | 87,3 % | t200L20 / t180-rep4000L20 ex-aequo |
  | 0 | 2 | 309,8 / 12,2 | 88,7 % | t200 / t180-rep4000 |
  | **0,5** | **0,5** | **318,0 / 12,5** | **88,2 %** | **t180-rep4000L20 a=0,8** |
  | 0,5 | 1 | 310,0 / 12,5 | 89,7 % | t180-rep4000L20 a=0,8 |
  | 0,5 | 2 | 310,0 / 11,0 | 89,6 % | t180-rep4000L20 a=0,8 |
  | 1 | 0,5 | 313,0 / 12,5 | 88,9 % | t180-rep4000L20 a=0,8 |
  | 1 | 1 | 310,0 / 12,5 | 89,7 % | t180-rep4000L20 a=0,8 |
  | 1 | 2 | 310,0 / 11,0 | 89,7 % | t180-rep4000L20 a=0,8 |

  **Toutes les règles battent la production hors échantillon sur les TROIS objectifs à la
  fois** (fp −6 à −9, IoU +7,3 à +10,2 points ; rappel +7 à −1). Dès que l'IoU entre dans
  le critère, le choix se stabilise sur **t180 + rep4000 + L20 + a = 0,8** — le bras qui
  menait déjà en IoU et en bornes sur le corpus complet. **C'est la recommandation.**
- **09:21** rapport de synthèse rédigé (page HTML, brouillon dans le scratchpad de session
  `moteur-folkfriend-rapport.html`) ; publication prévue après E7 pour y inclure la
  présélection 8 000. Deux erreurs corrigées à la relecture : durée du corpus **12,7 h**
  (et non 29 h) ; repondération du modèle de tempo : slides −14 points, slip jigs −4.
  Avancement 09:20 : régénérations rep8000, toutes sessions écrites sauf Audio F
  (2 000-2 200/3 914) → E7 vers 09:35-09:40.
- **09:23** vérification pour le rapport : `Cadence/vendor/folkfriend/` embarque **deux builds**,
  `folkfriend_bg.wasm` (sans SIMD, défaut) et `folkfriend_bg_simd.wasm` (`+simd128`, ~1,7×),
  compilés en `--target web` (procédure dans son `README.md`). **Toutes les mesures de coût de
  cette nuit viennent du build Node SANS SIMD** ; la seconde passe (Needleman-Wunsch) étant la
  partie accélérée par SIMD, le surcoût de la présélection (×1,5 à 4 000) est à remesurer sur le
  build SIMD de l'app. Rapport précisé en conséquence. Correction de lecture : à 09:20 le groupe A
  des régénérations rep8000 n'avait pas fini (auberge puis bruit restaient) ; à 09:23 Audio F
  2 800/3 914 dans les deux bras → fin ~09:28, E7 ~09:35.
- **09:28** régénérations t200 + rep8000 et t180 + rep8000 TERMINÉES (8 fichiers de fenêtres
  chacune). **E7 démarré automatiquement à 09:28:05** (`v3/logs/e7-run.log`) ; porte L=20 sur
  t200 + rep8000 : 504/9 482 fenêtres vidées, dont 44/338 du bruit. À la fin : lire
  `v3/e7-{fixed,floors,temporal}-compare.txt`, relancer `v3/loso-arms-iou.js` (inclut les bras
  rep8000 par défaut), compléter et publier le rapport.
- **09:34** **E7 TERMINÉ** (`v3/e7-{fixed,floors,temporal}-compare.txt`, `v3/logs/e7-run.log`) —
  présélection 8 000 sur la chaîne complète, a = 0,8 (rappel / fp · IoU · bornes p90) :

  | bras | a = 0,75 | a = 0,8 |
  |---|---|---|
  | t180 + rep4000 + L20 | 315/12 · 87,2 % · 16/16 s | **318/12 · 88,2 % · 14/15 s** |
  | t200 + rep8000 + L20 | 319/14 · 86,8 % · 16/15 s | 320/14 · 88,1 % · 14/15 s |
  | **t180 + rep8000 + L20** | 318/13 · 87,0 % · 17/15 s | **320/13 · 88,2 % · 16/15 s** |

  Courbes du plancher (sans plancher d'absence) : fp ≤ 10 → **t200+rep8000+L20 309/10**
  contre t180+rep4000+L20 299/10 et t200+L20 291/10 ; fp ≤ 15 → 316/14 contre 313/14.
  **Validation hors échantillon sur 14 bras / 308 candidats** (`v3/loso-arms-iou-e7-out.txt`) :
  κ = 0,5, λ = 0,5 → **320,0 / 13,5, IoU 88,2 %** (choix : t180 + rep8000 + L20 a = 0,8) ;
  κ = 0,5, λ = 1 → 313,0 / 13,5, IoU 89,7 % ; κ = 1, λ = 2 → 313,0 / 11,0, IoU 89,8 %.
  **Piège confirmé** : sans IoU dans le critère (κ = 0, λ = 1), la sélection prend parfois
  a = 0,95 (débordement) et l'IoU hors échantillon tombe à 83,2 %.
  **Lecture** : 8 000 apporte **+2 morceaux pour +1 fp à IoU égale** au prix d'une requête ×2,4
  (contre ×1,5 à 4 000), avec un vrai gain à faible budget de fp. **Recommandation inchangée :
  t180 + rep4000 + L20 + a = 0,8** (meilleur compromis coût / fp / IoU) ; **option : rep8000**
  si le surcoût mesuré sur le build SIMD de l'app est acceptable.
- **09:36** **rapport de synthèse publié** : https://claude.ai/code/artifact/11d53495-4685-40ec-8646-eeee3d84bb96
  (source : scratchpad de session, `moteur-folkfriend-rapport.html`). Contenu : recommandation et
  ses cinq chiffres, courbe rappel / fp du balayage de plancher, six résultats établis, tableau
  levier par levier, validation hors échantillon (308 candidats), pistes réfutées, réserves,
  reproduction. **Plus aucun calcul en cours.** Suites possibles, non lancées : recompiler les deux
  builds de `vendor/folkfriend` avec les réglages et mesurer le coût sur le build SIMD ; valider sur
  une 8e session annotée ; porter le plancher d'absence et la porte de contour dans `Cadence/src`
  (décision de conception à prendre avec l'utilisateur).

## Intégration en production (13:00 → , demandée par l'utilisateur)

Mandat : exposer les variables optimisées dans le WASM (détecteur générique, défauts
d'origine), les régler depuis Cadence avec la mention « valeurs optimales à ce jour ».
- **13:14** fait : setters Rust documentés (+ `set_min_query_length` côté `QueryEngine`,
  défaut 0) ; builds web scalaire + SIMD installés dans `vendor/folkfriend` (glue identique
  une fois triée), build Node dans `noise-study/wasm-node` (sauvegardes :
  `v3/install-backup/`) ; `sessionConfig.ts` → `FF_TEMPO_MIN_BPM` 60, `FF_TEMPO_MAX_BPM`
  180, `FF_QUERY_REPASS_SIZE` 4000, `FF_MIN_QUERY_LENGTH` 20 (documentés) ; `ffWorker.ts`
  les applique ; `noise-study/lib/wasmClient.js` lit les mêmes constantes ;
  `detectionTemporalConfig.ts` → `absentObservationRatio?: 0.8` (loi du seuil documentée) ;
  `observationScore` l'applique ; harnais de l'étude rendu explicite (rejoué : 6/6 identique) ;
  README du vendor mis à jour ; `tsc --noEmit` OK.
- **13:16** **PROBLÈME : 2 échecs de l'oracle `viterbiStreamingEquivalence.test.ts`**
  (« segment count: streaming=6 reference=5 »). Cause : la production n'utilise QUE
  `StreamingViterbiDecoder` (direct, import, finalisation, reprise), dont le théorème
  d'exactitude suppose qu'un morceau admis tardivement a un historique en log(epsilon)
  qui ne gagne jamais. Avec le plancher d'absence (log 0,16 = −1,8) il devient compétitif →
  le flux diverge du décodage depuis zéro — celui que l'étude a mesuré. Recalculer depuis
  zéro à chaque admission rétablirait l'exactitude mais ramènerait le coût quadratique.
  **Correction retenue (modèle)** : une absence n'est bon marché qu'APRÈS l'admission du
  morceau (premier score ≥ minCandidateProbability) ; avant, traitement inchangé et
  observations pré-admission ignorées par les décodeurs depuis zéro → cas exact du
  théorème, flux = lot = référence. À remesurer sur la chaîne complète (la sémantique
  change légèrement par rapport à l'étude).
- **13:20** contrôle A : build Node de production (`pkg-node-prod`), AUCUN réglage, contre
  `fixtures-ctl` (One_of_the_Best, 435 fenêtres) → **IDENTICAL**. Contrôle B (corpus complet
  avec les appels de `ffWorker`) en cours → `v3/fixtures-prod/`.
  **Conception détaillée de la correction** (`viterbiDetector.ts`) :
  1. `SlotSpace.admitAt: Int32Array` — slot → fenêtre d'admission (UNKNOWN : 0). Source :
     `timeline.admittedAt` si fourni, sinon dérivé de la ligne creuse (première entrée avec
     score ≥ `cfg.minCandidateProbability`). Stable d'un préfixe à l'autre.
  2. `computeColumn(…, t, epsScore)` : état non admis à `t` → observation IGNORÉE et plancher
     epsilon d'origine (`observationScoreFn(0)` ou log ε, SANS le ratio) ; admis → observation
     réelle si présente, sinon plancher d'absence.
  3. Décodeur de référence : même règle, même dérivation.
  4. Preuve : avant admission, l'historique d'un état est une chaîne pure en log ε (−13,8 par
     fenêtre) ; entrer dans X depuis UNKNOWN domine toute telle chaîne d'au moins ~10 nats →
     le théorème existant s'applique tel quel, avec ou sans plancher d'absence ; flux
     fenêtre par fenêtre = flux par lots (`feedAll`) = depuis zéro = référence.
  5. Harnais : `pipeline.buildTimeline` fournit `admittedAt` calculé sur les scores BRUTS
     (ses scores transformés rendent le seuil 0,20 dénué de sens).
- **13:25** correction implémentée (`temporalObservationBuilder.ts` : champ optionnel
  `admittedAt` ; `viterbiDetector.ts` : `preAdmissionScore`, `admissionIndex`,
  `SlotSpace.admitAt`, `computeColumn(…, t, epsScore)`, décodeur de référence, paragraphe
  ajouté au théorème du flux ; `pipeline.ts` : `admittedAt` sur scores bruts).
  **`tsc --noEmit` OK ; suite complète 49 fichiers, 689 tests réussis, 0 échec** (oracle
  d'équivalence flux/référence redevenu vert AVEC le plancher d'absence). Lancés : tests
  nocturnes d'équivalence sur vraies sessions (`CADENCE_NIGHTLY=1`) et remesure de la chaîne
  complète sous la nouvelle règle d'admission (ctl et bras de l'étude t180+rep4000+L20).
- **13:27** **remesure sous la règle d'admission** (`v3/admit-temporal-{ctl,t180-rep4000L20}.json`,
  configurations temporelles, contre `v3/e5-temporal-*.json` de l'étude) : **rappel et fp
  IDENTIQUES dans les 14 configurations** ; IoU −0,0 à −0,2 point ; erreur de début p90
  +0 à +2 s. Production sans plancher d'absence : inchangée au bit. Recommandation
  t180+rep4000+L20, a=0,8 : **318/12, IoU 88,2 → 88,0 %, début p90 14 → 16 s, fin p90 15 s**.
  Lecture : le vrai début d'un morceau précède souvent sa première fenêtre forte ; « attendre »
  avant l'admission aidait un peu à le rattraper — c'est exactement ce que l'exactitude du
  décodeur en flux interdit. Prix minime. **Les chiffres documentés dans le code seront
  alignés sur les chiffres de production définitifs** (contrôle B, porte côté requête).
- **13:28** relecture du diff de production (`git diff --stat` : 12 fichiers, +318 / −15 hors
  binaires) : admission appliquée à l'identique dans les deux boucles de `computeColumn`, le
  décodeur de référence et `syncSlotSpace` ; UNKNOWN toujours admis ; aucun autre appelant de
  `syncSlotSpace` / `computeColumn` (tsc). **Fins de ligne vérifiées** : les 10 fichiers texte
  modifiés sont 100 % CRLF, comme dans `HEAD` (les avertissements git ne sont que
  `core.autocrlf=true`). Reste à faire après le contrôle B : mentionner la règle d'admission
  dans la doc de `absentObservationRatio` et aligner les chiffres cités (88,2 % → valeur de
  production) dans `detectionTemporalConfig.ts`, `sessionConfig.ts` et le README du vendor.
- **13:31** **CONTRÔLE B CONCLUANT** (`v3/logs/prod-check.log`, `v3/prod-check-temporal.txt`,
  `v3/prod-{fixed,temporal}.json`) : corpus régénéré par `pkg-node-prod` avec les appels exacts
  de `ffWorker` (tempo 60-180, présélection 4 000, longueur minimale de requête 20) → chaîne
  complète **aux détections identiques à l'étude sous règle d'admission** : a=0,8 → **318/12,
  IoU 88,0 %, bornes p90 16 s / 15 s** ; sans plancher d'absence 313/14, IoU 82,0 %. Au niveau
  fenêtre, porte côté requête contre porte hors ligne : Korea IDENTICAL, sinon 2 à 168 fenêtres
  différentes par session (Anglade 70, tabac 121, auberge 76, One_of_the_Best 2, 13th Moon 22,
  Audio F 168, bruit 54). **Diff champ par champ (7 configurations)** : rappel, fp, bruit, `per`
  (trouvés / total / fp / mal placés) et erreurs de bornes p50/p90 IDENTIQUES partout ; seules
  la couverture et l'IoU diffèrent, de ~0,01 point, via la borne d'un morceau à Anglade (Σ IoU
  −0,016) et d'un dans Audio F (−0,019). Aucune détection changée.
- **13:33** **DÉCISION UTILISATEUR : régénérer maintenant les fixtures commitées**
  (`test-fixtures/sessions`) avec le moteur et les réglages de production. Plan, pour ne pas
  gêner les tests nocturnes d'équivalence qui lisent ces fichiers (en cours depuis 13:22) :
  (1) `noise-study/regenerate-fixtures.js` gagne `FIXTURES_OUT_DIR` (défaut inchangé) ;
  (2) régénération par CE script (la référence du projet) dans `v3/fixtures-regen-official/`,
  3 processus ; (3) comparaison au bit avec `v3/fixtures-prod/` (validation croisée des deux
  chaînes) ; (4) copie dans `test-fixtures/sessions` APRÈS la fin des tests nocturnes ;
  (5) suite de tests complète, attentes chiffrées qui bougent signalées ; (6) README des
  fixtures : section de provenance. Sauvegarde des fixtures actuelles avant copie :
  `v3/install-backup/test-fixtures-sessions/`.
- **13:52** fait : sauvegarde des 8 fixtures commitées (170 Mo) + empreintes
  `SHA256-before.txt` ; section « Engine that produced the windows » ajoutée à
  `test-fixtures/sessions/README.md` ; régénération officielle lancée (3 processus, journaux
  `v3/logs/regen-official-{F,A,B}.log`, démarrage vérifié). **Promotion automatisée avec
  barrière** : `v3/fixtures-promote.sh` compare les 8 fichiers officiels à `v3/fixtures-prod/`
  et **s'arrête sans rien copier** si un seul diffère ; sinon copie dans
  `test-fixtures/sessions`, écrit `SHA256-after.txt` et relance `npx vitest run`. Lanceur de fond
  armé : attend la régénération ET l'absence de tout processus vitest (tests nocturnes) →
  `v3/logs/fixtures-promote.log`. **Reprise après coupure** : relancer
  `bash experiments/ranking-study/v3/fixtures-promote.sh` depuis `Cadence/` une fois les 8
  fichiers présents et aucun test en cours.
- **14:01** **tests nocturnes d'équivalence TERMINÉS** (13:22 → 14:01) :
  `CADENCE_NIGHTLY=1 npx vitest run viterbiStreamingEquivalence.test.ts viterbiDetectorEquivalence.test.ts`
  → **2 fichiers, 11 tests réussis, 0 échec, 5 ignorés**. Les 5 ignorés sont les tests
  « optimisé contre référence » sur vraies sessions de `viterbiDetectorEquivalence.test.ts`,
  désactivés EN DUR par `it.skip` (antérieur à cette nuit, sans rapport). **Les 5 tests de flux
  pas à pas sur vraies sessions ont tourné et réussi** — One_of_the_Best, auberge, tabac,
  Anglade, 13th Moon : `StreamingViterbiDecoder` = `runViterbiDetectionReference` avec la
  configuration de production (plancher d'absence 0,8 + règle d'admission), sur les fixtures
  encore issues de l'ancien moteur. Audio F et Korea ne figurent pas dans ce test.
  Régénération officielle à 14:01 : 5/8 fichiers, Audio F 2 600/3 914.
- **14:10** **FIXTURES PROMUES** (`v3/logs/fixtures-promote.log`) : régénération officielle
  (`regenerate-fixtures.js`, moteur et réglages de production) contre régénération du harnais
  (`v3/fixtures-prod/`) → **8/8 IDENTICAL** (Korea 779, Anglade 1 060, tabac 1 017, auberge 983,
  One_of_the_Best 435, 13th Moon 956, Audio F 3 914, bruit 338 fenêtres) ; copiées dans
  `test-fixtures/sessions` ; empreintes `v3/install-backup/test-fixtures-sessions/SHA256-{before,after}.txt` ;
  **suite complète sur les nouvelles fenêtres : 49 fichiers, 689 tests réussis, 0 échec**.
  Risque repéré et traité : `npm run deploy` fait `git add .` et `v3/` contient plusieurs Go de
  données dérivées → dossiers de données ajoutés à `.gitignore` (scripts, JSON de résultats et
  journaux restent suivables).

### État final de l'intégration (non commité — l'utilisateur gère git)

| où | quoi |
|---|---|
| `folkfriend-src/rust` (dépôt git séparé) | setters exportés : `set_tempo_range`, `set_num_repass`, `set_min_query_length`, `set_note_filter`, `set_tempo_model` ; défauts = moteur d'origine (contrôlé au bit) |
| `Cadence/vendor/folkfriend` | builds scalaire + SIMD recompilés, `.d.ts`, README (section « Detector parameters ») |
| `Cadence/src/session/sessionConfig.ts` | `FF_TEMPO_MIN_BPM` 60, `FF_TEMPO_MAX_BPM` 180, `FF_QUERY_REPASS_SIZE` 4000, `FF_MIN_QUERY_LENGTH` 20, documentés comme optimum actuel |
| `Cadence/src/session/recognition/ffWorker.ts` | applique ces réglages à l'init |
| `…/detectionTemporalConfig.ts` | `absentObservationRatio?: 0.8` (loi du seuil + règle d'admission documentées) |
| `…/viterbiDetector.ts`, `…/temporalObservationBuilder.ts` | plancher d'absence + fenêtre d'admission (exactitude du décodeur en flux rétablie) |
| `Cadence/experiments/noise-study` | `wasm-node` = build de production ; client lisant les constantes ; `FIXTURES_OUT_DIR` |
| `Cadence/test-fixtures/sessions` | 8 fenêtres régénérées par le moteur de production ; README (provenance) |
| `Cadence/.gitignore` | données dérivées de `experiments/ranking-study/v3/` |

**Vérifications** : moteur aux défauts = ancien moteur (bit) ; production = étude sur la chaîne
(318/12, IoU 88,0 %) ; oracle flux/référence synthétique + 5 vraies sessions ; suite complète
689/689 avant ET après régénération ; `tsc` propre. **Non vérifié** : coût réel en navigateur sur le
build SIMD ; équivalence flux/référence sur Audio F et Korea (absentes du test nocturne).

- **14:15** **`folkfriend-src` préparé pour commit** (demande de l'utilisateur : ne pas l'oublier ;
  le commit reste à lui, cf. consigne mémorisée). État : 10 fichiers Rust modifiés + `nw_simd.rs`
  nouveau (debug du 18/08, optimisations du 01/09, réglages du 13/09) + `.gitattributes`.
  `cargo check --release --all-targets` natif OK (seul avertissement : l'ancien `mem::forget`).
  **Fausse modification de `rust/wavs/soup_dragon.wav` résolue** : le fichier est identique au bit
  à `HEAD`, mais `* text eol=lf` (`.gitattributes` amont) le traitait en texte — le commiter aurait
  réécrit deux paires CRLF du binaire. Ajout de `*.wav binary` → le WAV sort de `git status`.
  Message de commit rédigé : `v3/folkfriend-commit-message.txt`. **Remote** : `origin` =
  `TomWyllie/folkfriend` (amont) → un push demandera un fork à l'utilisateur. Chiffres
  documentés alignés sur la production (88,0 %, 16 s / 15 s ; le 88,2 % hors échantillon est
  gardé et étiqueté comme mesuré dans le harnais) dans `detectionTemporalConfig.ts`,
  `sessionConfig.ts`, README du vendor ; règle d'admission ajoutée à la doc du champ.
- **06:08** 1 920 évaluations (03:37 UTC). Débit pendant mes sondes : 1,22 éval/s ;
  campagne seule 1,66. **Fin projetée ~09:20 locale** si je la laisse tourner seule.
  Réveil automatique armé à 6 000 évaluations → analyse intermédiaire.

## Ossature de la campagne de réserve (≤ 6 000 évaluations)

À remplir après l'analyse intermédiaire ; la structure ne dépend pas des données.

- **Dimensions ajoutées** : `ANNEAL_ABSENT=1` (plancher d'absence a ∈ [0 ; 0,95],
  continu, par pas) et `ANNEAL_HOLDS` (maintien temporel, lié à la chaîne).
- **Transformations** : celles qui gagnent **hors échantillon** (LOSO) à la fin de
  la campagne principale, pas celles qui gagnent dans l'échantillon. Filtre plat :
  idem. À décider au point de contrôle.
- **Graine** : 12 (ne recouvre aucun fichier de la graine 11). Fichiers fusionnables
  avec la campagne principale : même corpus (`total` = 341), mêmes champs, plus
  `absentRatio`, `hold`, et `per[i][3]` = misplaced.
- **Budget** : 6 000 au plus ; à 1,66 éval/s ≈ 1 h.
- **Critère d'arbitrage final** : point du front LOSO (hors échantillon), centre de
  plateau (voisinage perturbé stable), jamais le pic dans l'échantillon.
