'use strict';
// Builds the MUSIC/NOISE labeled dataset (CSV + JSONL, one row per window)
// from the enriched -windows.json dumps. Deliberately independent of Viterbi
// (per the study's core requirement) — labels come from two external sources
// only:
//
//   MUSIC        — the window's OWN top-1 raw candidate (debug.fullCandidates[0],
//                   the same ranking FolkFriend itself produced) has a name
//                   that appears in that session's real annotated setlist
//                   (*-timings.txt). Doesn't touch Viterbi at all.
//   NOISE_PURE   — every window of 732984_11910076-lq, a dedicated ~28min
//                   pure-noise recording (no music at all, confirmed by the
//                   user) — the cleanest possible NOISE label.
//   NOISE_MISMATCH — real-session windows whose top-1 name is NOT in that
//                   session's setlist. Ambiguous (could be true background
//                   noise, OR real music where FolkFriend just picked the
//                   wrong tune) — kept as a separate, secondary label, never
//                   merged into NOISE_PURE. Exactly the bucket the
//                   "Romanian Fantasy at 0.60 during chatter" case lives in.
//   (unlabeled)  — windows with no candidates at all (empty:true). Excluded
//                   from every export; there's nothing to compare.
//
// This intentionally never assumes "not detected = noise" (explicit user
// instruction) — every label is anchored to either the real setlist or the
// dedicated noise recording, never to Viterbi's own output.

const fs = require('node:fs');
const path = require('node:path');

const SESSIONS_DIR = path.resolve(__dirname, '../../test-fixtures/sessions');
const OUT_DIR = path.resolve(__dirname, 'output');

const REAL_SESSIONS = [
  '20260523_1_matin_Anglade',
  '20260523_2_aprem_tabac',
  '20260523_5_auberge_fleurie',
  'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video',
  // 20240228_session_dubliners removed (2026-08-18) — user call: session
  // leader plays too poorly, not a representative sample. See project memory.
  '20240721_tocane_2_chapiteau',
];
const NOISE_PURE_SESSION = '732984_11910076-lq';

function normalizeName(s) {
  return s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/x:\s*\d+/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(w => w && w !== 'the')
    .join(' ')
    .trim();
}

