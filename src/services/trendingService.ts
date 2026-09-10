import type { PopularityDb } from '../trending/db';
import type { TrendingGainMode } from '../types';
import { normalizeDisplayName } from '../utils';

// ── Trending table computation ──────────────────────────────────────────────
// Pure local computation over a synced PopularityDb (see trendingSyncService) —
// no network calls here. Port of TheSession_PopularityExplorer's table.ts,
// adapted to read from Cadence's own PopularityDb shape (which already carries
// `names`, unlike the source tool's Database).

// Alias kept so existing GainMode imports don't need to change — the type
// itself lives in types.ts since it's also part of the trending Route shape.
export type GainMode = TrendingGainMode;

export interface TuneRow {
  id: number;
  name: string;
  gain: number;
  startValue: number;
  endValue: number;
  /** The series drawn as the row's sparkline. Deflated when the correction is
   *  on — every point restated in the currency of the tune's anchor, the way
   *  a figure is quoted "in constant euros". A tune merely riding the site's
   *  growth then draws a FLAT line, which is what it deserves; left raw, it
   *  would climb steadily beside a row reading "−12". */
  periodValues: (number | null)[];
  /** What this tune would be worth at the end of the period if it had done
   *  nothing but follow the site's own growth — the yardstick every displayed
   *  figure is measured against.
   *
   *  With the correction off it is simply `startValue`, so "gain" and
   *  "gain over the baseline" are the same number and no branch is needed
   *  anywhere downstream. */
  expectedEnd: number;
}

/** The gain that is the tune's own doing: what it has beyond the baseline. */
export function netGain(row: TuneRow): number {
  return row.endValue - row.expectedEnd;
}

// ── Correcting for the site's growth ─────────────────────────────────────────
// A tune's tunebook count rises partly because the tune is spreading and
// partly because TheSession keeps gaining members who fill tunebooks. The
// second part is common to every tune, and it is large: measured on the real
// history, +8.4% a year, and accelerating (0.10%/week in 2019, 0.16%/week
// now). Without taking it off, the "biggest gains" table is a popularity
// ranking in disguise — The Kesh, Drowsy Maggie and Cooley's top it every
// single week, because the biggest stock captures the biggest share of the
// tide. Deflating replaces 16 of the top 20 (measured over a year).
//
// The baseline is the total tunebook count across tunes, which is the honest
// denominator: it counts the additions actually made, by new members and by
// old ones alike. TheSession publishes no member count — adactio's dump has
// no such file — and this is the better measure anyway.

/** Whether the table is deflated, ON by default — an undeflated ranking is a
 *  popularity chart wearing a trend's clothes, so the useful answer is the
 *  default and the raw one is the opt-out.
 *
 *  Carried in the ROUTE, beside the dates, the mode and the threshold: they
 *  are one set of reading choices and they belong in one place. That also
 *  makes the whole table shareable and restored together (route persistence
 *  survives a restart), which a per-device flag would have quietly broken —
 *  a link would arrive showing different numbers than the sender saw.
 *
 *  Absence means ON, so a refusal is written as an explicit `false` and every
 *  read goes through here. */
export const DEFLATE_BY_DEFAULT = true;

export function deflateFromRoute(value: boolean | undefined): boolean {
  return value ?? DEFLATE_BY_DEFAULT;
}

/** Cumulative growth factor per snapshot, `index[0] = 1`.
 *
 *  CHAINED, not a ratio of totals: each step compares only the tunes present
 *  in BOTH of that pair, so a tune entering the file never counts as growth.
 *  Two reasons. It is how a price index handles a basket whose composition
 *  changes — and, decisively here, it makes the growth between ANY two
 *  snapshots an O(1) division, which is what lets each tune be deflated from
 *  its own starting point below.
 *
 *  The correction is small (8.56% chained vs 8.54% direct over a year), so
 *  this is about what it enables, not about accuracy. */
/** Keyed on the database object itself: the sync replaces it wholesale on
 *  every change, so identity is exactly the right cache key, and a stale entry
 *  is unreachable by construction. Worth caching — the walk is ~12 000 series
 *  over ~370 snapshots, and both the table and its header ask for it. */
const _indexCache = new WeakMap<PopularityDb, number[]>();

export function growthIndex(dbState: PopularityDb): number[] {
  const hit = _indexCache.get(dbState);
  if (hit) return hit;
  const computed = buildGrowthIndex(dbState);
  _indexCache.set(dbState, computed);
  return computed;
}

