import { describe, it, expect } from 'vitest';
import { alternatePickFields, viterbiPickOf } from './model';
import type { AnnotationAlternate, SessionAnnotation } from './model';

const alt = (tuneId: string, displayName: string): AnnotationAlternate => ({
  tuneId, settingId: `s${tuneId}`, displayName, dance: 'reel', meter: '4/4', meanScore: 0.5,
});

const PICKED = alt('1', 'The Silver Spear');
const OTHER  = alt('2', 'The Musical Priest');

function annotation(over: Partial<SessionAnnotation> = {}): SessionAnnotation {
  return {
    id: 'a1',
    tuneId: PICKED.tuneId, settingId: PICKED.settingId, displayName: PICKED.displayName,
    dance: PICKED.dance, meter: PICKED.meter,
    start: 0, end: 30, confidence: 0.8, bucket: 'high', meanScore: 0.5,
    evidence: [], alternates: [OTHER], viterbiPick: PICKED,
    userConfirmed: false, liked: false, finalized: true,
    ...over,
  };
}

describe('confirming a detection', () => {
  it('counts as a confirmation even when it is what the decoder already said', () => {
    // The point of the feature: "this result is right" is a verdict on the
    // detection, not a disagreement with it, and it earns the same freeze.
    const fields = alternatePickFields(annotation(), PICKED);
    expect(fields.userConfirmed).toBe(true);
    expect(fields.tuneId).toBe('1');
  });

  it('switches the displayed identity when another tune is picked', () => {
    const fields = alternatePickFields(annotation(), OTHER);
    expect(fields.userConfirmed).toBe(true);
    expect(fields.tuneId).toBe('2');
    expect(fields.displayName).toBe('The Musical Priest');
  });

  it('hands the annotation back to the decoder on null', () => {
    // Un-confirming an override also undoes it: the annotation goes back to
    // displaying whatever the decoder currently picks, not the tune the user
    // had chosen with no confirmation attached to it.
    const overridden = annotation({ ...OTHER, userConfirmed: true });
    const fields = alternatePickFields(overridden, null);
    expect(fields.userConfirmed).toBe(false);
    expect(fields.tuneId).toBe('1');
    expect(fields.displayName).toBe('The Silver Spear');
  });

  it('falls back to the current identity for a session recorded before viterbiPick existed', () => {
    // No migration was ever written for that field (see viterbiPickOf) — an
    // old session must still be un-confirmable without losing its tune.
    const legacy = annotation({ viterbiPick: undefined as unknown as AnnotationAlternate, userConfirmed: true });
    expect(viterbiPickOf(legacy).tuneId).toBe('1');
    expect(alternatePickFields(legacy, null).tuneId).toBe('1');
  });
});
