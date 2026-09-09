# Ranking study — results, 2026-09-08

## FINAL v2 — sept sessions, 720 evaluations, 2026-09-09

Audio F (`20240721_tocane_2_chapiteau`, 149 morceaux) a rejoint le corpus, qui
passe de 192 a 341 morceaux de reference. Campagne resserree : 4 transformations
x `flat=off` x 3 lambda = 12 chaines de 60 pas, 6 processus, **80 minutes**.

### Le titre de la v1 ne survit pas

**A rappel egal, le gain tombe de 70 % a 15 %.**

| | rappel | fp | transformation | plat | plancher | minSeg | confirm |
|---|---|---|---|---|---|---|---|
| production | 312/341 | 20 | `identity` | on | 0.20 | 2 | — |
| meilleur a rappel egal | **312/341** | **17** | `share` | off | 0.1101 | 2 | none |

Poids du gagnant : `chg=1.62 stay=0.05 out=0.72 in=0.00`.

**5 evaluations sur 720 dominent la production**, et les cinq sont la meme
configuration a des poids pres — contre 266 sur 12 700 en v1. Ce n'est plus une
region, c'est un point.

### Ce qui reste vrai : les gains existent, mais ce sont des echanges

| rappel | fp | perte de rappel | gain sur les fp | transformation |
|---|---|---|---|---|
| 312/341 | 17 | 0 % | −15 % | `share` |
| 308/341 | 10 | −1,3 % | −50 % | `share` |
| 305/341 | 7 | −2,2 % | −65 % | `nullRatioTailMean` |
| 294/341 | 3 | −5,8 % | −85 % | `share` |
| 256/341 | 2 | −18 % | −90 % | `share` |

Le bruit reste a **0** sur tout le front utilisable, comme en v1. La couverture
plafonne a 82-83 % partout, y compris en production : elle ne discrimine pas.

### Ce que le front dit, et ce qu'il ne dit pas

Sur les 47 points du front :

| dimension | distribution | vaut-il comme preuve ? |
|---|---|---|
| filtre plat | `off` 47 | **non** — la campagne l'a impose (`ANNEAL_FLAT=off`) |
| transformation | `share` 25 · `nullRatio3` 15 · `nullRatioTailMean` 7 | partiellement — 4 des 10 seulement etaient candidates |
| minSeg | 2 → 34 · 0 → 9 · 1 → 4 | **oui** — libre de bouger a chaque pas |
| confirmation | `none` 42 · `peak` 5 | **oui** — libre de bouger |

`shareXMargin` etait dans la campagne et n'a place **aucun** point sur le front,
alors qu'il en tenait 6 sur 44 en v1. C'est le signe le plus net que le corpus a
change de forme, pas seulement de taille.

### La reserve qui compte le plus

**Il n'y a pas de jeu de validation.** Les 720 evaluations optimisent sur le
corpus exact qui sert ensuite a les juger. Un ecart de 3 faux positifs sur 20,
trouve apres 720 tentatives, est parfaitement a portee du hasard : c'est un
optimum dans l'echantillon, et rien ici ne dit qu'il tient hors echantillon.
Promouvoir `share` sur la foi de ce seul chiffre serait surinterpreter.

Les echanges du tableau precedent sont d'une autre nature : −65 % de faux
positifs pour −2,2 % de rappel est un ecart trop grand pour etre du bruit
d'echantillonnage. **Si quelque chose doit etre promu, c'est un point de ce
tableau-la, choisi comme un arbitrage produit — pas le gagnant a rappel egal.**


### Decoupage par session (2026-09-09) — `breakdown.test.ts`

Le front donne une paire de chiffres par configuration, sommee sur tout le
corpus. Audio F portant a elle seule 10 des 20 faux positifs de la production,
un candidat peut ressembler a une amelioration du modele en n'etant qu'une
particularite d'un enregistrement. Le decoupage tranche.

**Le gagnant a rappel egal (312/17) est du bruit.** Son gain de 3 faux positifs
est la somme algebrique de mouvements de ±1 a ±2 en sens contraires sur trois
sessions : +1 sur Anglade, −2 sur tabac, −1 sur 13th Moon, −1 sur F, plus un
morceau gagne ici et un perdu la. Il n'y a rien a promouvoir la-dedans, et c'est
exactement ce que l'absence de jeu de validation laissait craindre.

