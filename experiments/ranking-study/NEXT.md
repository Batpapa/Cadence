# Where this stands, and how to pick it up

Written 2026-09-08 at ~03:45 so the state survives a context reset. `RESULTS.md`
holds the findings; this holds the operations.

## Running overnight

Four annealing campaigns, one after another, each sharded across parallel
processes. Each writes one JSON file per shard into `.out/` (gitignored) and
nothing else — results are recovered by merging those files, so an interrupted
campaign loses only its own wave.

| wave | seed | steps/chain | evaluations | shards |
|---|---|---|---|---|
| 1 | 1 | 40 | 2 400 | 10 |
| 2 | 2 | 60 | 3 600 | 8 |
| 3 | 3 | 60 | 3 600 | 8 |
| 4 | 4 | 45 | 2 700 | 8 |

Plus 400 random draws under seed 1. About 12 700 evaluations in total.

## Collecting the results

```bash
SEARCH_MERGE=1 SEARCH_SEED=all npm run ranking
```

`all` pools every campaign in `.out/`. Prints the global Pareto front, the
configurations beating production (177 tunes / 10 false positives on these six
sessions), and a tally of what the front's members have in common — which is the
only way to tell a setting that *causes* a win from one a winner merely carries.

A partial `.out/` is fine: merging works on whatever files exist.

## Operational findings, so they are not re-derived

**Memory.** A `TemporalTimeline` stores one dense array per state per window.
Across the six sessions that is 15 849 states and 14.4M cells for **52 000
non-zero values — 0.36% density**, about 230 MB per (transform, flat) pair
counting `observations` and `ranks`. Caching all twenty pairs exceeded Node's
heap and killed the first search. The fix is to group draws by timeline and hold
exactly one at a time. Do not reintroduce a global cache.

This is *not* a defect in production code: the app holds one timeline at a time
(~40 MB) and Viterbi wants indexed access. Only this harness wants twenty.

**Throughput saturates around 8 processes.** Measured: 8 shards gave 0.51
evaluations/s aggregate, 10 shards gave 0.58 — 14% more for 25% more processes,
on a 20-core machine with cores to spare. Per-process time went from 10 s to 17 s
per evaluation. The bottleneck is memory bandwidth, not compute, which is what a
0.36%-dense sweep would predict. **More processes will not help; a sparser
representation would.**

⚠️ **Superseded 2026-09-13 — and the ceiling moved DOWN, to ~6.** Re-measured
after the decode optimisations, on the seven-session corpus, 12 chains × 6 steps
= 72 evaluations at each concurrency, same machine (20 logical cores, 32 GB):

| processes | wall | aggregate | per process |
|---|---|---|---|
| 1 | 239 s | 0,30 eval/s | 3,3 s/eval |
| 4 | 73 s | 0,99 eval/s | 4,1 s/eval |
| 6 | 63 s | 1,14 eval/s | 5,2 s/eval |
| 12 | 56 s | 1,29 eval/s | 9,3 s/eval |

1 → 4 keeps 83% efficiency; 6 → 12 buys **13% for twice the processes**. So the
sweet spot is now **6**, measured, not the 8 it used to be.

It moving EARLIER is the expected consequence of the decode getting ~15× faster
while the memory traffic per evaluation did not change at all: each process now
demands the same bandwidth in a third of the time, so the bus saturates with
fewer of them.

❌ **The conclusion drawn from this next was WRONG, and the following measurement
said so.** This paragraph used to end: making the data smaller is what lifts
throughput from here. The timeline was made sparse the same night (662 → 24 MB,
see below) and the ceiling did not move — still 6 processes, and 12 now buy **2%**
over 6 instead of 13%. The per-shard logs rule out process start-up: the internal
time, counted after the sessions are loaded, is within 2-6 s of the wall clock at
every concurrency, before and after. Whatever saturates, it is not the timeline.

**Audio F costs 4.7× the other six put together.** Measured 2026-09-09, single
process, identity transform, flat filter on — one decode each:

