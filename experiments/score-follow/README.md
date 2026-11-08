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
  **Since 2026-11-07 alignments read the cleaned energies** (`alignFeaturesOf`,
  the app's scoreFollowWorker.ts): see "Cleaned features" below.
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

## Cleaned features (2026-11-07)

The recognition engine's cleaning of each frame (`take_clean_features`, folkfriend's
`feature/clean.rs`): its harmonic part (median filters 9 frames x 9 bins, soft mask — strums,
bodhrán and attacks out), each note minus its median over 10 s (drones, held chords), then
the 3 strongest notes of each frame. `lib/engine.js` `alignFeaturesOf`; real.js, locate.js,
synth.js, probe.js and live.mjs's offline truth read it, like the app. The Play-along's
follower and the tempo keep `take_features`: no gain for the tempo, and the harmonic
filter's 4 frames of look-ahead broke the live follower (synthetic solo 100 % → 16-28 % on
the right note).

real.js, 330 tunes common to every variant (feature-independent measures):
| features | under 80 % covered | ends off, p90 start/end | pass CV med/p90 | best decoy claims med/p90 |
|---|---|---|---|---|
| take_features | 20 | 5.5 / 4.6 s | 0.28 / 1.32 % | 11 / 89 % |
| cleaned, all 48 notes | 2 | 5.0 / 5.0 | 0.66 / 1.91 | 106 / 111 (anything fits anywhere) |
| cleaned, 5 notes | 6 | 4.7 / 3.8 | 0.41 / 1.42 | 12 / 92 |
| cleaned, 4 notes | 11 | 4.9 / 3.3 | 0.37 / 1.42 | 8 / 39 |
| **cleaned, 3 notes (kept)** | **17** | **5.0 / 3.6** | **0.18 / 1.24** | **4 / 12** |
| cleaned, 5 notes, no drone removal | 7 | 4.8 / 4.2 | 0.45 / 1.55 | 19 / 98 |
| cleaned, 3 notes, "another tune" 1.5 | 5 | 4.8 / 3.9 | 0.45 / 1.67 | 17 / 101 |
| cleaned, 3 notes, "another tune" 1.0 | 39 | 10.6 / 10.0 | 0.08 / 1.07 | 3 / 6 |
3 notes is better on every measure but one tune (of 337) whose best decoy beats it; 1.2 stays.
Synthetic (synth.js): unchanged, median 7-8 ms, p90 24-32 ms, 100 % within 100 ms.

The share on the score runs higher on the cleaned energies (the right score's median 0.71 →
0.80): MATCH_USABLE / MATCH_GOOD moved to the values equally rare among the right scores
(0.5 → 0.66, 0.6 → 0.735); the Play-along keeps 0.5 / 0.6 (LIVE_MATCH_*). locate's zone worth
keeps 0.5 (LOCATE_WRONG_SHARE): at 0.66 it picked worse zones (20 tunes held instead of 22).

locate.js, tabac (85 min), 26 tunes played + 24 absent:
| | held where annotated | followed | absent tunes followed (false finds) |
|---|---|---|---|
| take_features, verdict 0.5 | 20 | 24 | 15 |
| cleaned 3 notes, verdict 0.5 | 22 | 24 | 7 |
| cleaned 3 notes, zone 0.66, verdict 0.66 | 20 | 22 | 2 |
| **cleaned 3 notes, zone 0.5, verdict 0.66 (the app)** | **22** | **21** | **3** |
Played tunes now 64-86 % on the score where held, absent ones 63-68 % where followed.

## The key the recording plays the score in (2026-11-08)

A recording may play the tune in another key than its score (the recognition now finds tunes in
any key). `keyOf` (scoreFollow.ts, mirrored in `lib/align.js`, option `findKey`, benches `KEY=1`):
the transposition under which the recording's pitch-class energy best correlates with the score's
pitch classes, both standardised — read off the notes alone, before any alignment.

Each annotated tune's score moved by a random number of semitones, the key to find being the
opposite: `keyOf` right on **337 / 337**. Searching the twelve keys by alignment instead (every
key at every tempo of the probe) took eight times as long and was wrong 3 times in 21: a fifth away
fits the alignment nearly as well, the notes heard do not.

With the key found rather than assumed, on the cleaned features (`real.js`, `locate.js`):

| | written key | key found |
|---|---|---|
| tunes followed over less than 80 % | 17 | 17 |
| ends, 90th percentile (start / end) | 5.0 / 3.5 s | 5.0 / 3.5 s |
| best decoy's claim, median / 90th percentile | 4 / 12 % | 5 / 14 % |
| true setting beats every decoy | 337 / 337 | 337 / 337 |
| 85-min recording: found where played / followed | 22 / 21 | 21 / 21 |
| 85-min recording: tunes never played « found » | 3 / 24 | 3 / 24 (the same) |