**Le gain de `nullRatioTailMean` (305/7), lui, est structurel.** Reparti sur
trois sessions, la plus grosse n'en portant que 40 % :

| session | rappel | faux positifs |
|---|---|---|
| `20260523_1_matin_Anglade` | 35/36 → **35/36** | 4 → **0** |
| `20260523_2_aprem_tabac` | 21 → 20 | 5 → **1** |
| `20240721_tocane_2_chapiteau` (F) | 135 → 133 | 10 → **8** |
| `13th_Moon_Gravity_Well` | 36 → **33** | 1 → 1 |
| `One_of_the_Best...` | 25 → 24 | 0 → 0 |
| Korea, `auberge_fleurie` | inchange | inchange |

Le fait le plus fort de toute l'etude est la premiere ligne : **sur Anglade, les
quatre faux positifs disparaissent sans perdre un seul morceau.**

Le cout, lui, est concentre ailleurs : 13th Moon perd 3 morceaux **sans aucun
gain en faux positifs**, et c'est la moitie de la perte totale. La transformation
ne fait donc pas un echange uniforme — elle nettoie les sessions bruyantes et
abime une session difficile. Ce candidat tourne a `minSeg=0` la ou la production
est a 2 : verifier si `minSeg=2` recupere 13th Moon sans rendre les faux
positifs est le test suivant le moins cher.

**Le 294/3 est a ecarter** : 41 % de son gain vient de F, qu'il paie de 10
morceaux perdus sur cette seule session.

### Pourquoi la v1 disait autre chose

Contrairement a ce que le premier jet de `RUNBOOK.md` affirmait, la campagne v1
ne reposait pas sur une verite terrain fausse : son `total` de 192 est exactement
la somme des six sessions **sans** Audio F. Elle ne l'avait pas du tout. Audio F
est la session la plus longue et celle qui porte le plus de faux positifs ; son
arrivee ne corrige pas la v1, elle en revele l'etroitesse.

Deux differences interdisent par ailleurs de lire v1 et v2 comme deux mesures du
meme objet : 720 evaluations contre 12 700, et 4 transformations contre 10.
L'absence d'un meilleur point en v2 est donc une preuve faible.

## FINAL — 12 700 evaluations, four annealing campaigns plus random search

> **Depassee par la v2 ci-dessus (2026-09-09).** Mesuree sur six sessions
> (192 morceaux), sans Audio F. Le « 70 % de faux positifs en moins a rappel
> egal » ne se reproduit pas a sept sessions, ou le meme echange ne rend que
> 15 %. La section reste ici pour la methode et pour la comparaison, pas comme
> resultat courant.

**Same recall as production for 70% fewer false positives.**

| recall | fp | transform | flat | floor | minSeg | confirm |
|---|---|---|---|---|---|---|
| production | 177 | **10** | `identity` (raw) | on | 0.20 | 2 |
| | **177** | **3** | `share` | off | 0.1232 | 2 |
| | 178 | 7 | `share` | off | 0.1214 | 0 |
| | 175 | 2 | `share` | off | 0.129 | 2 |
| | 173 | 1 | `nullRatio3` | off | 1.235 | 2 |
| | 169 | 0 | `nullRatio5` | off | 1.118 | 0 |

**266 configurations of 12 700 beat production on both axes**, so this is a
region, not a lucky draw. Noise stays at zero across the entire usable front.

### What the front is made of, which no single row can tell you

Tallied over the 44 configurations on the Pareto front:

| dimension | distribution |
|---|---|
| transform | `share` 16 · `nullRatioTailMean` 11 · `nullRatio3` 8 · `shareXMargin` 6 · `nullRatio5` 2 · `sqrtHybrid` 1 |
| flat filter | **off 42 · on 2** |
| minSegmentWindows | **2 → 37** · 0 → 4 · 1 → 3 |
| confirmation | none 36 · peak 8 |

**`identity` never appears.** Neither does `relLeader` or `rankDecay0.5`. The raw
absolute score is strictly dominated once the other factors are free to move —
which is the study's question, answered.

