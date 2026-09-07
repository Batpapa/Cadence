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

5. **A timestamp is `mm:ss` OR `h:mm:ss`.** Skipping every `h:mm:ss` line as a
   set header silently dropped every tune past the first hour — `1:00:55
   Foxhunter` is a tune, `00:04:37 Reel set:` is a header. What separates them
   is what *follows* the timestamp, not its shape.
6. **A transposition is one typo, not two.** Plain Levenshtein preferred
   `bryn s` (one deletion) over the real tune `byrne s` (a y/r swap, two
   operations) for the hand-typed `Bryne's` — turning a session the detector had
   got perfectly right into "one miss, one false positive". Hence
   Damerau-Levenshtein, plus a tie-break on closeness in length, since a typo
   rarely changes how long a title is. Roman numerals are folded to digits for
   the same reason (`Toss the Feathers II` vs `toss the feathers 2`).

Every one of these six was found because a number looked wrong to a human, not
because the harness complained. It cannot validate itself — read the fuzzy log.

## Baseline (2026-09-06, 7 sessions, 319 ground-truth tunes)

| floor | recall | false positives | noise |
|---|---|---|---|
| 0.20 (current) | 287 (90.0%) | 45 | 0 |
| 0.25 (previous) | 281 (88.1%) | 41 | 0 |

Per session at 0.20: matin_Anglade 34/35·6, aprem_tabac 21/28·5, auberge_fleurie
27/28·1, One_of_the_Best 25/27·0, tocane 118/129·27, 13th_Moon 31/41·6, Korea
**31/31·0**.

Four of the misses are titles absent from the index, so the reachable ceiling is
315, not 319.

Two findings worth more than the numbers: the pure-noise recording yields **zero**
detections at every threshold — this floor is not what defends against noise —
and the trade is roughly one true tune per false positive throughout, so there is
no optimum to find, only a preference to state.
