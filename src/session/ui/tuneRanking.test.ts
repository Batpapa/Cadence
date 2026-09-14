import { describe, it, expect } from 'vitest';
import { rankDetectedTunes, occurrencesOf, sortTuneRows, TUNE_SORT_DEFAULT_ASC, filterByFacets, passesChips, type PassFacet } from './tuneRanking';
import type { FilterState } from '../../types';
import type { Analysis, Detection } from '../model';

function det(o: Partial<Detection> & { tuneId: string }): Detection {
  const start = o.start ?? 0;
  const pick = { tuneId: o.tuneId, settingId: '1', displayName: `tune ${o.tuneId}`, dance: 'reel', meter: '4/4', meanScore: 0.8 };
  // Assigned rather than spread, so no key is written twice — and fully built
  // rather than cast, so a new required field on Detection breaks this file
  // instead of silently making the fixtures a lie.
  const base: Detection = {
    id: `d-${o.tuneId}-${start}`,
    ...pick,
    start,
    end: start + 30,
    confidence: 0.8,
    bucket: 'high',
    evidence: [],
    alternates: [],
    viterbiPick: pick,
    finalized: true,
    userConfirmed: false,
    liked: false,
  };
  return Object.assign(base, o);
}

function session(id: string, date: string | null, dets: Detection[]): Analysis {
  return {
    id, name: `séance ${id}`, date, duration: 3600,
    mimeType: 'audio/wav', source: 'import', annotations: dets,
  };
}

