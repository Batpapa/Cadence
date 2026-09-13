#!/usr/bin/env bash
# Experiment E1 — evaluate both regenerated arms at the frozen configurations,
# then the recall ceiling and the tempo diagnostic per arm, then compare.
#   bash experiments/ranking-study/v3/e1-run.sh      (run from Cadence/)
set -u
V=experiments/ranking-study/v3
NAMES="1Hour_Trad_Irish_Music_Session_in_Korea 20260523_1_matin_Anglade 20260523_2_aprem_tabac 20260523_5_auberge_fleurie One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video 13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24 20240721_tocane_2_chapiteau 732984_11910076-lq"

for arm in ctl t320; do
  missing=0
  for n in $NAMES; do
    [ -f "$V/fixtures-$arm/$n-windows.json" ] || { echo "MANQUE $arm/$n-windows.json"; missing=1; }
    case "$n" in 732984_11910076-lq) ;; *) [ -f "$V/fixtures-$arm/$n-timings.csv" ] || { echo "MANQUE $arm/$n-timings.csv"; missing=1; } ;; esac
  done
  [ "$missing" = 0 ] || { echo "bras $arm incomplet, arret"; exit 1; }
done

for arm in ctl t320; do
  D="$(pwd)/$V/fixtures-$arm"
  echo "==== evalset $arm ===="
  RANKING_FIXTURES_DIR="$D" EVAL_IN=$V/e1-configs.json EVAL_OUT=$V/e1-$arm.json \
    npx vitest run --config vitest.ranking.config.ts experiments/ranking-study/evalset.test.ts 2>&1 | grep -E " : |rejouees|Error|FAIL|rror"
  echo "==== plafond $arm ===="
  RANKING_FIXTURES_DIR="$D" CEILING=1 \
    npx vitest run --config vitest.ranking.config.ts experiments/ranking-study/ceiling.test.ts 2>&1 | grep -E "n=|Error|FAIL" | tee $V/e1-ceiling-$arm.txt
  echo "==== tempo $arm ===="
  RANKING_FIXTURES_DIR="$D" node --max-old-space-size=8192 $V/tempo.js > $V/e1-tempo-$arm.txt 2>&1
  grep -E "plage|^  (reel|jig|polka|slip jig|hornpipe) " $V/e1-tempo-$arm.txt
done

echo "==== comparaison ===="
node $V/e1-compare.js | tee $V/e1-compare.txt
