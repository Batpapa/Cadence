// Live score following — the Play-along's bench (2026-10-31).
//
// Runs the app's own follower, src/session/liveFollow.ts (Node strips its
// types; it imports nothing on purpose), one feature frame at a time, as the
// microphone would feed it, and carries each estimate forward with the app's
// LiveCursor to the moment the cursor would be drawn: H seconds after the
// end of the last frame heard — the microphone's latency plus the screen's.
// Compared with the truth at that very moment:
//   - synthetic: tunes rendered from their contour (lib/render.js), true
//     onsets known. Three ways of playing: a session (fast, accompanied,
//     noisy), solo, and practice (a part, a pause, the B part, the last two
//     bars again, a pause, the whole tune);
//   - real: the annotated sessions, the "truth" being the offline alignment
//     of the same contour over the same audio (lib/align.js, the recording's
//     model, which sees the future). Pessimistic for the Play-along: a pub
//     session, the tune never started from a known point.
//
//   node experiments/score-follow/live.mjs synth            (from Cadence/)
//   node experiments/score-follow/live.mjs real [session-substring] [maxTunes]
//
// Settings by environment: LAG, ENTER, EXIT, SWITCH, SHOW, HIDE, BPMS
// (comma-separated), GAIN, SNAP, CONFIRM; SAME (positions alike over ±SAME
// quavers count as one place, 0 for none); NOLEVEL=1 (no samples' level);
// GHOST=1 (when a cursor showed outside the tune).
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { featuresOf, decodeSpan } = require('./lib/engine');
const { renderSequence } = require('./lib/render');
const { align, FPS, MIDI_LOW } = require('./lib/align');
const { LiveFollower, LiveCursor, VersionWatch, versionMerge } = await import(pathToFileURL(path.resolve(here, '../../src/session/liveFollow.ts')).href);

const ROOT = path.resolve(here, '../..');
const INDEX = path.resolve(here, '../noise-study/.cache/tune-index.json');
const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV';
const toMidi = (contour) => [...contour].map((c) => MIDI_LOW + CHARS.indexOf(c));
const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));

const env = (k) => (process.env[k] !== undefined ? Number(process.env[k]) : undefined);
const followOpts = Object.fromEntries(Object.entries({
  lagFrames: env('LAG'), durWeight: env('DUR'), octaveWeight: env('OCT'), wrongPenalty: env('WRONG'), quietPenalty: env('QUIET'), pitchShare: env('PITCH'), jumpMargin: env('JMARGIN'), jumpFrames: env('JFRAMES'), enterPenalty: env('ENTER'), exitPenalty: env('EXIT'), switchPenalty: env('SWITCH'),
  showFrames: env('SHOW'), hideFrames: env('HIDE'), rateSeconds: env('RATESEC'),
  bpms: process.env.BPMS ? process.env.BPMS.split(',').map(Number) : undefined,
  fps: FPS,
}).filter(([, v]) => v !== undefined));
const cursorOpts = Object.fromEntries(Object.entries({ gain: env('GAIN'), snapQuavers: env('SNAP'), confirmSeconds: env('CONFIRM') }).filter(([, v]) => v !== undefined));

/** Moments the cursor is drawn after the end of the last frame heard. */
const HS = [0, 0.05, 0.1, 0.15, 0.2, 0.3];
/** The horizon acquisition is judged at: a fair guess at a phone's. */
const H_ACQ = HS.indexOf(0.15);
/** Seconds into a stretch of playing before it counts as steady. */
const STEADY_S = 5;

const gapOf = (a, b, n) => { const d = Math.abs(a - b) % n; return Math.min(d, n - d); };

/** The truth over played notes: at `t` s, the quaver and fraction, the local
 *  tempo (quavers/s) and how long the current stretch of playing has lasted;
 *  null where nothing is played. `notes`: { t, index } in order, index null
 *  for a rest; `end`: the end of the last. */
function truthOf(notes, end) {
  const since = [];
  notes.forEach((n, k) => { since.push(n.index === null ? null : (k > 0 && since[k - 1] !== null ? since[k - 1] : n.t)); });
  const next = (k) => (k + 1 < notes.length ? notes[k + 1].t : end);
  return (t) => {
    if (!notes.length || t < notes[0].t || t >= end) return null;
    let lo = 0, hi = notes.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (notes[mid].t <= t) lo = mid; else hi = mid - 1; }
    const n = notes[lo];
    if (n.index === null) return null;
    const dur = next(lo) - n.t;
    // Two quavers' worth: swing makes one long and one short.
    const pair = lo + 1 < notes.length ? next(lo + 1) - n.t : 2 * dur;
    return { q: n.index + (t - n.t) / dur, rate: 2 / pair, since: t - since[lo] };
  };
}

