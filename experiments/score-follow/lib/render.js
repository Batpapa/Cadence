'use strict';
// A played SEQUENCE rendered to audio, true onsets known — synth.js's render,
// generalised for the live bench (live.mjs): the sequence is the quaver
// indices actually played, with rests, so a practice session (a part, a
// pause, the B part again, a bar twice) can be rendered as well as a tune
// played straight through.
const { RATE } = require('./engine');

const hz = (m) => 440 * 2 ** ((m - 69) / 12);

/** `played`: quaver indices into `score`, null for a quaver's rest.
 *  Returns the PCM and the notes: { t, dur, index } (index null in a rest). */
function renderSequence(score, played, { bpm, swing = 0.55, drift = 0.06, jitter = 0.008, snrDb = 10, lead = 3, accomp = true, cuts = 0.1, seed = 12345, held = false }) {
  let s0 = seed;
  const rnd = () => ((s0 = (s0 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const q = 60 / bpm / 2;
  const notes = [];
  let t = lead;
  const total = played.length;
  for (let n = 0; n < total; n++) {
    const phase = n / total;
    const local = q * (1 + drift * Math.sin(2 * Math.PI * phase * 1.5));
    const dur = local * 2 * (n % 2 === 0 ? swing : 1 - swing);
    notes.push({ t: t + (played[n] === null ? 0 : jitter * gauss()), dur, index: played[n] });
    t += dur;
  }
  const end = t;
  const len = Math.ceil((t + lead) * RATE);
  const pcm = new Float32Array(len);
  for (let k = 0; k < notes.length; k++) {
    const nt = notes[k];
    if (nt.index === null) continue;
    // held: quavers of one pitch in a row are one note held, as a crotchet
    // is played — no attack to tell where the second begins.
    let endT = nt.t + nt.dur;
    while (held && k + 1 < notes.length && notes[k + 1].index !== null && score[notes[k + 1].index] === score[nt.index]) { k++; endT = notes[k].t + notes[k].dur; }
    const a = Math.max(0, Math.floor(nt.t * RATE));
    const b = Math.min(len, Math.floor(endT * RATE));
    const f0 = hz(score[nt.index]);
    const cut = rnd() < cuts ? Math.floor(0.03 * RATE) : 0;
    let phase = 0;
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
    const counts = new Map();
    for (const m of score) counts.set(m % 12, (counts.get(m % 12) || 0) + 1);
    const root = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0] + 48;
    for (let i = 0; i < notes.length; i += 2) {
      if (notes[i].index === null) continue;
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
  let p = 0, heard = 0;
  for (let s = 0; s < len; s++) if (pcm[s] !== 0) { p += pcm[s] * pcm[s]; heard++; }
  // Noise against the music where there is music, not diluted by the rests.
  const noiseAmp = Math.sqrt(p / Math.max(1, heard) / 10 ** (snrDb / 10));
  let pink = 0;
  for (let s = 0; s < len; s++) { pink = 0.97 * pink + 0.03 * gauss() * 6; pcm[s] += noiseAmp * pink; }
  return { pcm, notes, end };
}

module.exports = { renderSequence };
