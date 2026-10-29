'use strict';
// Does abcjs unfold a setting into as many quavers as the index's contour?
// The cursor places a quaver proportionally along abcjs's timeline of one
// pass, which is exact only when the two agree.
//   node experiments/score-follow/abcjs-vs-contour.js [n]   (from Cadence/)
const fs = require('node:fs');
const path = require('node:path');
const abcjs = require('abcjs');
const idx = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../noise-study/.cache/tune-index.json'), 'utf8'));
const ids = Object.keys(idx.settings);
const n = Number(process.argv[2] || 400);
let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const key = (mode) => mode.replace(/major$/, '').replace(/minor$/, 'm').replace(/dorian$/, 'dor').replace(/mixolydian$/, 'mix');
const ratios = [];
const off = [];
for (let k = 0; k < n; k++) {
  const id = ids[Math.floor(rnd() * ids.length)];
  const s = idx.settings[id];
  const abc = `X:1\nM:${s.meter}\nL:1/8\nQ:1/8=120\nK:${key(s.mode)}\n${s.abc.replace(/!/g, '\n')}`;
  let tune;
  try { tune = abcjs.parseOnly(abc)[0]; } catch { continue; }
  if (!tune?.setTiming) continue;
  // At 120 quavers a minute a quaver is 500 ms.
  const timings = tune.setTiming(120 / (s.meter.endsWith('/8') ? 1 : 2), 0);
  const last = timings.length ? timings[timings.length - 1].milliseconds : 0;
  const ratio = last / 500 / s.contour.length;
  ratios.push(ratio);
  if (Math.abs(ratio - 1) > 0.03) off.push(`${id} ${s.dance} ${s.meter} contour ${s.contour.length} abcjs ${(last / 500).toFixed(1)}`);
}
ratios.sort((a, b) => a - b);
const q = (p) => ratios[Math.floor((ratios.length - 1) * p)].toFixed(3);
console.log(`${ratios.length} settings — abcjs quavers / contour: p5 ${q(0.05)} p25 ${q(0.25)} median ${q(0.5)} p75 ${q(0.75)} p95 ${q(0.95)}; off by >3 %: ${off.length}`);
console.log(off.slice(0, 15).join('\n'));
