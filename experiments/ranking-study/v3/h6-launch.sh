#!/usr/bin/env bash
# Hypothesis H6 screening — tempo model slope (default 0.5), stride 2, full corpus.
#   bash experiments/ranking-study/v3/h6-launch.sh      (run from Cadence/)
# Refuses to start unless the knobs2 control reproduced fixtures-ctl bit for bit.
set -u
V=experiments/ranking-study/v3
K=../folkfriend-src/rust/pkg-node-knobs2
if ! grep -q "IDENTICAL" /c/Users/antl/AppData/Local/Temp/claude/c--Perso-IrishMusicExperiments/7e397b90-95aa-46ec-92b3-181ff302bbab/tasks/b8e3trnye.output 2>/dev/null \
   && ! node $V/compare-windows.js $V/fixtures-ctl/One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video-windows.json $V/knobs2-default/One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video-windows.json 2>/dev/null | grep -q IDENTICAL; then
  echo "controle knobs2 non IDENTICAL (ou absent) : arret"; exit 1
fi
F=20240721_tocane_2_chapiteau
REST="1Hour_Trad_Irish_Music_Session_in_Korea 20260523_1_matin_Anglade 20260523_2_aprem_tabac 20260523_5_auberge_fleurie One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video 13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24 732984_11910076-lq"
date +%H:%M:%S
for S in 0.6 0.75 1.0; do
  T=${S/./}
  node --max-old-space-size=8192 $V/regen-tempo.js --wasm $K --stride 2 --call set_tempo_model:3,$S --out $V/screen-slope$T $F > $V/logs/screen-slope$T-F.log 2>&1 &
  node --max-old-space-size=8192 $V/regen-tempo.js --wasm $K --stride 2 --call set_tempo_model:3,$S --out $V/screen-slope$T $REST > $V/logs/screen-slope$T-rest.log 2>&1 &
done
wait
date +%H:%M:%S
for f in $V/logs/screen-slope*.log; do echo "== $f"; tail -n 1 "$f"; done
