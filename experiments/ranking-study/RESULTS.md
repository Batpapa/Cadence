# Ranking study — results, 2026-09-08

## FINAL — 12 700 evaluations, four annealing campaigns plus random search

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