/** One performance through the follower: per horizon, the frames steady,
 *  shown, on the right quaver, the errors; the frames outside any playing
 *  and how many of those showed a cursor anyway; the acquisitions. */
function runCase(feats, levels, score, truth) {
  const N = score.length;
  const frames = feats.length / 48;
  // Positions the score cannot tell apart are one place on the page: a part
  // played twice (A1, A2) is drawn once, and a cursor on A2 when A1 is heard
  // is on the right note. Counted as wrong, they made the real sessions look
  // a part off half the time (2026-10-31): the contour, unfolded, has the
  // part twice, and the follower may hesitate between the copies at no cost
  // to what is drawn. Same place: the same contour over ±SAME quavers
  // (default 12, SAME=0 to count strictly) — not the endings, which differ.
  const W = env('SAME') ?? 12;
  const same = Array.from({ length: N }, (_, i) => {
    const out = [i];
    // Alike over a stretch of 2·SAME + 1 quavers that holds both, however it
    // sits around them: near the end of a part played twice, what follows
    // differs (the part again, or the next) though the notes are drawn once
    // (2026-11-01, a take of Man of Aran).
    const at = (k) => score[((k % N) + N) % N];
    if (W > 0) {
      for (let j = 0; j < N; j++) {
        if (j === i || at(i) !== at(j)) continue;
        let back = 0, ahead = 0;
        while (back < 2 * W && at(i - back - 1) === at(j - back - 1)) back++;
        while (ahead < 2 * W && at(i + ahead + 1) === at(j + ahead + 1)) ahead++;
        if (back + ahead + 1 >= 2 * W + 1) out.push(j);
      }
    }
    return out;
  });
  /** How far `p` is from `q` on the page, in quavers. */
  const drawnGap = (p, q) => {
    const base = Math.floor(q) % N, frac = q - Math.floor(q);
    let g = Infinity;
    for (const j of same[base]) g = Math.min(g, gapOf(p, j + frac, N));
    return g;
  };
  const lf = new LiveFollower(score, followOpts);
  const cursors = HS.map(() => new LiveCursor(N, cursorOpts));
  const acc = HS.map(() => ({ steady: 0, shown: 0, on: 0, far: 0, errs: [], outside: 0, ghost: 0, backs: 0, backsOut: 0, jumps: 0, prev: null, errq: [] }));
  const raw = { n: 0, on: 0 };
  // Acquisition at H_ACQ: from the start of each stretch of playing to the
  // first second spent on the right quaver throughout.
  const acqs = [];
  let stretch = null, onSince = null;
  /** GHOST=1: when a cursor showed outside the tune, at H = 0. */
  const ghosts = [];
  const t0 = process.hrtime.bigint();
  for (let fr = 0; fr < frames; fr++) {
    const e = lf.push(feats.subarray(fr * 48, fr * 48 + 48), levels?.[fr]);
    const tEnd = (fr + 1) / FPS;
    if (e.quaver !== null) {
      const tr = truth(e.at);
      if (tr) { raw.n++; if (drawnGap(e.quaver, tr.q) < 0.5) raw.on++; }
    }
    HS.forEach((H, j) => {
      const c = cursors[j];
      c.update(e);
      const now = tEnd + H;
      const p = c.position(now);
      const tr = truth(now);
      const a = acc[j];

      // A step back of more than a quaver is a visible jump back — while
      // the tune is played, or outside it. Not between two copies of a part:
      // the cursor stays where it is drawn.
      if (p !== null && a.prev !== null) {
        const d = ((p - a.prev) % N + N) % N;
        if (d > N / 2 && N - d > 1 && drawnGap(p, a.prev) > 1) { if (tr) a.backs++; else a.backsOut++; }
        // Any visible jump, either way: the drawn place moved by more than two
        // quavers in one frame.
        if (tr && drawnGap(p, a.prev) > 2) a.jumps++;
      }
      a.prev = p;
      if (!tr) {
        a.outside++;
        if (p !== null) { a.ghost++; if (process.env.GHOST && j === 0) ghosts.push(+now.toFixed(2)); }
        if (j === H_ACQ) { stretch = null; onSince = null; }
        return;
      }
      const on = p !== null && drawnGap(p, tr.q) < 0.5;
      if (j === H_ACQ) {
        if (stretch === null || tr.since < stretch.since) stretch = { start: now - tr.since, since: tr.since, done: false };
        stretch.since = tr.since;
        if (!stretch.done) {
          if (!on) onSince = null;
          else if (onSince === null) onSince = now;
          else if (now - onSince >= 1) { acqs.push(onSince - stretch.start); stretch.done = true; }
        }
      }
      if (tr.since < STEADY_S) return;
      a.steady++;
      if (p === null) return;
      a.shown++;
      if (on) a.on++;
      // Elsewhere in the tune: more than two quavers off what is played.
      if (drawnGap(p, tr.q) > 2) a.far++;
      a.errs.push(drawnGap(p, tr.q) / tr.rate);
      a.errq.push(drawnGap(p, tr.q));
    });
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (process.env.GHOST && ghosts.length) console.log('  ghosts at', ghosts.filter((g, k) => k === 0 || g - ghosts[k - 1] > 0.05).join(' '), '(' + ghosts.length + ' frames)');
  return { acc, raw, acqs, ms, seconds: frames / FPS };
}

const pct = (xs, p) => { if (!xs.length) return NaN; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : '–');
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–');

function summarise(label, runs) {
  console.log(`\n── ${label}: ${runs.length} performances, ${f0(runs.reduce((a, r) => a + r.seconds, 0))} s ──`);
  const rawN = runs.reduce((a, r) => a + r.raw.n, 0), rawOn = runs.reduce((a, r) => a + r.raw.on, 0);
  console.log(`  follower alone, at its own moment (lag ${followOpts.lagFrames ?? 'default'}): on the right quaver ${f1(100 * rawOn / rawN)} %`);
  console.log('  H (ms)  shown  on-quaver  err med / p90 (ms)  shown outside  jumps back in / out');
  HS.forEach((H, j) => {
    const steady = runs.reduce((a, r) => a + r.acc[j].steady, 0);
    const shown = runs.reduce((a, r) => a + r.acc[j].shown, 0);
    const on = runs.reduce((a, r) => a + r.acc[j].on, 0);
    const errs = runs.flatMap(r => r.acc[j].errs);
    const outside = runs.reduce((a, r) => a + r.acc[j].outside, 0);
    const ghost = runs.reduce((a, r) => a + r.acc[j].ghost, 0);
    const backs = runs.reduce((a, r) => a + r.acc[j].backs, 0);
    const backsOut = runs.reduce((a, r) => a + r.acc[j].backsOut, 0);
    console.log(`  ${String(H * 1000).padStart(5)}  ${f1(100 * shown / steady).padStart(5)} %  ${f1(100 * on / steady).padStart(7)} %  ${f0(1000 * pct(errs, 0.5)).padStart(8)} / ${f0(1000 * pct(errs, 0.9)).padEnd(8)}  ${f1(100 * ghost / Math.max(1, outside)).padStart(8)} %  ${String(backs).padStart(6)} / ${backsOut}`);
  });
  const acqs = runs.flatMap(r => r.acqs);
  const stretches = runs.reduce((a, r) => a + r.acqStretches, 0);
  console.log(`  acquisition at H = ${HS[H_ACQ] * 1000} ms: ${acqs.length}/${stretches} stretches, median ${f1(pct(acqs, 0.5))} s, p90 ${f1(pct(acqs, 0.9))} s, max ${f1(Math.max(...acqs))} s`);
  const cost = runs.reduce((a, r) => a + r.ms, 0) / runs.reduce((a, r) => a + r.seconds, 0);
  console.log(`  cost: ${f1(cost)} ms of CPU per second of audio (${f1(cost / 10)} % of one core)`);
}

/** Each frame's mean square, the follower's `level` — what the app's worker
 *  measures on the microphone's samples. NOLEVEL=1 leaves it out. */
function levelsOf(pcm) {
  if (process.env.NOLEVEL) return null;
  const n = Math.floor(pcm.length / 1024), out = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = i * 1024; k < (i + 1) * 1024; k++) s += pcm[k] * pcm[k]; out[i] = s / 1024; }
  return out;
}

