# Campagne v4 — journal de bord (2026-09-13, soir → nuit)

**Ce fichier est le point de reprise.** Le plus récent est en bas de « Journal ».
Heures = sortie de `date` (heure locale).

## Mandat (utilisateur, 2026-09-13 ~14:30)

- La détection FolkFriend a changé (tempo 60-180, présélection 4 000, porte de contour
  L=20, fixtures régénérées) → **reprendre le ranking test** : balayage systématique des
  paramètres en recuit simulé.
- **Repartir frais** : historique des points supprimé (fait 14:36 : `.out/search-seed11-*`,
  5 020 évaluations de la v3). Les résultats d'expériences moteur de `v3/` (E1-E7) ne sont
  pas des points du recuit et restent.
- **Limite 10 000 points.** Estimation du temps restant au bout de 500.
- Puis autonomie : analyse, tests supplémentaires, couverture, optimisation sur le
  plateau — posture d'équipe de recherche (l'utilisateur a un doctorat en maths-info).
- **Interdit : toucher à la détection des fenêtres** (entrée fixe). Philosophie inchangée :
  FolkFriend (custom, fixe) → traitement → Viterbi → traitement.
- **« min number of top 1 » (`minSegmentWindows`) jamais au-delà de 2** (rapidité
  d'affichage d'un résultat).
- Ne pas commiter. Rien dans `src/` sans raison forte (et le dire).

## Conception de la v4 (`anneal4.test.ts`)

Objectif de chaîne : **found − λ·(fp + bruit) + κ·iouPts**, iouPts = 100·ΣIoU / total (341).
Un morceau trouvé avec des bornes justes vaut plus qu'un fragment. Les détections sur
l'enregistrement de bruit comptent comme faux positifs. Tout est stocké brut : l'analyse
peut rescalariser.

Grille (λ, κ) : (0,25 ; 0,5) (0,5 ; 0,5) (1 ; 0,5) (2 ; 0,5) (0,5 ; 0) (0,5 ; 2).
10 transformations × 6 objectifs = **60 chaînes × 166 pas = 9 960 évaluations**, rondes
entrelacées de 10 pas (budget égal à tout instant).

| coordonnée | domaine | production | note |
|---|---|---|---|
| transformation | 10, liée à la chaîne | identity | échelles d'émission différentes |
| floorQ | [0,0005 ; 0,9], pas log-normal | 0,1665 (= 0,20 en identity) | quantile d'un pool FIXE par transformation (meilleure valeur de chaque fenêtre brute non vide ; toutes les valeurs si les meneurs valent tous 1 : relLeader, rankDecay) |
| minSeg | {0, 1, 2} | 2 | plafond 2 imposé |
| confirmation | none / mean / peak × ratio [1 ; 5] | none | |
| tuneChange | [0 ; 3] | 1,0 | |
| unknownStay / tuneToUnknown / unknownToTune | [0 ; 2] | 0,2 / 0,5 / 0,5 | |
| plancher d'absence a | [0 ; 0,99] | 0,8 | 0 = log ε |
| rapidChangePenalty | [0 ; 4] | 2,0 | jamais cherché avant |
| sameTuneMergeGapWindows | entier [0 ; 24] | 10 | jamais cherché avant |
| filtre plat | off ou marge [0 ; 0,25] | on, 0,05 | |
| tempoSpreadThreshold | [0 ; 0,3] | 0,12 | **calibré sur 36 tempos candidats, le moteur en émet 24** |
| minCandidateProbability | [0,12 ; 0,32] | 0,20 | admission (et fenêtre d'admission du plancher d'absence) |

