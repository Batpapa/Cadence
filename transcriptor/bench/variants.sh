#!/bin/sh
# Notes decoded with other decoder settings, judged by the transcription bench's whole chain
# (the delivered grid: hp8 flux at 2048, mixed 0.4). Arguments: pairs of tag and options JSON,
#   sh bench/variants.sh -rc6 '{"repeatCost":6}' -rc10 '{"repeatCost":10}'
cd "$(dirname "$0")/.."
tags=""
while [ $# -ge 2 ]; do
  tag=$1; opts=$2; shift 2
  tags="$tags $tag"
  for c in tuneset session flute user dotted; do
    GRID_ANA=hp8 FRACTIONAL=1 OUR_NOVELTY=1 NOVELTY_MIX=0.4 ANA=hpSL10 node bench/to-sweep.js $c "$opts" $tag > out/ts$tag-$c.log 2>&1 &
  done
  wait
done
cd ../../transcription-bench
for t in $tags; do
  CACHE_TAG=$t JOBS=1 node sweep.js sweep-out/sets-base.json v$t > sweep-out/v$t.log 2>&1
  echo "$t $(grep '^base' sweep-out/v$t.log)" | sed -E 's/base +//; s/stac +[0-9.]+ //; s/tok2 +[0-9.]+ tok6 +[0-9.]+ brk +[0-9.]+ //g; s/metre.*key +[0-9.]+ //; s/  +/ /g'
done
