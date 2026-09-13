#!/usr/bin/env bash
# E6 — full chain on the shortlist arms: rep4000 (tempo 240) and t180+rep4000,
# each with and without the contour gate L=20. Same three config sets as E5,
# compared with E5's ctl, ctlL20 and t180L20 outputs (which must already exist).
#   bash experiments/ranking-study/v3/e6-run.sh      (run from Cadence/)
set -u
V=experiments/ranking-study/v3
NAMES="1Hour_Trad_Irish_Music_Session_in_Korea 20260523_1_matin_Anglade 20260523_2_aprem_tabac 20260523_5_auberge_fleurie One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video 13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24 20240721_tocane_2_chapiteau 732984_11910076-lq"
for f in e5-fixed-ctl e5-fixed-ctlL20 e5-fixed-t180L20; do
  [ -f "$V/$f.json" ] || { echo "MANQUE $V/$f.json (E5 d'abord)"; exit 1; }
done
ARMS_NEW=""
for arm in ${ARMS:-rep4000 t180-rep4000}; do
  ok=1
  for n in $NAMES; do [ -f "$V/fixtures-$arm/$n-windows.json" ] || ok=0; done
  if [ "$ok" = 1 ]; then
    [ -d "$V/gate-$arm-full-L20" ] || node --max-old-space-size=12288 $V/gate-contour.js $V/fixtures-$arm $V/gate-$arm-full-L20 20
    ARMS_NEW="$ARMS_NEW $arm:fixtures-$arm ${arm}L20:gate-$arm-full-L20"
  else
    echo "bras $arm incomplet, ignore"
  fi
done
[ -n "$ARMS_NEW" ] || { echo "aucun bras complet"; exit 1; }

run() { # $1 arm, $2 dir, $3 configs, $4 tag
  RANKING_FIXTURES_DIR="$(pwd)/$2" EVAL_IN=$3 EVAL_OUT=$V/e5-$4-$1.json \
    npx vitest run --config vitest.ranking.config.ts experiments/ranking-study/evalset.test.ts 2>&1 | grep -E "rejouees|Error|FAIL|rror"
}
NAMES_OUT="ctl ctlL20 t180L20 ${EXTRA_REF:-}"
for spec in $ARMS_NEW; do
  arm=${spec%%:*}; dir=$V/${spec#*:}
  echo "==== $arm ($dir) ===="
  run "$arm" "$dir" $V/e1-configs.json fixed
  run "$arm" "$dir" $V/e5-floor-sweep.json floors
  run "$arm" "$dir" $V/e5-configs-temporal.json temporal
  NAMES_OUT="$NAMES_OUT $arm"
done
for tag in fixed floors temporal; do
  echo "==== $tag ===="
  node $V/arms-compare.js $(for a in $NAMES_OUT; do printf "%s " $V/e5-$tag-$a.json; done) | tee $V/${OUT:-e6}-$tag-compare.txt
done