| session | decode |
|---|---|
| 20240721_tocane_2_chapiteau (Audio F) | **20 095 ms** |
| 20260523_1_matin_Anglade | 1 209 ms |
| 1Hour_Trad_Irish_Music_Session_in_Korea | 882 ms |
| 20260523_5_auberge_fleurie | 834 ms |
| 20260523_2_aprem_tabac | 597 ms |
| 13th_Moon_Gravity_Well | 529 ms |
| One_of_the_Best_Traditional_Irish_Music | 241 ms |
| **the six together** | **4 291 ms** |

F is 41% of the corpus by windows and **82% of it by cost**, because the decode
is O(T×S) and the state space grows with the recording: a 5 h 26 session admits
far more tunes than a one-hour one. Consequences, on the 12 700 evaluations
already in `.out/`: topping F up alone is **71 h** single-process, re-running
everything at seven sessions **86 h**. So the top-up saves only about 18% — the
cost is F, not the repetition, and no amount of caching changes that.

Two levers, in order of payoff. **A sparser observation representation** is the
one that matters: 0.36% density (above) means the decode is moving mostly zeros,
and it is memory bandwidth that saturates at 8 processes. **A smaller campaign**
is the cheap one: 12 700 evaluations was exploratory breadth, and re-scoring all
of it under the new corpus buys less than a targeted run around the region that
already dominates production.

Worth keeping in mind for the corpus itself: F is not one session in any musical
sense, it is a whole festival day. If it were ever split into hour-long parts,
both T and S would drop per part and the superlinear term with them.

**Shard by equal work, not by group.** The random search split by (transform,
flat) group, and group sizes ran from 32 to 76 draws, so three processes idled
while others finished. The annealing shards by chain, and chains have identical
step counts.

**PowerShell writes redirected output as UTF-16.** `grep` on those files silently
matches nothing; pipe through `iconv -f UTF-16LE -t UTF-8` first.

## Decode speed — where the time goes, and what has been taken out (2026-09-13)

`bench.test.ts` measures this on demand:

```bash
npx vitest run --config vitest.ranking.config.ts experiments/ranking-study/bench.test.ts
```

**The Viterbi decode is 97-98% of an evaluation.** `buildTimeline` is 29-45 ms
against ~1 s of decoding, so nothing upstream is worth optimising.

**The cost is structural, not arithmetic.** At the baseline the decode spent
~460-550 ns per (window × state) cell, for what amounts to four comparisons.
That was: a `stateIndex` Map rebuilt from scratch on every column, DP columns
held as `Map<string, …>` (string hashing, boxing), 2-4 `Candidate` objects plus
an array allocated per cell, and a per-column `Map` of tag groups with its own
entry objects. Three passes, all bit-identical (the equivalence oracles are the
gate — `viterbiStreamingEquivalence.test.ts` caught a wrong assumption within
seconds, see below):

| | Anglade (T=1060, S=2160) | 13th Moon (T=956, S=1695) |
|---|---|---|
| baseline | 1054 ms · 460 ns/cell | 889 ms · 548 ns/cell |
| stateIndex hoisted out of the column loop | 854 ms | 853 ms |
| per-cell Candidate objects removed | 667 ms | 424 ms |
| tag groups on reused typed arrays | 621 ms · 271 ns/cell | 378 ms · 233 ns/cell |
| observations resolved once, not per cell | 563 ms · 246 ns/cell | 347 ms · 214 ns/cell |
| DP columns as typed arrays, slot-indexed | 98 ms · 43 ns/cell | 58 ms · 36 ns/cell |
| **sparse observations (no log on the 99,7% floor)** | **59 ms · 26 ns/cell** | **30 ms · 19 ns/cell** |

**≈18× and ≈30× on the decode**, every step bit-identical (the equivalence
oracles are the gate, and they earned their keep — see below). Read individual
rows as trends, not to three digits: repeated runs spread by 20-40%.

