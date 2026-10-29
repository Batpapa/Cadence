'use strict';
// Synthetic check of the aligner: a tune rendered from its own contour with a
// drifting tempo, swing, timing jitter, cuts, an accompaniment and noise, so
// the true onset of every quaver is known.
//
//   node experiments/score-follow/synth.js [--version]   (from Cadence/)
//
// --version renders one setting and aligns against ANOTHER setting of the same
// tune (same length only): the musicians rarely play the index's exact version.
const fs = require('node:fs');
const path = require('node:path');
const { featuresOf, RATE } = require('./lib/engine');
const { align, FPS, MIDI_LOW } = require('./lib/align');

const INDEX = path.resolve(__dirname, '../noise-study/.cache/tune-index.json');
const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV';
const toMidi = (contour) => [...contour].map((c) => MIDI_LOW + CHARS.indexOf(c));

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

const hz = (m) => 440 * 2 ** ((m - 69) / 12);

/** Renders `passes` passes of `score`; returns the PCM and the true onsets. */
function render(score, { bpm, passes = 3, swing = 0.55, drift = 0.06, jitter = 0.008, snrDb = 10, lead = 3, accomp = true, cuts = 0.1 }) {
  const q = 60 / bpm / 2;
  const notes = [];
  let t = lead;
  const total = score.length * passes;
  for (let n = 0; n < total; n++) {
    const phase = n / total;
    const local = q * (1 + drift * Math.sin(2 * Math.PI * phase * 1.5));
    const dur = local * 2 * (n % 2 === 0 ? swing : 1 - swing);
    notes.push({ t: t + jitter * gauss(), dur, m: score[n % score.length], index: n % score.length, pass: Math.floor(n / score.length) });
    t += dur;
  }
  const len = Math.ceil((t + lead) * RATE);
  const pcm = new Float32Array(len);
  for (const nt of notes) {
    const a = Math.max(0, Math.floor(nt.t * RATE));
    const b = Math.min(len, Math.floor((nt.t + nt.dur) * RATE));
    const f0 = hz(nt.m);
    const cut = rnd() < cuts ? Math.floor(0.03 * RATE) : 0;
    let phase = 0; // accumulated: a vibrato computed as sin(f(t)·t) sweeps wildly
    for (let s = a; s < b; s++) {
      const k = s - a;
      const env = Math.min(1, k / (0.01 * RATE)) * Math.min(1, (b - s) / (0.015 * RATE));
      const f = k < cut ? f0 * 2 ** (3 / 12) : f0 * (1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * s / RATE));
      phase += 2 * Math.PI * f / RATE;
      let v = 0;
      for (let h = 1; h <= 8; h++) v += Math.sin(phase * h) / h;
      pcm[s] += 0.25 * env * v;
    }
  }
  if (accomp) {
    // A guitar-ish strum on every crotchet: the tune's lowest common pitch class
    // as root, with its fifth, two octaves down-ish.
    const counts = new Map();
    for (const m of score) counts.set(m % 12, (counts.get(m % 12) || 0) + 1);
    const root = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0] + 48;
    for (let i = 0; i < notes.length; i += 2) {
      const a = Math.floor(notes[i].t * RATE), b = Math.min(len, a + Math.floor(0.4 * RATE));
      for (const m of [root, root + 7, root + 12]) {
        const f = hz(m);
        for (let s = Math.max(0, a); s < b; s++) {
          const env = Math.exp(-(s - a) / (0.15 * RATE));
          pcm[s] += 0.08 * env * (Math.sin(2 * Math.PI * f * s / RATE) + 0.5 * Math.sin(4 * Math.PI * f * s / RATE));
        }
      }
    }
  }
  let p = 0;
  for (let s = 0; s < len; s++) p += pcm[s] * pcm[s];
  const noiseAmp = Math.sqrt(p / len / 10 ** (snrDb / 10));
  let pink = 0;
  for (let s = 0; s < len; s++) { pink = 0.97 * pink + 0.03 * gauss() * 6; pcm[s] += noiseAmp * pink; }
  return { pcm, notes };
}

function evaluate(result, notes) {
  const byIndex = new Map();
  for (const n of notes) (byIndex.get(n.index) || byIndex.set(n.index, []).get(n.index)).push(n.t);
  const errs = [];
  for (const o of result.onsets) {
    const t = o.frame / FPS;
    const cands = byIndex.get(o.index) || [];
    let e = Infinity;
    for (const c of cands) if (Math.abs(c - t) < Math.abs(e)) e = t - c;
    errs.push(Math.abs(e));
  }
  errs.sort((a, b) => a - b);
  const pct = (x) => errs[Math.min(errs.length - 1, Math.floor(errs.length * x))];
  const covered = result.onsets.length / notes.length;
  return { median: pct(0.5), p90: pct(0.9), within100: errs.filter((e) => e <= 0.1).length / notes.length, covered };
}

const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const versionMode = process.argv.includes('--version');
const settingsOf = new Map();
for (const [id, s] of Object.entries(idx.settings)) (settingsOf.get(s.tune_id) || settingsOf.set(s.tune_id, []).get(s.tune_id)).push(id);

// A spread of dances; ids are TheSession tune ids (their first setting).
const tunes = [['1', 112], ['55', 115], ['2', 110], ['71', 105], ['27', 120], ['248', 90], ['3', 100], ['52', 118], ['65', 112], ['16', 105]];
const rows = [];
for (const [tuneId, bpm] of tunes) {
  const ids = settingsOf.get(tuneId) || [];
  const played = idx.settings[tuneId] ? tuneId : ids[0];
  if (!played) continue;
  const sPlayed = idx.settings[played];
  let target = played;
  if (versionMode) {
    target = ids.find((id) => id !== played && idx.settings[id].contour.length === sPlayed.contour.length);
    if (!target) continue;
  }
  const scorePlayed = toMidi(sPlayed.contour);
  const scoreTarget = toMidi(idx.settings[target].contour);
  const { pcm, notes } = render(scorePlayed, { bpm });
  const feats = featuresOf(pcm);
  const t0 = Date.now();
  const r = align(feats, scoreTarget);
  const ms = Date.now() - t0;
  const ev = evaluate(r, notes);
  const name = (idx.aliases[tuneId] || ['?'])[0];
  rows.push({ name, dance: sPlayed.dance, len: scorePlayed.length, trueBpm: bpm, bpm: r.bpm, ...ev, ms });
  console.log(`${name.padEnd(28)} ${sPlayed.dance.padEnd(9)} N=${String(scorePlayed.length).padEnd(4)} bpm ${bpm}→${r.bpm}  median ${(ev.median * 1000).toFixed(0)} ms  p90 ${(ev.p90 * 1000).toFixed(0)} ms  ≤100ms ${(ev.within100 * 100).toFixed(0)} %  covered ${(ev.covered * 100).toFixed(0)} %  (${ms} ms)`);
}
