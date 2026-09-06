# Threshold sweep

Measures what a detection threshold actually costs, by running the **real**
pipeline (`filterFlatWindows` → `filterByTempoSpread` → `buildTemporalTimeline`
→ `runViterbiDetection` → `filterShortSegments`) over every annotated session in
`test-fixtures/sessions/`, plus the pure-noise recording, and comparing the
detections to the hand-written ground truth.

```bash
npm run sweep                          # full 0.15 -> 0.30 sweep (~20 min)
SWEEP_POINTS=0.20,0.25 npm run sweep   # just those thresholds
SWEEP_AUDIT_ONLY=1 npm run sweep       # only the name-matching audit (~2 s)
```

`detectionTemporalConfig.ts` says of several values "never change this without
re-running the sweep". This is that sweep; before 2026-09-06 it existed only as
ad-hoc scripts that were not kept.

## The hard part is not the decoding, it is the matching

Four separate ways this measurement produced confident, wrong numbers before it
produced right ones. All four are handled in `sweep.test.ts`; read this before
trusting any change to it.

1. **Articles are inverted.** The tune index says `virginia, the`, the
   annotation says `The Virginia`. Strip the article at *both* ends.
2. **A tune has many names.** `cooley's` is also `reaping the rye` and five
   others. Never compare name to name: resolve both sides to a **tune id**
   through the index's own `aliases` table.
3. **The numeric column in the annotations is not a TheSession id.** On
   `Give Us A Drink Of Water … 258`, id 258 is `westbrook bell`, while that
   title resolves to 635/661 — it is the annotator's own numbering. Trusting it
   dropped one session from 33/34 to 2/35.
4. **Humans typed these files.** `Radican's` for `Redican's`, `Comb you hair`,
   `Teetotaler's`/`teetotaller's`, `Atholl`/`Athol`, a dance word present on one
   side only, `Also known as` spelled out inside the title. Hence a bounded
   Levenshtein — and **every fuzzy acceptance is printed**, because a loose
   threshold inflates recall silently, which is exactly how the first three
   mistakes went unnoticed.

Symptom to watch for: if one session's recall collapses while the others hold,
suspect the matching, not the detector. `One_of_the_Best` is the reference — it
is the cleanest annotation and should sit around 25/27 with no false positives.

## Baseline (2026-09-06, 7 sessions, 315 ground-truth tunes)

| floor | recall | false positives | noise |
|---|---|---|---|
| 0.15–0.20 | 282 (89.5%) | 50 | 0 |
| 0.25 | 277 (87.9%) | 45 | 0 |
| 0.30 | 270 (85.7%) | 41 | 0 |

Four of the 33 misses are titles absent from the index, so the reachable ceiling
is 311, not 315.

Two findings worth more than the numbers: the pure-noise recording yields **zero**
detections at every threshold — this floor is not what defends against noise —
and the trade is roughly one true tune per false positive throughout, so there is
no optimum to find, only a preference to state.