Hors campagne, délibérément : maintien temporel (hold, +140 fp en v3, redondant avec le
plancher d'absence), porte en proportion (inerte en v3), `sameTuneTransitionCost`
(dégénéré avec les autres coûts), `flatWindowTopN`.

**Contrôle (14:37)** : `ANNEAL_CHECK=1` rejoue la production par le même code →
**318/341, fp 12, bruit 0, IoU 88,0 %, bornes p90 15,5 / 14,5 s**, par session
31/0 35/2 22/5 30/0 25/0 39/1 136/4 = identique à `v3/prod-temporal.json`. Sondes :
minCand 0,14 → identique (décodage ×1,7) ; **tempoSpread 0 → 321/16, IoU 87,6 %** (le filtre
d'étalement coûte 3 morceaux pour 4 fp sur le nouveau moteur).

## Lancement exact

Depuis `Cadence/` :

```bash
for s in 0 1 2 3 4 5; do
  ANNEAL_STEPS=166 ANNEAL_ROUND=10 ANNEAL_SHARDS=6 ANNEAL_SHARD=$s SEARCH_SEED=21 \
  npx vitest run --config vitest.ranking.config.ts experiments/ranking-study/anneal4.test.ts \
    > experiments/ranking-study/v4/logs/anneal-$s.log 2>&1 &
done; wait
```

Lancée à **14:38**. Progression : `node experiments/ranking-study/v4/count.js`.
Sorties : `.out/v4-seed21-anneal0{0..5}.json`, flush toutes les 20 évaluations et à chaque
ronde. **Ne jamais relancer la graine 21** (écrase) : pour compléter, graine 22.

Une ligne : `transform floorQ floor minSeg confirm weights absent rapid mergeGap flat
tempoSpread minCand found total fp noise misplaced sumIoU iouMean iouPts coverage startP50
startP90 endP50 endP90 per ms lambda kappa chain step temp score accepted` ;
`per[i] = [found, total, fp, misplaced, ΣIoU, n IoU]` dans l'ordre de `SESSIONS` : Korea,
Anglade, tabac, auberge, OneBest, 13thMoon, AudioF. `flat: null` = filtre plat désactivé.

## Outils

| outil | rôle |
|---|---|
| `anneal4.test.ts` | recuit v4 ; `ANNEAL_CHECK=1` = production par le même code → `.out/v4-check.json` |
| `v4/count.js` | évaluations écrites par shard |
| `v4/analyze.js` | `MODE=front|groups|loso|marg|sa` |

## Journal

- **14:36** historique v3 du recuit supprimé ; `anneal4.test.ts` écrit.
- **14:37** contrôle production au bit (ci-dessus). Essai à blanc : 12 évaluations en 21 s
  (1 processus). Défaut corrigé avant lancement : pool de plancher dégénéré pour relLeader
  et rankDecay (meneur toujours à 1).
- **14:38** campagne lancée.
- **14:42:28** 500 évaluations (≈ 268 s après le lancement, construction des timelines
  comprise) → **1,87 éval/s** ; reste 9 460 → **~1 h 25, fin estimée ~16:10**, marge
  jusqu'à ~16:30 si les chaînes refroidies visitent des régions plus coûteuses
  (admission basse = décodage ×1,7). Premiers points (220) : aucune chaîne ne bat la
  production à son propre objectif, attendu à T = 6. Point d'analyse intermédiaire armé à
  5 000.
- **15:11** 3 820 évaluations, 1,92 éval/s → fin ~16:05.
- **15:22** **analyse intermédiaire à 5 000** (`v4/analysis-5k.txt`, chaînes au pas ~84/166,
  T ≈ 1,7, acceptation 76 %) :
  - **Aucune évaluation ne domine la production sur les 3 critères** (318 / 12+0 / IoU 88,0 %).
  - Front notable : **nullRatio3 314 / 6, IoU 89,1 %, bornes p90 12,5 / 13,5 s** (mS=2, filtre
    plat off, tempoSpread 0,143, admission 0,133, a = 0,83, stay 0,11, gap 5, rapid 1,43) —
    un échange −4 morceaux / −6 fp à IoU égale ou meilleure.
  - Hors échantillon (tous groupes) : rien ne bat la production au λ bas ; au λ = 2 le
    choix nullRatio3 donne 313 / 7 (κ = 0,5) et **314 / 6, IoU 89,1 % (κ = 1)**, +4 et +8
    de score — l'échange vers moins de fp se généralise, comme en v3.
  - ⚠️ **Diagnostic de recherche** : les chaînes identity, parties au hasard, n'ont PAS
    retrouvé la région de la production (meilleur identity sous fp ≤ 12 : 311, contre 318
    en production). L'espace à 14 dimensions est loin d'être couvert à ce stade. Donc,
    après la campagne : **affinage amorcé** (chaînes froides partant de la production et
    des gagnants hors échantillon) avant toute conclusion « la production est optimale ».
- **15:24** outillage ajouté à `anneal4.test.ts` (les processus en cours ont chargé l'ancien
  code, sans effet sur eux) :
  - `ANNEAL_START=rows.json` + `ANNEAL_T0` / `ANNEAL_T1` : une chaîne par (ligne de départ ×
    objectif), liée à sa transformation — affinage amorcé ;
  - `ANNEAL_EVAL=in.json [ANNEAL_EVAL_OUT=…]` : évalue des lignes telles quelles (sondes de
    voisinage, courbes de réponse) ;
  - paramètres désormais écrits **sans arrondi**. Rejeu de 13 lignes de la graine 21
    (`v4/replay-sample.js`) : found / fp / bruit / mal placés / `per` **identiques 13/13** ;
    ΣIoU décalée de 0,1 à 0,4 sur 4 lignes, à cause des paramètres arrondis à 4 décimales
    (bornes qui bougent sur des ex-aequo). Les comptes de la graine 21 sont donc exacts,
    son IoU l'est à ±0,2 point près au pire.

- **16:08** **campagne TERMINÉE** : 9 960 évaluations, 6 × 1 660, 4 414 à 5 438 s par shard
  (1 h 30 au total, 1,84 éval/s). Sortie complète : `v4/analysis-final.txt`.
- **16:10** **B1 — le verdict intermédiaire s'inverse avec le refroidissement** :
  - **53 évaluations dominent strictement la production sur les 3 critères** (51 nullRatio3,
    2 share). Meilleure : **nullRatio3 324 / 12+0, IoU 88,7 %, bornes p90 13,5 / 12,5 s**
    (production 318 / 12, 88,0 %, 15,5 / 14,5 s) — par session 31/0 35/3 24/3 30/1 25/0 39/2
    140/3 (production 31/0 35/2 22/5 30/0 25/0 39/1 136/4) : +2 tabac, +4 Audio F, mais
    +1 fp à Anglade, auberge, 13th Moon.
    Réglages : floor = 1,0 (le 1er rang doit battre le 3e), mS = 2, a = **0,99**, stay =
    **0,00**, in = **0,01**, out 0,80, chg 0,79, rapid 0,26, gap 7, filtre plat off,
    tempoSpread **0,008** (filtre de tempo quasi coupé), admission 0,238. Coin extrême de
    l'espace : UNKNOWN ne coûte rien à tenir ni à quitter, l'absence ne coûte presque rien.
  - Par transformation, meilleur rappel à fp+bruit ≤ 12 : nullRatio3 324, nullRatioTailMean
    321, share 320, shareXMargin 319, nullRatio5 318, sqrtHybrid 318, relLeader 317,
    **identity 316** (< production 318 : le recuit identity n'a toujours pas retrouvé la
    production, ce qui borne ce que valent ces comparaisons entre transformations).
  - **Hors échantillon (tous groupes)** : **λ = 0,5, κ = 0,5 → 321,0 / 12,0, IoU 89,1 %**
    (+3 morceaux, fp égal, +1,1 point d'IoU sur des sessions jamais vues ; nullRatio3 dans
    les 7 plis) ; κ = 1 identique ; λ = 0,25, κ = 1 → 322 / 17 ; mais **λ = 1 → 317 / 13 et
    λ = 2 → 317 / 12-14** : le gain ne tient pas à tous les taux de change. Sans IoU (κ = 0),
    rien ne bat la production (315-317 / 11-16).
  - Convergence : acceptation 86 → 55 %, T final 0,26 ; 58 chaînes sur 60 trouvent leur
    meilleur score en 2e moitié → **pas convergé**, le recuit trouvait encore.
  - **Lecture** : candidat réel mais gain modeste (≈ +3 morceaux hors échantillon, soit 1 %),
    dépendant de λ, dans un coin de l'espace. Pas encore « clairement meilleur ». → B2.
- **16:10** **B2 lancé** (graine 22). Départs (`v4/starts.js` → `v4/starts-b2.json`, 9 après
  retrait de 2 quasi-doublons du nullRatio3 324/12) : production ; nullRatio3 324/12
  (sélection hors échantillon λ ≤ 1) ; shareXMargin 317/5 et nullRatio3 319/8 (sélection
  λ = 2) ; share 320/11 ; meilleurs à λ = κ = 0,5 de identity (320/19), nullRatio5 (321/19),
  nullRatioTailMean (318/13, IoU 89,8 %), shareXMargin (319/9). × 6 objectifs = **54 chaînes
  × 45 pas = 2 430 évaluations**, T 1 → 0,05, rondes de 5. Journaux `v4/logs/refine-*.log`,
  sorties `.out/v4-seed22-anneal0*.json` (paramètres non arrondis). Analyse de l'union :
  `PREFIX=v4-seed2 node v4/analyze.js`.
- **16:12** contrôle des départs : le pas 0 de chaque chaîne reproduit sa ligne de départ
  (production 318/12+0, IoU 88,0 % via le plancher absolu → indice du pool ; nullRatio3
  324/12+0, 88,7 % ; shareXMargin 317/5 ; nullRatio3 319/8). Sondes B3/B4 générées, NON
  lancées (elles concurrenceraient l'affinage) : `v4/neigh.js make` → `v4/probe-prod.json`
  et `v4/probe-nr3.json` (118 configurations chacune : base, 68 points de courbes un-facteur,
  50 tirages de voisinage). À lancer en 6 processus avec `ANNEAL_EVAL=… ANNEAL_SHARDS=6
  ANNEAL_SHARD=s` (sorties `-<s>.json`), résumé par `node v4/neigh.js sum <fichiers>`.
  ⚠️ Le candidat nullRatio3 est **sur les bornes** du domaine (a = 0,99 borne haute ; stay et
  in à 0, tempoSpread ≈ 0) : l'affinage ne peut pas aller au-delà. Ces bornes sont
  physiques (coût ≥ 0, a < 1) — c'est un régime « mécanisme éteint », à lire comme tel.
- **16:37** **B2 TERMINÉ** (2 430 évaluations ; `v4/refine-out.txt`, union
  `v4/analysis-union.txt`, 12 390 évaluations) :
  - **Départ production (identity)** : l'affinage froid ne trouve que des pas minuscules —
    meilleurs 320/14 · 87,8 %, 319/11 · 87,8 %, 318/11 · 88,1 % ; 0 à 9 tirages sur 45 la
    dominent, de ±1. **La production est un optimum local dans le régime identity.**
    Hors échantillon, le groupe identity seul ne la bat à aucun (λ, κ) (−0,6 à −6,7).
  - **Départ nullRatio3 324/12** : 324/10 · 88,8 % (confirmation peak ×1,23, a 0,975, gap 11,
    tempoSpread 0) ; à λ = 2 : 322/9 · 89,1 %. 27 à 41 tirages sur 45 dominent la production
    selon l'objectif → **région large, pas un pic isolé** (à confirmer par B4).
  - Autres départs : shareXMargin reste à 317-322 / 5-12 avec IoU 85-87 % ; nullRatioTailMean
    321/11 · 89,7 % (16/45 dominants à κ = 2) ; share 320/10-11 · 87-88 % ; nullRatio5 et
    identity 320/19 ne battent pas la production.
  - **Union, hors échantillon (tous groupes)** : λ = 0,5, κ = 0,5 → **321,0 / 10,2 fp,
    IoU 89,1 %** ; λ = 1, κ = 0,5 → **322,0 / 10,2, 89,2 %** ; λ = 1, κ = 1 → 322 / 10,2,
    89,2 % ; κ = 0 → 319-320 / 11-12, 84-86 % ; **λ = 2 → 315 / 13, 88,2 %, perd**.
    nullRatio3 choisi dans 7 plis sur 7 à λ ≤ 1. La production : 318 / 12, 88,0 %.
  - Dans l'échantillon : 378 évaluations dominent la production (nullRatio3 238, share 80,
    identity 30, nullRatioTailMean 26, shareXMargin 4) — chiffre gonflé par l'affinage qui
    part de la production, à ne pas citer comme résultat.
- **16:38** B3/B4 lancés (236 configurations, 6 processus, `v4/logs/probe-*.log`). Préparés :
  `ANNEAL_EVAL_DETAIL=1` (morceaux trouvés et ids fp par session, pour un test apparié) et
  `v4/picks.js L K` (sélection hors échantillon imbriquée, détail par pli).
- ⚠️ **Correction d'horodatage** : `date` = 16:39:33 après l'entrée « 16:48 ». Les entrées
  « 16:37 » à « 16:48 » ont été estimées ; réel ≈ 16:30 → 16:39. Ordre exact.
- **16:45** **Sélection imbriquée, détail par pli** (`v4/picks.js`, union) — λ = 1, κ = 0,5 :
  hors échantillon 322 / 10,2 / 89,2 % contre 318 / 12 / 88,0 %. Par session : Korea =,
  Anglade = (IoU +1,6), **tabac +1 morceau −1,9 fp IoU +2,9**, auberge +0,1 fp, OneBest =,
  13th Moon +1 morceau +1 fp, **Audio F +2 morceaux −1 fp IoU +1,5**. Aucune session ne perd
  un morceau. Choix quasi unique = **C\*** (`v4/picks-L1K05.json[0]`, choisi dans 6 plis sur
  7) : nullRatio3, plancher 1,0, minSeg 2, confirmation peak ×1,23, a = 0,975, stay 0,
  in 0, out 0,80, chg 0,785, rapid 0,25 (libre), gap 11 (libre), filtre plat off,
  tempoSpread 0, admission 0,237 → **324 / 10+0, IoU 88,8 %**.
- **16:47** **Test apparié C\* contre production** (`ANNEAL_EVAL_DETAIL=1`, `v4/pairdiff.js`,
  `v4/pairdiff-out.txt`) : morceaux **+7 / −1** (tabac +2 −1, 13th Moon +1, Audio F +4 ;
  signe p = 0,07) ; ids fp +2 / −4 (p = 0,69) ; **IoU sur les 317 morceaux communs : mieux
  85, pire 38, égal 194, p = 2,7e-5, +1,22 point en moyenne**. Réserve : C\* est choisi sur le
  corpus complet (mais stable d'un pli à l'autre).
- **16:48** **B3/B4** (`v4/probe-b34-sum.txt` ; base = nullRatio3 324/12, voisin de C\*) :
  - courbes **plates** (plateau) : rapid 0-4, gap 0-20, floorQ ×0,25-×2, minSeg 0-2,
    tempoSpread 0-0,02, admission 0,2-0,24 ;
  - **falaises** : stay > 0 → 324/16 · 80,9 % ; in ≥ 0,25 → IoU 81-84 % ; out 0,5 → 22 fp,
    1,2 → IoU 81,7 % ; filtre plat 0,05 → 318/8 ; a ≤ 0,9 → 319/9-10 · 83-88 % ;
    tempoSpread 0,15 → 318/5 (échange).
  - Production, mêmes courbes : stay 0,3 → IoU 80,0 % ; a 0,9 → 79,8 % ; out 1,2 → 83,4 % ;
    flat off → 319/27 ; minSeg < 2 → 42-43 fp ; tempoSpread ≤ 0,05 → 321/16.
  - Voisinage aléatoire (50 tirages chacun) : production 0 domine / 24 dominés, médiane
    316/12 · 85,4 % ; nullRatio3 **8 dominent la production / 0 dominés**, médiane 324/16 ·
    85,6 %.
  - **Lecture structurelle** : les deux bases sont collées à la falaise de la loi du seuil,
    avec la **même marge** −log(a) − stay : production 0,223 − 0,2 = **0,023**, C\* 0,025 − 0 =
    **0,025**. Le « pont » maximal sur des fenêtres d'absence, (out + in) / marge, vaut ~43
    fenêtres en production et ~32 pour C\*. Le recuit a donc retrouvé la même physique
    temporelle dans l'autre régime ; ce qui change vraiment : la preuve relative (le 1er
    doit battre le 3e, qui remplace le filtre plat), aucune pression contre l'attente en
    UNKNOWN (stay 0) ni barrière d'engagement (in − stay = 0 contre 0,3), filtre de tempo
    coupé, confirmation au pic. Le voisinage indépendant (a et stay bougés séparément)
    franchit la falaise sur la moitié des tirages pour les DEUX bases : il mesure la loi,
    pas la base → refait en coordonnées de marge (`MARGIN=1`, courbe `margin`).
- **16:41** **LE GAIN EN FP DE C\* EST EN PARTIE UN ARTEFACT DE MÉTRIQUE.** Segments mal
  placés (`ANNEAL_EVAL_DETAIL=1`, liste par session) : production **17**, C\* **23** — et la
  nature compte plus que le nombre :
  - Audio F : **2265 « out the door and over the wall » ×11** chez C\* (×4 en production),
    dans les blancs entre sets ; +13978 à 3:47 ; 3115 déplacé.
  - tabac : **19481 « michael's lament » 62:42 → 71:22, soit 8 min 40 d'un seul segment
    fantôme**, plus 41:17-43:17 (la production n'a qu'un fantôme de 85 s du même id).
  - En contrepartie C\* retire des fantômes de la production (Anglade 3382 gardé, tabac 3206,
    2232, 1839 ; Audio F 249, 2044).
  **Mécanisme** : `fp` compte des ids DISTINCTS (convention héritée du threshold-sweep). Un
  attracteur déjà compté une fois pose ensuite autant de fantômes qu'il veut gratuitement.
  C\* coupe le filtre d'étalement de tempo — conçu le 2026-08-18 précisément contre ces
  attracteurs (2265, 19481, 6058) — parce que le critère ne voit pas ce qu'il protège.
  Angle mort déjà nommé en v3 (H2, 06:05) et jugé « minime en métrique » : il ne l'est pas
  pour un optimiseur, qui l'exploite. **Toute sélection doit pénaliser les segments mal
  placés.** Le compte est stocké dans chaque ligne (`misplaced`, `per[i][3]`) → sélection
  hors échantillon refaite hors ligne avec `COST=mis|both` (`v4/picks.js`) ; résumés de sonde
  enrichis (`neigh.js sum` affiche `m<mal placés>` et la dominance à 4 critères).

- **16:44** **Sélection hors échantillon avec les segments mal placés pénalisés**
  (`COST=mis|both node v4/picks.js L K`, union 12 390 évaluations) :

  | coût | λ | κ | hors échantillon rappel / fp / mal placés / IoU |
  |---|---|---|---|
  | production | — | — | **318 / 12 / 17 / 88,0 %** |
  | fp (critère de la campagne) | 1 | 0,5 | 322 / 10,2 / (23) / 89,2 % |
  | mal placés | 0,25 | 0,5 | 320 / 10,2 / **23,2** / 88,9 % |
  | mal placés | 0,5 | 0,5 | 317 / 10,0 / **23** / 89,2 % |
  | mal placés | 1 | 0,5 | 315 / 11,0 / **24** / 89,6 % |
  | fp + mal placés | 0,5 | 0,5 | 317 / 12,0 / **25** / 89,4 % |

  **Plus rien ne domine la production** : dès que les fantômes comptent, la sélection perd 1 à
  3 morceaux et pose 6 à 8 segments mal placés de plus ; seuls l'IoU (+0,9 à +1,6 point) et
  les ids fp (−0 à −2) progressent. Le pli Audio F pèse tout : ses 14 fantômes (contre 7) sont
  invisibles depuis les six autres sessions, où la même configuration n'en pose presque pas —
  **un défaut qui ne se révèle que sur une session longue ne peut pas être appris sans elle**.

## CONCLUSION DE LA CAMPAGNE v4 (2026-09-13, ~16:45) — ARRÊTÉE

Consigne utilisateur appliquée : **rien ne bat clairement la production sur tous les
critères → noté, campagne arrêtée.** Production inchangée (318/341, 12 fp, 17 segments mal
placés, IoU 88,0 %). Rien dans `src/`.

1. **La production est un optimum local solide** : l'affinage froid qui en part ne gagne que
   ±1 morceau / ±1 fp ; le groupe identity ne la bat hors échantillon à aucun taux de change.
2. **Le seul « gagnant » (C\*, nullRatio3, 324/10, IoU 88,8 %) exploite un angle mort de la
   métrique** : `fp` compte des ids distincts, donc un attracteur déjà compté pose des
   fantômes gratuitement ; C\* coupe le filtre d'étalement de tempo qui les retenait (2265 ×11
   dans Audio F, un segment fantôme de 8 min 40 à tabac). Mesuré aux segments, il est dominé
   sur ce critère (23 contre 17) et la sélection hors échantillon ne bat plus la production.
