# FolkFriend WASM (vendored)

Compiled WebAssembly build of [FolkFriend](https://github.com/TomWyllie/folkfriend)
by Tom Wyllie — transcription and recognition of traditional instrumental folk music.

**License: GPL-3.0-only** (see `LICENSE`). Cadence uses this library for the
Session recording / tune recognition feature; attribution is shown in the app's
About screen.

**Source: [github.com/Batpapa/folkfriend](https://github.com/Batpapa/folkfriend)**,
a fork of upstream carrying Cadence's changes. The files here are built from its
commit **`e09a2fc`** (2026-11-09: the two additive changes of "Played pitch" below, on
top of the pitch-class mode, "any pitch", the cleaned features and the query speed-ups)
and that build reproduces them byte for byte (`folkfriend_bg.wasm` MD5
`d87710c9ded87c7ce957c87fd5196ad7`, `folkfriend_bg_simd.wasm` MD5
`2a616af88f4c72b98999afdf24b6ac76`). The module shipped on 2026-11-08 is commit
`6b53e2c` (`bd96c7b53ccc50ee7317e6be1fffbda9` / `04160e3bcd7e807f833971685c73caac`);
from 2026-10-29 to 2026-11-07, commit `1b37f01`; from 2026-09-13 to 2026-10-29,
commit `b0d0a58`. **Whenever these files
change, commit to the fork first and update the commit named here.**

## Contents

| File | Role |
|---|---|
| `folkfriend.js` | wasm-bindgen JS glue (`--target web`: `import init, { FolkFriendWASM }`) |
| `folkfriend.d.ts` | TypeScript declarations |
| `folkfriend_bg.wasm` | compiled WASM module, no SIMD — the safe default (~346 KB) |
| `folkfriend_bg_simd.wasm` | same engine built with `simd128`, ~1.7x faster (~348 KB) |
| `folkfriend_bg.wasm.d.ts` | raw WASM interface declarations |

## How to rebuild

Prerequisites: Rust toolchain (`rustup`, host `x86_64-pc-windows-gnu` works fine,
no Visual Studio needed), target `wasm32-unknown-unknown`, and `wasm-pack`.

**The source of truth is the fork above, NOT upstream master** (local clone:
`C:\Perso\IrishMusicExperiments\folkfriend-src`). A fresh clone of upstream
builds a different engine.

```sh
cd C:\Perso\IrishMusicExperiments\folkfriend-src\rust

# The original committed Cargo.lock pinned wasm-bindgen 0.2.81, which modern
# rustc refuses to compile — already bumped to 0.2.92 and committed in this fork.

# The two optimisation levers Cadence enables (`wasm-opt = ['-O3']`, `lto` +
# `codegen-units = 1`) are DISABLED in upstream's Cargo.toml and are now
# committed in the fork's — nothing to set by hand. See "Rebuilt 2026-09-01".

# TWO builds: the engine batches four index alignments per vector instruction
# where SIMD is available (see "Engine changes"), and a module containing SIMD
# instructions does not merely run slower without support — it fails to
# validate. So both are shipped and ffWorker.ts picks at runtime.

wasm-pack build --target web --release                       # -> folkfriend_bg.wasm
RUSTFLAGS="-C target-feature=+simd128" \
  wasm-pack build --target web --release --out-dir pkg-simd   # -> folkfriend_bg_simd.wasm

# The JS glue is identical for both (verified: same 36 imports, same lines), so
# only ONE folkfriend.js is vendored and it serves either binary.
# Old single-build line, for reference:
# wasm-pack build --target web --release

cp pkg/folkfriend.js pkg/folkfriend.d.ts pkg/folkfriend_bg.wasm pkg/folkfriend_bg.wasm.d.ts \
   <cadence>/vendor/folkfriend/
```

(A separate `wasm-pack build --target nodejs --release --out-dir pkg-node`
also exists, used only by the offline noise-study harness in
`Cadence/experiments/noise-study/` — not part of the shipped app.)

Built 2026-07-15 from master (folkfriend v1.3.0, rustc 1.97.0, wasm-pack 0.15.0).

**Rebuilt 2026-08-18** from a locally-patched fork (`C:\Perso\IrishMusicExperiments\folkfriend-src`, not upstream master) — adds two new WASM exports, `transcribe_pcm_buffer_debug()` and `run_transcription_query_debug()`, that surface note/tempo/quantization telemetry and the untruncated candidate list (previously computed internally then discarded). Purely additive: every export that existed before (`transcribe_pcm_buffer`, `run_transcription_query`, etc.) is byte-for-byte unchanged in behavior — verified via `cargo check` + the full Cadence test suite before vendoring. See `src/session/recognition/ffWorker.ts` (now calls the `_debug` variants and populates `WindowResult.debug`) and project memory ("noise signature study", 2026-08-17/18) for why.

**Rebuilt 2026-09-01** — same source, same exports, **only the build flags changed**: LTO + `codegen-units = 1` on the release profile, and `wasm-opt -O3` (upstream ships with binaryen switched off entirely). Measured on 600 s of real session audio, 4 interleaved rounds against the previous build: **−12 % CPU** (15.00 s → 13.24 s for 40 × 15 s windows, non-overlapping ranges) and **−30 % size** (443 KB → 307 KB). Gains are uniform across every stage (PCM feed −9 %, transcription −9 %, index query −10 %), i.e. better generated code rather than one hot path unblocked.

Correctness was the gate, not the speed: across all builds and rounds the transcribed contour is identical (SHA-256 `928db93b29218061`) and the top-3 scores match to six decimals. `+simd128` was also built and measured — **rejected**: no gain outside the noise (the index query is aho-corasick string matching, not vectorisable float work), so it would have bought a browser-support requirement for nothing.

Note the wasm-bindgen JS glue is re-emitted in a different ORDER on every build (its output ordering is not deterministic); a `diff` against the previous `folkfriend.js` looks large but sorts identical. Compare the WASM `code` section, not the glue, when checking whether a rebuild actually changed anything.

**Engine changes 2026-09-01** — the first modifications to FolkFriend's own code (the project has been unmaintained for ~2 years; the user approved patching it). **Analysing one 15 s window went from 363 ms to 178 ms (×0.49)**, measured interleaved round-by-round so an ordering effect could not masquerade as a gain.

Five of the six changes are **behaviour-preserving by construction and verified byte-for-byte**; the sixth is validated by full backtest. All live in the fork.

1. **Needleman-Wunsch rewritten** (`query/nw.rs`) — the hottest loop in the engine (~80 % of a query, run `QUERY_REPASS_SIZE` times per query). Byte comparison instead of `&str` slicing; `b`'s character hoisted out of the inner loop; `last_row[last_col_index]` kept in a register rather than re-loaded and re-stored per cell (that store also aliased `last_row[col]` as far as the compiler could tell, forcing a reload of the neighbours each iteration). **The proof that this last one is exact is written out in the file — do not simply hoist that accumulator out of the loop, it is order-dependent** and the recurrence reads it back at the last column.

2. **Bounds checks out of the NW inner loop** (`query/nw.rs`) — `a_bytes[..n-1].iter().zip(last_row[1..n].iter_mut())` instead of indexed access, two checks per lattice cell removed with no `unsafe`.

3. **Pass 1 without an automaton** (`query/heuristic.rs`) — the n-grams are a fixed 4 bytes, so they pack into a `u32` and a match is a word comparison. A Bloom-style bit filter rejects fast; hits fall through to an exact multiplicity map, so the filter's false positives cost time and can never change a score. **Equivalence detail**: `ngrams_str` keeps DUPLICATES and aho-corasick counts one match per duplicate pattern id, so the old score was Σ (occurrences in query) × (occurrences in setting) — which the multiplicity map reproduces exactly. Queries shorter than 4 characters fall back to the old path (`ngrams_str` has a special branch there).

4. **Pass 1 without per-setting allocations** (`query/heuristic.rs`) — the old code built a `HashMap` only to collect it straight back out (55 084 hash inserts per query), cloned every setting id (55 084 `String`s per query, for ids that live in the index anyway), and used `.collect::<Vec<Match>>().len()` where `.count()` does. It now borrows and counts in place, and uses `select_nth_unstable` rather than fully sorting 55 084 entries to keep 2 000 — exact, because the comparator is a strict total order, so the top `n` is a uniquely determined set.

5. **No heap churn in the per-frame path** (`feature/autocorrelate.rs`) — fixed-size buffers for the octave-fixing loop and an in-place index sort for the noise filter, replacing ~18 000 allocations per analysis window. **Measured gain: none** (the allocator was not the bottleneck) — kept for the reduced memory pressure on phones, not for speed.

6. **Sixth root as sqrt-then-cbrt** (`feature/autocorrelate.rs`) — the one change that is NOT bit-identical. Upstream's comment says the `powf` form is "~1.75 faster than using norm()", which was measured on a native target; on wasm32 the trade-off inverts, `f32.sqrt` being a machine instruction and `powf` a libm call. This line runs 720 000 times per 15 s window. Rewriting it (same value: s^(1/6) = cbrt(sqrt(s))) took the feed stage **from 35.9 ms to 14.7 ms**. Float rounding differs, and 79 windows in 80 see a character or two change in their transcribed contour — but the **full backtest over the 4 annotated sessions (3 491 windows) is identical: recall 97/118, 16 false positives, 114 results, not one tune gained or lost.**

**`QUERY_REPASS_SIZE` stays at 2000 — see the long comment in `ff_config.rs`.** Lowering it is the biggest theoretical lever and 500 looked safe on the obvious criterion (all 57 windows with a confident top-1 kept their winner). It is not: **recall 97/118 at 2000, 94/118 at 1000, 93/118 at 500**. The mechanism is not shortlist membership — `run_contour_query` deduplicates by `tune_id` and keeps each tune's *best* setting, so a smaller shortlist means fewer settings of a given tune get aligned, lowering the maximum it is reported with. Ranking the shortlist better does not help (match-density normalisation put the true tune at rank ≤243 every time and still lost the same detections, plus 3 false positives).

**Dead ends, measured, so they are not re-paid**: branch-and-bound pruning of NW (the bound `max + 2×rows_left` only drops below threshold in the last ~7 rows of 193 — useless); re-acquiring the WASM view per PCM frame (costs nothing, so the defensive re-acquire in `ffWorker.ts` stays); rewriting `powf(x, 2.0)` as a multiplication (the compiler already does it).

**Validation.** Bit-exactness of 1–4: `run_transcription_query` compared byte-for-byte across builds over ~3 500 real contours plus hand-made degenerate ones — 0 differences. Bit-exactness of 5: the window dumps of all 4 sessions regenerated and compared **byte for byte** against the reference — identical. Change 6: full backtest, identical. Throughout, a control mattered — the previous engine was re-run on the same audio and reproduced its own recall exactly, which is what makes any difference attributable rather than noise.

**SIMD batching 2026-09-01 (second pass of optimisation)** — **analysing a 15 s window went from 297 ms to 84 ms (×0.28) against the upstream engine**, measured interleaved round-by-round.

Pass 2 aligns the query against `QUERY_REPASS_SIZE` settings and was ~74 % of a query's cost. Its inner cell is `max(diag + s, max(left - 1, up - 1))` with `left` carried from the previous iteration, so the loop is **latency-bound, not throughput-bound** — it spends most cycles waiting on that chain. Four independent alignments packed into one `v128` ride the very same chain, so four times the work costs almost the same time. A standalone spike measured **4.34x** on the kernel before any of it was wired in; end to end the query went ×0.58.

`query/nw_simd.rs` holds the kernel. Notes for anyone touching it:
* Every lane must share one `n`, so only settings **at least as long as the query** are batched; shorter ones (~4 % of the index) go down the scalar path, as does any leftover of fewer than 4.
* Batches are grouped **by setting length** so the four lanes finish within a few rows of each other. Rows where all four are still running use no masking at all; only the short tail blends. Dropping this grouping costs 25 % of the query — measured.
* That grouping sort is **`sort_unstable_by_key`** deliberately: scores are written back at their ORIGINAL index, so how batches are grouped cannot reach the output, and the stable sort cost ~30 KB of module size for nothing.
* The order scores are *collected* in still matters — the ranking sort below is stable, and ties decide which setting represents a tune after deduplication. Writing back by original index keeps that bit-for-bit as it was.
* Normalisation is `0.5 * high / n`, in that order. Folding it into `high * (0.5 / n)` rounds twice instead of once and is **not** the same `f32`.
* Column `n` is order-dependent (it reads the running accumulator, not the cell above) — see `nw.rs` for the proof. It is handled once per row, outside the vectorised span.

**Shipping two binaries.** WebAssembly SIMD landed in Safari only in **16.4 (March 2023)**, and a module using it *fails to validate* on anything older — the Sessions feature would be dead, not slow. `ffWorker.ts` therefore validates a 30-byte probe module and fetches whichever binary fits. Both are emitted by the bundler; only one is ever downloaded. Size grew ~318 KB → ~346 KB, which the grouping sort and the batching machinery account for.

**Verification.** Both binaries produce `run_transcription_query` output **byte-for-byte identical** to the previous engine across the full corpus (~3 500 real contours plus degenerate ones). That is the strongest form available here: identical bytes out means the backtest result carries over unchanged, with nothing left to sample.

## Score following export (2026-10-28)

**`take_features()`** — new, additive like the `_debug` exports: returns the
per-frame pitch energies fed so far as one `Float32Array`, row-major (frames ×
48, MIDI 48 first), undecoded and unnormalised, then flushes them. It lets the
caller align a whole performance against a KNOWN score (`session/scoreFollow.ts`)
instead of transcribing it. Nothing else changed: the glue diff against the
previous build is that method plus wasm-bindgen's `Float32Array` constructor
import. Both binaries rebuilt with the commands above (out dirs
`pkg-align-web` / `pkg-align-web-simd`); the offline harness uses
`pkg-node-align` (`experiments/score-follow/`).

## Detector parameters (2026-09-13)

**The engine is now a generic, caller-parameterised detector.** Five setters are
exported on `FolkFriendWASM`; with none of them called, results are **bit-identical**
to the 2026-09-01 engine (verified: window dumps regenerated at defaults compare
byte for byte). Cadence sets its tuned values in `ffWorker.ts`'s `handleInit`, from
constants in `src/session/sessionConfig.ts` — which is where the measurements behind
them are written down.

| Setter | Engine default (upstream) | Cadence | Where it acts |
|---|---|---|---|
| `set_tempo_range(low, high)` | 60, 240 | **60, 180** | `decode/contour.rs` — candidate tempos, crotchets/min, step 5, upper bound exclusive |
| `set_num_repass(n)` | 2000 | **4000** | `query/mod.rs` — settings re-aligned by Needleman-Wunsch |
| `set_min_query_length(n)` | 0 | **20** | `query/mod.rs` — a shorter contour returns no candidates |
| `set_note_filter(power, frames)` | 0.10, 3 | (default) | `decode/contour.rs` — notes dropped before quantisation |
| `set_tempo_model(intercept, slope)` | 3.0, 0.5 | (default) | `decode/contour.rs` — per-note score of the tempo selector |

Why these values (full study: `experiments/ranking-study/CAMPAIGN_V3.md`):
* **Tempo cap.** The selector scores rounding error in frames, so a faster candidate
  tempo — a finer grid — always fits better, and it overshoots: on the same audio,
  when allowed to go faster the right tune's rank got worse 97 times for 20 better.
  Capping at 180: +70 net rank-1 windows. Widening to 320 changed nothing.
* **Shortlist 4000.** Tunes are reported with their best setting; aligning more settings
  raises it. +58 net rank-1 windows (65 gained / 7 lost), no effect on noise, query ×1.5
  on the scalar build (not yet measured on the SIMD build, where pass 2 is the
  accelerated part). 8000: +2 tunes, +1 false positive, ×2.4.
* **Minimum query length 20.** Scores are normalised by the shorter sequence, so a very
  short contour finds a chance alignment in 55 000 settings; the slower tempo cap makes
  noise transcribe to such contours. At 20 no window carrying the right tune was emptied.
* Note filter and tempo model were exposed for the study and left at their defaults:
  both directions of the note filter lose, and re-weighting the tempo model helps polkas
  but costs compound-meter tunes more than the cap does.

End to end, with `absentObservationRatio` 0.8 in `detectionTemporalConfig.ts`, on windows
regenerated by this very build with Cadence's calls: 318 / 341 tunes, 12 false positives,
mean IoU 88.0 % (before: 311, 20, 79.5 %), and held up on sessions the choice was not made
on. The query-side contour gate differs from the study's offline gate in 2-168 windows per
session (a too-short octave-lifted query is now skipped instead of winning and being emptied).
Against the study's figures this changes no detection — found, false positives and misplaced
segments are identical in every session and configuration — and moves the boundaries of two
tunes (one in Anglade, one in Audio F) by a few seconds: mean IoU −0.01 point.

Built 2026-09-13 from the fork (same toolchain and flags as 2026-09-01): `pkg/` → the
scalar module and the glue, `pkg-simd/` → `folkfriend_bg_simd.wasm`; the glue of the two
builds is identical once sorted (checked), so one `folkfriend.js` still serves both.
The offline harness build (`--target nodejs`) is copied to
`experiments/noise-study/wasm-node/`, whose client reads the same sessionConfig constants.

## Pitch-class recognition (2026-11-07)

One new export, `set_pitch_class_mode()`, one-way and per instance. Without the call
nothing changes: the default path is untouched code. With it, the instance transcribes
and compares **pitch classes** (octave forgotten), `rust/src/feature/pitch_class.rs`:

1. frames are kept as magnitude spectra and processed per window: harmonic/percussive
   separation (median filters 9 frames x 9 bins, soft mask H^2/(H^2+P^2)) — strums,
   banjo attacks and bodhran hits are vertical lines in a spectrogram, sustained notes
   horizontal ones;
2. the same modified autocorrelation as the default path, onto 48 notes, without its
   per-frame octave fix and top-5;
3. drone removal: each note loses its median energy over the window (what does not
   move over 10 s: pipes' drones, held chords, hum);
4. octaves summed into 12 classes, 5 kept per frame, melody followed over 12 states
   with an interval model taken modulo the octave (`beam_search::decode_pitch_classes`);
5. the index is folded the same way when loaded (or at the call, if already loaded),
   and the contour's symbols are the first twelve: 'a' = C ... 'l' = B.

Cadence enables it on the recognition instance only (`ffWorker.ts`), with any pitch
(below) — the only engine it runs since 2026-11-07; the tempo tracker and score following
keep default instances, whose `take_features` is unchanged. Two instruments playing the
tune in different registers add up instead of competing for the note, and octave errors
cannot happen, which retires the octave fallback.

Measured on the 17 annotated sessions (live replay, the detector's floor chosen on one
half and scored on the other): **675 / 698 tunes found for 16 false positives**, against
645 / 698 for 27 with the default path; on the sessions held out of every choice,
227/236 + 249/250 against 222/236 + 247/250. Noise still yields nothing.

Speed (Node, Tabac, 150 windows): SIMD build **65 ms per window against 76**, scalar 132
against 138 — the transcription now costs what it did (10 ms on SIMD: the medians run four
at a time with `f32x4.pmin/pmax`, which are exactly the scalar compare-and-select), and
one folded query replaces the default path's two in 41 % of windows. Every optimisation
was checked to leave the output bit-identical: the regenerated fixtures equal the
research harness's windows contour for contour and score for score (18 723 windows; one
noise window differs from the NATIVE harness by one note, native and wasm cube roots
differing in the last bit).

Built 2026-11-07/08 from what became the fork's commit `6b53e2c`, same toolchain and flags: `pkg/` → the
scalar module and the glue, `pkg-simd/` → `folkfriend_bg_simd.wasm` (glue identical,
checked). The offline harness build (`--target nodejs`, SIMD) is in
`experiments/noise-study/wasm-node/`, whose client makes the same calls as `ffWorker.ts`.

## Any pitch (2026-11-07)

`set_any_pitch(on)`, per instance, pitch-class mode only, off by default. On: each window's
tuning is estimated (`pitch_class::window_tuning`: the circular mean of where the energy falls
between two equal-tempered notes) and the notes are read that far off the grid, and the query
looks in all twelve keys — the written key's QUERY_REPASS_SIZE shortlist untouched, plus the
best PC_ANY_KEY_EXTRA = 1000 (setting, transposition) pairs of the other keys, found in ONE pass
over the index by rotating the query's 4-grams (`heuristic::run_transcription_query_any_key`),
each aligned against the query moved down to its key. Always on in Cadence since 2026-11-07
(it replaced the manual "instruments' pitch" setting).

Measured (4 sessions, 96 tunes, recordings resampled off pitch): a quarter-tone sharp 91-92/96
instead of 8/96; +25 / -30 cents 92/96 (the default path already holds 91-92 there). At written
pitch on the 18 files: the same tunes, 2 false positives fewer, a few more wrong names shown for
a moment (39 against 30 in ~13 h). Cost (Node, SIMD) when first built: 112 ms per window instead
of 64 — before the speed-ups below. Off, the
module reproduces the default pitch-class windows bit for bit; on, the research harness's.

Each result of a transcription query also says the key it was found in (`transpose`, 0-11:
the recording plays the setting that many semitones above its written key, modulo the octave;
always 0 outside this mode). Cadence stores it per window candidate and shows each detection in
the key it was played in. No score changes with it.

## Played pitch (2026-11-08), every result unchanged

Two additions for the pitch split (Cadence `playedPitch.ts` / `pitchSplit.ts`: the same tune
played again straight away in another key is another detection):
- `transcribe_pcm_buffer_debug`'s `features` carry `tuning` in pitch-class mode with any pitch:
  the window's tuning estimate (`pitch_class::window_tuning`, semitones off A = 440, -0.5 .. 0.5),
  computed already and dropped until now.
- each any-key query result carries `other_keys`: the other (setting, transposition 0-11, score)
  pairs of the same tune that the full search aligned, best first, at most 24 (`OTHER_KEYS_MAX`),
  also computed already and dropped.
Results, their order and their scores are unchanged: the 18 annotated sessions' windows
(19 700) are identical to the fixtures (contour, top 10, scores, transposition) with both builds,
and the two builds give byte-for-byte the same windows. Research record outside the repo
(recognition-research/JOURNAL.md, section 17).

## Speed-ups (2026-11-08), every result unchanged

Measured by querying the same 200 real contours through the old and new Node SIMD builds side by
side in one process (alternating, so the machine's clock changes hit both): **any pitch -42 %,
written key -23 %**, every result byte for byte the same; the shipped modules still reproduce the
research windows 120/120.
- `nw_simd::needleman_wunsch_x8`: the alignment eight at a time on 16-bit lanes (cells stay
  within [-n, 2n], n the query's length; queries of 10 000 symbols or more take the 32-bit
  kernel). Batches of 8, then 4, then one; scores written back at their original index.
- `heuristic::run_transcription_query_any_key`: grams packed four bits a pitch class, rolled with
  shift / or / mask (a base-12 rolling index cost more than the whole written-key pass), an 8 KB
  presence bitset in front of a direct table instead of a Bloom filter and a hashed lookup, and
  the best `PC_ANY_KEY_EXTRA` pairs taken from a histogram of their scores (all above the cut,
  ties at it by id then key) instead of a bounded heap — the same set, in the same order.
- `index::PitchClassGrams`: every setting's 4-symbol gram codes computed once, when the index is
  folded, in one block (`build_pitch_class_grams`), so the any-key pass reads a code and tests a
  bit per symbol instead of rolling it from the contour: a further **-14 to -15 %** on the any-key
  query (two sessions, A/B, results identical), for 24 MB more (54 -> 78 MB of engine memory
  with the index) and 23 ms more to load the index (120 -> 143 ms).
Tried and left out: the contours alone copied into one contiguous block (-4 %, for 12.5 MB more).

## Cleaned features (2026-11-07)

`enable_clean_features()` then `take_clean_features(drone_frames, causal, stride, top_k)`
(`rust/src/feature/clean.rs`): the 48 note energies of each frame as the pitch-class engine
reads them (harmonic part, no octave fix), each note minus its median over `drone_frames`
(sliding, taken every `stride` frames), the `top_k` strongest kept. Streamed in chunks of 512
frames overlapping by the harmonic filter's half-width, so a long recording never holds its
spectra (a Rust test checks the chunks give exactly one pass's result). Cadence's score
following (alignment, locate in a long recording) reads them with 10 s, 1 s, 3; its tempo and
the Play-along keep `take_features` (no gain measured there; the harmonic filter's 4 frames of
look-ahead break the live follower).

## Tune index

The recognition index (~34 MB JSON, mapping directly to TheSession.org tune IDs) is
**not** vendored; it is downloaded at runtime and cached in IndexedDB. See
`src/session/recognition/indexStore.ts`. Source:
`https://raw.githubusercontent.com/TomWyllie/folkfriend-app-data/master/public/folkfriend-non-user-data.json`
(version metadata in `nud-meta.json` next to it).
