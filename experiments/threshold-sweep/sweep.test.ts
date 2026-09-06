import { it } from 'vitest';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { buildTemporalTimeline, filterFlatWindows, filterByTempoSpread, UNKNOWN_STATE } from '../../src/session/recognition/temporalObservationBuilder';
import { runViterbiDetection, filterShortSegments } from '../../src/session/recognition/viterbiDetector';
import { DETECTION_TEMPORAL_CONFIG as CFG } from '../../src/session/recognition/detectionTemporalConfig';
import type { WindowResult } from '../../src/session/model';

const DIR = nodePath.resolve(__dirname, '../../test-fixtures/sessions');
const INDEX = nodePath.resolve(__dirname, '../noise-study/.cache/tune-index.json');

const SESSIONS = [
  '20260523_1_matin_Anglade',
  '20260523_2_aprem_tabac',
  '20260523_5_auberge_fleurie',
  'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video',
  '20240721_tocane_2_chapiteau',
  '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24',
  '1Hour_Trad_Irish_Music_Session_in_Korea',
];
const NOISE = '732984_11910076-lq';

// ── Matching ground truth to detections ──────────────────────────────────────
// Three separate ways this measurement has already been wrong, all fixed here:
//   1. TheSession inverts articles ("virginia, the"), the annotation does not.
//   2. A tune carries many names — "cooley's" is also "reaping the rye" — so
//      names must be resolved to tune IDS through the index's own alias table.
//   3. The numeric column in the annotations is NOT a TheSession id (258 there
//      is "westbrook bell", while the title on that line resolves to 635/661).
// And the fourth, handled below: the annotations are TYPED BY HAND, so they
// carry typos, missing dance words and stray punctuation.

const base = (s: string): string => s
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/x:\s*\d+/g, '').replace(/n[o°]\.?\s*\d+/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim()
  .replace(/^(?:the|a|an) /, '').replace(/ (?:the|a|an)$/, '');

const DANCES = /\b(?:jigs?|reels?|hornpipes?|polkas?|slides?|waltz(?:es)?|marches|march|mazurkas?|barndances?|strathspeys?|schottische|slip ?jigs?)\b/gi;

/** Every reading of a hand-written title worth trying, because the annotations
 *  spell tunes several different ways:
 *   - with and without the parenthetical ("Kesh (jig)" must reach "kesh jig");
 *   - with and without the dance word ("Kesh Jig" must reach "kesh, the");
 *   - the first name only, when the line spells out an alias itself
 *     ("Dusty miller Also known as Lus Na mBanrion"). */
function variants(label: string): string[] {
  // "Rookery, The (reel) 752" — the annotator's own numbering, space-separated
  // rather than tabbed, so it survives into the title and blocks every match.
  // Both readings are kept, never one instead of the other: stripping the
  // trailing number rescues "Rookery, The (reel) 752" but would wreck
  // "Dowd's No. 9", where the number is part of the name.
  const cleaned = label.replace(/\s+\d+\s*$/, '');
  const heads = [label, cleaned].flatMap(l => l.split(/\s+(?:also known as|aka)\s+/i));
  const out = new Set<string>();
  for (const head of heads) {
    for (const form of [head.replace(/\([^)]*\)/g, ' '), head.replace(/[()]/g, ' ')]) {
      const b = base(form);
      if (b) out.add(b);
      const noDance = base(form.replace(DANCES, ' '));
      if (noDance) out.add(noDance);
    }
  }
  return [...out];
}

/** Levenshtein that gives up as soon as it exceeds `max` — the alias table has
 *  ~100k names and every unresolved label is compared against all of them. */
function within(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j]! < best) best = cur[j]!;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

const nameToIds = new Map<string, Set<string>>();
{
  const idx = JSON.parse(fs.readFileSync(INDEX, 'utf-8')) as { aliases: Record<string, string[]> };
  for (const [tuneId, names] of Object.entries(idx.aliases)) {
    for (const n of names) {
      const k = base(n);
      if (!k) continue;
      if (!nameToIds.has(k)) nameToIds.set(k, new Set());
      nameToIds.get(k)!.add(tuneId);
    }
  }
}
const ALL_KEYS = [...nameToIds.keys()];

const fuzzyLog: string[] = [];

function resolve(label: string): Set<string> {
  for (const v of variants(label)) {
    const exact = nameToIds.get(v);
    if (exact) return exact;
  }
  // Typo tolerance, deliberately tight: ~15% of the title's length, at least 1.
  // Every acceptance is logged — a loose fuzzy match silently inflates recall,
  // which is exactly the class of error this harness has already made.
  let bestKey: string | null = null, bestDist = Infinity;
  for (const v of variants(label)) {
    if (v.length < 4) continue;                      // too short to be safe
    const max = Math.max(1, Math.round(v.length * 0.15));
    for (const k of ALL_KEYS) {
      const d = within(v, k, max);
      if (d <= max && d < bestDist) { bestDist = d; bestKey = k; }
    }
  }
  if (bestKey) {
    fuzzyLog.push(`"${label}" ≈ "${bestKey}" (distance ${bestDist})`);
    return nameToIds.get(bestKey)!;
  }
  return new Set<string>();
}

