import { describe, it, expect } from 'vitest';
import { rankDetectedTunes, occurrencesOf, sortTuneRows, TUNE_SORT_DEFAULT_ASC } from './tuneRanking';
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
