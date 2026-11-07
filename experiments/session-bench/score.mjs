// Scores a live replay of the annotated sessions (liveReplay.test.ts) against their timings.
//
//   node score.mjs <replayDir> [--json]      replayDir holds cadence-<session>.json
//   SESSIONS=a,b node score.mjs <replayDir>  only those sessions (a quick look on a subset)
//   FP_DETAIL=1                               also lists every false positive
//
// Found      : a final detection carries the right id over the row.
// Lock-on    : seconds from the annotated start to the first time the right name is shown
//              (any detection carrying it over the row, provisional ones included).
// False pos. : a final detection where no annotated row of that id is playing (GRACE s of
//              slack after the row's end). Rows with id 0 (annotator did not know) excuse
//              anything; rows with id -1 (not on TheSession) excuse nothing.
// Wrong shown: names shown at some point over no row of theirs, then retracted or renamed —
//              what the live screen shows that the final list no longer does. Counted, and
//              how many stayed up more than 30 s.
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2];
const JSON_OUT = process.argv.includes('--json');
if (!DIR) { console.error('usage: node score.mjs <replayDir> [--json]'); process.exit(1); }
const FIX = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '../../test-fixtures/sessions');
const GRACE = 30;
const CORPUS = [
  '20260523_1_matin_Anglade', '20260523_2_aprem_tabac', '20260523_5_auberge_fleurie',
  'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video', '20240721_tocane_2_chapiteau',
  '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24', '1Hour_Trad_Irish_Music_Session_in_Korea',
  '20240723_tocane_soir_1', '20260227_3_marcellin_fond',
];
// One room, one band, every week: weighed as its own group rather than eight recordings.
const MOON = ['2025_07_02', '2025_08_13', '2025_08_27', '2025_10_22', '2025_12_10', '2026_01_14', '2026_02_25', '2026_04_08'].map((d) => `13th_Moon_${d}`);
const NOISE = '732984_11910076-lq';
const only = process.env.SESSIONS?.split(',').map((s) => s.trim()).filter(Boolean);
const pick = (list) => (only?.length ? list.filter((s) => only.includes(s)) : list);

// ---- ground truth (same parsing as experiments/threshold-sweep/sweep.test.ts) ----
const toSeconds = (v) => {
  const parts = v.trim().split(/:+/).filter(Boolean).map(Number);
  if (!parts.length || parts.some(Number.isNaN)) return undefined;
  return parts.reduce((a, n) => a * 60 + n, 0);
};
function splitCsvLine(line, delim) {
  const out = []; let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) { if (ch !== '"') cur += ch; else if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
    else if (ch === '"') quoted = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}
