// H3: is recall (production) and the candidate-list ceiling worse for some dance types / short contours?
//   node experiments/ranking-study/v3/dance.js
const fs = require("fs");
const path = require("path");
const DIR = path.resolve(__dirname, "../../../test-fixtures/sessions");
const SESSIONS = ["1Hour_Trad_Irish_Music_Session_in_Korea", "20260523_1_matin_Anglade", "20260523_2_aprem_tabac", "20260523_5_auberge_fleurie", "One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video", "13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24", "20240721_tocane_2_chapiteau"];
const idx = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../noise-study/.cache/tune-index.json"), "utf-8")).settings;
const info = new Map();
for (const s of Object.values(idx)) {
  const t = String(s.tune_id);
  const e = info.get(t) || { dance: s.dance, lens: [] };
  if (typeof s.contour === "string") e.lens.push(s.contour.length);
  info.set(t, e);
}
const med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
const secs = v => v.trim().split(":").filter(Boolean).map(Number).reduce((a, n) => a * 60 + n, 0);
const anat = fs.readFileSync(path.resolve(__dirname, "anatomy-prod.txt"), "utf-8").split("\n");
const missed = new Set();
let cur = "";
for (const l of anat) {
  const m = l.match(/==== (.+) ====/); if (m) cur = m[1];
  const r = l.match(/RATE\s+(\d+)\s+(\d+):(\d+):(\d+)/);
  if (r) missed.add(cur + "|" + r[1] + "|" + (Number(r[2]) * 3600 + Number(r[3]) * 60 + Number(r[4])));
}
const agg = new Map(), byLen = new Map();
const add = (m, k, found, top10) => { const e = m.get(k) || { n: 0, found: 0, top10: 0 }; e.n++; e.found += found; e.top10 += top10; m.set(k, e); };
for (const id of SESSIONS) {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, id + "-windows.json"), "utf-8"));
  const ws = Array.isArray(raw) ? raw : Object.values(raw);
  const rows = fs.readFileSync(path.join(DIR, id + "-timings.csv"), "utf-8").split("\n").map(l => l.trim()).filter(Boolean).slice(1);
  for (const l of rows) {
    const c = l.split(",");
    const tid = c[2].trim();
    if (!/^[1-9][0-9]*$/.test(tid)) continue;
    const st = secs(c[0]), en = secs(c[1]);
    const found = missed.has(id + "|" + tid + "|" + st) ? 0 : 1;
    const inSpan = ws.filter(w => { const x = (w.tWindowStart + w.tWindowEnd) / 2; return x >= st && x <= en; });
    const top10 = inSpan.some(w => w.candidates.some(k => k.tuneId === tid)) ? 1 : 0;
    const e = info.get(tid) || { dance: "?", lens: [] };
    add(agg, e.dance || "?", found, top10);
    const L = med(e.lens);
    add(byLen, L <= 130 ? "contour<=130" : L <= 200 ? "contour 131-200" : L <= 300 ? "contour 201-300" : "contour>300", found, top10);
  }
}
const print = (title, m) => {
  console.log("\n-- " + title + " : n | trouves (production) | dans le top10 au moins une fois");
  for (const [k, e] of [...m.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log("  " + String(k).padEnd(18) + String(e.n).padStart(4) + " | " + String(e.found).padStart(3) + " (" + (100 * e.found / e.n).toFixed(0).padStart(3) + "%) | " + String(e.top10).padStart(3) + " (" + (100 * e.top10 / e.n).toFixed(0).padStart(3) + "%)");
  }
};
console.log("manques de production lus dans anatomy-prod.txt :", missed.size);
print("par type de danse", agg);
print("par longueur de contour mediane du morceau", byLen);
