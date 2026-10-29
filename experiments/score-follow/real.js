'use strict';
// Score following on the real annotated sessions. There is no note-level
// ground truth, so three things are measured per tune:
//  - discrimination: the detected setting must align clearly better than
//    decoys (other tunes of the same meter and similar length) — if it does
//    not, the cursor would be following noise;
//  - coverage: share of the tune's span the alignment follows;
//  - regularity: durations of the successive passes (a tune is played at a
//    steady tempo, so a cursor that slips shows up as uneven passes).
//
//   node experiments/score-follow/real.js [session-substring] [maxTunes]   (from Cadence/)
const fs = require('node:fs');
const path = require('node:path');
const { featuresOf, decodeSpan } = require('./lib/engine');
const { align, FPS, MIDI_LOW, MIDI_NUM } = require('./lib/align');

const ROOT = path.resolve(__dirname, '../..');
const INDEX = path.resolve(__dirname, '../noise-study/.cache/tune-index.json');
const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV';
const toMidi = (contour) => [...contour].map((c) => MIDI_LOW + CHARS.indexOf(c));
const AUDIO = {
  '20260523_1_matin_Anglade': '20260523_1_matin_Anglade.m4a',
  '20260523_2_aprem_tabac': '20260523_2_aprem_tabac.m4a',
  '20260523_5_auberge_fleurie': '20260523_5_auberge_fleurie.m4a',
  '20240721_tocane_2_chapiteau': '20240721_tocane_2_chapiteau.m4a',
  '1Hour_Trad_Irish_Music_Session_in_Korea': '1Hour Trad Irish Music Session in Korea.mp3',
  'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video': 'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video.mp3',
  '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24': '13th Moon Gravity Well - Irish Trad Session 2024.01.24.mp3',
};
const secs = (s) => s.split(':').reduce((a, b) => a * 60 + Number(b), 0);

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
// `CONTOURS=file.json`: the true setting's score read off its DRAWING (pitches
// per quaver, by settingId) instead of the index's contour. With `BEST=1`,
// both are aligned and the better fit kept — what the app does since
// 2026-10-29 (scoreFollowWorker.ts). Decoys keep the index's.
const CONTOURS = process.env.CONTOURS ? JSON.parse(fs.readFileSync(process.env.CONTOURS, 'utf8')) : null;
const BEST = !!process.env.BEST;
const byMeter = new Map();
for (const [id, s] of Object.entries(idx.settings)) (byMeter.get(s.meter) || byMeter.set(s.meter, []).get(s.meter)).push(id);

/** Share of aligned frames whose loudest pitch class is the score's. */
function matchRate(feats, score, r) {
  let hit = 0, n = 0;
  for (let k = 0; k < r.onsets.length; k++) {
    const a = r.onsets[k].frame, b = k + 1 < r.onsets.length ? r.onsets[k + 1].frame : r.end;
    const pc = (score[r.onsets[k].index] + r.transpose) % 12;
    for (let t = a; t < b; t++) {
      let best = 0, arg = 0;
      for (let p = 0; p < MIDI_NUM; p++) if (feats[t * MIDI_NUM + p] > best) { best = feats[t * MIDI_NUM + p]; arg = p; }
      if (best <= 0) continue;
      n++;
      if ((arg + MIDI_LOW) % 12 === pc) hit++;
    }
  }
  return n ? hit / n : 0;
}

function passes(r) {
  const starts = [];
  r.onsets.forEach((o, k) => { if (o.index === 0) starts.push(o.frame / FPS); });
  const durs = starts.slice(1).map((s, i) => s - starts[i]);
  const mean = durs.reduce((a, b) => a + b, 0) / (durs.length || 1);
  const sd = Math.sqrt(durs.reduce((a, b) => a + (b - mean) ** 2, 0) / (durs.length || 1));
  return { count: starts.length, durs, cv: durs.length > 1 ? sd / mean : NaN };
}