const stretchesOf = (notes) => notes.filter((n, k) => n.index !== null && (k === 0 || notes[k - 1].index === null)).length;

// ── Synthetic ────────────────────────────────────────────────────────────────
function synth() {
  const settingsOf = new Map();
  for (const [id, s] of Object.entries(idx.settings)) (settingsOf.get(s.tune_id) || settingsOf.set(s.tune_id, []).get(s.tune_id)).push(id);
  // synth.js's spread of dances, its tempi as a slow session's.
  const tunes = [['1', 112], ['55', 115], ['2', 110], ['71', 105], ['27', 120], ['248', 90], ['3', 100], ['52', 118], ['65', 112], ['16', 105]];
  const ways = {
    session: (N) => ({ played: Array.from({ length: 3 * N }, (_, k) => k % N), bpmScale: 1.8, accomp: true, snrDb: 10 }),
    solo: (N) => ({ played: Array.from({ length: 2 * N }, (_, k) => k % N), bpmScale: 1, accomp: false, snrDb: 25 }),
    practice: (N) => {
      const range = (a, b) => Array.from({ length: b - a }, (_, k) => a + k);
      const rest = (s, q) => Array.from({ length: Math.round(s / q) }, () => null);
      const q = 60 / 90 / 2;
      const half = Math.floor(N / 2);
      return {
        played: [...range(0, half), ...rest(2.5, q), ...range(half, N), ...range(N - 16, N), ...rest(1.5, q), ...range(0, N)],
        bpm: 90, accomp: false, snrDb: 25,
      };
    },
  };
  const want = process.argv[3];
  for (const [way, make] of Object.entries(ways)) {
    if (want && way !== want) continue;
    const runs = [];
    for (const [tuneId, bpm0] of tunes) {
      const played0 = idx.settings[tuneId] ? tuneId : (settingsOf.get(tuneId) || [])[0];
      if (!played0) continue;
      const score = toMidi(idx.settings[played0].contour);
      const w = make(score.length);
      const bpm = w.bpm ?? Math.round(bpm0 * w.bpmScale);
      const { pcm, notes, end } = renderSequence(score, w.played, { bpm, accomp: w.accomp, snrDb: w.snrDb });
      const r = runCase(featuresOf(pcm), levelsOf(pcm), score, truthOf(notes, end));
      r.acqStretches = stretchesOf(notes);
      runs.push(r);
      const a = r.acc[H_ACQ];
      console.log(`${way.padEnd(8)} ${(idx.aliases[tuneId] || ['?'])[0].slice(0, 26).padEnd(26)} ${idx.settings[played0].dance.padEnd(9)} N=${String(score.length).padEnd(4)} bpm ${String(bpm).padEnd(4)} on ${f1(100 * a.on / a.steady)} %  err med ${f0(1000 * pct(a.errs, 0.5))} ms  acq [${r.acqs.map(f1).join(' ')}] s`);
    }
    summarise(way, runs);
  }
}