**`share` wins**, and that is the satisfying part: it is the only transform that
produces a genuine per-window probability distribution, which is the shape
Viterbi's emission term is defined for. The theoretically cleanest option is also
the empirically best one, having started as one candidate among nine.

**The flat-window filter should go** — 42 front members to 2.

**The duration floor should stay.** `minSegmentWindows: 2` holds 37 of 44 front
places. The earlier finding that removing it costs almost nothing survives only
in a narrow band (4 front points at minSeg 0, including 178/7); across the front
as a whole, production's value is right. The confirmation-by-strength rule is
likewise mostly unnecessary — `none` on 36 of 44.

### A second refutation of this study's own reasoning

The winning transition weights cluster around `unknownToTune ≈ 1.0–1.5`, against
production's 0.5. **Entering a tune should cost MORE, not less.** The hypothesis
that drove half of this work — lower the commitment barrier so Viterbi stops
declining to commit — is wrong in the same way the transition-scale hypothesis
was wrong: these penalties are a regulariser, and at a fixed false-positive
budget, more of them wins.

The other winning weights sit near `tuneChange ≈ 1.3`, `unknownStay ≈ 0.3`,
`tuneToUnknown ≈ 0.1–0.6` (production: 1.0 / 0.2 / 0.5).

### Robustness

The 175/2 point is a **plateau**, not a spike: a dozen front members differ only
in the third decimal of one weight. A narrow optimum would be a warning sign
about overfitting six sessions; a broad one is what survives new data — which
matters, because Audio F is not in this corpus yet.


Six annotated sessions, 192 ground-truth tunes. **Audio F excluded** (no CSV
yet), and it is the largest session, so everything below is provisional until it
lands.

## The short version

Two independent gains, and they compose:

1. **Scoring each candidate against its own window's null model** dominates the
   recall/false-positive curve at every budget — 6 to 10 more tunes for the same
   cost, with the floor becoming a scale-free *factor* rather than a score.
2. **The flat-window filter was the ceiling.** With it on, every transform tops
   out at 177/192. With it off, 182–183.

Together they beat production on both axes. The best measured points are
`nullRatioTailMean` with the flat filter off: **178 tunes for 11 false
positives** where production gets 177 for 10, or **173 for a single false
positive** if the budget matters more than the last few tunes.

With the flat filter left ON, the transforms trade purely on cost:

| false positives | `identity` (production) | `nullRatio3` |
|---|---|---|
| 0 | 154 | 153 |
| 1 | — | **170** |
| 2 | 165 | 171 |
| 3 | — | 173 |
| 4 | — | 174 |
| 5 | — | **175** |
| 6 | 169 | 175 |
| 9 | 174 | **177** |
| 10 | **177** | 177 |

At every budget below 10 the ratio curve dominates, by 6 to 10 tunes. Mean
coverage is unchanged (84–85%), the noise fixture yields zero detections
throughout, and no detection ever lands on an `offindex` span.

## What actually separates a found tune from a missed one

Not the absolute score, and not the rank either. **The gap between the leader and
its own window's also-rans.**

The two transforms built to test the extremes both collapse:

| transform | best recall |
|---|---|
| `nullRatioTailMean` | 174 |
| `nullRatio3` | 173 |
| `share` | 172 |
| `identity` | 169 |
| `relLeader` (pure relative) | 153 |
| `rankDecay0.5` (pure rank) | 151 |

`relLeader` and `rankDecay` failed exactly as predicted before measuring, and
their floor grid **degenerated to a single value** — their top-1 is invariably
1.0, so no floor can discriminate. That is the mechanical demonstration that
neither the ordering alone nor the leader's identity alone carries the
information: what the winning transforms share is that they all measure
decisiveness, by three different formulas, and they land within 2 tunes of each
other.

The floor's meaning changes with them, and for the better. It stops being a score
and becomes a **factor**: `nullRatio3` at 1.15 means "beat this window's third
candidate by 15%". That sentence holds whatever the recording's audio quality —
which an absolute floor of 0.20 can never claim, since the level it compares
against carries the audio quality as a nuisance parameter.

## 177 was the flat-window filter, not a ceiling

Turning `filterFlatWindows` off moves the ceiling to **182–183**:

