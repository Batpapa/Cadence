# Score following — proof of concept (2026-10-28)

Where in its score is a recorded tune, moment by moment? Recognition says
WHICH tune a detection is; this aligns the detected setting's score to the
recording so the score's cursor can follow the real audio
(`src/session/scoreFollow.ts`, UI in `src/session/ui/ScoreFollowView.tsx`).

## Ingredients

- **Audio**: FolkFriend's per-frame pitch energies, exposed by a new additive
  export `take_features()` (frames × 48 pitches, MIDI 48–95, 46.9 frames/s at
  48 kHz). Build: `folkfriend-src/rust`, `wasm-pack build --target nodejs
  --release --out-dir pkg-node-align` (this folder reads it from there).
- **Score**: the setting's `contour` from the recognition index — one symbol per
  quaver, repeats unfolded, pickup included: one pass of the tune on a quaver
  grid, the very sequence the recogniser matched.

## Model

A hidden semi-Markov model. Each quaver is a segment of free length (0.45–2.2 ×
the quaver of a candidate tempo, log² penalty); after the last quaver the score
loops to the first (several passes). Outside the tune a frame is worth the best
of "another tune" (its best free pitch − 1) and "noise" (a floor): a flat score
there loses to any music at all, and the previous tune of a set (same meter)
was aligned as the end of a pass. Emission: log share of the frame's energy on
the score's pitch, octaves folded in at 0.6. Tempi 60–260 crotchets/min (session
reels run at 190–230; 60 and 70 since 2026-10-31, for a tune slowed down to
learn it — on the 336 tunes below they never won, every result unchanged).

**Search.** Tempo and transposition are chosen on a 30 s probe from a quarter
in (every candidate, then ±5), and the whole recording is aligned ONCE at the
winner. The earlier search (every tempo on the whole, then ±5/±10) is kept
behind `EXHAUSTIVE=1`: on 12 tunes the results were identical to the quaver
(one match share 73 % vs 76 %) at 1.5–20× the cost. In the app (desktop, mains
power) a 110 s excerpt then takes ~0.7 s end to end: decoding and the contour
~0.3 s, features ~0.05 s, alignment ~0.07 s — not worth a port to Rust yet.

## Files

- `lib/align.js` — the lab copy of the aligner, kept in step with the app's
  `scoreFollow.ts`. `lib/engine.js` — features + ffmpeg span decoding.
- `synth.js` — tunes rendered from their own contour with tempo drift, swing,
  jitter, cuts, a strummed accompaniment and pink noise: true onsets known.
  `--version` aligns against ANOTHER setting of the same tune.
- `real.js [session] [max]` — the annotated sessions (`test-fixtures/`), each
  tune with the setting the engine itself voted for, 5 s of margin on each
  side, against 4 decoys of the same meter and similar length. `OTHER=x` sets
  the "another tune" penalty, `EXHAUSTIVE=1` the old search, `BPMS=60,70,…`
  the candidate tempi.
- `locate.js [session] [max]` — a card's recording has no detection to say
  where its tune is: the worker's search of a long recording (`locate`,
  4-minute windows every 2 minutes) replayed on a whole annotated session.

## Results

**Synthetic** (10 tunes, all dances): median onset error 8 ms, 90th percentile
22–33 ms, 100 % of quavers within 100 ms, tempo found within 5.

**Another version** of the same tune: aligns, but the index numbering of two
versions differs (a pickup more or less shifts every quaver; one version was
in Bm instead of Dm) — the metric there is not meaningful, the behaviour is.

**Real sessions**, first model (flat outside score, no margin), 221 tunes: the
detected setting beats every decoy 221/221; median share of frames on the
score's pitch class 72 % (decoys 46 %); median spread of pass durations 0.6 %
(90th percentile 2.2 %) — a cursor that slipped would show uneven passes.

**Current model** (outside = another tune or noise, 5 s margins, probe search),
336 tunes of the 7 sessions, "another tune" penalty 1 vs 1.2:

