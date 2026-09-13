// Campaign v3 analysis. node analyze.js [extra result files...]
const fs = require('fs');
const path = require('path');
const dir = 'C:/Perso/IrishMusicExperiments/Cadence/experiments/ranking-study/.out';
const SESS = ['Korea', 'Anglade', 'tabac', 'auberge', 'OneBest', '13thMoon', 'AudioF'];
const PROD = { found: 312, fp: 20, per: [[31, 31, 0], [35, 36, 4], [21, 27, 5], [29, 30, 0], [25, 26, 0], [36, 42, 1], [135, 149, 10]] };

let rows = [];
for (const f of fs.readdirSync(dir).filter(f => f.startsWith(process.env.SEED_PREFIX || 'search-seed11-') && !/-check|-dry/.test(f))) {
  try { rows.push(...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))); } catch { }
}
for (const f of process.argv.slice(2)) rows.push(...JSON.parse(fs.readFileSync(f, 'utf-8')));
rows = rows.filter(r => r.per);
const N = rows.length;
console.log(`${N} evaluations`);
const holdTag = r => (r.hold && r.hold.k > 0 ? `|h${r.hold.k}:${r.hold.decay}` : '');
const grp = r => `${r.transform}|${r.flat ? 'on' : 'off'}${holdTag(r)}`;
const w = x => x.tuneChange === undefined ? 'prod' : `chg=${x.tuneChange.toFixed(2)} stay=${x.unknownStay.toFixed(2)} out=${x.tuneToUnknown.toFixed(2)} in=${x.unknownToTune.toFixed(2)}`;
const desc = r => `${r.transform} ${r.flat ? 'on' : 'off'} fq=${(r.floorQ ?? 0).toFixed(4)} fl=${r.floor.toFixed(4)} mS=${r.minSeg} ${r.confirm} a=${(r.absentRatio ?? 0).toFixed(2)}${holdTag(r)} ${w(r.weights)}`;

function front(rs, F = r => r.found, P = r => r.fp) {
  // best found for each fp level, then strict monotone
  const sorted = [...rs].sort((a, b) => P(a) - P(b) || F(b) - F(a));
  const out = []; let best = -1;
  for (const r of sorted) if (F(r) > best) { out.push(r); best = F(r); }
  return out;
}

const mode = process.env.MODE || 'all';

