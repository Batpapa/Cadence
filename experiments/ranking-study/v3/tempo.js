// H3 cause: does FolkFriend's tempo estimate go wrong on polkas?
//   node experiments/ranking-study/v3/tempo.js
const fs = require("fs");
const path = require("path");
const DIR = process.env.RANKING_FIXTURES_DIR || path.resolve(__dirname, "../../../test-fixtures/sessions");
const SESSIONS = ["1Hour_Trad_Irish_Music_Session_in_Korea", "20260523_1_matin_Anglade", "20260523_2_aprem_tabac", "20260523_5_auberge_fleurie", "One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video", "13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24", "20240721_tocane_2_chapiteau"];
const idx = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../noise-study/.cache/tune-index.json"), "utf-8")).settings;
const dance = new Map();
for (const s of Object.values(idx)) if (!dance.has(String(s.tune_id))) dance.set(String(s.tune_id), s.dance);
const secs = v => v.trim().split(":").filter(Boolean).map(Number).reduce((a, n) => a * 60 + n, 0);
const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : NaN; };

// Fisher exact (two-sided) for a 2x2 table, via hypergeometric probabilities.
function lf(n) { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; }
function fisher(a, b, c, d) {
  const n = a + b + c + d, r1 = a + b, c1 = a + c;
  const p = x => Math.exp(lf(r1) + lf(n - r1) + lf(c1) + lf(n - c1) - lf(n) - lf(x) - lf(r1 - x) - lf(c1 - x) - lf(n - r1 - c1 + x));
  const p0 = p(a); let tot = 0;
  for (let x = Math.max(0, c1 + r1 - n); x <= Math.min(r1, c1); x++) { const px = p(x); if (px <= p0 * (1 + 1e-9)) tot += px; }
  return tot;
}
console.log("Fisher, manques polka 7/22 contre autres 22/319 : p = " + fisher(7, 15, 22, 297).toExponential(2));
console.log("Fisher, jamais-top10 polka 4/22 contre autres 5/319 : p = " + fisher(4, 18, 5, 314).toExponential(2));

const pool = new Map();
let candMin = Infinity, candMax = -Infinity;
for (const id of SESSIONS) {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, id + "-windows.json"), "utf-8"));
  const ws = Array.isArray(raw) ? raw : Object.values(raw);
  const rows = fs.readFileSync(path.join(DIR, id + "-timings.csv"), "utf-8").split("\n").map(l => l.trim()).filter(Boolean).slice(1);
  for (const l of rows) {
    const c = l.split(",");
    const tid = c[2].trim();
    if (!/^[1-9][0-9]*$/.test(tid)) continue;
    const st = secs(c[0]), en = secs(c[1]);
    const d = dance.get(tid) || "?";
    const e = pool.get(d) || { bpm: [], rank1: 0, n: 0, inTop: 0, rank1Bpm: [], absentBpm: [] };
    for (const w of ws) {
      const x = (w.tWindowStart + w.tWindowEnd) / 2;
      if (x < st || x > en) continue;
      const f = w.debug && w.debug.features;
      if (!f) continue;
      for (const tc of f.tempo_candidates || []) { if (tc.bpm < candMin) candMin = tc.bpm; if (tc.bpm > candMax) candMax = tc.bpm; }
      e.n++;
      e.bpm.push(f.best_bpm);
      const k = w.candidates.findIndex(cd => cd.tuneId === tid);
      if (k === 0) { e.rank1++; e.rank1Bpm.push(f.best_bpm); }
      if (k >= 0) e.inTop++; else e.absentBpm.push(f.best_bpm);
    }
    pool.set(d, e);
  }
}
console.log("\nplage des tempo_candidates dans les fenetres : " + candMin + " -> " + candMax + " bpm");
console.log("\n-- best_bpm sur les plages annotees : type | fenetres | rang1 % | top10 % | bpm p10/p50/p90 | bpm quand rang 1 (p50) | bpm quand absent du top10 (p50)");
for (const [d, e] of [...pool.entries()].sort((a, b) => b[1].n - a[1].n)) {
  if (e.n < 30) continue;
  console.log("  " + d.padEnd(10) + String(e.n).padStart(6) + " | " + (100 * e.rank1 / e.n).toFixed(0).padStart(3) + "% | " + (100 * e.inTop / e.n).toFixed(0).padStart(3) + "% | "
    + q(e.bpm, 0.1).toFixed(0) + "/" + q(e.bpm, 0.5).toFixed(0) + "/" + q(e.bpm, 0.9).toFixed(0) + " | " + q(e.rank1Bpm, 0.5).toFixed(0) + " | " + q(e.absentBpm, 0.5).toFixed(0));
}
// Histogram of best_bpm for polka vs reel, 10-bpm bins
for (const d of ["polka", "reel", "jig"]) {
  const e = pool.get(d); if (!e) continue;
  const h = new Map();
  for (const b of e.bpm) { const k = Math.floor(b / 10) * 10; h.set(k, (h.get(k) || 0) + 1); }
  const hr = new Map();
  for (const b of e.rank1Bpm) { const k = Math.floor(b / 10) * 10; hr.set(k, (hr.get(k) || 0) + 1); }
  console.log("\n  histogramme best_bpm " + d + " (bin: fenetres / dont rang 1)");
  console.log("   " + [...h.keys()].sort((a, b) => a - b).map(k => k + ":" + h.get(k) + "/" + (hr.get(k) || 0)).join("  "));
}