3. **Gain réel mais isolé : l'IoU.** Apparié C\* contre production : mieux sur 85 morceaux
   communs, pire sur 38 (p = 3e-5, +1,2 point) ; morceaux +7 / −1 (p = 0,07, non
   significatif). À lui seul ne justifie pas un changement de régime de décodage.
4. **Constat structurel** : production et C\* sont tous deux au bord de la loi du seuil avec
   la même marge −log(a) − stay ≈ 0,024 et un pont maximal (out + in)/marge de 30-40
   fenêtres ; le recuit a retrouvé la même physique temporelle par un autre chemin. La
   bonne coordonnée de recherche est la marge, pas a et stay séparément.
5. **Le filtre d'étalement de tempo (0,12) garde son rôle sur le nouveau moteur malgré ses 24
   candidats** : le couper rapporte des morceaux et des ids fp mais multiplie les fantômes.
   Sa recalibration n'est PAS établie par cette campagne.

**Leçons de méthode, à reporter dans toute campagne future** :
- **Pénaliser les segments mal placés dans l'objectif du recuit**, pas seulement les ids fp
  distincts — un optimiseur exploite tout angle mort qu'une analyse humaine juge « minime ».
- Des départs aléatoires sur 14 dimensions ne retrouvent pas la région de la production en
  10 000 évaluations : toute conclusion « rien ne bat X » exige des chaînes amorcées en X.