// ── Real sessions ────────────────────────────────────────────────────────────
function real() {
  const AUDIO = {
    '20260523_1_matin_Anglade': '20260523_1_matin_Anglade.m4a',
    '20260523_2_aprem_tabac': '20260523_2_aprem_tabac.m4a',
    '20260523_5_auberge_fleurie': '20260523_5_auberge_fleurie.m4a',
    '20240721_tocane_2_chapiteau': '20240721_tocane_2_chapiteau.m4a',
    '1Hour_Trad_Irish_Music_Session_in_Korea': '1Hour Trad Irish Music Session in Korea.mp3',
    'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video': 'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video.mp3',
    '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24': '13th Moon Gravity Well - Irish Trad Session 2024.01.24.mp3',
  };
  const secs = (s) => s.split(':').reduce((a, b) => a * 60 + Number(b), 0);
  const filter = process.argv[3] || '';
  const maxTunes = Number(process.argv[4] || 1e9);
  const runs = [];
  for (const [fixture, audioName] of Object.entries(AUDIO)) {
    if (!fixture.includes(filter)) continue;
    const csv = path.join(ROOT, 'test-fixtures/sessions', fixture + '-timings.csv');
    const winFile = path.join(ROOT, 'test-fixtures/sessions', fixture + '-windows.json');
    const audio = path.join(ROOT, 'test-fixtures/audio', audioName);
    if (!fs.existsSync(csv) || !fs.existsSync(audio)) continue;
    const windows = JSON.parse(fs.readFileSync(winFile, 'utf8'));
    const rows = fs.readFileSync(csv, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
    let done = 0;
    for (const [a, b, tuneId] of rows) {
      if (done >= maxTunes) break;
      if (!(Number(tuneId) > 0)) continue;
      const start = secs(a), end = secs(b);
      // The setting the engine itself picked, as real.js does.
      const votes = new Map();
      for (const w of windows) {
        if (w.tWindowEnd <= start || w.tWindowStart >= end) continue;
        for (const c of w.candidates) if (c.tuneId === tuneId) votes.set(c.settingId, (votes.get(c.settingId) || 0) + c.score);
      }
      if (!votes.size) continue;
      const settingId = [...votes.entries()].sort((x, y) => y[1] - x[1])[0][0];
      const setting = idx.settings[settingId];
      if (!setting) continue;
      done++;
      const M = 5;
      const from = Math.max(0, start - M);
      const pcm = decodeSpan(audio, from, end + M - from);
      const feats = featuresOf(pcm);
      const score = toMidi(setting.contour);
      const off = align(feats, score, { transposes: [0], otherPenalty: 1.2 });
      const notes = off.onsets.map((o) => ({ t: o.frame / FPS, index: o.index }));
      const r = runCase(feats, levelsOf(pcm), score, truthOf(notes, off.end / FPS));
      r.acqStretches = notes.length ? 1 : 0;
      runs.push(r);
      const h = r.acc[H_ACQ];
      console.log(`${fixture.slice(0, 14).padEnd(14)} ${(idx.aliases[tuneId] || ['?'])[0].slice(0, 26).padEnd(26)} ${setting.dance.padEnd(9)} ${String(Math.round(end - start)).padStart(4)} s bpm ${off.bpm}  on ${f1(100 * h.on / h.steady)} %  shown ${f1(100 * h.shown / h.steady)} %  elsewhere ${f1(100 * h.far / h.steady)} %  err med ${f0(1000 * pct(h.errs, 0.5))} ms  acq [${r.acqs.map(f1).join(' ')}] s`);
    }
  }
  summarise('real sessions', runs);
}

// ── Takes downloaded from the app ────────────────────────────────────────────
// The Play-along's « download the take » (developer mode): the features and
// levels the app's worker computed, the score it followed. The truth, as for
// the real sessions, is the offline alignment of that score over the take.
// TRACE=1 prints the cursor drawn at H = 150 ms every quarter of a second,
// next to that truth and the note heard.
function takes() {
  const files = process.argv.slice(3);
  const runs = [];
  const f32 = (b64) => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  for (const file of files) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j.kind !== 'cadence-play-along') { console.log(file, ': not a take'); continue; }
    const feats = f32(j.features), levels = process.env.NOLEVEL ? null : f32(j.levels);
    const score = j.score;
    const off = align(feats, score, { transposes: [0], otherPenalty: 1.2 });
    const notes = off.onsets.map((o) => ({ t: o.frame / FPS, index: o.index }));
    const truth = truthOf(notes, off.end / FPS);
    const r = runCase(feats, levels, score, truth);
    r.acqStretches = notes.length ? 1 : 0;
    runs.push(r);
    const h = r.acc[H_ACQ];
    console.log(`${path.basename(file)}  ${(feats.length / 48 / FPS).toFixed(0)} s  N=${score.length}  offline bpm ${off.bpm}  on ${f1(100 * h.on / h.steady)} %  shown ${f1(100 * h.shown / h.steady)} %  elsewhere ${f1(100 * h.far / h.steady)} %  err med ${f0(1000 * pct(h.errs, 0.5))} ms  jumps back ${h.backs}  all jumps ${h.jumps}  acq [${r.acqs.map(f1).join(' ')}] s`);
    if (process.env.TRACE) traceTake(feats, levels, score, truth);
  }
  if (runs.length > 1) summarise('takes', runs);
}

