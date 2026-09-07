# Session fixtures

## Provenance — which recording is which

The audio is not in the repo. It lives outside it, under opaque names, and this
table is the only thing tying the two together. Verified by MD5: each
`Audio X - Help.txt` is byte-identical to the `-timings.txt` beside it.

| Source audio | Fixture |
|---|---|
| `Audio A.mp3` | `1Hour_Trad_Irish_Music_Session_in_Korea` |
| `Audio B.mp3` | `One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video` |
| `Audio C.m4a` | `20260523_5_auberge_fleurie` |
| `Audio D.m4a` | `20260523_2_aprem_tabac` |
| `Audio E.m4a` | `20260523_1_matin_Anglade` |
| `Audio F.m4a` | `20240721_tocane_2_chapiteau` |
| `Audio G.mp3` | `13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24` |
| `Noise.mp3` | `732984_11910076-lq` (no timings — see below) |

The `Audio X` names are what the annotating group uses, so anything arriving
from them (CSV ground truth in particular) is labelled that way and has to be
translated through this table before it means anything here.

## Files

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

**There is no longer an exception.** `13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24`
was the last hold-out at 15 s / 5 s, because its audio had not been kept; the
audio was supplied on **2026-09-06** and it was regenerated with the rest (956
windows, 79.8 min). Every fixture now shares one geometry, so nothing needs to
exclude or special-case it any more.

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
