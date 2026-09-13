import { describe, it, expect } from 'vitest';
import { alternatePickFields, viterbiPickOf, withManualAlternate, manualAlternateRemovalFields } from './model';
import type { DetectionAlternate, Detection } from './model';

const alt = (tuneId: string, displayName: string): DetectionAlternate => ({
  tuneId, settingId: `s${tuneId}`, displayName, dance: 'reel', meter: '4/4', meanScore: 0.5,
});

const PICKED = alt('1', 'The Silver Spear');
const OTHER  = alt('2', 'The Musical Priest');

function detection(over: Partial<Detection> = {}): Detection {
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
    const fields = alternatePickFields(detection(), PICKED);
    expect(fields.userConfirmed).toBe(true);
    expect(fields.tuneId).toBe('1');
  });

  it('switches the displayed identity when another tune is picked', () => {
    const fields = alternatePickFields(detection(), OTHER);
    expect(fields.userConfirmed).toBe(true);
    expect(fields.tuneId).toBe('2');
    expect(fields.displayName).toBe('The Musical Priest');
  });

  it('hands the detection back to the decoder on null', () => {
    // Un-confirming an override also undoes it: the detection goes back to
    // displaying whatever the decoder currently picks, not the tune the user
    // had chosen with no confirmation attached to it.
    const overridden = detection({ ...OTHER, userConfirmed: true });
    const fields = alternatePickFields(overridden, null);
    expect(fields.userConfirmed).toBe(false);
    expect(fields.tuneId).toBe('1');
    expect(fields.displayName).toBe('The Silver Spear');
  });

  describe('a tune named by hand', () => {
    const NAMED = alt('3', 'the kesh');

    // The user's request: "Add" only adds — the tune is ticked afterwards,
    // from the list, like any other variant.
    it('joins the variants without being chosen', () => {
      const ann = detection();
      expect(withManualAlternate(ann, NAMED)).toEqual([NAMED]);
      expect(ann.tuneId).toBe('1');
      expect(ann.userConfirmed).toBe(false);
    });

    // And stays one after a change of mind: reopening the list must still
    // show it.
    it('stays a variant whatever is picked, and when the choice is undone', () => {
      const named = detection({ manualAlternates: withManualAlternate(detection(), NAMED) });
      const picked = { ...named, ...alternatePickFields(named, NAMED) };
      expect(picked.tuneId).toBe('3');
      expect(picked.manualAlternates).toEqual([NAMED]);
      const undone = { ...picked, ...alternatePickFields(picked, null) };
      expect(undone.tuneId).toBe('1');
      expect(undone.manualAlternates).toEqual([NAMED]);
    });

    it('is not added twice', () => {
      const named = detection({ manualAlternates: [NAMED] });
      expect(withManualAlternate(named, NAMED)).toEqual([NAMED]);
    });

    // A tune the recogniser already scored is in the list with its score.
    it('is not added when the list already holds the tune', () => {
      expect(withManualAlternate(detection(), OTHER)).toBeUndefined();
      expect(withManualAlternate(detection(), PICKED)).toBeUndefined();
    });

    it('can be removed, leaving the choice alone when it was not the one ticked', () => {
      const SECOND = alt('4', 'the maid behind the bar');
      const named = detection({ manualAlternates: [NAMED, SECOND] });
      const fields = manualAlternateRemovalFields(named, '3');
      expect(fields.manualAlternates).toEqual([SECOND]);
      expect(fields.tuneId).toBeUndefined();
      expect(manualAlternateRemovalFields(detection({ manualAlternates: [NAMED] }), '3').manualAlternates).toBeUndefined();
    });

    // A confirmation cannot outlive the variant it chose.
    it('hands the detection back to the decoder when the ticked one is removed', () => {
      const ticked = detection({ ...NAMED, manualAlternates: [NAMED], userConfirmed: true });
      const after = { ...ticked, ...manualAlternateRemovalFields(ticked, '3') };
      expect(after.tuneId).toBe('1');
      expect(after.userConfirmed).toBe(false);
      expect(after.manualAlternates).toBeUndefined();
    });
  });

  it('falls back to the current identity for a session recorded before viterbiPick existed', () => {
    // No migration was ever written for that field (see viterbiPickOf) — an
    // old session must still be un-confirmable without losing its tune.
    const legacy = detection({ viterbiPick: undefined as unknown as DetectionAlternate, userConfirmed: true });
    expect(viterbiPickOf(legacy).tuneId).toBe('1');
    expect(alternatePickFields(legacy, null).tuneId).toBe('1');
  });
});