function traceTake(feats, levels, score, truth) {
  const N = score.length;
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const name = (m) => NAMES[((m % 12) + 12) % 12];
  const lf = new LiveFollower(score, followOpts);
  const cur = new LiveCursor(N, cursorOpts);
  const every = Math.round(FPS / 4);
  for (let fr = 0; fr < feats.length / 48; fr++) {
    const fe = feats.subarray(fr * 48, fr * 48 + 48);
    const e = lf.push(fe, levels?.[fr]);
    cur.update(e);
    const now = (fr + 1) / FPS + 0.15;
    const p = cur.position(now);
    if (fr % every) continue;
    let top = 0;
    for (let i = 1; i < 48; i++) if (fe[i] > fe[top]) top = i;
    const tr = truth(now);
    const show = (q) => (q === null ? '    –    ' : `${q.toFixed(1).padStart(5)} ${name(score[Math.floor(q) % N]).padEnd(2)}`);
    console.log(`  ${now.toFixed(2).padStart(6)} s  heard ${name(MIDI_LOW + top).padEnd(2)}  ${e.state.padEnd(6)} cursor ${show(p)}  truth ${show(tr ? tr.q : null)}`);
  }
}

// ── Which version is being played (VersionWatch) ─────────────────────────────
// Every setting of a tune followed side by side, one of them "on screen":
// whether another is offered, which, and when. Synthetic: the first setting
// played (solo, then session), on screen in turn itself — any offer is a
// false one — and up to SHOWN others (the played one, or a near twin, should
// be offered: `same` is the share of quavers the offer has in common with
// what is played). Takes: `versions take tuneId shownId file.json`.
// Settings: MERGE, WIN, MARGIN, HOLD.
const watchOpts = Object.fromEntries(Object.entries({ merge: env('MERGE'), windowSeconds: env('WIN'), margin: env('MARGIN'), holdSeconds: env('HOLD') }).filter(([, v]) => v !== undefined));
const twin = (a, b) => { const n = Math.min(a.length, b.length); let s = 0; for (let i = 0; i < n; i++) if (a[i] === b[i]) s++; return s / Math.max(a.length, b.length); };

