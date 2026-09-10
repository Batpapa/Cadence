import { describe, it, expect } from 'vitest';
import { matchingDetections, readSearchTunes, writeSearchTunes } from './sessionSearch';
import type { Analysis, Detection } from '../model';

// ── Searching a session by what was PLAYED in it ─────────────────────────────
// Requested from the field (2026-09-09): a session is remembered by its tunes
// far more often than by its name. Deliberately a plain substring match — no
// fuzziness, no Fahy/Fahey tolerance (the user ruled that out): a hit nobody
// can explain is worse than a miss they can retype.
//
// One entry per DETECTION, not per tune name: each is a moment in the
// recording the result list links straight to.

function detection(name: string, tuneId: string, start = 0, over: Partial<Detection> = {}): Detection {
  const identity = { tuneId, settingId: '1', displayName: name, dance: 'reel', meter: '4/4', meanScore: 0.8 };
  return {
    id: `d-${tuneId}-${start}`, ...identity, start, end: start + 30,
    confidence: 0.8, bucket: 'high', evidence: [], alternates: [],
    viterbiPick: identity, userConfirmed: false, liked: false, finalized: true,
    ...over,
  };
}

function session(...anns: Detection[]): Analysis {
  return {
    id: 's1', name: 'Tuesday session', date: '2026-09-01T20:00:00.000Z',
    duration: 3600, source: 'live', annotations: anns,
  } as Analysis;
}

const cooleys  = detection("Cooley's", '1197', 0);
const wiseMaid = detection('The Wise Maid', '85', 200);

const names = (ds: Detection[]) => ds.map(d => d.displayName);

describe('matchingDetections', () => {
  it('finds a tune by a fragment of its name', () => {
    expect(names(matchingDetections(session(cooleys, wiseMaid), 'wise'))).toEqual(['The Wise Maid']);
  });

  it('is case-insensitive, the query arriving already lowercased', () => {
    expect(names(matchingDetections(session(cooleys), 'cooley'))).toEqual(["Cooley's"]);
  });

  it('finds a tune by its TheSession id, bare or prefixed', () => {
    expect(names(matchingDetections(session(cooleys, wiseMaid), '1197'))).toEqual(["Cooley's"]);
    expect(names(matchingDetections(session(cooleys, wiseMaid), 'thesession:1197'))).toEqual(["Cooley's"]);
  });

  it('matches an id EXACTLY — a fragment of a number means nothing', () => {
    // '11' inside '1197' is not a tune anyone is looking for; names stay
    // substring-matched because a name fragment IS how people type.
    expect(matchingDetections(session(cooleys), '11')).toEqual([]);
  });

  it('returns EVERY pass through a tune, not one entry per name', () => {
    // Two moments in the evening, two rows, two destinations.
    const again = detection("Cooley's", '1197', 1800);
    const hits = matchingDetections(session(cooleys, again), 'cooley');
    expect(hits).toHaveLength(2);
    expect(hits.map(h => h.start)).toEqual([0, 1800]);
  });

  it('returns them in playing order, whatever order they are stored in', () => {
    const late = detection("Cooley's", '1197', 2400);
    const early = detection("Cooley's", '1197', 60);
    expect(matchingDetections(session(late, early), 'cooley').map(h => h.start)).toEqual([60, 2400]);
  });

  it('keeps a confirmed detection, which the row colours differently', () => {
    const confirmed = detection('The Kesh', '9', 10, { userConfirmed: true });
    expect(matchingDetections(session(confirmed), 'kesh')).toHaveLength(1);
  });

  it('returns nothing for an empty query, so an empty box filters nothing', () => {
    expect(matchingDetections(session(cooleys), '')).toEqual([]);
  });

  it('survives a session with no detections at all', () => {
    expect(matchingDetections(session(), 'anything')).toEqual([]);
  });
});

describe('le reglage "chercher aussi dans les morceaux"', () => {
  // No localStorage in this environment at all — which is also a real browser
  // state (private mode, site data blocked). Reading must answer "off" and
  // writing must not throw, or the whole library screen fails to render over
  // a checkbox.
  it('vaut faux par defaut, et quand le stockage est inaccessible', () => {
    expect(readSearchTunes()).toBe(false);
  });

  it('ne jette pas quand l ecriture est refusee', () => {
    expect(() => writeSearchTunes(true)).not.toThrow();
    expect(() => writeSearchTunes(false)).not.toThrow();
  });

  it('relit ce qui a ete ecrit quand le stockage existe', () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    };
    try {
      writeSearchTunes(true);
      expect(readSearchTunes()).toBe(true);
      // Written explicitly rather than deleted: "absent" and "refused" must
      // not become the same thing, the way an optional flag defaulting to true
      // already burned us once (syncAudioByDefault).
      writeSearchTunes(false);
      expect(store.get('cadence_sessions_search_tunes')).toBe('0');
      expect(readSearchTunes()).toBe(false);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
