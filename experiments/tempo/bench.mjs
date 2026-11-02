// The live tempo's bench (2026-11-01).
//
// Runs the app's own tracker, src/session/liveTempo.ts (Node strips its
// types; it imports nothing on purpose), on FolkFriend's features of the
// annotated sessions, one reading a second as the live screen gets them.
// Two truths:
//   - per reading: the offline score alignment of the bench next door
//     (../score-follow/output/real.json, made by real.js), one onset per
//     aligned quaver — the quavers it counts over the reading's window;
//   - per tune (the user's idea): the annotated span holds a whole number of
//     passes of the tune, so its mean rate is passes × quavers per pass ÷ the
//     span. The passes counted by rounding the span over the alignment's
//     median pass, the quavers per pass read off the score: the alignment
//     only has to be right to half a pass. Assumes a steady tempo and bounds
//     on pass boundaries (92 % of the annotated ends lie within a tenth of a
//     pass of one, boundSuggest.ts) — annotations are to the second.
// And where nothing is played (the stretches between annotated tunes: talk,
// tuning up), how often a pulse is claimed anyway.
//
//   node experiments/tempo/bench.mjs [session-substring]      (from Cadence/)
//
// Settings by environment: W (window seconds), MIN (seconds before a first
// reading), STRENGTH (minStrength), PRIOR (priorWeight).
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { featuresOf, decodeSpan } = require('../score-follow/lib/engine');
const { FPS } = require('../score-follow/lib/align');
const { TempoTracker, TEMPO_OPTIONS } = await import(pathToFileURL(path.resolve(here, '../../src/session/liveTempo.ts')).href);

const ROOT = path.resolve(here, '../..');
const AUDIO = {
  '20260523_1_matin_Anglade': '20260523_1_matin_Anglade.m4a',
  '20260523_2_aprem_tabac': '20260523_2_aprem_tabac.m4a',
  '20260523_5_auberge_fleurie': '20260523_5_auberge_fleurie.m4a',
  '20240721_tocane_2_chapiteau': '20240721_tocane_2_chapiteau.m4a',
  '1Hour_Trad_Irish_Music_Session_in_Korea': '1Hour Trad Irish Music Session in Korea.mp3',
  'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video': 'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video.mp3',
  '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24': '13th Moon Gravity Well - Irish Trad Session 2024.01.24.mp3',
};
const opt = {
  ...TEMPO_OPTIONS,
  ...(process.env.W ? { windowSeconds: Number(process.env.W) } : {}),
  ...(process.env.MIN ? { minSeconds: Number(process.env.MIN) } : {}),
  ...(process.env.STRENGTH ? { minStrength: Number(process.env.STRENGTH) } : {}),
  ...(process.env.PRIOR ? { priorWeight: Number(process.env.PRIOR) } : {}),
};
const filter = process.argv[2] || '';
const secs = (s) => s.split(':').reduce((a, b) => a * 60 + Number(b), 0);
const pct = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const share = (xs, f) => (xs.length ? (100 * xs.filter(f).length) / xs.length : NaN).toFixed(1) + '%';
const real = JSON.parse(fs.readFileSync(path.resolve(here, '../score-follow/output/real.json'), 'utf8'));

/** One reading a second over [start, end) of `audio`, as the app reads them:
 *  each with the estimate whatever its strength, and the app's own verdict. */
function readings(audio, start, end) {
  const F = featuresOf(decodeSpan(audio, start, end - start));
  const tracker = new TempoTracker(FPS, opt);
  const out = [];
  const step = Math.round(FPS) * 48;
  for (let at = 0; at < F.length; at += step) {
    tracker.push(F.subarray(at, Math.min(F.length, at + step)));
    const t = start + tracker.frames / FPS;
    const { reading, estimate } = tracker.read(t);
    if (estimate) out.push({ t, rate: estimate.rate, strength: estimate.strength, reading });
  }
  return out;
}