// Three fixture formats seen across sessions, none using the same delimiter:
//   "Name (dance)\tN"      (tab-separated; N's meaning unclear, ignored — see analyze.js)
//   "M:SS Name"             (space-separated, mm:ss prefix)
//   "Name — N"              (em-dash separated, N likely a duration in seconds)
// All three are name-only for matching purposes, so only the name half matters.
function parseTimings(file) {
  const lines = fs.readFileSync(file, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
  const names = new Set();
  for (const line of lines) {
    const mmss = line.match(/^\d+:\d{2}\s+(.+)$/);
    const emdash = line.match(/^(.+?)\s+—\s+\d+$/);
    const rawName = mmss ? mmss[1] : emdash ? emdash[1] : line.split('\t')[0].trim();
    names.add(normalizeName(rawName));
  }
  return names;
}

const SCORE_THRESHOLDS = [0.20, 0.30, 0.40, 0.50];

function computeCandidateFeatures(fullCandidates) {
  const scores = fullCandidates.map(c => c.score);
  const top = (i) => scores[i] ?? 0;
  const sumTopN = (n) => scores.slice(0, n).reduce((a, b) => a + b, 0);
  const above = (t) => scores.filter(s => s > t).length;
  return {
    top1_score: top(0),
    top2_score: top(1),
    top3_score: top(2),
    top1_minus_top2: top(0) - top(1),
    top1_div_top2: top(1) > 0 ? top(0) / top(1) : null,
    sum_top5: sumTopN(5),
    sum_top10: sumTopN(10),
    candidates_above_20: above(0.20),
    candidates_above_30: above(0.30),
    candidates_above_40: above(0.40),
    candidates_above_50: above(0.50),
    num_candidates: fullCandidates.length,
  };
}

function computeContourFeatures(contour) {
  if (!contour || contour.length === 0) {
    return { contour_num_direction_changes: null, contour_repetition_ratio: null, contour_pitch_range: null, contour_unique_pitch_count: null };
  }
  const codes = [...contour].map(ch => ch.charCodeAt(0));
  let directionChanges = 0;
  let prevDir = 0;
  for (let i = 1; i < codes.length; i++) {
    const d = Math.sign(codes[i] - codes[i - 1]);
    if (d !== 0 && prevDir !== 0 && d !== prevDir) directionChanges++;
    if (d !== 0) prevDir = d;
  }
  let longestRun = 1, curRun = 1;
  for (let i = 1; i < codes.length; i++) {
    if (codes[i] === codes[i - 1]) { curRun++; longestRun = Math.max(longestRun, curRun); } else { curRun = 1; }
  }
  return {
    contour_num_direction_changes: directionChanges,
    contour_repetition_ratio: longestRun / codes.length,
    contour_pitch_range: Math.max(...codes) - Math.min(...codes),
    contour_unique_pitch_count: new Set(codes).size,
  };
}

function computeTempoSpread(tempoCandidates) {
  if (!tempoCandidates || tempoCandidates.length === 0) {
    return { tempo_score_std: null, tempo_score_range: null };
  }
  const scores = tempoCandidates.map(t => t.combined_score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
  return {
    tempo_score_std: Math.sqrt(variance),
    tempo_score_range: Math.max(...scores) - Math.min(...scores),
  };
}

function buildRows() {
  const rows = [];

  const groundTruthBySession = new Map();
  for (const name of REAL_SESSIONS) {
    const timingsPath = path.join(SESSIONS_DIR, `${name}-timings.txt`);
    groundTruthBySession.set(name, parseTimings(timingsPath));
  }

  const allSessions = [...REAL_SESSIONS, NOISE_PURE_SESSION];
  for (const sessionId of allSessions) {
    const windowsPath = path.join(SESSIONS_DIR, `${sessionId}-windows.json`);
    if (!fs.existsSync(windowsPath)) { console.warn(`SKIP ${sessionId}: no windows dump`); continue; }
    const windows = JSON.parse(fs.readFileSync(windowsPath, 'utf-8'));
    const gt = groundTruthBySession.get(sessionId); // undefined for the noise session

    windows.forEach((w, windowIndex) => {
      const fullCandidates = w.debug?.fullCandidates ?? w.candidates ?? [];
      const features = w.debug?.features ?? null;

      let label;
      if (sessionId === NOISE_PURE_SESSION) {
        label = 'NOISE_PURE';
      } else if (fullCandidates.length === 0) {
        return; // unlabeled, excluded
      } else {
        const top1Name = normalizeName(fullCandidates[0].displayName);
        label = gt.has(top1Name) ? 'MUSIC' : 'NOISE_MISMATCH';
      }
      if (fullCandidates.length === 0 && label !== 'NOISE_PURE') return;

      const row = {
        sessionId,
        windowIndex,
        startTime: w.tWindowStart,
        endTime: w.tWindowEnd,
        label,
        top1_name: fullCandidates[0]?.displayName ?? null,
        empty: w.empty,
        ...computeCandidateFeatures(fullCandidates),
        ...(features ? {
          note_count_raw: features.note_count_raw,
          note_count_filtered: features.note_count_filtered,
          note_count_rejected: features.note_count_rejected,
          note_duration_mean: features.note_duration_mean,
          note_duration_median: features.note_duration_median,
          note_power_mean: features.note_power_mean,
          note_power_max: features.note_power_max,
          note_power_median: features.note_power_median,
          best_bpm: features.best_bpm,
          best_quant_score: features.best_quant_score,
          best_rhythm_score: features.best_rhythm_score,
          best_combined_score: features.best_combined_score,
          contour_length: features.contour_length,
          ...computeTempoSpread(features.tempo_candidates),
        } : {
          note_count_raw: null, note_count_filtered: null, note_count_rejected: null,
          note_duration_mean: null, note_duration_median: null,
          note_power_mean: null, note_power_max: null, note_power_median: null,
          best_bpm: null, best_quant_score: null, best_rhythm_score: null, best_combined_score: null,
          contour_length: null, tempo_score_std: null, tempo_score_range: null,
        }),
        ...computeContourFeatures(w.debug?.contour ?? null),
      };
      rows.push(row);

      // Full-resolution sidecar (contour string + tempo curve + top-10) kept
      // separately per-row in the JSONL export, not the CSV.
      row.__jsonlExtra = {
        contour: w.debug?.contour ?? null,
        tempo_candidates: features?.tempo_candidates ?? null,
        top10_scores: fullCandidates.slice(0, 10).map(c => c.score),
      };
    });
  }

  return rows;
}

function toCsv(rows) {
  const cols = Object.keys(rows[0]).filter(k => k !== '__jsonlExtra');
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const row of rows) lines.push(cols.map(c => esc(row[c])).join(','));
  return lines.join('\n') + '\n';
}

function toJsonl(rows) {
  return rows.map(r => JSON.stringify({ ...r, ...r.__jsonlExtra, __jsonlExtra: undefined })).join('\n') + '\n';
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = buildRows();

  const counts = {};
  for (const r of rows) counts[r.label] = (counts[r.label] ?? 0) + 1;
  console.log('Row counts by label:', counts);

  fs.writeFileSync(path.join(OUT_DIR, 'dataset.csv'), toCsv(rows));
  fs.writeFileSync(path.join(OUT_DIR, 'dataset.jsonl'), toJsonl(rows));
  console.log(`Wrote ${rows.length} rows to ${OUT_DIR}/dataset.csv and dataset.jsonl`);
}

main();