describe('rankDetectedTunes', () => {
  it('groups by tune id, not by name', () => {
    // The same reel spelled two ways is one tune. Only the id says so.
    const rows = rankDetectedTunes([
      session('s1', '2026-01-01T20:00:00Z', [
        det({ tuneId: '1', displayName: "cooley's" }),
        det({ tuneId: '1', displayName: 'cooleys reel', start: 300 }),
      ]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(2);
  });

  it('counts every pass, because that is how often it was heard', () => {
    const rows = rankDetectedTunes([
      session('s1', '2026-01-01T20:00:00Z', [
        det({ tuneId: '1' }), det({ tuneId: '1', start: 300 }), det({ tuneId: '1', start: 600 }),
      ]),
    ]);
    expect(rows[0]!.count).toBe(3);
    expect(rows[0]!.sessions).toBe(1);
  });

  it('separates "played a lot one night" from "played every night"', () => {
    // Both tunes are heard three times; only one of them is in the repertoire.
    const rows = rankDetectedTunes([
      session('s1', '2026-01-01T20:00:00Z', [
        det({ tuneId: 'drilled' }), det({ tuneId: 'drilled', start: 60 }), det({ tuneId: 'drilled', start: 120 }),
        det({ tuneId: 'regular', start: 180 }),
      ]),
      session('s2', '2026-02-01T20:00:00Z', [det({ tuneId: 'regular' })]),
      session('s3', '2026-03-01T20:00:00Z', [det({ tuneId: 'regular' })]),
    ]);
    const drilled = rows.find(r => r.tuneId === 'drilled')!;
    const regular = rows.find(r => r.tuneId === 'regular')!;
    expect(drilled.count).toBe(regular.count);
    expect(drilled.sessions).toBe(1);
    expect(regular.sessions).toBe(3);
    // Same count, so the spread decides — and it puts the regular one first.
    expect(rows[0]!.tuneId).toBe('regular');
  });

  it('sorts by count first, and is total so it never reshuffles', () => {
    const rows = rankDetectedTunes([
      session('s1', '2026-01-01T20:00:00Z', [
        det({ tuneId: 'a', displayName: 'aaa' }),
        det({ tuneId: 'b', displayName: 'bbb' }), det({ tuneId: 'b', displayName: 'bbb', start: 60 }),
        det({ tuneId: 'c', displayName: 'ccc' }),
      ]),
    ]);
    expect(rows.map(r => r.tuneId)).toEqual(['b', 'a', 'c']);   // 2, then 1/1 by name
  });

  it('one heart is enough, anywhere', () => {
    const rows = rankDetectedTunes([
      session('s1', '2026-01-01T20:00:00Z', [det({ tuneId: '1' })]),
      session('s2', '2026-02-01T20:00:00Z', [det({ tuneId: '1', liked: true })]),
      session('s3', '2026-03-01T20:00:00Z', [det({ tuneId: '1' })]),
    ]);
    expect(rows[0]!.liked).toBe(true);
  });

  it('keeps the newest name, so a correction wins over what it replaced', () => {
    const rows = rankDetectedTunes([
      session('old', '2026-01-01T20:00:00Z', [det({ tuneId: '1', displayName: 'wrong name' })]),
      session('new', '2026-06-01T20:00:00Z', [det({ tuneId: '1', displayName: 'corrected name' })]),
    ]);
    expect(rows[0]!.displayName).toBe('corrected name');
  });

  it('survives undated sessions without letting them claim the newest name', () => {
    const rows = rankDetectedTunes([
      session('dated', '2026-01-01T20:00:00Z', [det({ tuneId: '1', displayName: 'dated name' })]),
      session('undated', null, [det({ tuneId: '1', displayName: 'undated name' })]),
    ]);
    expect(rows[0]!.displayName).toBe('dated name');
    expect(rows[0]!.lastHeard).toBe(Date.parse('2026-01-01T20:00:00Z'));
  });

  it('dates a tune by when it was PLAYED, not by when the evening began', () => {
    const rows = rankDetectedTunes([
      session('s1', '2026-01-01T20:00:00Z', [det({ tuneId: '1', start: 1800 })]),
    ]);
    expect(rows[0]!.lastHeard).toBe(Date.parse('2026-01-01T20:30:00Z'));
  });

  it('tells two passes in one evening apart, which a session date cannot', () => {
    const rows = rankDetectedTunes([
      session('s1', '2026-01-01T20:00:00Z', [
        det({ tuneId: '1', displayName: 'early', start: 60 }),
        det({ tuneId: '1', displayName: 'late', start: 3000 }),
      ]),
    ]);
    expect(rows[0]!.lastHeard).toBe(Date.parse('2026-01-01T20:50:00Z'));
    // ...and the newest name is the later pass's, not whichever came last in
    // the array.
    expect(rows[0]!.displayName).toBe('late');
  });

  it('orders two overlapping evenings by the real instant, not by their starts', () => {
    // The evening that began EARLIER holds the more recent pass. Comparing the
    // two session dates would answer the other way round.
    const rows = rankDetectedTunes([
      session('long', '2026-01-01T20:00:00Z', [det({ tuneId: '1', start: 3600 * 3 + 1800 })]), // 23:30
      session('late', '2026-01-01T23:00:00Z', [det({ tuneId: '2', start: 300 })]),             // 23:05
    ]);
    const byId = new Map(rows.map(r => [r.tuneId, r.lastHeard]));
    expect(byId.get('1')).toBe(Date.parse('2026-01-01T23:30:00Z'));
    expect(byId.get('2')).toBe(Date.parse('2026-01-01T23:05:00Z'));
    expect(byId.get('1')! > byId.get('2')!).toBe(true);
  });

  it('reports no date rather than a wrong one when nothing is dated', () => {
    const rows = rankDetectedTunes([session('s1', null, [det({ tuneId: '1' })])]);
    expect(rows[0]!.lastHeard).toBeNull();
  });

  it('ignores a detection with no tune id, and an empty library', () => {
    expect(rankDetectedTunes([])).toEqual([]);
    const rows = rankDetectedTunes([session('s1', null, [det({ tuneId: '' })])]);
    expect(rows).toEqual([]);
  });
});

describe('sortTuneRows', () => {
  const mk = (tuneId: string, name: string, count: number, sessionsN: number, lastHeard: number | null) =>
    ({ row: { tuneId, displayName: name, count, sessions: sessionsN, liked: false, lastHeard }, name });

  // Three tunes that disagree on every criterion, so each mode has to pick a
  // different winner or it is not sorting by what it claims.
  const rows = [
    mk('a', 'Banish Misfortune', 2, 2, 300),
    mk('b', 'Apples in Winter', 9, 1, 100),
    mk('c', 'Cooley\'s', 5, 5, 900),
  ];

  // `asc: false` is each criterion's natural order — the card library's
  // convention, where sortAsc only ever means "reversed" (see sortTuneRows).
  it('sorts names A→Z by default', () => {
    expect(sortTuneRows(rows, 'alpha', false).map(r => r.name)).toEqual(
      ['Apples in Winter', 'Banish Misfortune', "Cooley's"]);
  });

  it('reverses names on demand', () => {
    expect(sortTuneRows(rows, 'alpha', true).map(r => r.name)).toEqual(
      ["Cooley's", 'Banish Misfortune', 'Apples in Winter']);
  });

  it('puts the most heard first when asked for counts', () => {
    expect(sortTuneRows(rows, 'count', false).map(r => r.row.count)).toEqual([9, 5, 2]);
  });

  it('puts the most recent first when asked for dates', () => {
    expect(sortTuneRows(rows, 'lastHeard', false).map(r => r.row.lastHeard)).toEqual([900, 300, 100]);
  });

  it('reverses on demand, in every mode', () => {
    for (const mode of ['alpha', 'count', 'lastHeard'] as const) {
      const natural = sortTuneRows(rows, mode, false).map(r => r.row.tuneId);
      const reversed = sortTuneRows(rows, mode, true).map(r => r.row.tuneId);
      expect(reversed).toEqual([...natural].reverse());
    }
  });

  it('sorts a tune nobody has dated as the oldest, never the newest', () => {
    const withUndated = [...rows, mk('d', 'Undated', 1, 1, null)];
    expect(sortTuneRows(withUndated, 'lastHeard', false).at(-1)!.row.tuneId).toBe('d');
    expect(sortTuneRows(withUndated, 'lastHeard', true).at(0)!.row.tuneId).toBe('d');
  });

  it('never leaves two rows interchangeable', () => {
    // Same name and same count: without a tiebreak the order would depend on
    // the input order, and the list would reshuffle under the reader.
    const tied = [mk('x', 'Same', 3, 1, 10), mk('y', 'Same', 3, 2, 20)];
    const once = sortTuneRows(tied, 'alpha', false).map(r => r.row.tuneId);
    const twice = sortTuneRows([...tied].reverse(), 'alpha', false).map(r => r.row.tuneId);
    expect(once).toEqual(twice);
  });

  it('leaves its input alone', () => {
    const before = rows.map(r => r.row.tuneId);
    sortTuneRows(rows, 'count', false);
    expect(rows.map(r => r.row.tuneId)).toEqual(before);
  });

  it('starts every criterion unreversed, like the card library', () => {
    expect(TUNE_SORT_DEFAULT_ASC).toBe(false);
  });
});

describe('occurrencesOf', () => {
  const sessions = [
    session('old', '2026-01-01T20:00:00Z', [det({ tuneId: '1', start: 100 })]),
    session('new', '2026-06-01T20:00:00Z', [det({ tuneId: '1', start: 50 }), det({ tuneId: '2', start: 80 })]),
    session('undated', null, [det({ tuneId: '1', start: 10 })]),
  ];

  it('returns one entry per detection, newest session first', () => {
    const occ = occurrencesOf(sessions, '1');
    expect(occ.map(o => o.session.id)).toEqual(['new', 'old', 'undated']);
  });

  it('carries what it takes to land on the detection', () => {
    const [first] = occurrencesOf(sessions, '1');
    expect(first!.session.id).toBe('new');
    expect(first!.session.name).toBe('séance new');
    expect(first!.detection.start).toBe(50);
  });

  it('puts an undated session last, not first', () => {
    // An unknown date is not a very old one — the same call "Detected in" makes.
    const occ = occurrencesOf(sessions, '1');
    expect(occ.at(-1)!.session.id).toBe('undated');
  });

  it('says nothing for a tune nobody played', () => {
    expect(occurrencesOf(sessions, 'absent')).toEqual([]);
  });
});

describe('passesChips', () => {
  const chips = (...e: [string, FilterState][]) => new Map(e);

  it('lets everything through when nothing is pinned', () => {
    expect(passesChips(['reel'], chips())).toBe(true);
    expect(passesChips([], chips())).toBe(true);
  });

  // Two included chips can only mean "either" for a pass.
  it('reads several included chips as any of them', () => {
    const c = chips(['reel', 'include'], ['jig', 'include']);
    expect(passesChips(['reel'], c)).toBe(true);
    expect(passesChips(['jig'], c)).toBe(true);
    expect(passesChips(['polka'], c)).toBe(false);
  });

  it('removes what an excluded chip names, and only that', () => {
    const c = chips(['reel', 'exclude']);
    expect(passesChips(['reel'], c)).toBe(false);
    expect(passesChips(['jig'], c)).toBe(true);
  });

  // A key nobody knows (no recognition index on this device) is neither what
  // was asked for nor what was ruled out.
  it('fails an inclusion but survives an exclusion when the value is unknown', () => {
    expect(passesChips([], chips(['Dmajor', 'include']))).toBe(false);
    expect(passesChips([], chips(['Dmajor', 'exclude']))).toBe(true);
  });

  // A pass in an analysis inside a folder answers to both.
  it('lets a pass in through any of its values, and out through any of them', () => {
    const inFolder = ['s1', 'folder:winter'];
    expect(passesChips(inFolder, chips(['folder:winter', 'include']))).toBe(true);
    expect(passesChips(inFolder, chips(['folder:winter', 'include'], ['s1', 'exclude']))).toBe(false);
    expect(passesChips(['s2', 'folder:winter'], chips(['folder:winter', 'include'], ['s1', 'exclude']))).toBe(true);
    expect(passesChips(inFolder, chips(['s1', 'include'], ['folder:winter', 'exclude']))).toBe(false);
  });
});

describe('filterByFacets', () => {
  // In these fixtures the setting id stands in for the key, since the real key
  // comes from the recognition index.
  const keys = (or: boolean, ...e: [string, FilterState][]): PassFacet => ({ chips: new Map(e), or, valuesOf: d => [d.settingId] });
  const types = (or: boolean, ...e: [string, FilterState][]): PassFacet => ({ chips: new Map(e), or, valuesOf: d => [d.dance] });
  const analyses = (or: boolean, ...e: [string, FilterState][]): PassFacet => ({ chips: new Map(e), or, valuesOf: (_d, s) => [s.id] });
  /** The analyses section as the panel builds it: s1 and s2 filed in winter,
   *  s3 in summer, s4 nowhere. */
  const FOLDERS: Record<string, string[]> = { s1: ['folder:winter'], s2: ['folder:winter'], s3: ['folder:summer'] };
  const filed = (or: boolean, ...e: [string, FilterState][]): PassFacet =>
    ({ chips: new Map(e), or, valuesOf: (_d, s) => [s.id, ...(FOLDERS[s.id] ?? [])] });

  // The user's rule: a key belongs to a pass, so filtering on it has to change
  // the count, not merely hide or show the tune.
  it('recounts a tune from the passes that are left', () => {
    const sessions = [
      session('s1', '2026-01-01T20:00:00Z', [
        det({ tuneId: '1', start: 10, settingId: 'inD' }),
        det({ tuneId: '1', start: 200, settingId: 'inG' }),
      ]),
      session('s2', '2026-01-02T20:00:00Z', [det({ tuneId: '1', start: 10, settingId: 'inD' })]),
    ];
    const [row] = rankDetectedTunes(filterByFacets(sessions, [keys(true, ['inD', 'include'])]));
    expect(row!.count).toBe(2);
    expect(row!.sessions).toBe(2);
    expect(rankDetectedTunes(filterByFacets(sessions, [keys(true, ['inG', 'include'])]))[0]!.sessions).toBe(1);
  });

  // Same rule for the analyses: pinning one evening counts that evening only.
  it('recounts from the analyses pinned, not from every analysis the tune is in', () => {
    const sessions = [
      session('s1', null, [det({ tuneId: '1', start: 10 }), det({ tuneId: '1', start: 200 })]),
      session('s2', null, [det({ tuneId: '1', start: 10 })]),
    ];
    const [row] = rankDetectedTunes(filterByFacets(sessions, [analyses(true, ['s2', 'include'])]));
    expect(row!.count).toBe(1);
    expect(rankDetectedTunes(filterByFacets(sessions, [analyses(true, ['s2', 'exclude'])]))[0]!.count).toBe(2);
  });

  it('drops a tune none of whose passes are left', () => {
    const sessions = [session('s1', null, [det({ tuneId: '1', dance: 'reel' }), det({ tuneId: '2', start: 90, dance: 'jig' })])];
    expect(rankDetectedTunes(filterByFacets(sessions, [types(true, ['jig', 'include'])])).map(r => r.tuneId)).toEqual(['2']);
  });

  // "All of" cannot be asked of a pass, which has one key: it is asked of the
  // tune, over the passes that carry one of the keys.
  it('reads "all of" as a tune heard in every key included, counted over those passes', () => {
    const sessions = [session('s1', null, [
      det({ tuneId: 'both', start: 10, settingId: 'inD' }),
      det({ tuneId: 'both', start: 90, settingId: 'inG' }),
      det({ tuneId: 'both', start: 300, settingId: 'inA' }),
      det({ tuneId: 'onlyD', start: 500, settingId: 'inD' }),
    ])];
    const all = rankDetectedTunes(filterByFacets(sessions, [keys(false, ['inD', 'include'], ['inG', 'include'])]));
    expect(all.map(r => r.tuneId)).toEqual(['both']);
    expect(all[0]!.count).toBe(2);
    const any = rankDetectedTunes(filterByFacets(sessions, [keys(true, ['inD', 'include'], ['inG', 'include'])]));
    expect(any.map(r => r.tuneId).sort()).toEqual(['both', 'onlyD']);
  });

  it('asks "all of" after every section has removed its passes', () => {
    // Heard in D in s1 and in G in s2 only: with s2 excluded it is no longer
    // heard in both keys.
    const sessions = [
      session('s1', null, [det({ tuneId: '1', start: 10, settingId: 'inD' })]),
      session('s2', null, [det({ tuneId: '1', start: 10, settingId: 'inG' })]),
    ];
    const both = keys(false, ['inD', 'include'], ['inG', 'include']);
    expect(rankDetectedTunes(filterByFacets(sessions, [both]))).toHaveLength(1);
    expect(rankDetectedTunes(filterByFacets(sessions, [both, analyses(true, ['s2', 'exclude'])]))).toHaveLength(0);
  });

  // The heart follows the passes too: a tune hearted in G only is not a
  // hearted tune among the passes in D.
  it('takes the heart from the passes that are left', () => {
    const sessions = [session('s1', null, [
      det({ tuneId: '1', start: 10, settingId: 'inD' }),
      det({ tuneId: '1', start: 90, settingId: 'inG', liked: true }),
    ])];
    expect(rankDetectedTunes(filterByFacets(sessions, [keys(true, ['inD', 'include'])]))[0]!.liked).toBe(false);
  });

  describe('with folders', () => {
    const sessions = [
      session('s1', null, [det({ tuneId: 'kesh', start: 10 }), det({ tuneId: 'kesh', start: 90 })]),
      session('s2', null, [det({ tuneId: 'kesh', start: 10 }), det({ tuneId: 'cooley', start: 90 })]),
      session('s3', null, [det({ tuneId: 'kesh', start: 10 }), det({ tuneId: 'banshee', start: 90 })]),
      session('s4', null, [det({ tuneId: 'cooley', start: 10 })]),
    ];
    const ids = (facets: PassFacet[]) => rankDetectedTunes(filterByFacets(sessions, facets)).map(r => `${r.tuneId}×${r.count}`).sort();

    it('counts every analysis in an included folder, and nothing outside it', () => {
      expect(ids([filed(true, ['folder:winter', 'include'])])).toEqual(['cooley×1', 'kesh×3']);
    });

    it('takes an excluded evening out of an included folder', () => {
      expect(ids([filed(true, ['folder:winter', 'include'], ['s1', 'exclude'])])).toEqual(['cooley×1', 'kesh×1']);
    });

    it('adds an evening from elsewhere to a folder under "any of"', () => {
      expect(ids([filed(true, ['folder:winter', 'include'], ['s4', 'include'])])).toEqual(['cooley×2', 'kesh×3']);
    });

    it('reads two folders under "all of" as the tunes heard in both', () => {
      expect(ids([filed(false, ['folder:winter', 'include'], ['folder:summer', 'include'])])).toEqual(['kesh×4']);
    });

    it('removes a whole folder when it is excluded', () => {
      expect(ids([filed(true, ['folder:winter', 'exclude'])])).toEqual(['banshee×1', 'cooley×1', 'kesh×1']);
    });
  });

  it('never touches the analysis it reads from', () => {
    const s = session('s1', null, [det({ tuneId: '1', dance: 'reel' }), det({ tuneId: '2', start: 90, dance: 'jig' })]);
    filterByFacets([s], [types(false, ['jig', 'include'], ['reel', 'include'])]);
    expect(s.annotations).toHaveLength(2);
  });
});