const tuneRows = [];  // per reading inside a tune
const tunes = [];     // per tune
const gapRows = [];   // per reading where nothing was annotated
for (const [fixture, audioName] of Object.entries(AUDIO)) {
  if (!fixture.includes(filter)) continue;
  const csvPath = path.join(ROOT, 'test-fixtures/sessions', fixture + '-timings.csv');
  const audio = path.join(ROOT, 'test-fixtures/audio', audioName);
  if (!fs.existsSync(csvPath) || !fs.existsSync(audio)) continue;
  const csv = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
  const aligned = real.filter((r) => r.fixture === fixture);
  const used = new Set();
  for (const [a, b, tuneId] of csv) {
    if (!(Number(tuneId) > 0)) continue;
    const start = secs(a), end = secs(b);
    const k = aligned.findIndex((r, i) => !used.has(i) && r.tuneId === tuneId && Math.abs(r.span - (end - start)) < 0.01);
    if (k >= 0) used.add(k);
    const r = k >= 0 && aligned[k].match >= 0.6 ? aligned[k] : null;
    const rs = readings(audio, start, end);
    // Per reading, against the aligned quavers in its window.
    const on = r ? r.onsets.map(([t, i]) => [Math.max(0, start - 5) + t, i]) : [];
    for (const x of rs) {
      let truth = null;
      if (r) {
        const inW = on.filter(([t]) => t >= x.t - opt.windowSeconds && t < x.t);
        if (inW.length >= 2 * opt.windowSeconds) {
          let q = 0, bad = false; const pts = [[inW[0][0], 0]];
          for (let j = 1; j < inW.length; j++) {
            let d = inW[j][1] - inW[j - 1][1];
            if (d <= 0) d += r.len;
            if (d > 4) { bad = true; break; }
            q += d; pts.push([inW[j][0], q]);
          }
          if (!bad) {
            const n = pts.length, mt = pts.reduce((s, p) => s + p[0], 0) / n, mq = pts.reduce((s, p) => s + p[1], 0) / n;
            truth = pts.reduce((s, p) => s + (p[0] - mt) * (p[1] - mq), 0) / pts.reduce((s, p) => s + (p[0] - mt) ** 2, 0);
          }
        }
      }
      tuneRows.push({ fixture, dance: r?.dance ?? '?', truth, ...x });
    }
    // Per tune: whole passes over the annotated span.
    if (r && r.passDurs.length) {
      const pass = pct(r.passDurs, 0.5);
      const passes = Math.round((end - start) / pass);
      const truth = (passes * r.len) / (end - start);
      const pulses = rs.filter((x) => x.t >= start + opt.windowSeconds && x.reading.state === 'pulse').map((x) => x.reading.rate);
      const onsetTruths = tuneRows.filter((x) => x.fixture === fixture && x.t >= start && x.t <= end && x.truth).map((x) => x.truth);
      tunes.push({ fixture, name: r.name, dance: r.dance, passes, truth, est: pulses.length ? pct(pulses, 0.5) : null, aligned: onsetTruths.length ? pct(onsetTruths, 0.5) : null, pulseShare: rs.length ? pulses.length / rs.length : 0 });
    }
  }
  // Between tunes: what is said where nothing is played. Five seconds off each
  // annotation, as the bounds are to the second and windows run 12 s back.
  const spans = csv.map(([a, b]) => [secs(a), secs(b)]).sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < spans.length; i++) {
    const g0 = spans[i - 1][1] + 5, g1 = spans[i][0] - 5;
    if (g1 - g0 < opt.minSeconds + 5) continue;
    for (const x of readings(audio, g0, g1)) gapRows.push({ fixture, ...x });
  }
  process.stderr.write(`${fixture}: ${tuneRows.length} readings in tunes, ${gapRows.length} between\n`);
}