**What matters for a campaign is the whole evaluation**, and there the figure is
**≈12× and ≈17×** (1083 → 89 ms, 930 → 53 ms): `buildTimeline` has not moved, so
at 23-30 ms it is now a THIRD of an evaluation instead of 3%. Any further decode
work has that as its ceiling — halving the decode again would buy 15%, not 50%.

**A `--cpu-prof` of five decodes settles where the rest of the time goes, and
the variance with it** (2026-09-13, run at the 621/378 ms row):

```
 29,6 %  (garbage collector)
 25,0 %  computeColumn
 15,6 %  pushEntry            ← the two Map.set per cell, nothing else
  7,8 %  indexPrevRow
  4,4 %  observationScore
  4,1 %  bestUnpenalizedExcluding
```

**GC + pushEntry = 45%, both owned by one thing: the DP columns are
`Map<string, …>`.** Two Maps are allocated per column and all T of them stay
alive for the backtrack, so a one-hour session holds millions of live entries
for the whole decode — which is also the obvious explanation for the run-to-run
variance. A good part of computeColumn's own 25% is the remaining string hashes
(`prevScore.get`, `stateIndex.get`). Roughly ten hash operations per cell
remain, at ~20-30 ns each in V8: that is essentially all of the 214-246 ns.

**A dead end worth not repeating:** clearing the group arrays with two
`fill(-1)` per column was *slower* than the Map it replaced (424 → 524 ms),
because the Map only ever held the handful of tags a column actually produced
while a fill touches all S slots. A generation counter (a slot counts as filled
only if it matches the current column number) removes the clearing entirely.

### DP columns as typed arrays — DONE 2026-09-13

`Float64Array` scores and `Int32Array` backpointers, one pair per column, in
place of the two Maps. This is the 45% above, and it delivered: 246 → 43 ns and
214 → 36 ns per cell. The obstacle, found the hard way the same evening:
**positions in `tuneIds` are NOT stable** (see the invariant correction in
`viterbiDetector.ts`), and the streaming decoder caches columns across calls —
so indexing columns by canonical position would silently reinterpret every
cached column the first time a late-admitted tune shifts the order.

The way through was two separate notions, until then conflated:

* a **storage slot** per state, handed out by the DECODER on first sight and
  never reused or moved. Columns are indexed by slot, so a cached column stays
  meaningful however tuneIds is later reordered. Slots are append-only by
  construction, so growth needs no remapping — an older, shorter column simply
  has no slot for a state that did not exist yet, which is exactly the
  `-Infinity` seeding case the header's correctness theorem already covers.
* a **canonical rank** — position in `[...tuneIds, UNKNOWN]` — used ONLY to
  break ties, as an `Int32Array` from slot to rank, rebuilt when tuneIds
  changes (which is already detected, for stateIndex).

With slots the per-cell hashes all disappear at once: `prevScore[slot]`, the tag
is already `prev[slot]` (a slot, not a name), observations are `obs[slot][t]`,
and the two `Map.set` become two array writes. A welcome simplification came
with it: the streaming decoder no longer patches its boundary column by hand,
because a cached column simply has no cell for a slot that did not exist yet and
`scoreAt`/`prevAt` answer -Infinity / -1 there — which IS the seeding it used to
write, and what its correctness theorem always assumed.

`buildResultFromSlots` and `convergenceFromSlots` are the array-shaped twins of
`buildResult`/`findConvergencePoint`; the reference decoder keeps the Map-based
originals, since it is the oracle and must stay independent.

### Sparse observations — DONE 2026-09-13, and it WAS a speed win

The prediction that sparsity had become a memory story was wrong, and a second
`--cpu-prof` said so before anything was written. With the Maps gone the profile
had changed shape completely — GC 29,6% → 2,1%, and **`observationScore` 4,4% →
23,4%**. `Math.log` was being called once per (window, state) cell, 2,3 M times a
decode, and 99,7% of those calls were on a zero returning the same constant.

