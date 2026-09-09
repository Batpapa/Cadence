import { it } from 'vitest';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { buildTemporalTimeline, filterFlatWindows, filterByTempoSpread, UNKNOWN_STATE, type TemporalTimeline } from '../../src/session/recognition/temporalObservationBuilder';
import { runViterbiDetection, filterShortSegments, mergeNearbySameTune, type DetectedTuneSegment } from '../../src/session/recognition/viterbiDetector';
import { DETECTION_TEMPORAL_CONFIG as CFG, type DetectionTemporalConfig } from '../../src/session/recognition/detectionTemporalConfig';
import type { WindowResult } from '../../src/session/model';

const DIR = nodePath.resolve(__dirname, '../../test-fixtures/sessions');

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

// ---- Ground truth ----------------------------------------------------------------------------------------------
// CSV only since 2026-09-09. Every session now carries a `-timings.csv` whose
// third column is a TheSession id, so nothing here reads a hand-written setlist
// any more — and with it went ~130 lines that existed solely to turn a typed
// title back into an id: the index's alias table, title normalisation (articles,
// roman numerals, dance words), a bounded Levenshtein pass and the audit log its
// fuzzy matches required. That machinery was a source of measurement error in
// its own right, which is why the CSVs were asked for.
//
// The last setlist standing was Audio F's, and it turned out to describe a
// DIFFERENT recording than the audio filed under that name: 8% of its ids appear
// in the session's own CSV, 1-3% in any other. It had been ground truth for 129
// of the 328 rows this sweep scored — about 40% of the corpus — which is why the
// 2026-09-06 figures that moved unknownObservationProbability to 0.20 cannot be
// trusted and this has to be re-run. The .txt files are gone.

/** What a ground-truth row is worth to the score.
 *   'tune'     - a real tune with an id. The only kind that counts, both as a
 *                target to find and as a name a detection may match.
 *   'unknown'  - id 0: the annotator did not recognise it. The tune is probably
 *                IN the index; we simply cannot tell which. Scored NEITHER way -
 *                counting a detection here as a false positive would penalise
 *                the detector for knowing more than the annotator.
 *   'offindex' - id -1: recognised, but genuinely absent from TheSession. The
 *                detector's whole vocabulary is TheSession ids, so nothing it
 *                says here can be right: any detection IS a false positive.
 *                This is the only false-positive ground truth we have inside
 *                real music - the noise fixture yields zero detections at every
 *                threshold, so it constrains nothing. */
type TruthKind = 'tune' | 'unknown' | 'offindex';

interface TruthEntry { label: string; ids: Set<string>; kind: TruthKind; start?: number; end?: number }

/** True when a detection and an annotated span share any time at all. */
function overlaps(seg: { startTime: number; endTime: number }, g: TruthEntry): boolean {
  if (g.start === undefined || g.end === undefined) return false;
  return seg.startTime < g.end && seg.endTime > g.start;
}

type Seg = { tuneId: string; label: string; span: string; startTime: number; endTime: number };

/** The detection that answers THIS row, or null.
 *
 *  Not `segs.find(s => g.ids.has(s.tuneId))`: a tune can legitimately be played
 *  twice in one session - Audio E annotates 1035 at 05:16 AND at 57:55, and the
 *  old .txt confirms it (X:11 then X:2, two settings of The Boys Of The Town).
 *  Taking the first segment carrying the right id credited the SECOND occurrence
 *  with the FIRST detection: a "hit" reported at 0% coverage, and a recall count
 *  inflated by every repeat in the corpus.
 *
 *  Rows with no span (the .txt path) keep the old id-only behaviour - there is
 *  nothing to match against there. */
function matchFor(g: TruthEntry, segs: Seg[]): Seg | null {
  const same = segs.filter(s => g.ids.has(s.tuneId));
  if (!same.length) return null;
  if (g.start === undefined || g.end === undefined) return same[0]!;

  let best: Seg | null = null;
  let bestOverlap = 0;
  for (const s of same) {
    const ov = Math.min(s.endTime, g.end) - Math.max(s.startTime, g.start);
    if (ov > bestOverlap) { bestOverlap = ov; best = s; }
  }
  return best;
}

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
    const [start, end, rawId, comment] = splitCsvLine(line, delim);
    const raw = (rawId ?? '').trim();

    // NEVER strip non-digits here. `raw.replace(/\D/g, '')` turned "-1" into
    // "1" - a real tune on TheSession - and left "0" looking like an id of its
    // own. Both sentinels were silently scored as ordinary tunes.
    const kind: TruthKind = raw === '0' ? 'unknown' : raw === '-1' ? 'offindex' : 'tune';
    const id = /^[1-9]\d*$/.test(raw) ? raw : '';

    out.push({
      kind,
      ids: id ? new Set([id]) : new Set<string>(),
      // The comment ADDS to the identity, it never replaces it: a row labelled
      // only "Played in A, but settings on TheSession are in G" no longer says
      // which tune was missed, which is the one thing the line exists to say.
      label: [
        kind === 'unknown' ? '(non reconnu par annotateur)'
          : kind === 'offindex' ? '(hors TheSession)'
            : id ? `tune ${id}` : '(sans id)',
        comment?.trim(),
      ].filter(Boolean).join(' - '),
      start: toSeconds(start ?? ''),
      end: toSeconds(end ?? ''),
    });
  }
  return out;
}

