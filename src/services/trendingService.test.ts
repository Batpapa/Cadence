import { describe, it, expect } from 'vitest';
import {
  computeRows, sortRows, formatGain, netGain, growthIndex, inflationBetween,
  deflateFromRoute, DEFLATE_BY_DEFAULT,
} from './trendingService';
import type { PopularityDb } from '../trending/db';

// ── Correcting a trend for the site's own growth ─────────────────────────────
// TheSession gains members continuously, so every tune's tunebook count rises
// whether or not the tune is spreading. Measured on the real history: +8.4% a
// year, accelerating. Left in, the "biggest gains" table ranks by popularity —
// the same four tunes every week, because the biggest stock takes the biggest
// share of the tide.
//
// A tune is measured against what it WOULD be worth had it merely followed
// that tide, anchored on the first snapshot where it is visible.

/** `tunes` given as plain arrays, one entry per snapshot, null = absent. */
function db(tunes: Record<string, (number | null)[]>, names: Record<string, string> = {}): PopularityDb {
  const len = Math.max(...Object.values(tunes).map(v => v.length));
  return {
    snapshots: Array.from({ length: len }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
    tunes,
    names,
  };
}

describe('growthIndex', () => {
  it('starts at 1 and compounds the site total', () => {
    // 100 → 110 → 121: +10% then +10%.
    const index = growthIndex(db({ a: [50, 55, 60.5], b: [50, 55, 60.5] }));
    expect(index[0]).toBe(1);
    expect(index[1]).toBeCloseTo(1.1, 10);
    expect(index[2]).toBeCloseTo(1.21, 10);
  });

  it('does NOT count a tune entering the file as growth', () => {
    // The chained, common-basket step: 'b' appears at snapshot 1 with 1000
    // tunebooks. Growth must stay 0% — nothing grew, the file merely widened.
    const index = growthIndex(db({ a: [100, 100], b: [null, 1000] }));
    expect(index[1]).toBeCloseTo(1, 10);
  });

  it('carries forward across a snapshot with nothing comparable', () => {
    const index = growthIndex(db({ a: [100, null, 120] }));
    expect(index.every(v => Number.isFinite(v) && v > 0)).toBe(true);
  });

  it('gives the growth between any two snapshots', () => {
    const index = growthIndex(db({ a: [100, 110, 121] }));
    expect(inflationBetween(index, 0, 2)).toBeCloseTo(0.21, 10);
    expect(inflationBetween(index, 1, 2)).toBeCloseTo(0.10, 10);
    expect(inflationBetween(index, 2, 2)).toBeCloseTo(0, 10);
  });
});

describe('computeRows — sans correction', () => {
  const state = db({ '1': [100, 150], '2': [10, 12] }, { '1': 'Big', '2': 'Small' });

  it('mesure le gain brut', () => {
    const rows = computeRows(state, 0, 1, 0);
    expect(rows.find(r => r.id === 1)!.gain).toBe(50);
    expect(rows.find(r => r.id === 2)!.gain).toBe(2);
  });

  it('prend le depart comme reference, donc le net EST le brut', () => {
    for (const row of computeRows(state, 0, 1, 0)) {
      expect(row.expectedEnd).toBe(row.startValue);
      expect(netGain(row)).toBe(row.gain);
    }
  });
});

describe('computeRows — corrige', () => {
  // The site doubles. A tune that doubles has done nothing; one that triples
  // has genuinely gained.
  const state = db({
    followed: [100, 200],
    tripled:  [100, 300],
    stalled:  [100, 100],
  });

  const row = (name: string) => computeRows(state, 0, 1, 0, true).find(r => r.name === `#${name}`)!;

  it('donne zero au morceau qui suit exactement le courant', () => {
    expect(row('followed').expectedEnd).toBeCloseTo(200, 6);
    expect(netGain(row('followed'))).toBeCloseTo(0, 6);
  });

  it('ne credite que le surplus', () => {
    expect(netGain(row('tripled'))).toBeCloseTo(100, 6);
  });

  it('rend negatif un morceau qui stagne pendant que le site grossit', () => {
    // It lost no tunebooks; it lost SHARE. The sign says exactly that.
    expect(netGain(row('stalled'))).toBeCloseTo(-100, 6);
  });

  it('renverse le classement quand le gros stock ne fait que suivre', () => {
    // The measured effect, in miniature: raw, "huge" wins on volume alone;
    // corrected, the small riser wins. On the real data this replaces 16 of
    // the top 20 over a year.
    const two = db({ huge: [1000, 2000], riser: [10, 30] });
    expect(sortRows(computeRows(two, 0, 1, 0, false), 'absolute')[0]!.name).toBe('#huge');
    expect(sortRows(computeRows(two, 0, 1, 0, true), 'absolute')[0]!.name).toBe('#riser');
  });
});

describe("computeRows — un morceau qui n'etait pas encore visible", () => {
  // tune_popularity.json only lists tunes with at least 10 tunebooks (the
  // file's minimum is exactly 10, with 636 tunes sitting on it), so an absent
  // value means "at most 9, unknown" — never zero. Anchoring on the first
  // sighting is what keeps a threshold-crosser from being credited with the
  // ten tunebooks it already had.
  // A tune's own growth is part of the index that judges it — it is in the
  // basket like everyone else. On the real data (~12 000 tunes) that
  // self-reference is nothing; in a fixture of two it is everything, so the
  // steady tune here carries enough mass to behave like a real corpus. This
  // cost the first version of these tests, which is why it is written down.
  const state = db({ crosser: [null, 10, 26], mass: [10000, 10000, 10000] });

  it("l'ancre sur sa premiere apparition, pas sur le debut de la fenetre", () => {
    const row = computeRows(state, 0, 2, 0, true).find(r => r.name === '#crosser')!;
    // Anchored at 10, not at 0: it keeps the ten tunebooks it already had.
    expect(row.expectedEnd).toBeGreaterThanOrEqual(10);
    expect(row.expectedEnd).toBeLessThan(10.1);
    expect(netGain(row)).toBeCloseTo(16, 1);
  });

  it('sans correction, il compte encore comme parti de zero', () => {
    // Unchanged behaviour when the option is off — this is the raw reading,
    // and the raw reading has always said this.
    const row = computeRows(state, 0, 2, 0).find(r => r.name === '#crosser')!;
    expect(netGain(row)).toBe(26);
  });

  it("un morceau present des le depart s'ancre au depart, sans cas particulier", () => {
    const rows = computeRows(state, 0, 2, 0, true);
    const row = rows.find(r => r.name === '#mass')!;
    const i = inflationBetween(growthIndex(state), 0, 2);
    expect(row.expectedEnd).toBeCloseTo(row.startValue * (1 + i), 6);
  });
});

describe('formatGain', () => {
  const state = db({ a: [100, 300] });   // site: +200%, so the tune merely follows

  it('arrondit le net plutot que de le tronquer', () => {
    const row = computeRows(db({ a: [100, 150], b: [100, 150] }), 0, 1, 0, true)[0]!;
    expect(formatGain(row, 'absolute')).toBe('+0');
  });

  it('signe le pourcentage sur la reference, pas sur le depart', () => {
    const row = computeRows(state, 0, 1, 0, true)[0]!;
    expect(formatGain(row, 'percent')).toBe('+0.0%');
    expect(formatGain(row, 'absolute')).toBe('+0');
  });

  it('rend un tiret quand il n y a aucune reference', () => {
    const row = computeRows(db({ a: [null, 5] }), 0, 1, 0)[0]!;
    expect(formatGain(row, 'percent')).toBe('—');
  });
});

describe('le reglage lui-meme', () => {
  it('est actif quand la route ne dit rien', () => {
    // Absence means ON, which is why a refusal has to travel as an explicit
    // `false` — the trap an optional "means yes" flag always sets.
    expect(DEFLATE_BY_DEFAULT).toBe(true);
    expect(deflateFromRoute(undefined)).toBe(true);
  });

  it('respecte un refus explicite', () => {
    expect(deflateFromRoute(false)).toBe(false);
    expect(deflateFromRoute(true)).toBe(true);
  });
});

describe('la courbe de la ligne', () => {
  // Drawn from the same numbers as the figure beside it, or a row reading
  // "−12" would climb.
  const state = db({ followed: [100, 150, 200], mass: [10000, 15000, 20000] });

  it('reste plate pour un morceau qui ne fait que suivre le courant', () => {
    const row = computeRows(state, 0, 2, 0, true).find(r => r.name === '#followed')!;
    const drawn = row.periodValues as number[];
    for (const v of drawn) expect(v).toBeCloseTo(drawn[0]!, 6);
  });

  it('reste brute quand la correction est coupee', () => {
    const row = computeRows(state, 0, 2, 0).find(r => r.name === '#followed')!;
    expect(row.periodValues).toEqual([100, 150, 200]);
  });

  it('monte pour un morceau qui bat le courant', () => {
    const beating = db({ riser: [100, 200, 400], mass: [10000, 15000, 20000] });
    const row = computeRows(beating, 0, 2, 0, true).find(r => r.name === '#riser')!;
    const drawn = row.periodValues as number[];
    expect(drawn[2]!).toBeGreaterThan(drawn[0]!);
  });

  it('garde les trous du releve', () => {
    const holed = db({ a: [10, null, 30], mass: [10000, 10000, 10000] });
    const row = computeRows(holed, 0, 2, 0, true).find(r => r.name === '#a')!;
    expect(row.periodValues[1]).toBeNull();
    expect(row.periodValues).toHaveLength(3);
  });
});
