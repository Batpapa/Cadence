#!/usr/bin/env bash
# E5 — full chain on the regenerated tempo arms, with the contour gate.
#   bash experiments/ranking-study/v3/e5-run.sh      (run from Cadence/)
# Arms: ctl (240, no gate), ctl+L20, t180+L20, t200+L20, and t180/t200 without the
# gate (to separate the two effects). Frozen configs (e1-configs.json) AND a floor
# sweep (e5-floor-sweep.json) per arm, because an absolute floor tuned for the old
# engine would handicap arms whose score scale moved.
set -u
V=experiments/ranking-study/v3
NAMES="1Hour_Trad_Irish_Music_Session_in_Korea 20260523_1_matin_Anglade 20260523_2_aprem_tabac 20260523_5_auberge_fleurie One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video 13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24 20240721_tocane_2_chapiteau 732984_11910076-lq"
# rep4000 is optional: included only if all its windows exist.
REP=0
if ls $V/fixtures-rep4000/*-windows.json >/dev/null 2>&1 && [ $(ls $V/fixtures-rep4000/*-windows.json | wc -l) -ge 8 ]; then
  REP=1
  [ -d "$V/gate-rep4000-full-L20" ] || node --max-old-space-size=12288 $V/gate-contour.js $V/fixtures-rep4000 $V/gate-rep4000-full-L20 20
fi
for arm in t180 t200; do
  for n in $NAMES; do
    [ -f "$V/fixtures-$arm/$n-windows.json" ] || { echo "MANQUE $arm/$n"; exit 1; }
  done
  [ -d "$V/gate-$arm-full-L20" ] || node --max-old-space-size=12288 $V/gate-contour.js $V/fixtures-$arm $V/gate-$arm-full-L20 20
done

run() { # $1 = arm name, $2 = fixtures dir, $3 = configs file, $4 = out tag
  RANKING_FIXTURES_DIR="$(pwd)/$2" EVAL_IN=$3 EVAL_OUT=$V/e5-$4-$1.json \
    npx vitest run --config vitest.ranking.config.ts experiments/ranking-study/evalset.test.ts 2>&1 | grep -E "rejouees|Error|FAIL|rror"
}
SPECS="ctl:fixtures-ctl ctlL20:gate-ctl-L20 t180:fixtures-t180 t180L20:gate-t180-full-L20 t200:fixtures-t200 t200L20:gate-t200-full-L20"
[ "$REP" = 1 ] && SPECS="$SPECS rep4000:fixtures-rep4000 rep4000L20:gate-rep4000-full-L20"
for spec in $SPECS; do
  arm=${spec%%:*}; dir=$V/${spec#*:}
  echo "==== $arm ($dir) ===="
  run "$arm" "$dir" $V/e1-configs.json fixed
  run "$arm" "$dir" $V/e5-floor-sweep.json floors
  run "$arm" "$dir" $V/e5-configs-temporal.json temporal
done

echo "==== configurations figees ===="
ARMS="ctl ctlL20 t180 t180L20 t200 t200L20"; [ "$REP" = 1 ] && ARMS="$ARMS rep4000 rep4000L20"
node $V/arms-compare.js $(for a in $ARMS; do printf "%s " $V/e5-fixed-$a.json; done) | tee $V/e5-fixed-compare.txt
echo "==== balayage du plancher ===="
node $V/arms-compare.js $(for a in $ARMS; do printf "%s " $V/e5-floors-$a.json; done) | tee $V/e5-floors-compare.txt
echo "==== configurations temporelles (plancher d absence) ===="
node $V/arms-compare.js $(for a in $ARMS; do printf "%s " $V/e5-temporal-$a.json; done) | tee $V/e5-temporal-compare.txt