- La validation une-session-dehors ne protège pas contre un défaut propre à une seule
  session (Audio F) : lire aussi le détail par pli et les segments, pas seulement les sommes.

**Si la recherche reprend un jour** (non lancé) : recuit avec coût = mal placés + ids fp,
coordonnées (marge, pont) à la place de (a, stay), départs amorcés en production.

**Addendum 16:48 — sondes en coordonnées de marge** (`v4/probe-margin-sum.txt`, 80 tirages
autour de C\* et de la production, marge conservée) :
- voisinage de C\* : 32/80 dominent la production sur 3 critères, **0/80 sur 4** (mal placés
  médiane 28, p90 45) ; voisinage de la production : 9/80 sur 3, 4/80 sur 4, 15 dominés.
- courbe `margin` : falaise confirmée pour les deux bases à marge ≤ 0 (IoU 80-81 %), plateau de
  0,01 à 0,05.
- **Hypothèse post hoc, NON validée** : C\* avec le filtre d'étalement de tempo remis à la
  valeur de production (0,12) → **321 / 7+0, 14 mal placés, IoU 88,7 %, bornes p90 13,5 / 11,5 s**
  contre production 318 / 12, 17, 88,0 %, 15,5 / 14,5 s — domine sur les 4 critères. Par
  session : égalité partout sauf **tabac 22/2/m2 contre 22/5/m6** et **Audio F 139/2/m8 contre
  136/4/m7** ; aucune session ne perd un morceau. Mais ce point a été trouvé en regardant une
  courbe un-facteur sur le corpus complet, après 12 390 évaluations : **optimisme de sélection
  non mesurable, gain concentré sur deux sessions** → à valider sur une session annotée NOUVELLE
  avant toute décision. Configuration sauvegardée : `v4/hypothesis-cstar-ts012.json`.
  La campagne reste arrêtée conformément à la consigne.