console.log(`window ${opt.windowSeconds} s, first after ${opt.minSeconds} s, minStrength ${opt.minStrength}, prior ${opt.priorWeight}`);
const judged = tuneRows.filter((x) => x.truth);
const err = (x) => Math.abs(x.rate / x.truth - 1);
console.log(`\nper reading, vs the alignment (${judged.length} readings):`);
console.log('  every estimate   within 2 / 4 / 8 %:', [0.02, 0.04, 0.08].map((e) => share(judged, (x) => err(x) < e)).join(' / '));
// What the screen shows: the median of the agreeing estimates.
const shownErr = (x) => Math.abs(x.reading.rate / x.truth - 1);
const shown = judged.filter((x) => x.reading.state === 'pulse');
console.log(`  pulse shown on ${share(judged, (x) => x.reading.state === 'pulse')} of them; the value shown within 2 / 4 / 8 %:`, [0.02, 0.04, 0.08].map((e) => share(shown, (x) => shownErr(x) < e)).join(' / '));
console.log(`  between tunes, a pulse shown on ${share(gapRows, (x) => x.reading.state === 'pulse')} of ${gapRows.length} readings`);
for (const d of [...new Set(judged.map((x) => x.dance))].sort()) {
  const s = judged.filter((x) => x.dance === d), sh = s.filter((x) => x.reading.state === 'pulse');
  console.log(`  ${d.padEnd(10)} ${String(s.length).padStart(6)}  shown ${share(s, (x) => x.reading.state === 'pulse').padStart(6)}  within 4 % ${share(sh, (x) => shownErr(x) < 0.04).padStart(6)}  ratio p10/50/90 ${[0.1, 0.5, 0.9].map((p) => pct(sh.map((x) => x.reading.rate / x.truth), p).toFixed(2)).join(' ')}`);
}
console.log(`\nstrength, p10/p50/p90: in tunes ${[0.1, 0.5, 0.9].map((p) => pct(tuneRows.map((x) => x.strength), p).toFixed(3)).join(' / ')}`
  + `, right ones (4 %) ${[0.1, 0.5, 0.9].map((p) => pct(judged.filter((x) => err(x) < 0.04).map((x) => x.strength), p).toFixed(3)).join(' / ')}`
  + `, wrong ones ${[0.1, 0.5, 0.9].map((p) => pct(judged.filter((x) => err(x) >= 0.04).map((x) => x.strength), p).toFixed(3)).join(' / ')}`
  + `, between tunes ${[0.1, 0.5, 0.9].map((p) => pct(gapRows.map((x) => x.strength), p).toFixed(3)).join(' / ')}`);
console.log('  strength alone, without the agreement of the last estimates:');
console.log('  threshold | shown in tunes | right among shown | pulse between tunes');
for (const th of [0, 0.05, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25, 0.3]) {
  const sh = judged.filter((x) => x.strength >= th);
  console.log(`  ${th.toFixed(2).padStart(9)} | ${share(tuneRows, (x) => x.strength >= th).padStart(14)} | ${share(sh, (x) => err(x) < 0.04).padStart(17)} | ${share(gapRows, (x) => x.strength >= th).padStart(6)} of ${gapRows.length}`);
}
const withEst = tunes.filter((x) => x.est);
console.log(`\nper tune, whole passes over the annotated span (${tunes.length} tunes, ${withEst.length} with a pulse shown):`);
console.log('  median of the readings within 2 / 4 / 8 %:', [0.02, 0.04, 0.08].map((e) => share(withEst, (x) => Math.abs(x.est / x.truth - 1) < e)).join(' / '));
const both = tunes.filter((x) => x.aligned);
console.log('  the two truths agree within 2 / 4 %:', [0.02, 0.04].map((e) => share(both, (x) => Math.abs(x.aligned / x.truth - 1) < e)).join(' / '), `(${both.length} tunes)`);
// Where they disagree, it is nearly always the count of passes (a pass more
// or less: 4/3, 5/4 off) or a score whose repeats are not the ones played —
// the estimate then sides with the alignment to the percent. Where they agree:
const solid = withEst.filter((x) => x.aligned && Math.abs(x.aligned / x.truth - 1) < 0.02);
console.log(`  where the two truths agree within 2 % (${solid.length} tunes), within 2 / 4 %:`, [0.02, 0.04].map((e) => share(solid, (x) => Math.abs(x.est / x.truth - 1) < e)).join(' / '));
for (const d of [...new Set(withEst.map((x) => x.dance))].sort()) {
  const s = withEst.filter((x) => x.dance === d);
  console.log(`  ${d.padEnd(10)} ${String(s.length).padStart(4)}  within 4 % ${share(s, (x) => Math.abs(x.est / x.truth - 1) < 0.04).padStart(6)}  ratio p10/50/90 ${[0.1, 0.5, 0.9].map((p) => pct(s.map((x) => x.est / x.truth), p).toFixed(2)).join(' ')}`);
}
// `DUMP=file.json`: every reading and tune, to study the display rules
// without decoding everything again.
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify({ opt, tuneRows, gapRows, tunes }));
if (process.env.LIST) for (const x of withEst.filter((x) => Math.abs(x.est / x.truth - 1) >= 0.04)) console.log(`  ✗ ${x.fixture.slice(0, 18)} ${x.name.slice(0, 28).padEnd(28)} ${x.dance.padEnd(9)} truth ${(x.truth * 30).toFixed(0)} est ${(x.est * 30).toFixed(0)} aligned ${x.aligned ? (x.aligned * 30).toFixed(0) : '-'} passes ${x.passes}`);
