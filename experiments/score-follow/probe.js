'use strict';
// One alignment looked at closely: how fast the score is walked through, ten
// seconds at a time. A cursor that "rushes" shows up as a jump in quavers/s.
//
//   node experiments/score-follow/probe.js <audio> <settingId> <from s> <to s>   (from Cadence/)
const fs = require('node:fs');
const path = require('node:path');
const { featuresOf, decodeSpan } = require('./lib/engine');
const { align, FPS, MIDI_LOW } = require('./lib/align');

const [audio, settingId, fromS, toS] = process.argv.slice(2);
const idx = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../noise-study/.cache/tune-index.json'), 'utf8'));
const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV';
const s = idx.settings[settingId];
const score = [...s.contour].map((c) => MIDI_LOW + CHARS.indexOf(c));
const from = Number(fromS), to = Number(toS);
const feats = featuresOf(decodeSpan(audio, from, to - from));
const r = align(feats, score);
console.log(`${(idx.aliases[s.tune_id] || ['?'])[0]} (${s.dance}, ${s.meter}, ${score.length} quavers) bpm ${r.bpm} — expected quaver rate ${(r.bpm / 30).toFixed(2)}/s`);
const t = r.onsets.map((o) => from + o.frame / FPS);
console.log(`aligned ${t[0]?.toFixed(1)} → ${(from + r.end / FPS).toFixed(1)} s, ${r.onsets.length} quavers`);
for (let a = Math.floor(t[0] / 10) * 10; a < from + r.end / FPS; a += 10) {
  const n = t.filter((x) => x >= a && x < a + 10).length;
  const firstIdx = r.onsets.find((o, k) => t[k] >= a)?.index;
  console.log(`  ${String(a).padStart(5)} s  ${(n / 10).toFixed(2)} quavers/s  ${'#'.repeat(Math.round(n / 2))}  (from quaver ${firstIdx})`);
}