| configuration | recall | false positives |
|---|---|---|
| production (`identity`, flat on, 0.20) | 177 | 10 |
| `nullRatioTailMean`, flat **off**, 1.43 | 173 | **1** |
| `nullRatioTailMean`, flat **off**, 1.21 | **178** | 11 |
| `nullRatioTailMean`, flat **off**, 1.00 | **182** | 25 |
| `nullRatioTailMean`, flat **off**, 0.87 | **183** (95.3%) | 37 |

The 1.21 point beats production on both axes to within one false positive; the
1.43 point finds 173 tunes for a **single** false positive where production pays
ten.

And the filter was never the noise defence it was taken for: **the pure-noise
fixture yields zero detections in every configuration tested here**, flat filter
on or off, at every floor. What it removed was evidence.

## Two things this study got wrong before getting them right

**`minSegmentWindows` does not require consecutive windows.** An earlier version
of this file said it did, and the inspector measured "longest consecutive run"
accordingly. `filterShortSegments` calls `countTop1Windows`, which counts windows
where the tune was FolkFriend's own rank 1 **anywhere inside the segment**.
Re-run with the right metric, Audio D's dead zone says the opposite of what was
first concluded:

```
tune 931  : rank 1 in 3 windows  -> confirmation gate PASSED, yet no segment emitted
tune 5654 : rank 1 in 5 windows  -> PASSED, yet no segment emitted
tune 2191 : never admitted to the state space at all
```

So `filterShortSegments` is not the blocker: both clear it comfortably. **Viterbi
simply declines to commit**, which is an emission-and-transition matter — and puts
the observation model back at the centre, consistent with the flat-filter result
above. (`2191` remains a separate, total failure: FolkFriend never proposes it in
any of the 71 windows.)

**`timeline.ranks` is already load-bearing in production**, precisely in
`countTop1Windows`. Its "not used by the V1 scoring — kept for a V2" comment is
true of the scoring only, and was repeatedly mis-read here as "populated but
unused".

## The duration floor can go, and it costs almost nothing

`minSegmentWindows` imposes a **minimum detectable duration** — two windows where
FolkFriend leads, which a short air or a half-buried tune can never supply
however clean the evidence in the one window it has. Removing it entirely
(`minSegmentWindows: 0`), with `nullRatioTailMean` and the flat filter off:

| floor | gate removed | production's gate (2) |
|---|---|---|
| 1.43 | 173 @ **2** fp | 173 @ **1** fp |
| 1.21 | 180 @ 14 fp | 178 @ 11 fp |
| 1.00 | 183 @ 43 fp | 182 @ 25 fp |

The two curves are near-identical. The gate is worth roughly 1–3 false
positives, and buys nothing in recall — but it forbids short detections
outright, which is a real capability lost for a small regularisation gain. On a
ratio observation, the confirmation is largely already in the score.

Two caveats. Removing it lets a few noise detections through at the loosest
floors (2–3 where the gate holds 0), and `minSegmentWindows: 1` measures
identically to 0 — Viterbi almost never emits a segment containing no rank-1
window at all, so the gate at 1 is close to a no-op.

## A hypothesis of this study's own, refuted

It predicted that the ratio transforms, by compressing the emission scale, would
need **lower** transition costs so the evidence could out-argue them. Swept at
×0.3, ×0.5 and ×1.0, the opposite holds: ×1.0 beats ×0.5 beats ×0.3, on both
transforms, at every budget.

The mechanism invoked was real — fixed penalties do weigh more against a
compressed emission — but the desirable direction was backwards. These penalties
are not an obstacle to evidence, they are a **regulariser**. Lowering them makes
switching cheap, which multiplies spurious segments, and at a fixed
false-positive budget more regularisation wins.

Worth recording for a second reason: the alarming "536 false positives with the
gate removed" measured earlier was an artefact of the ×0.3 scale, not of removing
the gate. At full costs the same configuration gives 43. One-factor-at-a-time
exploration produced that scare, and would have kept it had the cost scale been
"refined" around the intuition rather than swept across it.

## Joint random search — and what it overturned

400 draws over ten dimensions at once (transform, flat filter, floor,
`minSegmentWindows`, confirmation rule, and the four transition weights
individually), seeded and sharded across eight processes. Pareto front, 13
configurations. Noise stays at zero across the whole usable front.

