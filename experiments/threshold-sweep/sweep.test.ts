import { it } from 'vitest';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { buildTemporalTimeline, filterFlatWindows, filterByTempoSpread, UNKNOWN_STATE, type TemporalTimeline } from '../../src/session/recognition/temporalObservationBuilder';
import { runViterbiDetection, filterShortSegments, mergeNearbySameTune, type DetectedTuneSegment } from '../../src/session/recognition/viterbiDetector';
import { DETECTION_TEMPORAL_CONFIG as CFG, type DetectionTemporalConfig } from '../../src/session/recognition/detectionTemporalConfig';
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

// ---- Matching ground truth to detections ----------------------------------------------------------------------------
// Three separate ways this measurement has already been wrong, all fixed here:
//   1. TheSession inverts articles ("virginia, the"), the annotation does not.
//   2. A tune carries many names - "cooley's" is also "reaping the rye" - so
//      names must be resolved to tune IDS through the index's own alias table.
//   3. The numeric column in the annotations is NOT a TheSession id (258 there
//      is "westbrook bell", while the title on that line resolves to 635/661).
// And the fourth, handled below: the annotations are TYPED BY HAND, so they
// carry typos, missing dance words and stray punctuation.

// Tune titles number their variants both ways - "Toss the Feathers II" in the
// annotation, "toss the feathers 2" in the index. Standalone roman numerals
// only; a bare "i" is left alone, being far too common a word to touch.
const ROMAN: Record<string, string> = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };

const base = (s: string): string => s
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/x:\s*\d+/g, '').replace(/n[o°]\.?\s*\d+/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim()
  .replace(/\b(ii|iii|iv|vi{0,3}|ix|x)\b/g, (m) => ROMAN[m] ?? m)
  .replace(/^(?:the|a|an) /, '').replace(/ (?:the|a|an)$/, '');

const DANCES = /\b(?:jigs?|reels?|hornpipes?|polkas?|slides?|waltz(?:es)?|marches|march|mazurkas?|barndances?|strathspeys?|schottische|slip ?jigs?)\b/gi;

/** Every reading of a hand-written title worth trying, because the annotations
 *  spell tunes several different ways:
 *   - with and without the parenthetical ("Kesh (jig)" must reach "kesh jig");
 *   - with and without the dance word ("Kesh Jig" must reach "kesh, the");
 *   - the first name only, when the line spells out an alias itself
 *     ("Dusty miller Also known as Lus Na mBanrion"). */
function variants(label: string): string[] {
  // "Rookery, The (reel) 752" - the annotator's own numbering, space-separated
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

/** Damerau-Levenshtein, bounded - gives up as soon as it exceeds `max`, since
 *  the alias table has ~100k names and every unresolved label is compared
 *  against all of them.
 *
 *  Transpositions count as ONE edit, not two, and that is not a refinement: a
 *  swap is the most ordinary typo a human makes. Plain Levenshtein resolved
 *  "Bryne's" to "bryn s" (one deletion) in preference to the actual tune
 *  "byrne's" (a y/r swap, two operations under the plain metric) - and the
 *  detector had found byrne's correctly, so the harness turned a perfect
 *  session into "one miss, one false positive". */
function within(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2]! + 1);
      }
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev;
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
  // Every acceptance is logged - a loose fuzzy match silently inflates recall,
  // which is exactly the class of error this harness has already made.
  let bestKey: string | null = null, bestDist = Infinity, bestLenGap = Infinity;
  for (const v of variants(label)) {
    if (v.length < 4) continue;                      // too short to be safe
    const max = Math.max(1, Math.round(v.length * 0.15));
    for (const k of ALL_KEYS) {
      const d = within(v, k, max);
      if (d > max) continue;
      // Ties are common once transpositions cost 1, and they are not arbitrary:
      // a typo rarely changes a title's length, so the candidate closest in
      // length is the better guess ("bryne s" -> "byrne s", not "bryn s").
      const lenGap = Math.abs(k.length - v.length);
      if (d < bestDist || (d === bestDist && lenGap < bestLenGap)) {
        bestDist = d; bestKey = k; bestLenGap = lenGap;
      }
    }
  }
  if (bestKey) {
    fuzzyLog.push(`"${label}" -0- "${bestKey}" (distance ${bestDist})`);
    return nameToIds.get(bestKey)!;
  }
  return new Set<string>();
}

interface TruthEntry { label: string; ids: Set<string>; start?: number; end?: number }

/** "1:02:17" / "01::02::17" -> seconds. Tolerates repeated colons because the
 *  format was dictated as "HH::MM::SS" and one of us has a typo; being lenient
 *  here is free, and a rejected line would look like a missed tune. */
