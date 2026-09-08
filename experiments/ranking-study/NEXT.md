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

**Shard by equal work, not by group.** The random search split by (transform,
flat) group, and group sizes ran from 32 to 76 draws, so three processes idled
while others finished. The annealing shards by chain, and chains have identical
step counts.

**PowerShell writes redirected output as UTF-16.** `grep` on those files silently
matches nothing; pipe through `iconv -f UTF-16LE -t UTF-8` first.

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