**Four configurations beat production on both axes**, production being
(177 tunes, 10 false positives):

| recall | fp | transform | flat | floor | minSeg | confirm | weights |
|---|---|---|---|---|---|---|---|
| **178** | **8** | `nullRatio3` | off | 1.00 | 2 | peak×1.30 | chg .93 stay .01 out .13 in .49 |
| 177 | 8 | `nullRatio5` | off | 1.18 | 1 | none | chg 1.41 stay .23 out .87 in .49 |
| 177 | 8 | `relLeaderXMargin` | on | 0.25 | 2 | none | chg .60 stay .39 out .60 in .13 |

The gain is real but modest — one tune and two false positives. The front's low
end is more striking: **171 tunes for a single false positive**, and 167 for
none, where production's own curve gives 154 at zero.

### Two of this study's conclusions were artefacts of one-factor-at-a-time

**`relLeaderXMargin` was written off at 168**, measured with the default
transition weights. It appears four times on the joint front, including at
177/8 — competitive with the best. **`relLeader` was declared a predicted
failure** at 153, and the reasoning for why looked sound; jointly it reaches 173
for 2 false positives, once `tuneToUnknown` drops to 0.15 and makes the decoder
very sticky.

Neither transform changed. What changed is that they were finally evaluated
somewhere other than at the coordinates the *other* factors happened to sit at.
Both were judged in a region that suited `nullRatio*` and penalised them, which
is precisely how one-factor-at-a-time manufactures a local optimum — and both
"failures" were reported here as findings before the joint search ran.

**The `peak` confirmation rule earns its place**: it appears on the best
dominating configuration, alongside `minSegmentWindows: 2` rather than instead
of it. So it is not (yet) a replacement for the duration floor, but it does buy
false-positive reduction on top of it.

**`minSegmentWindows: 3`** — stricter than production — holds most of the
very-low-false-positive end of the front. Worth remembering next to the finding
that the gate can be removed almost for free at higher budgets: which direction
helps depends entirely on the budget.

### Limits of this search

400 draws in ten dimensions is thin, so the front is a **lower bound** on what
is reachable, not an optimum. One seed only. And no local refinement was done
around the dominating points, which is the obvious next step now that they are
known.

## What this suggests next, in order

1. **Relax the adjacency requirement.** Viterbi already bridges weak evidence
   through its transition costs, and `mergeNearbySameTune` bridges gaps after
   the fact — so demanding two *consecutive* supporting windows on top of that
   may be the wrong instrument, applied twice. This is now the most promising
   lever, and it was invisible before the observation model was isolated.
2. **Reconsider the flat-window filter.** It blanks 80% of the dead zone,
   including windows where the missed tune was ranked first, and a blanked
   window is not neutral — it becomes an UNKNOWN observation, evidence *against*
   the tune it was nominating. The ratio transforms encode decisiveness
   themselves, which may make a hard cliff redundant. Measured separately.
3. **Re-run everything once Audio F lands.** It is the largest session and the
   one with the most false positives (27 of the corpus's total at 0.20), so it
   carries real weight in any FP-budgeted comparison.

## Methodology notes worth keeping

**The acceptance test earned its place twice.** It first flagged a mismatch on
`20260523_1_matin_Anglade` that turned out to be a stale expectation, not a bug —
the figure predated the annotator's 365→635 correction. Both harnesses now agree
on all six sessions, false positives included.

**The first floor grid measured nothing.** It spread quantiles from p5 to p95 of
the top-1 distribution, but production's own floor sits *below* p5 — a floor only
detects anything while it stays under most windows' best candidate, so the entire
usable range lives in the first few percent. The first pass scored identity at
169 where it really achieves 177. The grid is now dense at the bottom. Any future
transform must be swept the same way, and the sanity check is that the control
reproduces its known operating point.

**Two false-positive columns exist for a reason.** The threshold-sweep counts
distinct detected ids claimed by no annotated row; that misses a detection
carrying a correct id at a completely wrong moment, which is neither a hit
(matching needs overlap) nor a false positive. In this corpus the two columns
happen to agree everywhere, which is itself worth knowing.
