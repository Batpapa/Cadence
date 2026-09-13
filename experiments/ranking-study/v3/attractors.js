// H2 — are there "noise attractor" tunes, and does the noise-only fixture
// predict which ones fire in the gaps between sets?
//   node experiments/ranking-study/v3/attractors.js
//
// Counts rank-1 windows per tune in three pools:
//   noise  — the noise-only recording (no music at all, independent of the corpus)
//   gaps   — session windows whose centre lies in NO annotated row (between sets)
//   music  — session windows inside an annotated row whose tune is NOT rank 1
//            (i.e. where a wrong tune leads during real music)
// and reports how much of the gap rank-1 mass the noise fixture's attractors cover.

const fs = require("fs");
const path = require("path");
const DIR = path.resolve(__dirname, "../../../test-fixtures/sessions");
const SESSIONS = [
  "1Hour_Trad_Irish_Music_Session_in_Korea",
  "20260523_1_matin_Anglade",
  "20260523_2_aprem_tabac",
  "20260523_5_auberge_fleurie",
  "One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video",
  "13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24",
  "20240721_tocane_2_chapiteau",
];
const NOISE = "732984_11910076-lq";

const secs = v => v.trim().split(":").filter(Boolean).map(Number).reduce((a, n) => a * 60 + n, 0);
function truth(id) {
  const lines = fs.readFileSync(path.join(DIR, id + "-timings.csv"), "utf-8").split("\n").map(l => l.trim()).filter(Boolean).slice(1);
  return lines.map(l => { const c = l.split(","); return { start: secs(c[0]), end: secs(c[1]), id: c[2].trim() }; });
}
function windows(id) {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, id + "-windows.json"), "utf-8"));
  return (Array.isArray(raw) ? raw : Object.values(raw)).sort((a, b) => a.tWindowStart - b.tWindowStart);
}
const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
const names = new Map();

const noise = new Map();
const noiseWs = windows(NOISE);
let noiseN = 0;
for (const w of noiseWs) {
  const c = w.candidates[0];
  if (!c) continue;
  noiseN++; bump(noise, c.tuneId); names.set(c.tuneId, c.displayName);
}

const gaps = new Map(), music = new Map(), perSessionGap = new Map();
let gapN = 0, musicN = 0;
for (const id of SESSIONS) {
  const tr = truth(id);
  for (const w of windows(id)) {
    const c = w.candidates[0];
    if (!c) continue;
    names.set(c.tuneId, c.displayName);
    const x = (w.tWindowStart + w.tWindowEnd) / 2;
    const row = tr.find(g => x >= g.start && x <= g.end);
    if (!row) {
      gapN++; bump(gaps, c.tuneId);
      if (!perSessionGap.has(c.tuneId)) perSessionGap.set(c.tuneId, new Set());
      perSessionGap.get(c.tuneId).add(id.slice(0, 10));
    } else if (row.id !== c.tuneId && row.id !== "0") {
      musicN++; bump(music, c.tuneId);
    }
  }
}

const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
console.log("bruit : " + noiseWs.length + " fenetres, " + noiseN + " avec un rang 1, " + noise.size + " morceaux distincts");
console.log("blancs : " + gapN + " fenetres avec un rang 1, " + gaps.size + " morceaux distincts");
console.log("musique, mauvais meneur : " + musicN + " fenetres, " + music.size + " morceaux distincts");

console.log("\n-- top 25 attracteurs du bruit pur (rang 1) : bruit | blancs | musique-faux-meneur | sessions ou il sallume dans les blancs");
for (const [k, n] of top(noise, 25)) {
  console.log("  " + k.padStart(6) + " " + String(n).padStart(4) + " | " + String(gaps.get(k) || 0).padStart(4) + " | " + String(music.get(k) || 0).padStart(4) + " | " + [...(perSessionGap.get(k) || [])].join(",") + "  " + names.get(k));
}
console.log("\n-- top 25 des blancs : blancs | bruit | musique-faux-meneur | sessions");
for (const [k, n] of top(gaps, 25)) {
  console.log("  " + k.padStart(6) + " " + String(n).padStart(4) + " | " + String(noise.get(k) || 0).padStart(4) + " | " + String(music.get(k) || 0).padStart(4) + " | " + [...(perSessionGap.get(k) || [])].join(",") + "  " + names.get(k));
}

// Coverage: share of gap rank-1 windows owned by tunes that are rank-1 at least
// T times in the noise fixture, against the share of all session music windows
// the same tunes lead correctly (the cost of penalising them).
const correct = new Map();
for (const id of SESSIONS) {
  const tr = truth(id);
  for (const w of windows(id)) {
    const c = w.candidates[0];
    if (!c) continue;
    const x = (w.tWindowStart + w.tWindowEnd) / 2;
    const row = tr.find(g => x >= g.start && x <= g.end);
    if (row && row.id === c.tuneId) bump(correct, c.tuneId);
  }
}
console.log("\n-- couverture : attracteurs = rang 1 >= T fois sur le bruit pur");
for (const T of [1, 2, 3, 5, 8]) {
  const att = new Set([...noise.entries()].filter(([, n]) => n >= T).map(([k]) => k));
  let g = 0, mu = 0, co = 0, truthTunes = 0;
  for (const [k, n] of gaps) if (att.has(k)) g += n;
  for (const [k, n] of music) if (att.has(k)) mu += n;
  for (const [k, n] of correct) if (att.has(k)) co += n;
  const allTruth = new Set(SESSIONS.flatMap(id => truth(id).map(r => r.id)));
  for (const k of att) if (allTruth.has(k)) truthTunes++;
  console.log("  T=" + T + " : " + att.size + " attracteurs ; " + (100 * g / gapN).toFixed(1) + "% des rangs 1 des blancs ; " + (100 * mu / musicN).toFixed(1) + "% des faux meneurs en musique ; " + co + " rangs 1 CORRECTS en musique leur appartiennent ; " + truthTunes + " sont des morceaux de la verite terrain");
}
