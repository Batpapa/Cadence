# FolkFriend WASM (vendored)

Compiled WebAssembly build of [FolkFriend](https://github.com/TomWyllie/folkfriend)
by Tom Wyllie — transcription and recognition of traditional instrumental folk music.

**License: GPL-3.0-only** (see `LICENSE`). Cadence uses this library for the
Session recording / tune recognition feature; attribution is shown in the app's
About screen.

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

**As of 2026-08-18, the source of truth is the locally-patched fork at
`C:\Perso\IrishMusicExperiments\folkfriend-src`, NOT upstream master** — it
carries the `_debug` export additions described above. Diff against upstream
before assuming a fresh `git clone` is equivalent.

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

## Tune index

The recognition index (~34 MB JSON, mapping directly to TheSession.org tune IDs) is
**not** vendored; it is downloaded at runtime and cached in IndexedDB. See
`src/session/recognition/indexStore.ts`. Source:
`https://raw.githubusercontent.com/TomWyllie/folkfriend-app-data/master/public/folkfriend-non-user-data.json`
(version metadata in `nud-meta.json` next to it).