function watchRun(feats, levels, scores, shown) {
  const w = new VersionWatch(scores, shown, { merge: versionMerge(scores.length), ...watchOpts, fps: FPS, follow: followOpts });
  let first = null, last = null;
  const t0 = performance.now();
  const frames = feats.length / 48;
  for (let fr = 0; fr < frames; fr++) {
    const o = w.push(feats.subarray(fr * 48, fr * 48 + 48), levels?.[fr]);
    if (o !== null && first === null) first = { v: o, t: fr / FPS };
    last = o;
  }
  return { first, last, ms: (performance.now() - t0) / frames };
}

function versions() {
  if (process.argv[3] === 'take') {
    const [tuneId, shownId, ...files] = process.argv.slice(4);
    const ids = Object.keys(idx.settings).filter((k) => idx.settings[k].tune_id === tuneId);
    const scores = ids.map((id) => toMidi(idx.settings[id].contour));
    const f32 = (b64) => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
    for (const file of files) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const r = watchRun(f32(j.features), f32(j.levels), scores, ids.indexOf(shownId));
      console.log(`${path.basename(file)} on screen ${shownId}: offered ${r.first ? `${ids[r.first.v]} at ${f1(r.first.t)} s` : 'nothing'}, at the end ${r.last === null ? 'nothing' : ids[r.last]}  (${ids.length} versions, ${r.ms.toFixed(2)} ms/frame)`);
    }
    return;
  }
  const SHOWN = Number(process.env.SHOWN || 4);
  const tunes = [['1', 112], ['55', 115], ['2', 110], ['71', 105], ['27', 120], ['248', 90], ['3', 100], ['52', 118], ['65', 112], ['16', 105]];
  const tally = { false: 0, quiet: 0, right: 0, twin: 0, wrong: 0, missed: 0, delays: [], ms: [] };
  for (const way of ['solo', 'session']) {
    for (const [tuneId, bpm0] of tunes) {
      const ids = Object.keys(idx.settings).filter((k) => idx.settings[k].tune_id === tuneId);
      const scores = ids.map((id) => toMidi(idx.settings[id].contour));
      const played = 0, score = scores[played], N = score.length;
      const solo = way === 'solo';
      const { pcm } = renderSequence(score, Array.from({ length: 3 * N }, (_, k) => k % N), { bpm: Math.round(bpm0 * (solo ? 1 : 1.8)), accomp: !solo, snrDb: solo ? 25 : 10 });
      const feats = featuresOf(pcm), levels = levelsOf(pcm);
      const step = Math.max(1, Math.floor((ids.length - 1) / SHOWN));
      const shownList = [played, ...Array.from({ length: Math.min(SHOWN, ids.length - 1) }, (_, k) => 1 + k * step)];
      const out = [];
      for (const shown of shownList) {
        const r = watchRun(feats, levels, scores, shown);
        tally.ms.push(r.ms);
        const near = twin(scores[shown], score);
        if (shown === played) {
          if (r.first) { tally.false++; out.push(`FALSE ${ids[r.first.v]} (same ${f0(100 * twin(scores[r.first.v], score))} %)`); } else { tally.quiet++; out.push('none'); }
          continue;
        }
        if (!r.first) { tally.missed++; out.push(`${ids[shown]} (same ${f0(100 * near)} %): none`); continue; }
        const same = twin(scores[r.first.v], score);
        if (r.first.v === played) tally.right++; else if (same >= near) tally.twin++; else tally.wrong++;
        tally.delays.push(r.first.t);
        out.push(`${ids[shown]} (same ${f0(100 * near)} %): ${ids[r.first.v]} (same ${f0(100 * same)} %) at ${f1(r.first.t)} s`);
      }
      console.log(`${way.padEnd(8)} ${(idx.aliases[tuneId] || ['?'])[0].slice(0, 22).padEnd(22)} ${String(ids.length).padStart(2)} versions  ${out.join(' | ')}`);
    }
  }
  const d = tally.delays.sort((a, b) => a - b);
  console.log(`played on screen: ${tally.false} false offers, ${tally.quiet} none · another on screen: ${tally.right} played offered, ${tally.twin} a closer twin, ${tally.wrong} a farther one, ${tally.missed} none · delay med ${f1(pct(d, 0.5))} s · ${pct(tally.ms.sort((a, b) => a - b), 0.5).toFixed(2)} ms/frame med`);
}