function toSeconds(v: string): number | undefined {
  const parts = v.trim().split(/:+/).filter(Boolean).map(Number);
  if (!parts.length || parts.some(Number.isNaN)) return undefined;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * The CSV the WhatsApp group is filling in: header row, then
 * `start | end | ID | comment`, where ID is a TheSession *tune* id.
 *
 * This is strictly better than the .txt files it replaces - an id needs no
 * resolving, so the six layers of name matching below never run, and the spans
 * make it possible to ask whether a detection actually COVERS the tune rather
 * than merely naming it somewhere in the recording.
 *
 * The delimiter is sniffed, not assumed: Excel in a French locale writes CSV
 * with semicolons, and this file is being produced by a dozen people on a dozen
 * machines.
 */
function parseTruthCsv(file: string): TruthEntry[] {
  const lines = fs.readFileSync(file, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
  const header = lines[0] ?? '';
  const delim = [',', ';', '\t', '|']
    .map(d => ({ d, n: header.split(d).length }))
    .sort((a, b) => b.n - a.n)[0]!.d;

  const out: TruthEntry[] = [];
  for (const line of lines.slice(1)) {                    // line 1 is the header
    const cell = line.split(delim).map(c => c.trim().replace(/^"|"$/g, ''));
    const [start, end, rawId, comment] = cell;
    const id = (rawId ?? '').replace(/\D/g, '');
    out.push({
      // A tune genuinely absent from TheSession is left blank on purpose: it
      // counts as unreachable rather than pointing at the wrong tune.
      ids: id ? new Set([id]) : new Set<string>(),
      label: comment?.trim() || (id ? `tune ${id}` : '(sans id)'),
      start: toSeconds(start ?? ''),
      end: toSeconds(end ?? ''),
    });
  }
  return out;
}

function parseTruth(file: string): TruthEntry[] {
  // The CSV wins wherever it exists - a session converted by the group needs no
  // name matching at all. The .txt path below stays only for the ones not yet
  // converted, and should disappear with them.
  const csv = file.replace(/\.txt$/, '.csv');
  if (fs.existsSync(csv)) return parseTruthCsv(csv);
  if (!fs.existsSync(file)) return [];

  const out: TruthEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean)) {
    // A timestamp may be mm:ss OR h:mm:ss - and "00:04:37 Reel set:" is a set
    // HEADER while "1:00:55 Foxhunter" is a tune an hour into the recording.
    // Keying on the timestamp's shape got that wrong and silently dropped every
    // tune past the first hour; what actually separates them is what FOLLOWS.
    const stamped = line.match(/^\d{1,2}:\d{2}(?::\d{2})?\s+(.*)$/);
    const rest = stamped ? stamped[1]!.trim() : null;
    if (rest !== null && (rest === '' || /\bset\s*:?\s*$/i.test(rest))) continue;

    const emdash = line.match(/^(.+?)\s+\u2014\s+\d+$/);
    const label = (rest !== null ? rest : emdash ? emdash[1]! : line.split('\t')[0]!).trim();
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

/**
 * The post-decode chain, EXACTLY as viterbiSegmenter.ts runs it on a finished
 * analysis. Getting this wrong is not cosmetic: the harness previously stopped
 * after filterShortSegments and reported "Ladies Pantalettes 10:52-11:07, 12%
 * coverage" where the app shows 10:52-12:52, because `mergeNearbySameTune`
 * rejoins a tune that dipped into UNKNOWN mid-performance. Caught by the user
 * comparing a screenshot to the report.
 *
 * The `false` matters too. That argument is `!forceFinalizeAll` in the
 * segmenter: while windows are still streaming in, the last segment is shown
 * unconfirmed so it is not invisible. A completed analysis has no such
 * exemption, and passing `true` here measured a leniency production never
 * applies to a finished recording.
 */
function finalise(segments: DetectedTuneSegment[], timeline: TemporalTimeline, cfg: DetectionTemporalConfig) {
  return mergeNearbySameTune(
    filterShortSegments(segments, timeline, cfg.minSegmentWindows, false),
    timeline,
    cfg.sameTuneMergeGapWindows,
  );
}

/** Same decode, keeping what each detection actually was and where - for
 *  SWEEP_DETAIL, which answers "which tune did it miss, and what did it hear
 *  instead?" rather than just how many. */
function detectSegments(windows: WindowResult[], unknownProb: number) {
  const cfg = { ...CFG, unknownObservationProbability: unknownProb };
  const timeline = buildTemporalTimeline(
    filterByTempoSpread(filterFlatWindows(windows, cfg.flatWindowTopN, cfg.flatWindowMarginThreshold), cfg.tempoSpreadThreshold),
    cfg,
  );
  const r = runViterbiDetection(timeline, cfg);
  return finalise(r.segments, timeline, cfg)
    .filter(s => s.tuneId !== UNKNOWN_STATE)
    .map(s => ({
      tuneId: s.tuneId,
      label: timeline.meta.get(s.tuneId)?.displayName ?? s.tuneId,
      startTime: s.startTime,
      endTime: s.endTime,
      span: `${Math.floor(s.startTime / 60)}:${String(Math.floor(s.startTime % 60)).padStart(2, '0')}`
          + `-${Math.floor(s.endTime / 60)}:${String(Math.floor(s.endTime % 60)).padStart(2, '0')}`,
    }));
}

function detectIds(windows: WindowResult[], unknownProb: number): Set<string> {
  const cfg = { ...CFG, unknownObservationProbability: unknownProb };
  const timeline = buildTemporalTimeline(
    filterByTempoSpread(filterFlatWindows(windows, cfg.flatWindowTopN, cfg.flatWindowMarginThreshold), cfg.tempoSpreadThreshold),
    cfg,
  );
  const r = runViterbiDetection(timeline, cfg);
  return new Set(finalise(r.segments, timeline, cfg).filter(s => s.tuneId !== UNKNOWN_STATE).map(s => s.tuneId));
}

it('sweeps the UNKNOWN floor', () => {
  const data = SESSIONS.map(id => ({ id, windows: load(id), truth: parseTruth(nodePath.join(DIR, `${id}-timings.txt`)) }))
    .filter(d => d.windows);
  const noise = load(NOISE);

  const totalTruth = data.reduce((a, d) => a + d.truth.length, 0);
  const unresolved = data.flatMap(d => d.truth.filter(t => t.ids.size === 0).map(t => `${d.id.slice(0, 18)}: ${t.label}`));
  console.log(`\n${data.length} sessions, ${totalTruth} morceaux de référence`);
  console.log(`\n---- rapprochements approximatifs (${fuzzyLog.length}) - ì AUDITER ----`);
  for (const l of fuzzyLog) console.log('  ' + l);
  console.log(`\n---- jamais résolus (${unresolved.length}), donc jamais trouvables ----`);
  for (const l of unresolved) console.log('  ' + l);

  // SWEEP_DETAIL=<substring of a session name> - every ground-truth tune of one
  // session, found or missed, plus what was heard that nobody annotated.
  const wanted = process.env['SWEEP_DETAIL'];
  if (wanted) {
    const floor = Number(process.env['SWEEP_POINTS'] ?? CFG.unknownObservationProbability);
    for (const d of data.filter(x => x.id.toLowerCase().includes(wanted.toLowerCase()))) {
      const segs = detectSegments(d.windows!, floor);
      const found = new Set(segs.map(s => s.tuneId));
      console.log(`\n---- ${d.id} @ ${floor} ----`);
      for (const g of d.truth) {
        const hit = segs.find(s => g.ids.has(s.tuneId));
        // With a CSV the annotation carries real spans, so a detection can be
        // judged on whether it COVERS the tune, not just on naming it somewhere
        // in the recording - a 15 s sliver of a 3 min set is not a success.
        let cover = '';
        if (hit && g.start !== undefined && g.end !== undefined && g.end > g.start) {
          const overlap = Math.max(0, Math.min(hit.endTime, g.end) - Math.max(hit.startTime, g.start));
          cover = `  couverture ${Math.round((overlap / (g.end - g.start)) * 100)}%`;
        }
        console.log(hit ? `  \u2713 ${g.label}  (${hit.span})${cover}`
          : `  \u2717 ${g.label}${g.ids.size === 0 ? '   [sans id - hors de portée]' : ''}`);
      }
      // Recall alone flatters the result: a tune found as a 15 s sliver of a
      // 3 min set counts the same as one tracked end to end. With real spans
      // that difference is finally visible, so it gets its own line.
      const covers = d.truth
        .map(g => {
          const hit = segs.find(s => g.ids.has(s.tuneId));
          if (!hit || g.start === undefined || g.end === undefined || g.end <= g.start) return null;
          return Math.max(0, Math.min(hit.endTime, g.end) - Math.max(hit.startTime, g.start)) / (g.end - g.start);
        })
        .filter((c): c is number => c !== null);
      if (covers.length) {
        const mean = covers.reduce((a, b) => a + b, 0) / covers.length;
        const slivers = covers.filter(c => c < 0.5).length;
        console.log(`\n  couverture moyenne ${Math.round(mean * 100)}% - ${slivers} détection(s) sous 50%, `
          + `${covers.filter(c => c >= 0.9).length} au-dessus de 90%`);
      }

      const spurious = segs.filter(s => !d.truth.some(g => g.ids.has(s.tuneId)));
      console.log(`  détections hors annotation (${spurious.length}) :`);
      for (const s of spurious) console.log(`    ? ${s.label}  (${s.span})`);
      void found;
    }
    return;
  }

  // The decode loop is 16 thresholds x 7 sessions - minutes. The matching audit
  // above is what has been wrong three times, so it can be checked on its own
  // first: SWEEP_AUDIT_ONLY=1 prints it and stops.
  if (process.env['SWEEP_AUDIT_ONLY']) return;

  console.log('\nplancher | rappel          | faux positifs | bruit');
  console.log('---------|-----------------|---------------|------');
  const detail = new Map<number, string[]>();
  // SWEEP_POINTS=0.20,0.25 restricts the decode to a few thresholds - the full
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

  console.log('\n* = valeur actuelle\n---- détail par session ----');
  for (const p of points) {
    console.log(`\nplancher ${p.toFixed(2)}`);
    for (const line of detail.get(p) ?? []) console.log('  ' + line);
  }
}, 1800000);