The Play-along does not look for the key (one note held fits a score in any key somewhere): it
follows the key on screen, the viewer's transposition included.

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

### The first take from the app (2026-11-01)

`node live.mjs take file.json…` replays takes downloaded from the app
(TRACE=1: the cursor drawn every quarter second, next to the offline truth
and the note heard). The first, Man of Aran played once through at 215:
« it jumps all over ». Wherever the player left the version on screen — a
variation of a bar — the path left the tune (4) and came back in elsewhere
(15): 19 for a jump, when one wrong quaver cost 20 to 30. Now (the user's
rule: going on with a wrong note costs less than jumping, a jump waits for
evidence, the part being played is kept): a wrong frame costs 2.5 at most,
leaving the tune 40 — paid in silence, a quiet frame costing 2 inside the
tune — coming back in after a stop still 15, and a path elsewhere must beat
the one going on by 15 for 10 frames. Frames with no pitch (the loudest
under a tenth of the energy) count as quiet.

| at H = 150 ms | before | now |
|---|---|---|
| the take: cursor elsewhere in the tune / visible jumps | 30 % / 8 | 6 % / 0 |
| real pub, Anglade (12 tunes): on the right note / p90 error / jumps back | 73 % / 2.3 s / 85 | 79 % / 178 ms / 16 |
| synthetic practice: on the note / acquisition p90 / jumps back | 98.4 % / 3.6 s / 12 | 98.0 % / 3.9 s / 8 |
| synthetic solo: acquisition max | 1.2 s | 3.5 s (The Clumsy Lover, 511 quavers) |
| synthetic session: cursor shown outside the tune | 11 % | 27 % |

The price: on a long, very repetitive tune a wrong first guess takes longer
to correct, and a cursor lingers about a second on a tune that stops under
an accompaniment that goes on. The "same place" measure now takes any
stretch of 25 identical quavers holding both positions, however it sits
around them (near the end of a part played twice the next quavers differ,
the notes are drawn once).

### Which version is being played (2026-11-01)

The second take was of another setting than the one on screen (Man of Aran,
29013 played, 973 shown): bars 2, 4, 6 and 8 otherwise, and the cursor
jumping between the two halves of each part. `VersionWatch`
(liveFollow.ts) follows every version of the file side by side on summed
frames (2 up to 8 versions, 3 up to 18, 4 beyond: a follower costs about
the square of its rate) and compares how much each one's best path loses
over 20 s; another version is offered once it beats the one on screen by 20
for 5 s. `node live.mjs versions` (synthetic, each tune's first setting
played solo then in session, all its settings in the file) and
`node live.mjs versions take tuneId shownId file.json…`:

| | |
|---|---|
| played version on screen (20 runs) | 0 offers |
| another on screen (60 runs) | the played one offered 41, a closer twin 13, a farther one 0, nothing 6 (versions 92-100 % alike) |
| delay of the offer, median | 12.4 s |
| the two takes, 4 versions on screen each | 29013 offered at 13-28 s every time; nothing with 29013 on screen |
| cost, 5-42 versions | 2.1 ms a frame median (laptop on battery saver) |

### Fast against slow (2026-11-01)

« Far more in time played fast than slow » (the user). `node live.mjs tempo`
(HELD=1: quavers of one pitch in a row held as one note): the same 10 tunes
solo at 80-220 — 100 % on the right note throughout, error 0.05 quaver
median at every tempo (18 ms at 80, 8 ms at 220). The synthetic playing does
not show it. Three takes of one reel (Martin Wynne's, 347) at 90, 140 and
200 do: on the right note 64.5 / 81 / 82.6 %, elsewhere in the tune 20 / 0.6
/ 1 %. Played slow, the path hopped to faster tempi (the cursor at 1.7 times
the music for seconds): a tempo switch cost 2 against frames that last twice
as long. A finer tempo grid and a longer tempo window changed nothing;
`switchPenalty` 15 (30 and 60 the same):

| | switch 2 | **switch 15 (kept)** |
|---|---|---|
| takes 90 / 140 / 200: on the right note | 64.5 / 81.0 / 82.6 % | 76.5 / 85.2 / 87.5 % |
| takes: elsewhere in the tune | 19.9 / 0.6 / 1.0 % | 9.2 / 0 / 0 % |
| real pub, Anglade (12 tunes): on the note / p90 error | 79.0 % / 178 ms | 82.3 % / 135 ms |
| synthetic session, solo, practice | 99.9 / 100 / 98.0 % | 100 / 100 / 98.0 % |

What is left slow is mostly the start: bars 1-4 and 5-8 of the A part
alike, the follower settles on the right half only once the notes that
differ have been played — at 90, ten seconds in.