// ── Fast against slow (2026-11-01) ───────────────────────────────────────────
// « It feels far more in time played fast than slow » (the user). The same
// tunes played solo, twice through, at each tempo: the error at H = 150 ms in
// milliseconds and in quavers — if it is a fraction of a quaver, slow playing
// shows it longer. HELD=1: quavers of one pitch in a row are one held note
// (a crotchet as played: no attack between its halves).
function tempo() {
  const settingsOf = new Map();
  for (const [id, s] of Object.entries(idx.settings)) (settingsOf.get(s.tune_id) || settingsOf.set(s.tune_id, []).get(s.tune_id)).push(id);
  const tunes = ['1', '55', '2', '71', '27', '248', '3', '52', '65', '16'];
  const bpms = process.env.TEMPI ? process.env.TEMPI.split(',').map(Number) : [80, 100, 120, 140, 160, 180, 200, 220];
  const H = HS.indexOf(0.15);
  for (const bpm of bpms) {
    const errs = [], errq = [], rates = [];
    let on = 0, steady = 0, far = 0, backs = 0;
    for (const tuneId of tunes) {
      const sid = idx.settings[tuneId] ? tuneId : (settingsOf.get(tuneId) || [])[0];
      if (!sid) continue;
      const score = toMidi(idx.settings[sid].contour);
      const played = Array.from({ length: 2 * score.length }, (_, k) => k % score.length);
      const { pcm, notes, end } = renderSequence(score, played, { bpm, accomp: false, snrDb: 25, held: !!process.env.HELD });
      const r = runCase(featuresOf(pcm), levelsOf(pcm), score, truthOf(notes, end));
      const a = r.acc[H];
      errs.push(...a.errs); errq.push(...a.errq);
      on += a.on; steady += a.steady; far += a.far; backs += a.backs;
    }
    console.log(`bpm ${String(bpm).padStart(3)}  quaver ${f0(30000 / bpm)} ms  on ${f1(100 * on / steady)} %  err med ${f0(1000 * pct(errs, 0.5))} / p90 ${f0(1000 * pct(errs, 0.9))} ms  = ${pct(errq, 0.5).toFixed(2)} / ${pct(errq, 0.9).toFixed(2)} quaver  elsewhere ${f1(100 * far / steady)} %  jumps back ${backs}`);
  }
}

const mode = process.argv[2] || 'synth';
console.log(`follower ${JSON.stringify(followOpts)}  cursor ${JSON.stringify(cursorOpts)}  watch ${JSON.stringify(watchOpts)}`);
if (mode === 'synth') synth();
else if (mode === 'real') real();
else if (mode === 'take') takes();
else if (mode === 'versions') versions();
else if (mode === 'tempo') tempo();
else console.log('usage: live.mjs synth [session|solo|practice] | real [session-substring] [maxTunes] | take file.json… | versions [take tuneId shownId file.json…]');
