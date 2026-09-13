// Campaign v4 analysis. node v4/analyze.js [extra result files...]
// MODE=front|groups|loso|marg|sa (default: all)
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', '.out');
const SESS = ['Korea', 'Anglade', 'tabac', 'auberge', 'OneBest', '13thMoon', 'AudioF'];

let rows = [];
const prefix = process.env.PREFIX || 'v4-seed21-';
for (const f of fs.readdirSync(OUT).filter(f => f.startsWith(prefix) && /anneal\d+\.json$/.test(f))) {
  try { rows.push(...JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf-8'))); } catch (e) { console.error(`illisible : ${f}`); }
}
for (const f of process.argv.slice(2)) rows.push(...JSON.parse(fs.readFileSync(f, 'utf-8')));
const PROD = JSON.parse(fs.readFileSync(path.join(OUT, 'v4-check.json'), 'utf-8')).find(r => r.label === 'production');
const TOTAL = PROD.total;
const N = rows.length;
const P = r => r.fp + r.noise;
const I = r => r.iouPts;
const pct = v => (v * 100).toFixed(1);
const w = x => `chg=${x.tuneChange.toFixed(2)} stay=${x.unknownStay.toFixed(2)} out=${x.tuneToUnknown.toFixed(2)} in=${x.unknownToTune.toFixed(2)}`;
const desc = r => `${r.transform} fq=${r.floorQ.toFixed(4)} fl=${r.floor.toFixed(4)} mS=${r.minSeg} ${r.confirm} a=${r.absent.toFixed(2)} rap=${r.rapid.toFixed(2)} gap=${r.mergeGap} flat=${r.flat === null ? 'off' : r.flat.toFixed(3)} ts=${r.tempoSpread.toFixed(3)} mc=${r.minCand.toFixed(3)} ${w(r.weights)}`;
const line = r => `${String(r.found).padStart(3)} fp=${String(r.fp).padStart(2)}+${r.noise} IoU=${pct(r.iouMean)}% pts=${r.iouPts.toFixed(1)} b90=${r.startP90}/${r.endP90}s | ${desc(r)} | ${r.per.map(p => `${p[0]}/${p[2]}`).join(' ')}`;
const tally = (rs, k) => { const m = {}; for (const r of rs) m[k(r)] = (m[k(r)] || 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a}:${b}`).join('  '); };
console.log(`${N} evaluations ; production ${PROD.found}/${TOTAL} fp=${PROD.fp}+${PROD.noise} IoU=${pct(PROD.iouMean)}% pts=${PROD.iouPts.toFixed(1)}`);

const mode = process.env.MODE || 'all';

if (mode === 'all' || mode === 'front') {
  // Best found at each (fp+noise) level, then strictly increasing.
  const sorted = [...rows].sort((a, b) => P(a) - P(b) || b.found - a.found || I(b) - I(a));
  const fr = []; let best = -1;
  for (const r of sorted) if (r.found > best) { fr.push(r); best = r.found; }
  console.log(`\n== front rappel / (fp+bruit) (${fr.length} niveaux) ==`);
  for (const r of fr.filter(r => P(r) <= 40)) console.log('  ' + line(r));
  // IoU-front: best iouPts at each fp level
  const sI = [...rows].sort((a, b) => P(a) - P(b) || I(b) - I(a));
  const frI = []; let bI = -1;
  for (const r of sI) if (I(r) > bI) { frI.push(r); bI = I(r); }
  console.log(`\n== front iouPts / (fp+bruit) ==`);
  for (const r of frI.filter(r => P(r) <= 40)) console.log('  ' + line(r));
  const dom = rows.filter(r => r.found >= PROD.found && P(r) <= P(PROD) && I(r) >= PROD.iouPts);
  const strict = dom.filter(r => r.found > PROD.found || P(r) < P(PROD) || I(r) > PROD.iouPts);
  console.log(`\n  dominent la production sur les 3 criteres : ${strict.length} (strict)`);
  console.log(`   par transformation : ${tally(strict, r => r.transform)}`);
  for (const r of [...strict].sort((a, b) => (b.found - 0.5 * P(b) + 0.5 * I(b)) - (a.found - 0.5 * P(a) + 0.5 * I(a))).slice(0, 12)) console.log('   ' + line(r));
}

if (mode === 'all' || mode === 'groups') {
  const B = [0, 3, 5, 8, 10, 12, 15, 20, 30];
  console.log(`\n== meilleur rappel sous budget fp+bruit, par transformation (IoU du point retenu) ==`);
  console.log('  ' + 'transformation'.padEnd(18) + '  n  ' + B.map(b => `<=${b}`.padStart(11)).join(''));
  for (const g of [...new Set(rows.map(r => r.transform))].sort()) {
    const rs = rows.filter(r => r.transform === g);
    const cells = B.map(b => {
      const c = rs.filter(r => P(r) <= b);
      if (!c.length) return '-';
      const bf = Math.max(...c.map(r => r.found));
      const bi = Math.max(...c.filter(r => r.found === bf).map(r => r.iouMean));
      return `${bf}·${pct(bi)}`;
    });
    console.log('  ' + g.padEnd(18) + String(rs.length).padStart(5) + ' ' + cells.map(c => c.padStart(11)).join(''));
  }
}

if (mode === 'all' || mode === 'loso') {
  // Leave-one-session-out. Select by found − λ·(fp+noise) + κ·iouPts on the six
  // training sessions, measure the seventh; ties averaged. Noise is a separate
  // recording: it enters every fold's selection and is reported as a mean.
  const LK = [];
  for (const k of [0, 0.5, 1]) for (const l of [0.25, 0.5, 1, 2]) LK.push([l, k]);
  const subsets = [['tous', () => true], ...[...new Set(rows.map(r => r.transform))].sort().map(g => [g, r => r.transform === g])];
  const only = process.env.LOSO_ONLY ? process.env.LOSO_ONLY.split(',') : null;
  console.log(`\n== une-session-dehors : selection max(rappel - L(fp+bruit) + K iouPts) sur 6 sessions ==`);
  console.log(`  production : ${PROD.found} / ${PROD.fp}+${PROD.noise}, IoU ${pct(PROD.iouMean)} %`);
  for (const [name, pred] of subsets) {
    if (only && !only.includes(name)) continue;
    const rs = rows.filter(pred);
    const cells = LK.map(([l, k]) => {
      let tf = 0, tp = 0, tn = 0, tI = 0, tnI = 0;
      const picks = {};
      for (let s = 0; s < 7; s++) {
        let best = -Infinity, tied = [];
        for (const r of rs) {
          const p = r.per[s];
          const trTot = TOTAL - p[1];
          const sc = (r.found - p[0]) - l * (r.fp - p[2] + r.noise) + k * 100 * (r.sumIoU - p[4]) / trTot;
          if (sc > best + 1e-9) { best = sc; tied = [r]; } else if (Math.abs(sc - best) <= 1e-9) tied.push(r);
        }
        const m = tied.length;
        tf += tied.reduce((a, r) => a + r.per[s][0], 0) / m;
        tp += tied.reduce((a, r) => a + r.per[s][2], 0) / m;
        tn += tied.reduce((a, r) => a + r.noise, 0) / m / 7;
        tI += tied.reduce((a, r) => a + r.per[s][4], 0) / m;
        tnI += tied.reduce((a, r) => a + r.per[s][5], 0) / m;
        const key = tied[0].transform; picks[key] = (picks[key] || 0) + 1;
      }
      return { l, k, tf, tp, tn, iou: tI / tnI, picks };
    });
    console.log(`  -- ${name} (${rs.length} evals)`);
    for (const c of cells) {
      const prodS = PROD.found - c.l * P(PROD) + c.k * PROD.iouPts;
      const s = c.tf - c.l * (c.tp + c.tn) + c.k * 100 * c.iou * c.tf / TOTAL;
      console.log(`     L=${String(c.l).padEnd(4)} K=${String(c.k).padEnd(3)} ${c.tf.toFixed(1)} / ${c.tp.toFixed(1)}+${c.tn.toFixed(1)}  IoU ${pct(c.iou)} %  (delta score ~ ${(s - prodS >= 0 ? '+' : '') + (s - prodS).toFixed(1)})  ${name === 'tous' ? JSON.stringify(c.picks) : ''}`);
    }
  }
}

if (mode === 'all' || mode === 'marg') {
  // Where do the good configurations sit? For each objective, the top 2 % by its
  // own score, and each parameter's quartiles among them — a plateau shows as a
  // tight, stable interval; a free parameter as one spanning its whole range.
  const LK = [[0.5, 0.5], [1, 0.5], [0.25, 0.5], [2, 0.5], [0.5, 0], [0.5, 1]];
  const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
  const num = {
    floor: r => r.floor, floorQ: r => r.floorQ, minSeg: r => r.minSeg, absent: r => r.absent,
    rapid: r => r.rapid, mergeGap: r => r.mergeGap, flat: r => (r.flat === null ? -1 : r.flat),
    tempoSpread: r => r.tempoSpread, minCand: r => r.minCand,
    chg: r => r.weights.tuneChange, stay: r => r.weights.unknownStay, out: r => r.weights.tuneToUnknown, in: r => r.weights.unknownToTune,
    margin: r => (r.absent > 0 ? -Math.log(r.absent) - r.weights.unknownStay : NaN),
  };
  const frac = Number(process.env.MARG_FRAC || 0.02);
  const tr = process.env.MARG_TRANSFORM;
  for (const [l, k] of LK) {
    const pool = tr ? rows.filter(r => r.transform === tr) : rows;
    const sc = r => r.found - l * P(r) + k * r.iouPts;
    const top = [...pool].sort((a, b) => sc(b) - sc(a)).slice(0, Math.max(10, Math.floor(frac * pool.length)));
    console.log(`\n== marges, top ${top.length} pour L=${l} K=${k}${tr ? ` (${tr})` : ''} : score ${sc(top[0]).toFixed(1)} .. ${sc(top[top.length - 1]).toFixed(1)} (production ${sc(PROD).toFixed(1)}) ==`);
    console.log(`   transform ${tally(top, r => r.transform)} | confirm ${tally(top, r => r.confirm.replace(/x.*/, ''))} | minSeg ${tally(top, r => r.minSeg)} | flat ${tally(top, r => (r.flat === null ? 'off' : 'on'))}`);
    for (const [name, f] of Object.entries(num)) {
      const v = top.map(f).filter(x => !Number.isNaN(x));
      if (!v.length) continue;
      console.log(`   ${name.padEnd(12)} p10 ${q(v, 0.1).toFixed(3).padStart(8)}  p25 ${q(v, 0.25).toFixed(3).padStart(8)}  p50 ${q(v, 0.5).toFixed(3).padStart(8)}  p75 ${q(v, 0.75).toFixed(3).padStart(8)}  p90 ${q(v, 0.9).toFixed(3).padStart(8)}`);
    }
    console.log('   meilleur : ' + line(top[0]));
  }
}

if (mode === 'all' || mode === 'sa') {
  console.log(`\n== diagnostic du recuit ==`);
  const bins = {};
  for (const r of rows) { const d = Math.min(5, Math.floor(r.step / 28)); (bins[d] ||= []).push(r); }
  for (const d of Object.keys(bins).sort((a, b) => a - b)) {
    const rs = bins[d];
    console.log(`  pas ${d * 28}-${d * 28 + 27} : ${rs.length} evals, acceptation ${pct(rs.filter(r => r.accepted).length / rs.length)} %, T~${rs[0].temp.toFixed(2)}, ms median ${[...rs.map(r => r.ms)].sort((a, b) => a - b)[rs.length >> 1]}`);
  }
  const chains = {};
  for (const r of rows) (chains[r.chain] ||= []).push(r);
  let late = 0, n = 0;
  const prodScore = (l, k) => PROD.found - l * P(PROD) + k * PROD.iouPts;
  const beat = {};
  for (const rs of Object.values(chains)) {
    const maxStep = Math.max(...rs.map(r => r.step));
    const bestAll = Math.max(...rs.map(r => r.score));
    const g = `${rs[0].transform}`;
    (beat[g] ||= [0, 0]); beat[g][1]++;
    if (bestAll > prodScore(rs[0].lambda, rs[0].kappa)) beat[g][0]++;
    if (maxStep < 40) continue;
    const half = maxStep / 2;
    const a = Math.max(...rs.filter(r => r.step <= half).map(r => r.score)), b = Math.max(...rs.filter(r => r.step > half).map(r => r.score));
    n++; if (b > a + 1e-9) late++;
  }
  console.log(`  chaines dont le meilleur score arrive en 2e moitie : ${late}/${n}`);
  console.log(`  chaines depassant la production a leur propre objectif : ${Object.entries(beat).map(([g, [a, b]]) => `${g} ${a}/${b}`).join('  ')}`);
}
