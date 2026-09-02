# Session fixtures

Two files per session:

- `<name>-windows.json` — the raw per-window recognition output, exactly what
  `ffWorker.ts` produces live, generated offline by
  `experiments/noise-study/regenerate-fixtures.js`. The audio itself is **not**
  committed (`test-fixtures/audio/` is gitignored — personal recordings).
- `<name>-timings.txt` — the hand-written ground truth. Three formats coexist,
  all parsed by the study harness: a plain setlist, `Name — tuneId`, and
  timestamped lines. Only two sessions carry per-item timestamps
  (`One_of_the_Best…` per tune, `13th_Moon…` per set), and they are the only
  boundary ground truth there is.

## Window geometry — read this before running any backtest

The dumps carry their own `tWindowStart`/`tWindowEnd`, so the geometry is
self-describing rather than assumed. As of **2026-09-02** every regenerable
fixture is **10 s windows every 5 s**, matching `ANALYSIS_WINDOW_S` /
`ANALYSIS_HOP_S` in `src/session/sessionConfig.ts` — which the generator now
reads from that file rather than duplicating, so the two can no longer drift.

**One exception**: `13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24` is
still **15 s / 5 s**. Its audio was never kept, so it cannot be regenerated.
It stays because it is 41 ground-truth tunes over 80 minutes and its window data
is still perfectly valid — but anything comparing geometries across sessions
must exclude it or account for it.

Keeping a subset of windows is a legitimate way to simulate a larger hop: since
nothing downstream reads `stepSeconds`, keeping every k-th window of a dump is
*exactly* the window set a run at hop 5k would have produced. That trick is what
made the 2026-09-01 hop study possible without re-running FolkFriend.

## The noise fixture

`732984_11910076-lq` has no `-timings.txt` because it contains **no music at
all** — bar ambience, talk, glasses. Its ground truth is "zero detections,
always", asserted unconditionally by `noiseBenchmark.test.ts`. It is the only
fixture that can measure false positives without a recall trade-off, which makes
it the right place to check any change to the pre-Viterbi filters.

## Regenerating

```
node experiments/noise-study/regenerate-fixtures.js [name…]
```

Needs `test-fixtures/audio/` (not in the repo) and the node-target FolkFriend
build in `experiments/noise-study/wasm-node/`. Roughly an hour for all six.
