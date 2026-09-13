'use strict';
// Engine screening at WINDOW level — no Viterbi. For one or more fixture
// directories (possibly sub-sampled with regen-tempo.js --stride), reports:
//   - rank-1 and top-10 rates inside annotated spans, overall and per dance;
//   - temporal quality of the evidence per annotated tune (the user's second
//     goal, coverage of the true duration): delay of the first rank-1 window
//     after the true start, lead of the last rank-1 window before the true end,
//     and the fraction of the span's windows where the tune is rank 1;
//   - on the noise fixture, the mean top-1 score (a false-positive pressure proxy).
// Windows are compared at the SAME indices across directories: a directory
// generated with --stride k holds windows 0, k, 2k... and is compared only on
// those, so every directory is read on the intersection of the time grids.
//
//   node experiments/ranking-study/v3/screen.js <dirA> [dirB ...]
const fs = require('node:fs');
const path = require('node:path');
const V = __dirname;
const CSV_DIR = path.resolve(V, '../../../test-fixtures/sessions');
const SESSIONS = ['1Hour_Trad_Irish_Music_Session_in_Korea', '20260523_1_matin_Anglade', '20260523_2_aprem_tabac', '20260523_5_auberge_fleurie', 'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video', '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24', '20240721_tocane_2_chapiteau'];
const NOISE = '732984_11910076-lq';
const idx = JSON.parse(fs.readFileSync(path.resolve(V, '../../noise-study/.cache/tune-index.json'), 'utf-8')).settings;
const dance = new Map();
for (const s of Object.values(idx)) if (!dance.has(String(s.tune_id))) dance.set(String(s.tune_id), s.dance);
const secs = v => v.trim().split(':').filter(Boolean).map(Number).reduce((a, n) => a * 60 + n, 0);
const q = (a, p) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };

const dirs = process.argv.slice(2).map(d => path.resolve(d));
if (!dirs.length) { console.error('usage: screen.js <dir> [dir...]'); process.exit(1); }
const loadMap = (dir, id) => {
  const p = path.join(dir, `${id}-windows.json`);
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const m = new Map();
  for (const w of (Array.isArray(raw) ? raw : Object.values(raw))) m.set(Math.round(w.tWindowStart * 10), w);
  return m;
};

const stats = dirs.map(() => ({ per: new Map(), onset: [], offset: [], frac: [], noTop1: 0, tunes: 0, noiseTop: [], windows: 0, gain: 0, loss: 0, gainT10: 0, lossT10: 0 }));

// Exact two-sided sign test (McNemar on discordant pairs): P(X <= min(g, l)) * 2
// for X ~ Binomial(g + l, 1/2), computed in log space.
function signTest(g, l) {
  const n = g + l;
  if (!n) return 1;
  const k = Math.min(g, l);
  const lf = x => { let s = 0; for (let i = 2; i <= x; i++) s += Math.log(i); return s; };
  let p = 0;
  for (let i = 0; i <= k; i++) p += Math.exp(lf(n) - lf(i) - lf(n - i) - n * Math.LN2);
  return Math.min(1, 2 * p);
}
const bump = (st, d, key) => { if (!st.per.has(d)) st.per.set(d, { n: 0, r1: 0, t10: 0 }); st.per.get(d)[key]++; };

for (const id of SESSIONS) {
  const maps = dirs.map(d => loadMap(d, id));
  if (maps.some(m => !m)) { console.log(`(session ${id} absente d'un dossier, ignoree)`); continue; }
  // intersection of time grids
  let keys = [...maps[0].keys()];
  for (const m of maps.slice(1)) keys = keys.filter(k => m.has(k));
  keys.sort((a, b) => a - b);
  const rows = fs.readFileSync(path.join(CSV_DIR, `${id}-timings.csv`), 'utf-8').split('\n').map(l => l.trim()).filter(Boolean).slice(1);
  for (const l of rows) {
    const c = l.split(',');
    const tid = c[2].trim();
    if (!/^[1-9][0-9]*$/.test(tid)) continue;
    const st0 = secs(c[0]), en = secs(c[1]);
    const d = dance.get(tid) || '?';
    // Paired pass: the same window in every directory, compared with the first.
    for (const k of keys) {
      const w0 = maps[0].get(k);
      const x = (w0.tWindowStart + w0.tWindowEnd) / 2;
      if (x < st0 || x > en) continue;
      const r0 = w0.candidates.findIndex(cd => cd.tuneId === tid);
      for (let a = 1; a < maps.length; a++) {
        const ra = maps[a].get(k).candidates.findIndex(cd => cd.tuneId === tid);
        const S = stats[a];
        if (ra === 0 && r0 !== 0) S.gain++;
        if (r0 === 0 && ra !== 0) S.loss++;
        if (ra >= 0 && r0 < 0) S.gainT10++;
        if (r0 >= 0 && ra < 0) S.lossT10++;
      }
    }
    maps.forEach((m, a) => {
      const S = stats[a];
      const inSpan = keys.map(k => m.get(k)).filter(w => { const x = (w.tWindowStart + w.tWindowEnd) / 2; return x >= st0 && x <= en; });
      if (!inSpan.length) return;
      S.tunes++;
      let first = null, last = null, r1 = 0;
      for (const w of inSpan) {
        const k = w.candidates.findIndex(cd => cd.tuneId === tid);
        S.windows++;
        if (typeof w.debug?.contour === 'string') (S.musicLen ||= []).push(w.debug.contour.length);
        bump(S, d, 'n'); bump(S, 'TOUS', 'n');
        if (k >= 0) { bump(S, d, 't10'); bump(S, 'TOUS', 't10'); }
        if (k === 0) {
          bump(S, d, 'r1'); bump(S, 'TOUS', 'r1'); r1++;
          const x = (w.tWindowStart + w.tWindowEnd) / 2;
          if (first === null) first = x;
          last = x;
        }
      }
      if (first === null) { S.noTop1++; return; }
      S.onset.push(first - st0);
      S.offset.push(en - last);
      S.frac.push(r1 / inSpan.length);
    });
  }
}
// noise fixture
{
  const maps = dirs.map(d => loadMap(d, NOISE));
  if (maps.every(Boolean)) {
    let keys = [...maps[0].keys()];
    for (const m of maps.slice(1)) keys = keys.filter(k => m.has(k));
    maps.forEach((m, a) => {
      for (const k of keys) {
        const w = m.get(k);
        stats[a].noiseTop.push(w.candidates[0]?.score ?? 0);
        const c = w.debug?.contour;
        if (typeof c === 'string') (stats[a].noiseLen ||= []).push(c.length);
      }
    });
  }
}

