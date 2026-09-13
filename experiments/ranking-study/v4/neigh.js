// B3 / B4 probes around a configuration.
//   node v4/neigh.js make rows.json <index|label> out.json [draws=50] [seed=1]
//     -> one-factor response curves + random neighbourhood draws, as ANNEAL_EVAL input
//   node v4/neigh.js sum results-*.json
//     -> curves as tables, neighbourhood as distributions, against production
const fs = require('fs');
const path = require('path');
const [, , cmd, ...args] = process.argv;

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const base = r => ({
  transform: r.transform, floorQ: r.floorQ, floor: r.floor, minSeg: r.minSeg, confirm: r.confirm,
  weights: { ...r.weights }, absent: r.absent, rapid: r.rapid, mergeGap: r.mergeGap,
  flat: r.flat, tempoSpread: r.tempoSpread, minCand: r.minCand,
});

if (cmd === 'make') {
  const [file, which, out, drawsS, seedS] = args;
  const rows = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const r0 = /^\d+$/.test(which) ? rows[Number(which)] : rows.find(r => r.label === which);
  if (!r0) throw new Error('ligne introuvable');
  const b = base(r0);
  const tag = r0.label || which;
  const list = [{ ...b, label: `${tag}|base` }];
  const curve = (name, values, set) => { for (const v of values) { const c = base(b); set(c, v); list.push({ ...c, label: `${tag}|curve|${name}|${v}` }); } };
  // Floor: absolute when the base has no quantile (production), else scale the quantile.
  if (b.floorQ) curve('floorQ×', [0.25, 0.5, 0.75, 1.5, 2, 4], (c, v) => { c.floorQ = clamp(b.floorQ * v, 0.0005, 0.9); });
  else curve('floor', [0.14, 0.16, 0.18, 0.22, 0.24, 0.26], (c, v) => { c.floor = v; });
  curve('absent', [0, 0.5, 0.7, 0.8, 0.9, 0.95, 0.97, 0.99], (c, v) => { c.absent = v; });
  curve('stay', [0, 0.05, 0.1, 0.2, 0.3, 0.5], (c, v) => { c.weights.unknownStay = v; });
  curve('in', [0, 0.1, 0.25, 0.5, 1], (c, v) => { c.weights.unknownToTune = v; });
  curve('out', [0.2, 0.5, 0.8, 1.2, 1.6], (c, v) => { c.weights.tuneToUnknown = v; });
  curve('chg', [0.3, 0.6, 0.8, 1, 1.5, 2], (c, v) => { c.weights.tuneChange = v; });
  curve('rapid', [0, 0.5, 1, 2, 4], (c, v) => { c.rapid = v; });
  curve('gap', [0, 3, 5, 7, 10, 15, 20], (c, v) => { c.mergeGap = v; });
  curve('tempoSpread', [0, 0.02, 0.05, 0.08, 0.1, 0.12, 0.15], (c, v) => { c.tempoSpread = v; });
  curve('minCand', [0.14, 0.18, 0.2, 0.24, 0.28], (c, v) => { c.minCand = v; });
  curve('flat', ['off', 0.02, 0.05, 0.1], (c, v) => { c.flat = v === 'off' ? null : v; });
  curve('minSeg', [0, 1, 2], (c, v) => { c.minSeg = v; });
  // Margin of the threshold law, −log(a) − unknownStay, at fixed stay: the coordinate
  // the absent floor actually acts through (both production and the v4 candidate sit
  // at ~0.024, right before the spill-over cliff).
  const stay0 = b.weights.unknownStay;
  curve('margin', [-0.01, 0, 0.01, 0.02, 0.03, 0.05, 0.1, 0.2], (c, v) => { c.absent = clamp(Math.exp(-(stay0 + v)), 0, 0.9999); });
  // Neighbourhood: every continuous coordinate jittered at once, discrete ones kept.
  const r = rng(Number(seedS || 1));
  const g = () => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-9))) * Math.cos(2 * Math.PI * r());
  for (let i = 0; i < Number(drawsS || 50); i++) {
    const c = base(b);
    if (b.floorQ) c.floorQ = clamp(b.floorQ * Math.exp(g() * 0.15), 0.0005, 0.9); else c.floor = b.floor * Math.exp(g() * 0.05);
    for (const k of Object.keys(c.weights)) c.weights[k] = clamp(c.weights[k] + g() * 0.08, 0, 3);
    // MARGIN=1 jitters in the threshold law's own coordinate: stay moves, and a follows
    // so that the margin −log(a) − stay is jittered multiplicatively around its base.
    // Independent jitter of a and stay crosses the cliff on half the draws for any base
    // sitting at the edge, and then measures the law, not the base.
    const m0 = -Math.log(b.absent) - b.weights.unknownStay;
    if (process.env.MARGIN === '1' && b.absent > 0 && m0 > 0) c.absent = clamp(Math.exp(-(c.weights.unknownStay + m0 * Math.exp(g() * 0.3))), 0, 0.9999);
    else c.absent = clamp(1 - (1 - b.absent) * Math.exp(g() * 0.3), 0, 0.99);
    c.rapid = clamp(b.rapid + g() * 0.2, 0, 4);
    c.mergeGap = clamp(Math.round(b.mergeGap + g() * 2), 0, 24);
    c.tempoSpread = clamp(b.tempoSpread + g() * 0.01, 0, 0.3);
    c.minCand = clamp(b.minCand + g() * 0.01, 0.12, 0.32);
    if (c.flat !== null) c.flat = clamp(c.flat + g() * 0.01, 0, 0.25);
    list.push({ ...c, label: `${tag}|neigh|${i}` });
  }
  fs.writeFileSync(out, JSON.stringify(list));
  console.log(`${list.length} configurations -> ${out}`);
} else if (cmd === 'sum') {
  const res = args.flatMap(f => JSON.parse(fs.readFileSync(f, 'utf-8')));
  const prod = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.out', 'v4-check.json'), 'utf-8')).find(r => r.label === 'production');
  const fmt = o => `${o.found}/${o.fp}+${o.noise} IoU ${(o.iouMean * 100).toFixed(1)} b90 ${o.startP90}/${o.endP90}`;
  const tags = [...new Set(res.map(o => o.label.split('|')[0]))];
  for (const t of tags) {
    const mine = res.filter(o => o.label.startsWith(t + '|'));
    const b = mine.find(o => o.label.endsWith('|base'));
    console.log(`\n=== ${t} : base ${b ? fmt(b) : '?'} (production ${fmt(prod)})`);
    const curves = {};
    for (const o of mine.filter(o => o.label.includes('|curve|'))) { const [, , name, v] = o.label.split('|'); (curves[name] ||= []).push([v, o]); }
    for (const [name, pts] of Object.entries(curves)) console.log(`  ${name.padEnd(12)} ${pts.map(([v, o]) => `${v}: ${o.found}/${o.fp + o.noise}/m${o.misplaced}·${(o.iouMean * 100).toFixed(1)}`).join('   ')}`);
    const nb = mine.filter(o => o.label.includes('|neigh|'));
    if (nb.length) {
      const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
      const d = (name, f) => { const v = nb.map(f); console.log(`  voisinage ${name.padEnd(8)} p10 ${q(v, 0.1).toFixed(1)}  p25 ${q(v, 0.25).toFixed(1)}  p50 ${q(v, 0.5).toFixed(1)}  p75 ${q(v, 0.75).toFixed(1)}  p90 ${q(v, 0.9).toFixed(1)}`); };
      d('rappel', o => o.found); d('fp+bruit', o => o.fp + o.noise); d('mal plac', o => o.misplaced); d('IoU %', o => o.iouMean * 100);
      const dom = nb.filter(o => o.found >= prod.found && o.fp + o.noise <= prod.fp + prod.noise && o.iouMean >= prod.iouMean).length;
      const dom4 = nb.filter(o => o.found >= prod.found && o.fp + o.noise <= prod.fp + prod.noise && o.misplaced <= prod.misplaced && o.iouMean >= prod.iouMean).length;
      console.log(`  voisinage : ${dom4} dominent la production en comptant aussi les segments mal places (production ${prod.misplaced})`);
      const worse = nb.filter(o => o.found <= prod.found && o.fp + o.noise >= prod.fp + prod.noise && o.iouMean <= prod.iouMean).length;
      console.log(`  voisinage : ${nb.length} tirages, ${dom} dominent la production (>= partout), ${worse} dominés par elle`);
    }
  }
}
