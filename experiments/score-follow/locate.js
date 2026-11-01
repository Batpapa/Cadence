'use strict';
// Finding a tune in a long recording (2026-10-31): the app's scoreFollowWorker
// `locate`, replayed with the lab aligner on a whole annotated session — a
// card's recording has no detection to say where its tune is. For each
// annotated tune (the setting the engine voted for, its drawn score when
// output/drawn-contours.json has it): does the stretch found hold the
// annotation, or another playing of the same tune? How long does it take?
//
// And what the app then says of the stretch (followed or refused) — for tunes
// NOT in the session too (ABSENT=n), where followed is a false find.
//
//   node experiments/score-follow/locate.js [session-substring] [maxTunes]   (from Cadence/)
const fs = require('node:fs');
const path = require('node:path');
const { featuresOf, decodeSpan, RATE } = require('./lib/engine');
const { align, FPS, MIDI_LOW, MIDI_NUM } = require('./lib/align');

const ROOT = path.resolve(__dirname, '../..');
const INDEX = path.resolve(__dirname, '../noise-study/.cache/tune-index.json');
const DRAWN = path.join(__dirname, 'output', 'drawn-contours.json');
const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV';
const toMidi = (contour) => [...contour].map((c) => MIDI_LOW + CHARS.indexOf(c));
const secs = (s) => s.split(':').reduce((a, b) => a * 60 + Number(b), 0);
const AUDIO = {
  '20260523_2_aprem_tabac': '20260523_2_aprem_tabac.m4a',
  '20260523_1_matin_Anglade': '20260523_1_matin_Anglade.m4a',
  '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24': '13th Moon Gravity Well - Irish Trad Session 2024.01.24.mp3',
};

// The worker's constants (scoreFollowWorker.ts).
const LONG_S = 6 * 60;
const LOCATE_WINDOW_S = 4 * 60;
const LOCATE_HOP_S = 2 * 60;
const LOCATE_JOIN_S = 10;
const ZONE_MARGIN_S = 15;
const ZONE_MAX_S = LONG_S - 2 * ZONE_MARGIN_S;
const MATCH_USABLE = 0.5;
const BPMS = process.env.BPMS ? process.env.BPMS.split(',').map(Number) : undefined;