| | 1 | **1.2 (kept)** |
|---|---|---|
| detected setting beats every decoy | 334 | 336 |
| coverage of the annotated span, p10 / p25 / median | 63 / 94 / 99 % | 90 / 98 / 100 % |
| tunes covered under 80 % | 46 | 18 |
| start off the annotation, median / p90 | 0.8 / 12.7 s | 0.8 / 5.5 s |
| end off the annotation, median / p90 | 1.1 / 11.1 s | 1.2 / 4.4 s |
| spread of pass durations, median / p90 | 0.5 / 1.3 % | 0.6 / 1.7 % |
| what the best decoy claims, median / p90 | 4 / 14 % | 11 / 89 % |

1.2 follows the real tune much further; the price is that a wrong score also
clings more readily — harmless in the app, which only ever aligns the
detected setting, and whose badge reads the match share. On the hardest
session alone (13th Moon, 40 tunes) 1.5 and 2.5 were tried: every decoy then
claimed the whole span — past the edge.

## A tune in a long recording (`locate.js`, 2026-11-01)

tabac (85 min), every annotated tune, then 24 tunes NOT played there (`ABSENT=24`,
first setting of tunes spread over ids 1–3000, the session's meters), each with
what the app then says of the stretch found (`output/locate-absent.log`):

| | found where annotated | followed (app's verdict) |
|---|---|---|
| 25 tunes played | 20 (5 elsewhere or in part, all after 53 min) | 23 — 3 of them at the wrong place |
| 24 tunes absent | — | 15 (false finds, 52–64 % on the score) |

The share on the score does not tell them apart (played 52–83 %, absent
52–64 %): an absent tune is found somewhere, and followed more often than not
— one clean reel (8:46–11:31) draws most of the absent reels. So the app never
says a tune is absent, and shows where in the recording it looked.

## Live: the Play-along (2026-10-31)

`live.mjs` runs the app's live follower itself (`src/session/liveFollow.ts`,
types stripped by Node 26 — it imports nothing on purpose) one frame at a
time, and the app's `LiveCursor` carries each estimate H seconds past the last
frame heard (microphone + screen latency), against the truth at that moment.
Positions the score cannot tell apart (same contour over ±12 quavers: a part
played twice is drawn once) count as one place. `node live.mjs synth
[session|solo|practice]`, `node live.mjs real [session] [max]`; settings by
environment (see the file's head). A take downloaded from the app (developer
mode) holds the same features and levels, to replay a run that went wrong.

Kept settings: enter 15, exit 4, switch 2, lag 3 frames, show 15 / hide 20
frames, the silence gate on the samples' level (−20 dB), cursor confirm 0.4 s.

| at H = 150 ms | on the right note | error med / p90 | acquisition med / p90 | jumps back |
|---|---|---|---|---|
| synthetic session (10 tunes, ~200 bpm, accompanied, 10 dB SNR) | 99.9 % | 8 / 21 ms | 1.0 / 1.7 s | 7 |
| synthetic solo (10 tunes, ~110 bpm) | 100 % | 14 / 36 ms | 1.2 / 2.1 s | 6 |
| synthetic practice (A part, pause, B part, last 2 bars again, pause, whole) | 97.7 % | 20 / 57 ms | 0.7 / 3.6 s | 8 (the replays) |
| real pub, Anglade (20 tunes) | 71 % | 33 ms / 4.4 s | 3.7 / 14 s | 130 |
| real pub, the afternoon (20 tunes) | 45 % | 84 ms / 10 s | 9.7 / 17 s | 227 |

The horizon costs almost nothing up to 300 ms: the local tempo carries the
position that far. Real pubs are the hard case — and the "truth" there is the
offline alignment, itself unsure on some tunes; what the Play-along is for,
one instrument close to the microphone, is the synthetic solo's case, to be
confirmed on real takes. Measures that settled the settings:
- the features hardly say how loud a frame is (pink noise 25 dB down still
  weighed a fifth of a played frame): the silence gate on them never closed,
  and the cursor wandered through pauses. Gated on the samples' level: a
  cursor outside the tune 35 % of the time instead of 60 (solo);
- enter 4 → 6: same accuracy, cursor outside the tune 17 % instead of 36
  (solo); 6 → 15 changes nothing synthetic, but on the pubs: 71 % right
  instead of 61, 4.4× fewer jumps (Anglade);
- cursor confirm 0.4 s: a third of the jumps, the same notes right;
- hide 33 → 20 frames: outside the tune 12 % instead of 17 (solo);
- lag 0 / 6 / 12 / 24 frames: within a point of each other.
