import * as fs from 'node:fs';
import * as nodePath from 'node:path';

// ── Ground truth, CSV only ────────────────────────────────────────────────────
// Deliberately NOT the threshold-sweep's parser. That one still carries the
// name-matching machinery (aliases, roman numerals, Damerau-Levenshtein) for
// the one session not yet converted, `20240721_tocane_2_chapiteau`. This study
// excludes that session, so every session it reads has a CSV and identifiers
// need no matching at all.
//
// The duplication is deliberate and worth stating: the two harnesses agreeing
// on the same baseline is stronger evidence than one shared implementation
// being self-consistent. The study's first test asserts exactly that.

export type TruthKind = 'tune' | 'unknown' | 'offindex';

export interface TruthEntry {
  label: string;
  ids: Set<string>;
  kind: TruthKind;
  start: number;
  end: number;
}

export interface Seg {
  tuneId: string;
  startTime: number;
  endTime: number;
}

/** "1:02:17" -> seconds. Tolerates repeated colons and MM:SS. */
function toSeconds(v: string): number {
  const parts = v.trim().split(/:+/).filter(Boolean).map(Number);
  if (!parts.length || parts.some(Number.isNaN)) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** Splits one CSV line honouring double-quoted fields — the annotators write
 *  commas inside comments, and a plain split shifts every later column. */
function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch !== '"') cur += ch;
      else if (line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(c => c.trim());
}

export function parseTruthCsv(file: string): TruthEntry[] {
  const lines = fs.readFileSync(file, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
  const header = lines[0] ?? '';
  const delim = [',', ';', '\t', '|']
    .map(d => ({ d, n: header.split(d).length }))
    .sort((a, b) => b.n - a.n)[0]!.d;

  const out: TruthEntry[] = [];
  for (const line of lines.slice(1)) {
    const [start, end, rawId, comment] = splitCsvLine(line, delim);
    const raw = (rawId ?? '').trim();

    // Never strip non-digits: that turned "-1" into "1", a real tune.
    const kind: TruthKind = raw === '0' ? 'unknown' : raw === '-1' ? 'offindex' : 'tune';
    const id = /^[1-9]\d*$/.test(raw) ? raw : '';

    out.push({
      kind,
      ids: id ? new Set([id]) : new Set<string>(),
      label: [
        kind === 'unknown' ? '(non reconnu)' : kind === 'offindex' ? '(hors TheSession)' : id ? `tune ${id}` : '(sans id)',
        comment?.trim(),
      ].filter(Boolean).join(' - '),
      start: toSeconds(start ?? ''),
      end: toSeconds(end ?? ''),
    });
  }
  return out;
}

export function loadTruth(dir: string, session: string): TruthEntry[] {
  const csv = nodePath.join(dir, `${session}-timings.csv`);
  if (!fs.existsSync(csv)) throw new Error(`no CSV ground truth for ${session}`);
  return parseTruthCsv(csv);
}

export function overlaps(seg: Seg, g: TruthEntry): boolean {
  return seg.startTime < g.end && seg.endTime > g.start;
}

/** The detection answering THIS row, or null — chosen by maximum temporal
 *  overlap, never by "first segment carrying the right id". A tune can be
 *  played twice in one session (Audio E annotates 1035 at 05:16 and 57:55) and
 *  the naive lookup credited the second occurrence with the first detection. */
export function matchFor<T extends Seg>(g: TruthEntry, segs: T[]): T | null {
  let best: T | null = null;
  let bestOverlap = 0;
  for (const s of segs) {
    if (!g.ids.has(s.tuneId)) continue;
    const ov = Math.min(s.endTime, g.end) - Math.max(s.startTime, g.start);
    if (ov > bestOverlap) { bestOverlap = ov; best = s; }
  }
  return best;
}

export interface Score {
  /** Ground-truth rows that count: kind 'tune'. */
  total: number;
  found: number;
  /** Detected ids claimed by no scoreable row and not excused by an 'unknown'
   *  span. Counted per distinct id, matching the threshold-sweep's convention. */
  falsePositives: number;
  /** Detections landing on an 'offindex' span: guaranteed-wrong by
   *  construction, the only false-positive ground truth inside real music. */
  onOffIndex: number;
  /** Segments answering no annotated row AT THE PLACE THEY SIT.
   *
   *  `falsePositives` above counts distinct ids and is the threshold-sweep's
   *  convention, kept so the two harnesses stay comparable — but it has a blind
   *  spot: a detection carrying a correct id at a completely wrong moment is
   *  neither a hit (matchFor needs overlap) nor a false positive (the id IS
   *  claimed somewhere), so it vanishes from both columns. This counts it. */
  misplaced: number;
  /** Mean fraction of each found row's annotated span actually covered. */
  meanCoverage: number;
  /** Found rows whose detection covers under half the annotated span. */
  slivers: number;
}

export function scoreSession(truth: TruthEntry[], segs: Seg[]): Score {
  const tunes = truth.filter(g => g.kind === 'tune');

  let found = 0;
  const coverages: number[] = [];
  for (const g of tunes) {
    const hit = matchFor(g, segs);
    if (!hit) continue;
    found++;
    if (g.end > g.start) {
      const ov = Math.max(0, Math.min(hit.endTime, g.end) - Math.max(hit.startTime, g.start));
      coverages.push(ov / (g.end - g.start));
    }
  }

  // A detection sitting on a span the annotator could not name is unscoreable:
  // the tune is probably in the index and the detection may well be right.
  const excused = new Set(segs
    .filter(s => truth.some(g => g.kind === 'unknown' && overlaps(s, g)))
    .map(s => s.tuneId));
  const foundIds = new Set(segs.map(s => s.tuneId));
  const falsePositives = [...foundIds]
    .filter(id => !tunes.some(g => g.ids.has(id)) && !excused.has(id)).length;

  const onOffIndex = segs.filter(s => truth.some(g => g.kind === 'offindex' && overlaps(s, g))).length;

  const misplaced = segs.filter(s =>
    !tunes.some(g => g.ids.has(s.tuneId) && overlaps(s, g))
    && !truth.some(g => g.kind === 'unknown' && overlaps(s, g))).length;

  return {
    total: tunes.length,
    found,
    falsePositives,
    onOffIndex,
    misplaced,
    meanCoverage: coverages.length ? coverages.reduce((a, b) => a + b, 0) / coverages.length : 0,
    slivers: coverages.filter(c => c < 0.5).length,
  };
}