So each window's handful of real observations is now scattered into
slot-addressed scratch (the same generation counter the tag groups use), and
every other state reads a precomputed floor — no second memory touch, no
logarithm. Built ONCE per decode by walking each tune's row end to end, which is
sequential; the dense version read S separate arrays at one offset per column
and touched S scattered cache lines to find six values.

A value of exactly 0 is left out of the list because `observationScore(0)` IS the
floor — so the sparse and dense forms are the same function, not an approximation.

### Sparse timeline — DONE 2026-09-13

`TemporalTimeline.observations` and `.ranks` (two dense arrays per state per
window) are gone. Each admitted tune keeps one sparse row of the windows it was a
candidate in (`SparseRow`, `timeline.rows`). The incremental builder materialises
nothing any more — a row IS its appearance log — and the decoder reads each
window's ~10 candidates instead of probing every admitted tune.

Full corpus (seven sessions + noise = 8 timelines, identity transform, flat
filter off), same machine, before → after:

| | before | after |
|---|---|---|
| heap retained by the timelines | 662 MB | **24 MB** (71 751 entries for 42,4 M dense cells) |
| `buildTimeline`, all sessions | 639 ms | **82 ms** |
| the floor-grid `tops` sweep | 1408 ms | **22 ms** |
| decode, Anglade / 13th Moon | 59 / 30 ms | **52 / 28 ms** |

Bit-identical, checked three ways: the timeline equivalence oracle (incremental
against from-scratch), the Viterbi oracles, and a replay of six evaluations stored
by the seed-5 campaign — written by the 2026-09-09 code, dense timeline and
pre-optimisation decoder — through today's code: same floor, found, fp, noise and
coverage to the last bit, a `peak` confirmation at 310 found / 18 fp included.
The `tops` count, 8276 windows, is identical as well.

Throughput, same protocol as the table above (12 chains × 6 steps = 72
evaluations, every shard checked complete in its log):

| processes | wall | aggregate | per process |
|---|---|---|---|
| 1 | 149 s (was 239) | 0,48 eval/s (was 0,30) | 2,1 s/eval |
| 4 | 51 s (was 73) | 1,41 eval/s (was 0,99) | 2,8 s/eval |
| 6 | 43 s (was 63) | 1,67 eval/s (was 1,14) | 3,6 s/eval |
| 12 | 42 s (was 56) | 1,71 eval/s (was 1,29) | 7,0 s/eval |

A real gain at every concurrency, +47% at six processes. But, as the correction
above says, **the ceiling did not lift**: one chain takes 12 s alone and 36 s
alongside eleven others, over 24 MB of timeline data.

### Still open: what saturates now

NOT measured — arithmetic and a hypothesis, recorded as such. The DP table is
dense by necessity (Viterbi needs every state's score at every window, and the
backpointers for the backtrack), at 12 bytes per cell: one evaluation writes
about 0,5 GB of column arrays across its eight timelines, Audio F alone ~350 MB
(3 914 windows × ~7 500 states) held live until its backtrack. Twelve processes
doing that is several GB of fresh memory every few seconds — bandwidth again,
from the DP table this time rather than the timeline.

Confirm before building anything: profile one shard alone against one under
contention, or compare allocation and page-fault rates. If it holds, two levers
are visible in the code: reuse column buffers across decodes instead of
allocating them per window, and stop keeping old columns' SCORES — outside debug
mode, only the last column's scores are ever read again; the backtrack needs the
backpointers alone.

## What to do with the merged front

1. **Refine locally** around whatever dominates production. The annealing chains
   are bound to one (transform, flat) pair each, so a promising pair deserves its
   own longer run rather than more breadth.
2. **Re-run everything once Audio F lands.** It is the largest session and
   carries 27 of the corpus's false positives at the production operating point,
   so it has real weight in any budgeted comparison. Every number here is
   provisional until then.
3. **Do not port anything to production yet.** Nothing in this directory touches
   `src/`. The transforms are applied in the harness's own `buildTimeline`, and
   the confirmation rules in its own `decode`. Promoting a winner means deciding
   where the transform belongs in the real chain, which is a separate design
   question from whether it wins.
