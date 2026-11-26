#!/bin/sh
# Notes decoded with other octave-profile settings into the transcription bench (tags -op*),
# the same grid as the delivered chain (hp8 flux at 2048, mixed 0.4), then one judge per tag.
cd "$(dirname "$0")/.."
run() {
  tag=$1; opts=$2
  for c in tuneset session flute user dotted; do
    GRID_ANA=hp8 FRACTIONAL=1 OUR_NOVELTY=1 NOVELTY_MIX=0.4 ANA=hpSL10 node bench/to-sweep.js $c "$opts" $tag > out/ts$tag-$c.log 2>&1 &
  done
  wait
}
run -opD09 '{"octaveDown":0.9}'
run -opD107 '{"octaveDown":1.07}'
cd ../../transcription-bench
for t in -opD09 -opD107; do
  CACHE_TAG=$t JOBS=1 node sweep.js sweep-out/sets-base.json op$t > sweep-out/op$t.log 2>&1
  echo "$t $(grep '^base' sweep-out/op$t.log)"
done