/** Splits one CSV line, honouring double-quoted fields. Not a general CSV
 *  parser - no embedded newlines - but the quotes matter: the group writes
 *  commas inside comments ("Played in A, but settings on TheSession are in G"),
 *  and a plain split(delim) does not just truncate that comment, it shifts
 *  every column after it. */
function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch !== '"') cur += ch;
      else if (line[i + 1] === '"') { cur += '"'; i++; }   // "" is a literal quote
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(c => c.trim());
}

function parseTruth(csv: string): TruthEntry[] {
  if (!fs.existsSync(csv)) throw new Error(`pas de verite terrain : ${csv}`);
  return parseTruthCsv(csv);
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
  const data = SESSIONS.map(id => ({ id, windows: load(id), truth: parseTruth(nodePath.join(DIR, `${id}-timings.csv`)) }))
    .filter(d => d.windows);
  const noise = load(NOISE);

  // Only 'tune' rows are scoreable. The two sentinel kinds are reported on
  // their own below rather than diluting the denominator.
  const scorable = (d: { truth: TruthEntry[] }) => d.truth.filter(g => g.kind === 'tune');
  const totalTruth = data.reduce((a, d) => a + scorable(d).length, 0);
  const unresolved = data.flatMap(d => scorable(d).filter(t => t.ids.size === 0).map(t => `${d.id.slice(0, 18)}: ${t.label}`));
  const unknownRows = data.flatMap(d => d.truth.filter(t => t.kind === 'unknown').map(t => `${d.id.slice(0, 18)}: ${t.label}`));
  const offIndexRows = data.flatMap(d => d.truth.filter(t => t.kind === 'offindex').map(t => `${d.id.slice(0, 18)}: ${t.label}`));
  console.log(`\n${data.length} sessions, ${totalTruth} morceaux de référence`);
  console.log(`  + ${unknownRows.length} non reconnus par annotateur (hors score), `
    + `${offIndexRows.length} hors TheSession (toute détection = faux positif)`);
  for (const l of offIndexRows) console.log(`    [hors index] ${l}`);
  for (const l of unknownRows) console.log(`    [non reconnu] ${l}`);
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
        if (g.kind !== 'tune') {
          // Neither found nor missed - these rows are not scored. What matters
          // is what was heard there: on an 'offindex' span anything heard is a
          // confirmed false positive, and on an 'unknown' one it is a candidate
          // name for a tune the annotator could not place.
          const heard = segs.filter(s => overlaps(s, g)).map(s => `${s.label} (${s.span})`);
          const tag = g.kind === 'offindex' ? '[hors index]' : '[non reconnu]';
          console.log(`  . ${tag} ${g.label}`
            + (heard.length ? `  -> entendu : ${heard.join(', ')}` : '  -> rien entendu'));
          continue;
        }
        const hit = matchFor(g, segs);
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
          const hit = matchFor(g, segs);
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

      // Anything heard that no scoreable row claims. Tagged rather than
      // filtered: one sitting on an 'unknown' span is excused by the score, and
      // seeing WHICH ones were excused is how we find out whether the excuse is
      // doing real work or quietly hiding false positives.
      const spurious = segs
        .filter(s => !d.truth.some(g => g.kind === 'tune' && g.ids.has(s.tuneId)))
        .map(s => ({
          ...s,
          note: d.truth.some(g => g.kind === 'unknown' && overlaps(s, g)) ? '  [excusé - span non reconnu]'
            : d.truth.some(g => g.kind === 'offindex' && overlaps(s, g)) ? '  [FAUX POSITIF confirmé - hors index]'
              : '',
        }));
      console.log(`  détections hors annotation (${spurious.length}) :`);
      for (const s of spurious) console.log(`    ? ${s.label}  (${s.span})${s.note}`);
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
      // Segments, not just ids: excusing a detection needs to know WHERE it sat.
      const segs = detectSegments(d.windows!, p);
      const found = new Set(segs.map(s => s.tuneId));
      const tunes = scorable(d);
      // matchFor, not an id lookup: a tune annotated twice was otherwise
      // counted found twice on the strength of a single detection.
      const t = tunes.filter(g => matchFor(g, segs) !== null).length;
      // A detection overlapping a span the annotator could not name is not
      // scoreable either way - see TruthKind. Detections on an 'offindex' span
      // are deliberately NOT excused: those are the real false positives.
      const excused = new Set(segs
        .filter(s => d.truth.some(g => g.kind === 'unknown' && overlaps(s, g)))
        .map(s => s.tuneId));
      const f = [...found].filter(id => !tunes.some(g => g.ids.has(id)) && !excused.has(id)).length;
      tp += t; fp += f;
      rows.push(`${d.id.slice(0, 30).padEnd(30)} ${String(t).padStart(3)}/${String(tunes.length).padEnd(3)} vrais, ${f} faux`);
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