const filter = process.argv[2] || '';
const maxTunes = Number(process.argv[3] || 1e9);
const out = [];
for (const [fixture, audioName] of Object.entries(AUDIO)) {
  if (!fixture.includes(filter)) continue;
  const csv = path.join(ROOT, 'test-fixtures/sessions', fixture + '-timings.csv');
  const winFile = path.join(ROOT, 'test-fixtures/sessions', fixture + '-windows.json');
  const audio = path.join(ROOT, 'test-fixtures/audio', audioName);
  if (!fs.existsSync(csv) || !fs.existsSync(audio)) continue;
  const windows = JSON.parse(fs.readFileSync(winFile, 'utf8'));
  const rows = fs.readFileSync(csv, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
  let done = 0;
  for (const [a, b, tuneId] of rows) {
    if (done >= maxTunes) break;
    if (!(Number(tuneId) > 0)) continue;
    const start = secs(a), end = secs(b);
    // The setting the engine itself picked for this tune in this span.
    const votes = new Map();
    for (const w of windows) {
      if (w.tWindowEnd <= start || w.tWindowStart >= end) continue;
      for (const c of w.candidates) if (c.tuneId === tuneId) votes.set(c.settingId, (votes.get(c.settingId) || 0) + c.score);
    }
    if (!votes.size) continue; // never detected: no detection to start from in the app
    const settingId = [...votes.entries()].sort((x, y) => y[1] - x[1])[0][0];
    const setting = idx.settings[settingId];
    if (!setting) continue;
    done++;
    // A margin on each side, like the app: the neighbouring tunes of the set
    // are then in the audio, and must be left out of the alignment.
    const M = 5;
    const from = Math.max(0, start - M);
    const feats = featuresOf(decodeSpan(audio, from, end + M - from));
    const frames = feats.length / MIDI_NUM;
    const t0 = Date.now();
    const opts = { transposes: [0], otherPenalty: Number(process.env.OTHER || 1.2), exhaustive: !!process.env.EXHAUSTIVE };
    const candidates = CONTOURS?.[settingId]
      ? (BEST ? [CONTOURS[settingId], toMidi(setting.contour)] : [CONTOURS[settingId]])
      : [toMidi(setting.contour)];
    let score = candidates[0], r = align(feats, score, opts);
    for (const c of candidates.slice(1)) {
      const o = align(feats, c, opts);
      if (o.score > r.score) { r = o; score = c; }
    }
    const ms = Date.now() - t0;
    // Decoys: same meter, length within 25 %, other tunes.
    const pool = (byMeter.get(setting.meter) || []).filter((id) => idx.settings[id].tune_id !== tuneId
      && Math.abs(idx.settings[id].contour.length - score.length) <= score.length * 0.25);
    const decoys = [];
    for (let k = 0; k < 4 && pool.length; k++) {
      const id = pool[Math.floor(rnd() * pool.length)];
      const d = align(feats, toMidi(idx.settings[id].contour), { ...opts, bpms: [r.bpm - 10, r.bpm, r.bpm + 10] });
      // A decoy now aligns only where it happens to fit and leaves the rest to
      // "not this tune": what it CLAIMS of the span is the telling figure.
      const claimed = d.onsets.length ? (d.end - d.onsets[0].frame) / FPS / (end - start) : 0;
      decoys.push({ id, perFrame: d.score / frames, match: matchRate(feats, toMidi(idx.settings[id].contour), d), claimed });
    }
    // Share of the ANNOTATED span the alignment covers, and how far its ends
    // fall from the annotation's (seconds; annotations are to the second).
    const a0 = r.onsets.length ? from + r.onsets[0].frame / FPS : end;
    const a1 = from + r.end / FPS;
    const covered = Math.max(0, Math.min(a1, end) - Math.max(a0, start)) / (end - start);
    const startErr = a0 - start, endErr = a1 - end;
    const pz = passes(r);
    const row = {
      fixture, tuneId, settingId, name: (idx.aliases[tuneId] || ['?'])[0], dance: setting.dance, len: score.length,
      span: end - start, bpm: r.bpm, perFrame: r.score / frames, match: matchRate(feats, score, r), covered, startErr, endErr,
      passes: pz.count, passCv: pz.cv, passDurs: pz.durs.map((d) => +d.toFixed(1)),
      decoyBest: Math.max(...decoys.map((d) => d.perFrame)), decoyMatch: Math.max(...decoys.map((d) => d.match)), decoyClaimed: Math.max(...decoys.map((d) => d.claimed)), ms,
      onsets: r.onsets.map((o) => [+(o.frame / FPS).toFixed(3), o.index]),
    };
    out.push(row);
    console.log(`${row.name.slice(0, 26).padEnd(26)} ${row.dance.padEnd(9)} ${String(Math.round(row.span)).padStart(4)}s bpm ${row.bpm}  match ${(row.match * 100).toFixed(0)}% decoy claims ${(row.decoyClaimed * 100).toFixed(0)}%  margin ${(row.perFrame - row.decoyBest).toFixed(3)}  covered ${(covered * 100).toFixed(0)}% ends ${startErr.toFixed(1)}/${endErr.toFixed(1)}s  passes ${row.passes} cv ${(pz.cv * 100).toFixed(1)}% [${row.passDurs.join(' ')}]  (${ms} ms)`);
  }
}
fs.mkdirSync(path.join(__dirname, 'output'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'output', `real${filter ? '-' + filter : ''}${process.env.OTHER ? '-p' + process.env.OTHER : ''}.json`), JSON.stringify(out));
const ok = out.filter((r) => r.perFrame > r.decoyBest);
console.log(`\n${out.length} tunes; true setting beats every decoy: ${ok.length}; median match ${(median(out.map((r) => r.match)) * 100).toFixed(0)}% ; median covered ${(median(out.map((r) => r.covered)) * 100).toFixed(0)}% vs decoy claims ${(median(out.map((r) => r.decoyClaimed)) * 100).toFixed(0)}%; median pass CV ${(median(out.map((r) => r.passCv).filter((x) => !isNaN(x))) * 100).toFixed(1)}%`);
function median(xs) { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