function buildGrowthIndex(dbState: PopularityDb): number[] {
  const n = dbState.snapshots.length;
  const index = new Array<number>(n).fill(1);
  const series = Object.values(dbState.tunes);
  for (let k = 1; k < n; k++) {
    let before = 0, after = 0;
    for (const values of series) {
      const a = values[k - 1], b = values[k];
      if (a === null || a === undefined || b === null || b === undefined) continue;
      before += a;
      after += b;
    }
    // A snapshot with nothing comparable carries the index forward unchanged
    // rather than collapsing it to zero.
    index[k] = index[k - 1] * (before > 0 ? after / before : 1);
  }
  return index;
}

/** Growth of the site between two snapshots, as a ratio (0.084 = +8.4%). */
export function inflationBetween(index: number[], fromIdx: number, toIdx: number): number {
  const from = index[fromIdx], to = index[toIdx];
  if (!from || !to) return 0;
  return to / from - 1;
}

export function computeRows(dbState: PopularityDb, startIdx: number, endIdx: number, minEnd: number, deflate = false): TuneRow[] {
  if (startIdx >= endIdx) return [];
  const index = deflate ? growthIndex(dbState) : null;

  const rows: TuneRow[] = [];
  for (const [idStr, allValues] of Object.entries(dbState.tunes)) {
    const endValue = allValues[endIdx];
    if (endValue === null || endValue === undefined || endValue < minEnd) continue;

    const startValue = allValues[startIdx] ?? 0;
    const gain = endValue - startValue;
    let periodValues = allValues.slice(startIdx, endIdx + 1);

    // Each tune is deflated from the first snapshot where it is VISIBLE, not
    // from the start of the window. `tune_popularity.json` only lists tunes
    // with at least 10 tunebooks — the file's minimum is exactly 10, and 636
    // tunes sit on that floor — so an absent value means "at most 9, unknown",
    // never "zero". Treating it as zero credited a tune crossing the threshold
    // with the ten tunebooks it already had: "10 → 26" was scored +26 instead
    // of +15. Anchoring on the first sighting costs nothing anywhere else: a
    // tune present from the start anchors on the start, which is the plain
    // formula with no special case.
    let expectedEnd = startValue;
    if (index) {
      let anchor = startIdx;
      while (anchor <= endIdx && (allValues[anchor] === null || allValues[anchor] === undefined)) anchor++;
      const base = anchor <= endIdx ? allValues[anchor]! : 0;
      expectedEnd = base * (1 + inflationBetween(index, anchor, endIdx));
      // The same restatement, point by point, so the drawn line and the figure
      // beside it tell one story.
      const scale = index[anchor] ?? 1;
      periodValues = periodValues.map((v, k) => {
        if (v === null || v === undefined) return null;
        const at = index[startIdx + k];
        return at ? v * (scale / at) : v;
      });
    }

    // dbState.names carries TheSession-data's raw library-catalog names
    // as-is ("Kesh, The") — normalized here at read time, not at write time
    // in trendingSyncService.ts, so an existing user's already-synced cache
    // reads correctly immediately rather than waiting for a future commit to
    // touch that tuneId again.
    const name = dbState.names[idStr] ? normalizeDisplayName(dbState.names[idStr]!) : `#${idStr}`;
    rows.push({ id: Number(idStr), name, gain, startValue, endValue, periodValues, expectedEnd });
  }

  rows.sort((a, b) => netGain(b) - netGain(a));
  return rows;
}

/** Sort key for percentage mode: a tune with no baseline sorts last (its
 *  percentage is undefined, not zero). */
export function percentGainKey(row: TuneRow): number {
  if (row.expectedEnd <= 0) return -Infinity;
  return row.endValue / row.expectedEnd - 1;
}

export function sortRows(rows: TuneRow[], mode: GainMode): TuneRow[] {
  const sorted = [...rows];
  if (mode === 'percent') sorted.sort((a, b) => percentGainKey(b) - percentGainKey(a));
  else sorted.sort((a, b) => netGain(b) - netGain(a));
  return sorted;
}

export function formatGain(row: TuneRow, mode: GainMode): string {
  if (mode === 'percent') {
    if (row.expectedEnd <= 0) return '—';
    const pct = percentGainKey(row) * 100;
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
  }
  // Rounded, not truncated: the baseline is fractional once deflated, and a
  // tune three tenths above its expected value has gained nothing worth a
  // whole unit.
  const net = Math.round(netGain(row));
  return net >= 0 ? `+${net}` : String(net);
}