/** Features of a whole file, decoded 5 minutes at a time (the app streams). */
function wholeFeatures(file) {
  const CHUNK = 300;
  const parts = [];
  let carry = new Float32Array(0);
  for (let at = 0; ; at += CHUNK) {
    const pcm = decodeSpan(file, at, CHUNK);
    if (pcm.length === 0) break;
    const joined = new Float32Array(carry.length + pcm.length);
    joined.set(carry); joined.set(pcm, carry.length);
    const usable = joined.length - (joined.length % 1024);
    parts.push(featuresOf(joined.subarray(0, usable)));
    carry = joined.slice(usable);
    if (pcm.length < CHUNK * RATE * 0.99) break;
  }
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function hitsOf(feats, score, r) {
  let hit = 0, n = 0;
  for (let k = 0; k < r.onsets.length; k++) {
    const a = r.onsets[k].frame, b = k + 1 < r.onsets.length ? r.onsets[k + 1].frame : r.end;
    const pc = (score[r.onsets[k].index] + r.transpose) % 12;
    for (let t = a; t < b; t++) {
      let best = 0, arg = 0;
      for (let p = 0; p < MIDI_NUM; p++) if (feats[t * MIDI_NUM + p] > best) { best = feats[t * MIDI_NUM + p]; arg = p; }
      if (best <= 0) continue;
      n++;
      if ((arg + MIDI_LOW) % 12 === pc) hit++;
    }
  }
  return { hit, n };
}

function locate(features, fps, score) {
  const frames = Math.floor(features.length / MIDI_NUM);
  const win = Math.round(LOCATE_WINDOW_S * fps), hop = Math.round(LOCATE_HOP_S * fps);
  const last = Math.max(0, frames - win);
  const count = Math.ceil(last / hop) + 1;
  const finds = [];
  for (let k = 0; k < count; k++) {
    const a = Math.min(k * hop, last);
    const sub = features.subarray(a * MIDI_NUM, Math.min(frames, a + win) * MIDI_NUM);
    const r = align(sub, score, BPMS ? { bpms: BPMS } : {});
    if (!r || r.onsets.length === 0) continue;
    const { hit, n } = hitsOf(sub, score, r);
    const worth = hit - MATCH_USABLE * n;
    if (worth > 0) finds.push({ worth, start: a / fps + r.onsets[0].frame / fps, end: a / fps + r.end / fps });
  }
  if (!finds.length) return null;
  finds.sort((x, y) => y.worth - x.worth);
  const best = finds[0];
  let { start, end } = best;
  for (let grew = true; grew;) {
    grew = false;
    for (const w of finds) {
      if (w.start > end + LOCATE_JOIN_S || w.end < start - LOCATE_JOIN_S) continue;
      if (w.start < start || w.end > end) { start = Math.min(start, w.start); end = Math.max(end, w.end); grew = true; }
    }
  }
  if (end - start > ZONE_MAX_S) {
    start = Math.max(start, Math.min((best.start + best.end) / 2 - ZONE_MAX_S / 2, end - ZONE_MAX_S));
    end = start + ZONE_MAX_S;
  }
  return { from: Math.max(0, start - ZONE_MARGIN_S), to: end + ZONE_MARGIN_S, found: { start, end } };
}

/** What the app then says of the zone found (ScoreFollowView `followable`):
 *  the zone aligned at once, its share of notes on the score (MATCH_USABLE)
 *  and what it covers of one pass at the tempo found (USABLE_COVER). The lab
 *  aligns the one score; the app also tries the index contour, keeps the best. */
function judge(features, z, score) {
  const a = Math.floor(z.from * FPS), b = Math.min(features.length / MIDI_NUM, Math.ceil(z.to * FPS));
  const sub = features.subarray(a * MIDI_NUM, b * MIDI_NUM);
  const r = align(sub, score, BPMS ? { bpms: BPMS } : {});
  if (!r || r.onsets.length === 0) return { ok: false, match: 0, cover: 0 };
  const { hit, n } = hitsOf(sub, score, r);
  const match = n ? hit / n : 0;
  const pass = Math.min((b - a) / FPS, (score.length * 30) / r.bpm);
  const cover = pass > 0 ? (r.end - r.onsets[0].frame) / FPS / pass : 1;
  return { ok: match >= MATCH_USABLE && cover >= 0.5, match, cover };
}
const say = (j) => `${j.ok ? 'FOLLOWED' : 'refused '} ${Math.round(j.match * 100)} % on score, ${Math.round(j.cover * 100)} % of a pass`;

const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const drawn = fs.existsSync(DRAWN) ? JSON.parse(fs.readFileSync(DRAWN, 'utf8')) : {};
const filter = process.argv[2] || 'tabac';
const maxTunes = Number(process.argv[3] || 1e9);
for (const [fixture, audioName] of Object.entries(AUDIO)) {
  if (!fixture.includes(filter)) continue;
  const csv = path.join(ROOT, 'test-fixtures/sessions', fixture + '-timings.csv');
  const winFile = path.join(ROOT, 'test-fixtures/sessions', fixture + '-windows.json');
  const audio = path.join(ROOT, 'test-fixtures/audio', audioName);
  const windows = JSON.parse(fs.readFileSync(winFile, 'utf8'));
  const rows = fs.readFileSync(csv, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(','))
    .filter(([, , id]) => Number(id) > 0).map(([a, b, id]) => ({ start: secs(a), end: secs(b), tuneId: id }));
  let t0 = Date.now();
  const features = wholeFeatures(audio);
  console.log(`${fixture}: ${(features.length / MIDI_NUM / FPS / 60).toFixed(1)} min, features in ${Date.now() - t0} ms`);
  let done = 0, held = 0, other = 0, missed = 0, followed = 0;
  const times = [];
  const used = [];
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  for (const row of rows) {
    if (done >= maxTunes) break;
    const votes = new Map();
    for (const w of windows) {
      if (w.tWindowEnd <= row.start || w.tWindowStart >= row.end) continue;
      for (const c of w.candidates) if (c.tuneId === row.tuneId) votes.set(c.settingId, (votes.get(c.settingId) || 0) + c.score);
    }
    if (!votes.size) continue;
    const settingId = [...votes.entries()].sort((x, y) => y[1] - x[1])[0][0];
    const setting = idx.settings[settingId];
    if (!setting) continue;
    done++;
    used.push(settingId);
    const score = drawn[settingId] ?? toMidi(setting.contour);
    t0 = Date.now();
    const z = locate(features, FPS, score);
    const ms = Date.now() - t0;
    times.push(ms);
    // Held: the zone covers the annotation, give or take 5 s at each end.
    const covers = (r) => z && z.from <= r.start + 5 && z.to >= r.end - 5;
    const overlaps = (r) => z && z.found.start < r.end && z.found.end > r.start;
    let verdict;
    if (covers(row)) { verdict = 'HELD'; held++; }
    else if (rows.some((r) => r !== row && r.tuneId === row.tuneId && (covers(r) || overlaps(r)))) { verdict = 'other playing'; other++; }
    else { verdict = overlaps(row) ? 'PART' : 'MISSED'; missed++; }
    const j = z ? judge(features, z, score) : { ok: false, match: 0, cover: 0 };
    if (j.ok) followed++;
    console.log(`${String(setting.name ?? settingId).slice(0, 28).padEnd(28)} ${fmt(row.start)}-${fmt(row.end)}  found ${z ? `${fmt(z.found.start)}-${fmt(z.found.end)}` : '—'}  ${verdict}  ${say(j)}  (${(ms / 1000).toFixed(1)} s)`);
  }
  times.sort((a, b) => a - b);
  console.log(`\n${done} tunes: held ${held}, another playing of the same tune ${other}, missed or partial ${missed}; followed ${followed}; locate median ${(times[times.length >> 1] / 1000).toFixed(1)} s`);

  // ABSENT=n: tunes NOT in the session, of its meters — what does the app say
  // of the stretch it finds for them? Followed is then a false find. The first
  // setting of tunes spread over the 3000 first ids (the older, more played).
  const absent = Number(process.env.ABSENT || 0);
  if (!absent) continue;
  const inSession = new Set(rows.map((r) => r.tuneId));
  const meters = new Set(used.map((id) => idx.settings[id].meter));
  const firsts = new Map();
  for (const [id, s] of Object.entries(idx.settings)) {
    const tune = Number(s.tune_id);
    if (tune > 3000 || inSession.has(s.tune_id) || !meters.has(s.meter) || s.contour.length < 32) continue;
    if (!firsts.has(tune) || Number(id) < Number(firsts.get(tune))) firsts.set(tune, id);
  }
  const pool = [...firsts.entries()].sort((a, b) => a[0] - b[0]);
  let falseFinds = 0;
  for (let k = 0; k < absent; k++) {
    const [tune, settingId] = pool[Math.floor((k * pool.length) / absent)];
    const setting = idx.settings[settingId];
    const score = drawn[settingId] ?? toMidi(setting.contour);
    const z = locate(features, FPS, score);
    const j = z ? judge(features, z, score) : { ok: false, match: 0, cover: 0 };
    if (j.ok) falseFinds++;
    console.log(`absent tune ${String(tune).padEnd(5)} ${setting.meter.padEnd(4)} found ${z ? `${fmt(z.found.start)}-${fmt(z.found.end)}` : '—'.padEnd(11)}  ${say(j)}`);
  }
  console.log(`\n${absent} absent tunes: followed (false finds) ${falseFinds}`);
}
