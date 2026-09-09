import { describe, it, expect } from 'vitest';
import { findCardDetections, theSessionTuneId, detectionsOnCards, sessionsOf } from './detections';
import { TUNE_ANALYSER_MODULE_KEY, type Analysis, type Detection } from './model';
import type { Card } from '../types';

// The "detected in" panel is derived on every render, so what it says is only
// ever as right as this function. The cases that matter are the ones where the
// answer must CHANGE without anything being rewritten: a corrected detection,
// a card from another source, a session with no date.

function card(externalId?: string): Card {
  return { id: 'c', guid: 'g', name: 'A Tune', defaultImportance: 1, tags: [], ...(externalId ? { externalId } : {}), content: { notes: '', attachments: [] } };
}

function ann(id: string, tuneId: string, start: number, extra: Partial<Detection> = {}): Detection {
  return {
    id, tuneId, settingId: '1', displayName: 'A Tune', dance: 'reel', meter: '4/4',
    start, end: start + 60, confidence: 0.8, bucket: 'high', meanScore: 0.9,
    evidence: [], alternates: [],
    viterbiPick: { tuneId, settingId: '1', displayName: 'A Tune', dance: 'reel', meter: '4/4', meanScore: 0.9 },
    userConfirmed: false, liked: false, finalized: true,
    ...extra,
  } as Detection;
}

function session(id: string, date: string | null, annotations: Detection[]): Analysis {
  return { id, name: '', date, duration: 3600, mimeType: 'audio/webm', source: 'live', annotations };
}

const lib = (...s: Analysis[]) => Object.fromEntries(s.map(x => [x.id, x]));

describe('theSessionTuneId', () => {
  it('reads the numeric id of a TheSession card', () => {
    expect(theSessionTuneId(card('thesession:1197'))).toBe('1197');
  });

  // Only TheSession ids can ever match: the recogniser answers with those.
  it('answers null for anything else', () => {
    expect(theSessionTuneId(card())).toBeNull();
    expect(theSessionTuneId(card('irishtuneinfo:42'))).toBeNull();
    expect(theSessionTuneId(card('thesession-set:1-2'))).toBeNull();
    expect(theSessionTuneId(card('thesession:abc'))).toBeNull();
  });
});

describe('findCardDetections', () => {
  it('finds every session that recognised the tune', () => {
    const groups = findCardDetections(card('thesession:7'), lib(
      session('s1', '2026-09-01T20:00:00Z', [ann('a', '7', 10)]),
      session('s2', '2026-09-03T20:00:00Z', [ann('b', '9', 10)]),
      session('s3', '2026-09-02T20:00:00Z', [ann('c', '7', 30)]),
    ));
    expect(groups.map(g => g.sessionId)).toEqual(['s3', 's1']); // newest first
  });

  // The user's rule: two passes through the same tune in one evening are two
  // destinations, not one line saying "twice".
  it('keeps every pass as its own detection, in playing order', () => {
    const groups = findCardDetections(card('thesession:7'), lib(
      session('s1', '2026-09-01T20:00:00Z', [ann('late', '7', 900), ann('early', '7', 120)]),
    ));
    expect(groups[0]!.detections.map(d => d.annotationId)).toEqual(['early', 'late']);
    expect(groups[0]!.detections.map(d => d.start)).toEqual([120, 900]);
  });

  // Matching on the detection's own tuneId means a correction is followed:
  // re-identifying a detection moves it from one card's list to another's, with
  // nothing to rewrite anywhere.
  it('follows a corrected identity rather than the algorithm first answer', () => {
    const corrected = ann('x', '9', 10, {
      userConfirmed: true,
      viterbiPick: { tuneId: '7', settingId: '1', displayName: 'Wrong', dance: 'reel', meter: '4/4', meanScore: 0.9 },
    });
    const sessions = lib(session('s1', '2026-09-01T20:00:00Z', [corrected]));
    expect(findCardDetections(card('thesession:7'), sessions)).toEqual([]);
    expect(findCardDetections(card('thesession:9'), sessions)[0]!.detections[0]!.confirmed).toBe(true);
  });

  it('says nothing for a card no session ever recognised', () => {
    const sessions = lib(session('s1', '2026-09-01T20:00:00Z', [ann('a', '9', 10)]));
    expect(findCardDetections(card('thesession:7'), sessions)).toEqual([]);
    expect(findCardDetections(card('irishtuneinfo:7'), sessions)).toEqual([]);
    expect(findCardDetections(card('thesession:7'), {})).toEqual([]);
  });

  // An unknown date is not a very old one; sorting it first would bury real
  // sessions under something that says nothing.
  it('puts an undated import last, not first', () => {
    const groups = findCardDetections(card('thesession:7'), lib(
      session('undated', null, [ann('a', '7', 10)]),
      session('dated', '2020-01-01T20:00:00Z', [ann('b', '7', 10)]),
    ));
    expect(groups.map(g => g.sessionId)).toEqual(['dated', 'undated']);
  });
});

describe('detectionsOnCards', () => {
  // Absence is the default, as everywhere else: whoever records sessions is the
  // only one who ever sees the panel, and for them it is the point.
  it('is on unless explicitly turned off', () => {
    expect(detectionsOnCards({})).toBe(true);
    expect(detectionsOnCards({ modules: {} })).toBe(true);
    expect(detectionsOnCards({ modules: { [TUNE_ANALYSER_MODULE_KEY]: { sessions: {} } } })).toBe(true);
    expect(detectionsOnCards({ modules: { [TUNE_ANALYSER_MODULE_KEY]: { sessions: {}, detectionsOnCards: false } } })).toBe(false);
  });
});

describe('sessionsOf', () => {
  it('reads the module slice, and survives a user who has never opened it', () => {
    expect(sessionsOf({})).toEqual({});
    expect(sessionsOf({ modules: {} })).toEqual({});
    const s = session('s1', null, []);
    expect(sessionsOf({ modules: { [TUNE_ANALYSER_MODULE_KEY]: { sessions: { s1: s } } } })).toEqual({ s1: s });
  });
});