if (mode === 'all' || mode === 'front') {
  const fr = front(rows);
  console.log(`\n== front global (${fr.length} niveaux) ==`);
  for (const r of fr) {
    const nTie = rows.filter(x => x.found === r.found && x.fp === r.fp).length;
    console.log(`  ${String(r.found).padStart(3)} fp=${String(r.fp).padStart(3)} bruit=${r.noise} couv=${(r.coverage * 100).toFixed(0)}% x${nTie} | ${desc(r)} | ${r.per.map(p => `${p[0]}/${p[2]}`).join(' ')}`);
  }
  // Dominating production
  const dom = rows.filter(r => r.found >= PROD.found && r.fp <= PROD.fp);
  const strict = dom.filter(r => r.found > PROD.found || r.fp < PROD.fp);
  console.log(`\n  dominent (>=) la production : ${dom.length}, strictement : ${strict.length}`);
  const tally = (rs, k) => { const m = {}; for (const r of rs) m[k(r)] = (m[k(r)] || 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a}:${b}`).join('  '); };
  console.log(`  strict par groupe : ${tally(strict, grp)}`);

  // "Near front": within 2 found of front at same fp — more robust than the front itself
  const bestAt = fp => Math.max(...rows.filter(r => r.fp <= fp).map(r => r.found));
  const near = rows.filter(r => r.found >= bestAt(r.fp) - 2 && r.fp <= 40);
  console.log(`\n  quasi-front (a 2 morceaux du front, fp<=40) : ${near.length} evaluations`);
  console.log(`   groupe  : ${tally(near, grp)}`);
  console.log(`   minSeg  : ${tally(near, r => r.minSeg)}`);
  console.log(`   confirm : ${tally(near, r => r.confirm.replace(/x[\d.]+$/, ''))}`);
}

if (mode === 'all' || mode === 'groups') {
  const B = [0, 1, 2, 3, 5, 7, 10, 15, 20, 30];
  const groups = [...new Set(rows.map(grp))].sort();
  console.log(`\n== meilleur rappel a budget de fp, par groupe (evals) ==`);
  console.log('  ' + 'groupe'.padEnd(24) + ' n    ' + B.map(b => `fp<=${b}`.padStart(7)).join(''));
  const lines = groups.map(g => {
    const rs = rows.filter(r => grp(r) === g);
    const vals = B.map(b => { const f = rs.filter(r => r.fp <= b).map(r => r.found); return f.length ? Math.max(...f) : 0; });
    return { g, n: rs.length, vals };
  }).sort((a, b) => b.vals[6] - a.vals[6]);
  for (const l of lines) console.log('  ' + l.g.padEnd(24) + String(l.n).padStart(5) + ' ' + l.vals.map(v => String(v).padStart(7)).join(''));
}

if (mode === 'all' || mode === 'loso') {
  // Leave-one-session-out: select on 6 sessions, score on the 7th. Ties
  // averaged, so an arbitrary tie-break cannot flatter the result.
  const alphas = [0.1, 0.25, 0.5, 0.75, 1.0, 1.5];
  const subsetsSpec = [['tous', () => true], ...[...new Set(rows.map(grp))].sort().map(g => [g, r => grp(r) === g])];
  console.log(`\n== validation croisee une-session-dehors ==`);
  console.log(`  selection : max rappel(train) sous fp(train) <= alpha * fp_prod(train) ; ex-aequo moyennes`);
  console.log(`  production hors echantillon : ${PROD.found} / fp ${PROD.fp}`);
  console.log('  ' + 'sous-ensemble'.padEnd(24) + alphas.map(a => `a=${a}`.padStart(15)).join(''));
  const res = {};
  for (const [name, pred] of subsetsSpec) {
    const rs = rows.filter(pred);
    const cells = alphas.map(a => {
      let tf = 0, tp = 0, inF = 0, inP = 0;
      for (let k = 0; k < 7; k++) {
        const pf = PROD.fp - PROD.per[k][2];
        const bud = a * pf;
        let best = -1, tied = [];
        for (const r of rs) {
          const trF = r.found - r.per[k][0], trP = r.fp - r.per[k][2];
          if (trP > bud) continue;
          const sc = trF * 1000 - trP;
          if (sc > best) { best = sc; tied = [r]; } else if (sc === best) tied.push(r);
        }
        if (!tied.length) return null;
        tf += tied.reduce((s, r) => s + r.per[k][0], 0) / tied.length;
        tp += tied.reduce((s, r) => s + r.per[k][2], 0) / tied.length;
      }
      return [tf, tp];
    });
    res[name] = cells;
    console.log('  ' + name.padEnd(24) + cells.map(c => (c ? `${c[0].toFixed(0)}/${c[1].toFixed(1)}` : '-').padStart(15)).join(''));
  }
  // In-sample counterpart for "tous", same rule on full corpus
  const ins = alphas.map(a => {
    const rs = rows.filter(r => r.fp <= a * PROD.fp);
    if (!rs.length) return '-';
    const bf = Math.max(...rs.map(r => r.found));
    const t = rs.filter(r => r.found === bf); const mp = Math.min(...t.map(r => r.fp));
    return `${bf}/${mp}`;
  });
  console.log('  ' + '(tous, dans echantillon)'.padEnd(24) + ins.map(c => c.padStart(15)).join(''));
}

if (mode === 'all' || mode === 'loso2') {
  // Second selection rule, to check the LOSO verdict does not hinge on the
  // fp-budget rule: maximise found - lambda * fp on the six training sessions,
  // score the held-out one. Ties averaged, as above. Production's own
  // out-of-sample figure is simply its per-session sum (it involves no selection).
  const lambdas = [0.25, 0.5, 1, 2];
  console.log(`\n== validation croisee une-session-dehors, regle scalaire ==`);
  console.log(`  selection : max (rappel - lambda x fp) sur les 6 sessions d'entrainement ; ex-aequo moyennes`);
  console.log(`  production : ${PROD.found}/${PROD.fp} (score ${lambdas.map(l => `L${l}=${(PROD.found - l * PROD.fp).toFixed(1)}`).join(' ')})`);
  const subsets = [['tous', () => true], ...[...new Set(rows.map(grp))].sort().map(g => [g, r => grp(r) === g])];
  console.log('  ' + 'sous-ensemble'.padEnd(24) + lambdas.map(l => `L=${l}`.padStart(16)).join(''));
  for (const [name, pred] of subsets) {
    const rs = rows.filter(pred);
    const cells = lambdas.map(l => {
      let tf = 0, tp = 0;
      for (let k = 0; k < 7; k++) {
        let best = -Infinity, tied = [];
        for (const r of rs) {
          const sc = (r.found - r.per[k][0]) - l * (r.fp - r.per[k][2]);
          if (sc > best + 1e-9) { best = sc; tied = [r]; } else if (Math.abs(sc - best) <= 1e-9) tied.push(r);
        }
        tf += tied.reduce((s, r) => s + r.per[k][0], 0) / tied.length;
        tp += tied.reduce((s, r) => s + r.per[k][2], 0) / tied.length;
      }
      const gain = (tf - l * tp) - (PROD.found - l * PROD.fp);
      return `${tf.toFixed(0)}/${tp.toFixed(1)} ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}`;
    });
    console.log('  ' + name.padEnd(24) + cells.map(c => c.padStart(16)).join(''));
  }
  console.log('  (dernier nombre de chaque case : score hors echantillon moins celui de la production, meme lambda)');
}

if (mode === 'all' || mode === 'sa') {
  console.log(`\n== diagnostic du recuit ==`);
  const byStep = {};
  for (const r of rows) { if (r.step === undefined) continue; const d = Math.min(9, Math.floor(r.step / 20)); (byStep[d] ||= []).push(r); }
  const fr = new Set(front(rows));
  for (const d of Object.keys(byStep).sort((a, b) => a - b)) {
    const rs = byStep[d];
    const acc = rs.filter(r => r.accepted).length / rs.length;
    const onFront = rs.filter(r => fr.has(r)).length;
    console.log(`  pas ${d * 20}-${d * 20 + 19} : ${rs.length} evals, acceptation ${(acc * 100).toFixed(0)}%, T~${rs[0].temp.toFixed(2)}, sur le front ${onFront}`);
  }
  // per chain: best scalar score in first vs second half
  const chains = {};
  for (const r of rows) (chains[r.chain] ||= []).push(r);
  let improvedLate = 0, n = 0;
  for (const rs of Object.values(chains)) {
    const L = rs[0].lambda; const maxStep = Math.max(...rs.map(r => r.step));
    if (maxStep < 40) continue;
    const s = r => r.found - L * r.fp;
    const half = maxStep / 2;
    const a = Math.max(...rs.filter(r => r.step <= half).map(s)), b = Math.max(...rs.filter(r => r.step > half).map(s));
    n++; if (b > a) improvedLate++;
  }
  console.log(`  chaines dont le meilleur score arrive en 2e moitie : ${improvedLate}/${n}`);
}