function truth(session) {
  const lines = fs.readFileSync(path.join(FIX, `${session}-timings.csv`), 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
  const delim = [',', ';', '\t', '|'].map((d) => ({ d, n: lines[0].split(d).length })).sort((a, b) => b.n - a.n)[0].d;
  return lines.slice(1).map((line) => {
    const [s, e, rawId, comment] = splitCsvLine(line, delim);
    const raw = (rawId ?? '').trim();
    const kind = raw === '0' ? 'unknown' : raw === '-1' ? 'offindex' : 'tune';
    return { kind, id: /^[1-9]\d*$/.test(raw) ? raw : '', start: toSeconds(s ?? ''), end: toSeconds(e ?? ''), comment };
  }).filter((r) => r.start !== undefined && r.end !== undefined);
}
function replay(session) {
  const p = path.join(DIR, `cadence-${session}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
}
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

function score(rows, cad) {
  const tunes = rows.filter((r) => r.kind === 'tune');
  const lat = [], cover = [], missed = [];
  let found = 0;
  for (const r of tunes) {
    const hits = cad.final.filter((d) => d.tuneId === r.id && overlap(d.start, d.end, r.start, r.end) > 0);
    if (hits.length) {
      found++;
      cover.push(Math.min(1, hits.reduce((a, d) => a + overlap(d.start, d.end, r.start, r.end), 0) / (r.end - r.start)));
    } else missed.push(r);
    let first = Infinity;
    for (const [now, , tuneId, start, end] of cad.log) {
      if (tuneId !== r.id || now >= first) continue;
      if (overlap(start, end ?? now, r.start, r.end) > 0) first = now;
    }
    if (hits.length && first < Infinity) lat.push(first - r.start);
  }
  let fp = 0, fpOff = 0, excused = 0;
  const fps = [];
  for (const d of cad.final) {
    if (rows.some((r) => r.kind === 'tune' && r.id === d.tuneId && overlap(d.start, d.end, r.start, r.end + GRACE) > 0)) continue;
    if (rows.some((r) => r.kind === 'unknown' && overlap(d.start, d.end, r.start, r.end) > 0)) { excused++; continue; }
    fp++;
    if (rows.some((r) => r.kind === 'offindex' && overlap(d.start, d.end, r.start, r.end) > 0)) fpOff++;
    fps.push(d);
  }
  const wrong = new Map();
  for (const [now, id, tuneId, start, end] of cad.log) {
    const ok = rows.some((r) => (r.kind === 'tune' && r.id === tuneId || r.kind === 'unknown') && overlap(start, end ?? now, r.start, r.end + GRACE) > 0);
    if (ok) continue;
    const k = `${id}|${tuneId}`;
    const v = wrong.get(k) ?? [now, now];
    v[1] = now;
    wrong.set(k, v);
  }
  const wrongLong = [...wrong.values()].filter(([a, b]) => b - a > 30).length;
  let right = 0, total = 0;
  for (const d of cad.final) {
    total += d.end - d.start;
    right += tunes.filter((r) => r.id === d.tuneId).reduce((a, r) => a + overlap(d.start, d.end, r.start, r.end), 0);
  }
  return { n: tunes.length, found, lat, cover, fp, fpOff, excused, fps, missed, wrongShown: wrong.size, wrongLong, named: cad.final.length, right, total };
}

const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const within = (a, n, s) => 100 * a.filter((x) => x <= s).length / n;
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

const result = { sessions: {}, groups: {} };
for (const [group, list] of [['corpus', pick(CORPUS)], ['moon', pick(MOON)]]) {
  const per = [];
  for (const session of list) {
    const cad = replay(session);
    if (!cad) continue;
    const s = score(truth(session), cad);
    per.push(s);
    result.sessions[session] = { found: s.found, n: s.n, fp: s.fp, wrongLong: s.wrongLong };
    if (!JSON_OUT) console.log(`${session.slice(0, 30).padEnd(30)} ${String(s.found).padStart(3)}/${String(s.n).padEnd(3)} FP ${String(s.fp).padStart(2)}  faux affichés >30 s ${s.wrongLong}`);
    if (process.env.FP_DETAIL && !JSON_OUT) {
      for (const d of s.fps) console.log(`    FP ${clock(d.start)}-${clock(d.end)} ${d.tuneId}`);
      for (const r of s.missed) console.log(`    manqué ${clock(r.start)}-${clock(r.end)} ${r.id} ${r.comment ?? ''}`);
    }
  }
  if (!per.length) continue;
  const sum = (k) => per.reduce((a, x) => a + x[k], 0);
  const n = sum('n'), lat = per.flatMap((x) => x.lat), cover = per.flatMap((x) => x.cover);
  const g = {
    found: sum('found'), n, recall: 100 * sum('found') / n, fp: sum('fp'), fpOff: sum('fpOff'), excused: sum('excused'),
    lockMedian: median(lat), lock10: within(lat, n, 10), lock20: within(lat, n, 20), lock30: within(lat, n, 30),
    cover: 100 * cover.reduce((a, b) => a + b, 0) / cover.length, timeRight: 100 * sum('right') / sum('total'),
    wrongShown: sum('wrongShown'), wrongLong: sum('wrongLong'),
  };
  result.groups[group] = g;
  if (!JSON_OUT) {
    console.log(`\n== ${group === 'corpus' ? 'corpus annoté' : '13th Moon 2025-26'}`);
    console.log(`  trouvés ${g.found}/${n} (${g.recall.toFixed(1)} %) ; faux positifs ${g.fp} (dont ${g.fpOff} sur un chant/hors TheSession), excusés ${g.excused}`);
    console.log(`  verrouillage : médiane ${g.lockMedian.toFixed(0)} s ; sous 10 s ${g.lock10.toFixed(0)} %, 20 s ${g.lock20.toFixed(0)} %, 30 s ${g.lock30.toFixed(0)} %`);
    console.log(`  couverture des morceaux trouvés ${g.cover.toFixed(0)} % ; temps nommé sur le bon morceau ${g.timeRight.toFixed(1)} %`);
    console.log(`  noms faux affichés en cours de route ${g.wrongShown}, dont plus de 30 s : ${g.wrongLong}\n`);
  }
}
const noise = (!only?.length || only.includes(NOISE)) ? replay(NOISE) : null;
if (noise) result.noise = noise.final.length;
if (JSON_OUT) console.log(JSON.stringify(result));
else if (noise) console.log(`bruit de bar sans musique : ${noise.final.length} détection(s)`);
