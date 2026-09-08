# Ranking study — does relative evidence beat an absolute score?

Measures what changes if the Viterbi emission term stops reading FolkFriend's
raw score and starts reading how that score compares to the rest of its own
window.

```bash
npm run ranking                                    # everything
STUDY_ONLY=identity,nullRatio3 npm run ranking     # a subset
STUDY_FLOORS=9 npm run ranking                     # coarser sweep
STUDY_FLAT=off npm run ranking                     # flat-window filter disabled
```

## The question

`detectionTemporalConfig.ts` names the limitation itself:

> the real limit is that this compares an ABSOLUTE score. Accompaniment degrades
> the contour, so a correctly identified tune can sit at 0.17-0.25 for its whole
> run while still topping every window by a healthy margin.

The 2026-09-08 dead-zone analysis put numbers on it. In the six silent minutes of
Audio D, FolkFriend's median top-1 score was **0.290** against **0.313** in a
healthy stretch of the same session — essentially normal. What collapsed was the
margin (0.063 vs 0.130) and with it the stability of the leader. And in that same
session a tune was detected at a best score of **0.145** while another was missed
at **0.287**. Absolute level is not what separates the two cases.

One more premise, easy to forget: **FolkFriend returns a score, not a
probability.** It is a Needleman-Wunsch alignment similarity. Its ordering within
a window is meaningful; its level carries the recording's audio quality as a
nuisance parameter. Passing it through `log()` as if it were a likelihood, and
comparing it to a constant, gives that nuisance a vote in every decision.

## What is and is not touched

**Untouched:** FolkFriend, the WASM engine, the Viterbi decoder, the segmenter,
the transition costs, `filterShortSegments`, `mergeNearbySameTune`.

**The single intervention** is a pure function on one window's candidate scores,
inserted between the pre-Viterbi filters and `buildTemporalTimeline`. Because
UNKNOWN's emission is a constant put through the *same* `observationScore` as
every real tune, rewriting the observation values is enough to change the entire
emission model — no detector change is needed to test any of this.

```
windows -> [flat filter] -> [tempo filter] -> ((TRANSFORM)) -> buildTemporalTimeline
        -> runViterbiDetection -> filterShortSegments(false) -> mergeNearbySameTune
```

## Two traps the design exists to avoid

**The state space must not move.** `minCandidateProbability` (0.20) admits a tune
to the Viterbi state space if it ever scores that well — and every transform
changes the scale that threshold reads. Left alone it would silently vary the
state space from one transform to the next and confound everything. So
`buildTimeline` freezes the admitted set on the **raw** scores, exactly as
production computes it, then transforms only the numbers attached to states that
were going to exist anyway.

**The floor must not be held fixed.** Each transform outputs on its own scale, so
`unknownObservationProbability` does not mean the same thing across them.
Comparing at a single floor would be meaningless. Each transform is swept over
floors drawn from the percentiles of *its own* distribution of top-1 values, and
the comparison is between **curves** — recall at an equal false-positive budget —
never between points.

For the ratio transforms the floor stops being a score at all and becomes a
factor: "1.5" means a candidate must beat its window's null model by half again.
That sentence is true whatever the recording's audio quality, which is not
something an absolute floor of 0.20 can claim.

## The transforms, and the hypothesis each tests

| name | value | tests |
|---|---|---|
| `identity` | `s_i` | control — must reproduce production exactly |
| `nullRatio3` | `s_i / s_3` | **main hypothesis** — the flat filter's own reference point, as a continuous ratio rather than a cliff |
| `nullRatio5` | `s_i / s_5` | same, with a median-ish null |
| `nullRatioTailMean` | `s_i / mean(s_2..s_n)` | same, with a null robust to one lucky near-duplicate |
| `share` | `s_i / Σs` | a genuine per-window distribution — the only transform producing something Viterbi's emission term is actually shaped for |
| `relLeader` | `s_i / s_1` | expected to fail informatively: the leader always scores 1.0, so every window nominates at full strength, noise included |
| `rankDecay0.5` | `0.5^(rank-1)` | does the magnitude carry anything the ordering does not? |
| `relLeaderXMargin` | `(s_i/s_1)·(s_1-s_3)/s_1` | bounded cousin of `nullRatio3` |
| `sqrtHybrid` | `s_i / √s_1` | is the answer a blend rather than a side? |

`log(s_i / null)` is worth naming for what it is: a log-ratio, evidence for this
tune against its window's own background. That is the shape a Viterbi emission is
supposed to have.

## Acceptance test

`identity` must reproduce the per-session figures of the independent
`threshold-sweep` harness. Two implementations agreeing is stronger evidence than
one being self-consistent, which is why the ground-truth parser here is a
deliberate duplicate rather than a shared import.

It has already earned its place: on its first run it flagged
`20260523_1_matin_Anglade`, and the culprit was a **stale expectation** — the
figure predated the annotator's correction of Audio E's first row. Both harnesses
now agree on all six sessions, false positives included.

## Scope and known limits

**Audio F (`20240721_tocane_2_chapiteau`) is excluded** — no CSV yet. It is also
the largest session, so every conclusion here must be re-checked once it lands.
Excluding it happens to remove the last consumer of name matching: all six
remaining sessions carry an identifier-based CSV.

**Two false-positive columns**, because the sweep's convention has a blind spot:

- `faux pos` counts distinct detected ids claimed by no scoreable row — the
  threshold-sweep's convention, kept for comparability.
- `mal places` counts segments answering no annotated row *at the place they
  sit*. A detection carrying a correct id at a completely wrong moment is
  neither a hit (matching needs temporal overlap) nor a false positive (the id
  is claimed somewhere), so it vanishes from the first column entirely.

**Held fixed, and arguably as influential as the observation model:**
`minSegmentWindows` (2 consecutive windows), the transition costs, and
`sameTuneMergeGapWindows`. The dead-zone analysis showed `minSegmentWindows` is
what actually blocked the missed tunes — their leading windows were never
adjacent. If a transform wins here, that constraint is the next thing to sweep.