## Programme après la campagne (écrit AVANT les résultats finaux, 15:25)

- **B1** analyse complète (`v4/analyze.js`) : fronts, une-session-dehors (tous groupes et
  par transformation), marges des meilleures configurations par objectif, convergence.
- **B2** affinage amorcé, graine 22 : départs = production + configurations distinctes
  retenues hors échantillon ; T0 = 1, T1 = 0,05, ~50 pas par chaîne ; budget ≤ 2 500.
- **B3** courbes de réponse un-facteur autour de la production et du meilleur candidat
  (tempoSpread, admission, marge plate, gap, rapid, plancher d'absence, plancher) — pour
  EXPLIQUER, jamais pour choisir (le un-facteur fabrique des optimums locaux, v1).
- **B4** robustesse : 50 tirages dans un voisinage relatif de chaque candidat final →
  distribution (rappel, fp, IoU) ; préférer le centre d'un plateau à un pic.
- **B5** validation une-session-dehors refaite sur l'union campagne + affinage (sélection
  imbriquée « tous ») : c'est le seul chiffre présentable comme résultat.
- **B6** rapport (page HTML publiée).

**Consigne utilisateur (15:30)** : si la conclusion finale reste que rien ne bat clairement
la production sur tous les critères, **on le note et on arrête la campagne**. Conséquence :
B1 puis B2 (l'affinage amorcé est ce qui rend le « rien ne bat la production » crédible,
puisque les départs aléatoires n'avaient pas atteint sa région), puis B5. **B3/B4 seulement
si un candidat bat la production hors échantillon sur les trois critères** ; sinon, note
de conclusion et arrêt.
