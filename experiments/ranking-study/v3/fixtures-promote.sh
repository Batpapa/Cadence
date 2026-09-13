#!/usr/bin/env bash
# Promote the official regeneration into test-fixtures/sessions — ONLY if every file
# is byte-for-byte identical (by window content) to the study harness's independent
# regeneration with the same engine build and calls. Then run the full test suite.
#   bash experiments/ranking-study/v3/fixtures-promote.sh      (run from Cadence/)
set -u
V=experiments/ranking-study/v3
S=$V/fixtures-regen-official
NAMES="1Hour_Trad_Irish_Music_Session_in_Korea 20260523_1_matin_Anglade 20260523_2_aprem_tabac 20260523_5_auberge_fleurie One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video 13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24 20240721_tocane_2_chapiteau 732984_11910076-lq"

echo "==== regeneration officielle contre fixtures-prod ===="
bad=0
for n in $NAMES; do
  [ -f "$S/$n-windows.json" ] || { echo "MANQUE $S/$n-windows.json"; bad=1; continue; }
  res=$(node --max-old-space-size=8192 $V/compare-windows.js $V/fixtures-prod/$n-windows.json $S/$n-windows.json | tail -n 2 | tr '\n' ' ')
  echo "  $n : $res"
  echo "$res" | grep -q "IDENTICAL" || bad=1
done
if [ "$bad" != 0 ]; then
  echo "ARRET : au moins un fichier differe ou manque — rien n'a ete copie dans test-fixtures/sessions."
  exit 1
fi

echo "==== copie dans test-fixtures/sessions ===="
for n in $NAMES; do cp "$S/$n-windows.json" "test-fixtures/sessions/$n-windows.json"; done
sha256sum test-fixtures/sessions/*-windows.json | awk '{print substr($1,1,16), $2}' | tee $V/install-backup/test-fixtures-sessions/SHA256-after.txt

echo "==== suite de tests complete ===="
npx vitest run 2>&1 | grep -E "FAIL|×|✗|failed|Test Files|Tests " | tail -n 40
