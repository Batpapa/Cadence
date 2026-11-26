'use strict';
// A synthetic recording through the decoder (as transcriptor.test.ts makes them).
//   node bench/synth.js '[[midi, start, length], ...]' seconds '{decoder options}'
const path = require('node:path'), { pathToFileURL } = require('node:url');
const N = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
(async () => {
  const D = await import(pathToFileURL(path.join(__dirname, '../src/decoder.ts')).href);
  const RATE = 48000, notes = JSON.parse(process.argv[2]), seconds = Number(process.argv[3]);
  const out = new Float32Array(Math.round(seconds * RATE));
  let seed = 7;
  for (let i = 0; i < out.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out[i] = 0.002 * (seed / 0x7fffffff - 0.5); }
  for (const [pitch, start, length] of notes) {
    const f0 = 440 * 2 ** ((pitch - 69) / 12), s = Math.round(start * RATE), n = Math.round(length * RATE);
    for (let i = 0; i < n && s + i < out.length; i++) { const t = i / RATE, env = Math.min(1, t / 0.005, (length - t) / 0.01); let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * h * f0 * t) / h; out[s + i] += 0.2 * env * v; }
  }
  const res = D.decode(D.analyseAudio(out, RATE), JSON.parse(process.argv[4] || '{}'));
  for (const r of res) console.log(r.onset.toFixed(3), r.offset.toFixed(3), N[r.cls], 'p' + r.power.toFixed(2), r.octaves.map(x => x.toExponential(1)).join(' '));
})();