const name = d => path.basename(d);
console.log('\n-- rangs 1 / top 10 dans les plages annotees (fenetres communes) --');
const dances = ['TOUS', 'reel', 'jig', 'polka', 'hornpipe', 'slip jig', 'slide'];
console.log('  dossier'.padEnd(24) + dances.map(x => x.padStart(18)).join(''));
dirs.forEach((d, a) => {
  const S = stats[a];
  console.log('  ' + name(d).padEnd(22) + dances.map(x => {
    const e = S.per.get(x); if (!e) return '-'.padStart(18);
    return `${(100 * e.r1 / e.n).toFixed(1)}%/${(100 * e.t10 / e.n).toFixed(1)}% n${e.n}`.padStart(18);
  }).join(''));
});
if (dirs.length > 1) {
  console.log(`\n-- comparaison appariee contre ${name(dirs[0])} (memes fenetres annotees) --`);
  console.log('  dossier'.padEnd(24) + 'rang1 gagnes/perdus'.padStart(21) + '   net'.padStart(7) + '   p (signe)'.padStart(13) + 'top10 gagnes/perdus'.padStart(22) + '   net'.padStart(7) + '   p (signe)'.padStart(13));
  dirs.slice(1).forEach((d, i) => {
    const S = stats[i + 1];
    console.log('  ' + name(d).padEnd(22) + `${S.gain}/${S.loss}`.padStart(21) + `${S.gain - S.loss >= 0 ? '+' : ''}${S.gain - S.loss}`.padStart(7)
      + signTest(S.gain, S.loss).toExponential(1).padStart(13)
      + `${S.gainT10}/${S.lossT10}`.padStart(22) + `${S.gainT10 - S.lossT10 >= 0 ? '+' : ''}${S.gainT10 - S.lossT10}`.padStart(7)
      + signTest(S.gainT10, S.lossT10).toExponential(1).padStart(13));
  });
}
console.log('\n-- qualite temporelle de la preuve, par morceau annote --');
console.log('  dossier'.padEnd(24) + 'sans rang1'.padStart(11) + '  retard debut p50/p75/p90 (s)'.padStart(32) + '  avance fin p50/p75/p90 (s)'.padStart(30) + '  fraction rang1 p25/p50'.padStart(26) + '  bruit top1 moyen'.padStart(19));
dirs.forEach((d, a) => {
  const S = stats[a];
  const f = v => (Number.isNaN(v) ? '-' : v.toFixed(0));
  const nt = S.noiseTop.length ? (S.noiseTop.reduce((x, y) => x + y, 0) / S.noiseTop.length).toFixed(4) : '-';
  console.log('  ' + name(d).padEnd(22) + `${S.noTop1}/${S.tunes}`.padStart(11)
    + `${f(q(S.onset, 0.5))}/${f(q(S.onset, 0.75))}/${f(q(S.onset, 0.9))}`.padStart(32)
    + `${f(q(S.offset, 0.5))}/${f(q(S.offset, 0.75))}/${f(q(S.offset, 0.9))}`.padStart(30)
    + `${q(S.frac, 0.25).toFixed(2)}/${q(S.frac, 0.5).toFixed(2)}`.padStart(26)
    + nt.padStart(19));
});
console.log('\n-- longueur du contour (symboles = croches) --');
console.log('  dossier'.padEnd(24) + 'musique annotee p25/p50/p75'.padStart(30) + 'bruit p25/p50/p75'.padStart(22));
dirs.forEach((d, a) => {
  const S = stats[a];
  const t = arr => (arr && arr.length ? `${q(arr, 0.25)}/${q(arr, 0.5)}/${q(arr, 0.75)}` : '-');
  console.log('  ' + name(d).padEnd(22) + t(S.musicLen).padStart(30) + t(S.noiseLen).padStart(22));
});
