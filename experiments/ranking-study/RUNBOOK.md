# Campagne resserrée à sept sessions — mode d'emploi

Écrit le 2026-09-09. **Lancée le 2026-09-09 : 720 évaluations en 80 minutes,
résultats dans `RESULTS.md`, section « FINAL v2 ».** La procédure ci-dessous
reste valable telle quelle pour la prochaine campagne. Tout ce qu'il faut est ici :
ce fichier ne suppose aucune mémoire de la conversation qui l'a produit.

`NEXT.md` garde les constats opérationnels, `RESULTS.md` les résultats. Ceci est
la procédure.

---

## Pourquoi cette campagne est étroite

Audio F (`20240721_tocane_2_chapiteau`) a rejoint le corpus le 2026-09-09 avec sa
vérité terrain. Mesuré ce jour-là, un décodage :

| | décodage |
|---|---|
| Audio F | **20,1 s** |
| les six autres sessions **réunies** | **4,3 s** |

F pèse 41 % du corpus en fenêtres et **82 % en temps**, parce que le décodage est
en O(T×S) et que l'espace d'états grandit avec la durée (7 515 états contre ~2 500
pour une session d'une heure). Conséquence : les 12 700 évaluations de la campagne
précédente coûteraient **86 h** à refaire à sept sessions, et 71 h à seulement
rattraper F. La largeur exploratoire n'est plus payable ; on dépense donc les
évaluations là où le front de Pareto s'est déjà concentré.

**Ce qui a été retenu**, d'après la fusion des 12 700 évaluations à six sessions :

- front par filtre plat : **off 42, on 2** → la campagne fixe `flat=off` ;
- front par transformation : share 16, nullRatioTailMean 11, nullRatio3 8,
  shareXMargin 6, nullRatio5 2, sqrtHybrid 1 → on garde **les quatre premières**,
  soit 41 des 44 points du front ;
- les trois λ sont conservés : le compromis rappel / faux positifs est un choix
  produit, pas un résultat de mesure, et la campagne doit couvrir l'éventail.

4 transformations × 1 filtre × 3 λ = **12 chaînes**.

---

## Avant de lancer : archiver l'ancien corpus

**Obligatoire.** `.out/` contient 12 700 évaluations faites sur **six** sessions
(`total = 192`). La nouvelle campagne écrit des évaluations sur **sept**
(`total = 341`). Les deux dans le même dossier n'ont aucun sens ensemble : un
front de Pareto qui compare « 178 sur 192 » à « 178 sur 341 » classe le premier
devant, en silence.

```bash
cd Cadence
mv experiments/ranking-study/.out experiments/ranking-study/.out-6sessions
```

La fusion refuse désormais de mélanger deux corpus et dit lequel elle voit, mais
l'archivage reste la bonne pratique : les anciens résultats restent consultables
en repointant le dossier.

---

## Lancer

Six processus, deux chaînes chacun, 60 pas par chaîne = **720 évaluations**.

⚠️ **Ne pas utiliser `npm run ranking`** pour cette campagne : `study.test.ts`
lance sans condition un balayage de dix transformations × treize planchers × deux
filtres, soit ~260 évaluations — environ 1 h 45 à sept sessions, hors budget. Il
faut viser le fichier.

```bash
cd Cadence
for s in 0 1 2 3 4 5; do
  ANNEAL_STEPS=60 ANNEAL_SHARDS=6 ANNEAL_SHARD=$s \
  ANNEAL_ONLY=share,nullRatio3,nullRatioTailMean,shareXMargin ANNEAL_FLAT=off \
  SEARCH_SEED=5 \
  npx vitest run --config vitest.ranking.config.ts experiments/ranking-study/anneal.test.ts \
    > /tmp/anneal-$s.log 2>&1 &
done
wait
```

`SEARCH_SEED=5` : les vagues 1 à 4 ont utilisé les graines 1 à 4, celle-ci ne
recouvre aucun nom de fichier même si l'archivage est oublié.

**Durée attendue : 1 h 30 à 2 h 20**, plafond 3 h.

La base, mesurée le 2026-09-09 en lançant réellement la commande à `ANNEAL_STEPS=1`
(un shard, deux chaînes) : **88 s**. En décomposant avec le coût de décodage connu
(~25 s par évaluation), il reste **~18 s de mise en place par chaîne** —
construction des huit timelines, puis le balayage `tops` qui parcourt les 42,4 M
cellules. À 60 pas cette mise en place tombe sous 1 % et le coût par évaluation
tend vers le décodage seul, soit ~53 min par shard en processus unique.

Reste la contention : `NEXT.md` mesure que le débit sature vers 8 processus
(bande passante mémoire, pas calcul), le temps par processus passant d'environ
10 s à 17 s par évaluation. À six processus, compter ×1,7 à ×2,5.

**Essai de validation déjà fait** : la commande ci-dessus tourne, sélectionne bien
12 chaînes dont 2 par shard, et écrit un fichier dont les évaluations portent
`total = 341` — le corpus à sept sessions. Pour référence, les deux tirages
initiaux (aléatoires, avant tout recuit) donnaient déjà `nullRatio3` à 317/341
pour 44 faux positifs, là où la production est à 312/341 pour 20.

**Mémoire : ~680 Mo par processus** (une chaîne garde les timelines des sept
sessions, 42,4 M cellules × 2 tableaux), donc ~4 Go pour la campagne.

---

## Arrêter avant la fin, sans rien perdre

Chaque shard **écrit son fichier toutes les dix évaluations** (corrigé le
2026-09-09 ; avant, il n'écrivait qu'à la toute fin et une interruption perdait
tout). Tuer les processus est donc sans danger à n'importe quel moment, et la
fusion lit ce qui existe.

```bash
pkill -f "anneal.test.ts"     # ou Ctrl+C sur le terminal
```

---

## Fusionner et lire

```bash
cd Cadence
SEARCH_MERGE=1 SEARCH_SEED=all \
  npx vitest run --config vitest.ranking.config.ts experiments/ranking-study/search.test.ts
```

La sortie donne le front de Pareto global, les configurations qui dominent la
production, et un décompte de ce que les membres du front ont en commun — le seul
moyen de distinguer un réglage qui *cause* une victoire d'un réglage qu'un
gagnant porte par hasard.

**Le repère de production a changé avec le corpus.** À six sessions il était de
177 morceaux / 10 faux positifs sur 192. À sept, la production trouve
**312 / 341 avec 20 faux positifs** (mesuré par `threshold-sweep` au plancher
0,20 le 2026-09-09). Le seuil « domine la production » codé dans `search.test.ts`
(`found >= 177 && fp <= 10`) **est celui de l'ancien corpus** : il ne veut plus
rien dire tel quel et doit être relu avant d'être cru.

---

## Ce qu'il ne faut pas conclure trop vite

*Corrige apres coup le 2026-09-09 : ce paragraphe affirmait que l'ancienne
campagne reposait sur une verite terrain fausse a 40 %. C'est faux, et
l'arithmetique le dit — son `total` de 192 est exactement la somme des six
sessions sans Audio F, qui n'y etait donc pas du tout. Les 40 % concernaient le
corpus en fenetres du threshold-sweep, pas celui-ci.*

Cette campagne **re-cherche** sur le nouveau corpus, elle ne se contente pas de
re-noter l'ancienne recherche. C'est voulu : l'ancienne ignorait Audio F, la
session la plus longue et celle qui porte le plus de faux positifs. Mais elle est
aussi plus etroite — quatre transformations sur dix, un seul reglage du filtre
plat. Si le front qui en sort ressemble peu a l'ancien, la premiere hypothese a
ecarter est que la restriction ait exclu la bonne region, pas que la region ait
bouge.

Rien ici ne touche `src/`. Promouvoir un gagnant reste une question de conception
séparée : où la transformation s'insère dans la chaîne réelle.