function parseTruth(file: string): Array<{ label: string; ids: Set<string> }> {
  const out: Array<{ label: string; ids: Set<string> }> = [];
  for (const line of fs.readFileSync(file, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean)) {
    if (/^\d{1,2}:\d{2}:\d{2}/.test(line)) continue;   // "00:04:37 Reel set:" — a set header, not a tune
    const mmss = line.match(/^\d+:\d{2}\s+(.+)$/);
    const emdash = line.match(/^(.+?)\s+—\s+\d+$/);
    const label = (mmss ? mmss[1]! : emdash ? emdash[1]! : line.split('\t')[0]!).trim();
    if (!label) continue;
    out.push({ label, ids: resolve(label) });
  }
  return out;
}

const load = (id: string): WindowResult[] | null => {
  const p = nodePath.join(DIR, `${id}-windows.json`);
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as WindowResult[] | Record<string, WindowResult>;
  return Array.isArray(raw) ? raw : Object.values(raw);
};

function detectIds(windows: WindowResult[], unknownProb: number): Set<string> {
  const cfg = { ...CFG, unknownObservationProbability: unknownProb };
  const timeline = buildTemporalTimeline(
    filterByTempoSpread(filterFlatWindows(windows, cfg.flatWindowTopN, cfg.flatWindowMarginThreshold), cfg.tempoSpreadThreshold),
    cfg,
  );
  const r = runViterbiDetection(timeline, cfg);
  const kept = filterShortSegments(r.segments, timeline, cfg.minSegmentWindows, true);
  return new Set(kept.filter(s => s.tuneId !== UNKNOWN_STATE).map(s => s.tuneId));
}

it('sweeps the UNKNOWN floor', () => {
  const data = SESSIONS.map(id => ({ id, windows: load(id), truth: parseTruth(nodePath.join(DIR, `${id}-timings.txt`)) }))
    .filter(d => d.windows);
  const noise = load(NOISE);

  const totalTruth = data.reduce((a, d) => a + d.truth.length, 0);
  const unresolved = data.flatMap(d => d.truth.filter(t => t.ids.size === 0).map(t => `${d.id.slice(0, 18)}: ${t.label}`));
  console.log(`\n${data.length} sessions, ${totalTruth} morceaux de référence`);
  console.log(`\n── rapprochements approximatifs (${fuzzyLog.length}) — À AUDITER ──`);
  for (const l of fuzzyLog) console.log('  ' + l);
  console.log(`\n── jamais résolus (${unresolved.length}), donc jamais trouvables ──`);
  for (const l of unresolved) console.log('  ' + l);

  // The decode loop is 16 thresholds x 7 sessions — minutes. The matching audit
  // above is what has been wrong three times, so it can be checked on its own
  // first: SWEEP_AUDIT_ONLY=1 prints it and stops.
  if (process.env['SWEEP_AUDIT_ONLY']) return;

  console.log('\nplancher | rappel          | faux positifs | bruit');
  console.log('---------|-----------------|---------------|------');
  const detail = new Map<number, string[]>();
  // SWEEP_POINTS=0.20,0.25 restricts the decode to a few thresholds — the full
  // 16-point sweep is ~20 minutes, which is far more than a side-by-side needs.
  const points = process.env['SWEEP_POINTS']
    ? process.env['SWEEP_POINTS']!.split(',').map(Number)
    : Array.from({ length: 16 }, (_, i) => Math.round((0.15 + i * 0.01) * 100) / 100);

  for (const u of points) {
    const p = Math.round(u * 100) / 100;
    let tp = 0, fp = 0;
    const rows: string[] = [];
    for (const d of data) {
      const found = detectIds(d.windows!, p);
      const t = d.truth.filter(g => [...g.ids].some(id => found.has(id))).length;
      const f = [...found].filter(id => !d.truth.some(g => g.ids.has(id))).length;
      tp += t; fp += f;
      rows.push(`${d.id.slice(0, 30).padEnd(30)} ${String(t).padStart(3)}/${String(d.truth.length).padEnd(3)} vrais, ${f} faux`);
    }
    detail.set(p, rows);
    console.log(`  ${p.toFixed(2)}${p === CFG.unknownObservationProbability ? '*' : ' '}   | ${String(tp).padStart(3)}/${totalTruth} (${((tp / totalTruth) * 100).toFixed(1).padStart(5)}%) | ${String(fp).padStart(13)} | ${noise ? detectIds(noise, p).size : 0}`);
  }

  console.log('\n* = valeur actuelle\n── détail par session ──');
  for (const p of points) {
    console.log(`\nplancher ${p.toFixed(2)}`);
    for (const line of detail.get(p) ?? []) console.log('  ' + line);
  }
}, 1800000);
