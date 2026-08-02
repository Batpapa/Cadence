import type { PopularityDb } from '../trending/db';

// ── Trending table computation ──────────────────────────────────────────────
// Pure local computation over a synced PopularityDb (see trendingSyncService) —
// no network calls here. Port of TheSession_PopularityExplorer's table.ts,
// adapted to read from Cadence's own PopularityDb shape (which already carries
// `names`, unlike the source tool's Database).

export type GainMode = 'absolute' | 'percent';

export interface TuneRow {
  id: number;
  name: string;
  gain: number;
  startValue: number;
  endValue: number;
  periodValues: (number | null)[];
}

export function computeRows(dbState: PopularityDb, startIdx: number, endIdx: number, minEnd: number): TuneRow[] {
  if (startIdx >= endIdx) return [];

  const rows: TuneRow[] = [];
  for (const [idStr, allValues] of Object.entries(dbState.tunes)) {
    const endValue = allValues[endIdx];
    if (endValue === null || endValue === undefined || endValue < minEnd) continue;

    const startValue = allValues[startIdx] ?? 0;
    const gain = endValue - startValue;
    const periodValues = allValues.slice(startIdx, endIdx + 1);

    rows.push({ id: Number(idStr), name: dbState.names[idStr] ?? `#${idStr}`, gain, startValue, endValue, periodValues });
  }

  rows.sort((a, b) => b.gain - a.gain);
  return rows;
}

/** Sort key for percentage mode: tunes with startValue<=0 sort last (undefined %). */
export function percentGainKey(row: TuneRow): number {
  if (row.startValue <= 0) return -Infinity;
  return row.gain / row.startValue;
}

export function sortRows(rows: TuneRow[], mode: GainMode): TuneRow[] {
  const sorted = [...rows];
  if (mode === 'percent') sorted.sort((a, b) => percentGainKey(b) - percentGainKey(a));
  else sorted.sort((a, b) => b.gain - a.gain);
  return sorted;
}

export function formatGain(row: TuneRow, mode: GainMode): string {
  if (mode === 'percent') {
    if (row.startValue <= 0) return '—';
    const pct = (row.gain / row.startValue) * 100;
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
  }
  return row.gain >= 0 ? `+${row.gain}` : String(row.gain);
}
