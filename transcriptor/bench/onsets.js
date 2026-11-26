'use strict';
const { REPO, WS } = require('./paths');
// Onset judge on tuneset (annotated played notes; repeated notes are merged in the
// annotation, so a re-attack found counts against us): F-measure of detected onsets
// against annotated ones, class blind, within 50 and 25 ms; recall at a low threshold (what
// a decoder choosing among candidates can reach); median timing error. Ours (broadband,
// pitch change, both) against FolkFriend's note starts.
//   node bench/onsets.js '{"threshold":1,"radius":6,"weight":1,...}'
const fs = require('node:fs'), v8 = require('node:v8'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const BENCH = `${WS}/transcription-bench`;
const C = require(`${BENCH}/lib/common`);
const { tunesetItems } = require(`${BENCH}/lib/corpora`);
const o = JSON.parse(process.argv[2] || '{}');

function match(det, truth, tol) {
  let i = 0, hit = 0; const errs = [];
  const used = new Uint8Array(det.length);
  for (const t of truth) {
    while (i < det.length && det[i] < t - tol) i++;
    let best = -1, bd = Infinity;
    for (let j = i; j < det.length && det[j] <= t + tol; j++) if (!used[j] && Math.abs(det[j] - t) < bd) { bd = Math.abs(det[j] - t); best = j; }
    if (best >= 0) { used[best] = 1; hit++; errs.push(det[best] - t); }
  }
  const p = hit / (det.length || 1), r = hit / (truth.length || 1);
  return { hit, p, r, f: p + r ? 2 * p * r / (p + r) : 0, errs };
}

(async () => {
  const S = await import(pathToFileURL(path.join(__dirname, '../src/spectrum.ts')).href);
  const L = await import(pathToFileURL(path.join(__dirname, '../src/salience.ts')).href);
  const O = await import(pathToFileURL(path.join(__dirname, '../src/onsets.ts')).href);
  const T = await import(pathToFileURL(`${REPO}/src/session/recognition/transcription.ts`).href);
  const items = tunesetItems();
  const ffCache = v8.deserialize(fs.readFileSync(`${BENCH}/cache/sweep/tuneset.v8`));
  const acc = {};
  const add = (k, m) => { acc[k] ??= { hit: 0, det: 0, tru: 0, errs: [] }; acc[k].hit += m.hit; acc[k].det += m.det; acc[k].tru += m.tru; acc[k].errs.push(...m.errs); };
  for (let i = 0; i < items.length; i++) {
    const pcm = C.decode(items[i].audio, { rate: 48000 });
    const short = S.analyse(pcm, 48000, { size: o.shortSize ?? 2048, hop: 256 });
    const long = S.analyse(pcm, 48000, { size: 4096, hop: 256 });
    const sal = L.salience(long, S.tuningOf(long), { kernel: 1, alpha: 0.9, beta: 0.5 });
    const hopS = 256 / 48000;
    const n = Math.min(short.frames, sal.frames);
    // both functions on one time axis: frame centres (the windows differ in length)
    const cS = (o.shortSize ?? 2048) / 2 / 48000, cL = 4096 / 2 / 48000, shift = Math.round((cL - cS) / hopS);
    const flux = O.overLocalMedian(short.flux, o.span ?? 40);
    const pc = O.overLocalMedian(O.pitchChange(sal.cls, sal.frames, o.lag ?? 4), o.span ?? 40);
    const norm = (x) => { let m = 0; for (const v of x) m += v; m /= x.length; return x.map(v => v / (m || 1)); };
    const fN = norm(flux), pN = norm(pc);
    const both = new Float32Array(n);
    for (let t = 0; t < n; t++) both[t] = (fN[t] ?? 0) + (o.weight ?? 1) * (pN[t - shift] ?? 0);
    const truth = items[i].truth.map(x => x.onset);
    const toTimes = (pk, centre) => pk.map(t => t * hopS + centre + (o.bias ?? 0));
    const sets = {
      flux: toTimes(O.peaks(fN, o.radius ?? 6, o.threshold ?? 1), cS),
      pitch: toTimes(O.peaks(pN, o.radius ?? 6, o.threshold ?? 1), cL),
      both: toTimes(O.peaks(both, o.radius ?? 6, o.threshold ?? 1), cS),
      bothLow: toTimes(O.peaks(both, o.radius ?? 6, (o.threshold ?? 1) * 0.3), cS),
      ff: T.classNotes(ffCache[i].classes).filter(x => x.power > 0.1 && x.frames >= 3).map(x => x.start / (48000 / 1024)),
    };
    for (const [k, det] of Object.entries(sets)) for (const tol of [0.05, 0.025]) { const m = match(det, truth, tol); add(`${k}@${tol * 1000}`, { hit: m.hit, det: det.length, tru: truth.length, errs: tol === 0.05 ? m.errs : [] }); }
  }
  for (const [k, a] of Object.entries(acc)) {
    const p = a.hit / a.det, r = a.hit / a.tru, f = 2 * p * r / (p + r);
    const e = a.errs.sort((x, y) => x - y), med = e.length ? e[e.length >> 1] : NaN, mad = e.length ? e.map(x => Math.abs(x - med)).sort((x, y) => x - y)[e.length >> 1] : NaN;
    console.log(`${k.padEnd(12)} F ${(100 * f).toFixed(1)}  P ${(100 * p).toFixed(1)}  R ${(100 * r).toFixed(1)}${e.length ? `  error median ${(1000 * med).toFixed(1)} ms, spread ${(1000 * mad).toFixed(1)} ms` : ''}`);
  }
})();
