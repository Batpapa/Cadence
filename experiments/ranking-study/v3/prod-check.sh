#!/usr/bin/env bash
# Control B — does the PRODUCTION engine (query-side contour gate, ffWorker's calls)
# reproduce the study arm (offline gate) and its end-to-end figures?
#   bash experiments/ranking-study/v3/prod-check.sh      (run from Cadence/)
set -u
V=experiments/ranking-study/v3
NAMES="1Hour_Trad_Irish_Music_Session_in_Korea 20260523_1_matin_Anglade 20260523_2_aprem_tabac 20260523_5_auberge_fleurie One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video 13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24 20240721_tocane_2_chapiteau 732984_11910076-lq"
for n in $NAMES; do
  [ -f "$V/fixtures-prod/$n-windows.json" ] || { echo "MANQUE fixtures-prod/$n"; exit 1; }
done

echo "==== fenetres : production (porte cote requete) contre etude (porte hors ligne) ===="
for n in $NAMES; do
  echo "-- $n"
  node --max-old-space-size=8192 $V/compare-windows.js $V/gate-t180-rep4000-full-L20/$n-windows.json $V/fixtures-prod/$n-windows.json | tail -n 2
done

echo "==== chaine complete sur fixtures-prod ===="
for pair in fixed:e1-configs temporal:e5-configs-temporal; do
  tag=${pair%%:*}; cfg=${pair#*:}
  RANKING_FIXTURES_DIR="$(pwd)/$V/fixtures-prod" EVAL_IN=$V/$cfg.json EVAL_OUT=$V/prod-$tag.json \
    npx vitest run --config vitest.ranking.config.ts experiments/ranking-study/evalset.test.ts 2>&1 | grep -E "rejouees|Error|FAIL|rror"
done

echo "==== configurations temporelles : etude (regle d'admission) contre production ===="
node $V/arms-compare.js $V/admit-temporal-t180-rep4000L20.json $V/prod-temporal.json | tee $V/prod-check-temporal.txt
