import { describe, it, expect } from 'vitest';
import { pitchCuts, samePlayedPitch } from './pitchSplit';
import { PlayedPitch, settingOffset, wrapSemitones } from './playedPitch';
import { IncrementalViterbiSegmenter } from './viterbiSegmenter';
import { DETECTION_TEMPORAL_CONFIG } from './detectionTemporalConfig';
import type { Detection, WindowCandidate, WindowResult } from '../model';

const CFG = { lambda: 0.6, tolerance: 0.5 };

function cand(tuneId: string, score: number, pitch?: number, otherPitches?: [number, number][]): WindowCandidate {
  const c: WindowCandidate = { tuneId, settingId: `s${tuneId}`, displayName: `tune ${tuneId}`, dance: 'reel', meter: '4/4', score };
  if (pitch !== undefined) c.pitch = pitch;
  if (otherPitches) c.otherPitches = otherPitches;
  return c;
}
/** Production windows: 10 s every 5 s. */
function win(i: number, candidates: WindowCandidate[]): WindowResult {
  return { tWindowStart: i * 5, tWindowEnd: i * 5 + 10, empty: candidates.length === 0, candidates };
}
/** One tune 'A' at score 0.7, its pitch window by window (undefined = no pitch). */
function tuneAt(pitches: (number | undefined)[], others?: (i: number) => [number, number][] | undefined): WindowResult[] {
  return pitches.map((p, i) => win(i, [cand('A', 0.7, p, others?.(i)), cand('B', 0.2)]));
}

describe('pitchCuts', () => {
  it('keeps one pitch whole, small tuning wobbles included', () => {
    const ws = tuneAt([0.02, -0.03, 0.05, 0.01, -0.04, 0.03, 0.0, 0.02]);
    expect(pitchCuts(ws, 'A', 0, ws.length, CFG)).toEqual([]);
  });

  it('cuts where the tune goes up a tone and stays there', () => {
    const ws = tuneAt([0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2]);
    expect(pitchCuts(ws, 'A', 0, ws.length, CFG)).toEqual([6]);
  });

  it('a single window read elsewhere never cuts', () => {
    const ws = tuneAt([0, 0, 0, 5, 0, 0, 0]);
    expect(pitchCuts(ws, 'A', 0, ws.length, CFG)).toEqual([]);
  });

  it('stays whole when the other key reads the tune almost as well (the soft cost)', () => {
    // windows 4-7 heard a fifth up — but the tune scores 0.68 at the old pitch there too
    // (a B part that is the A part transposed): no evidence of a change
    const ws = tuneAt([0, 0, 0, 0, 7, 7, 7, 7], i => (i >= 4 ? [[0, 0.68]] : undefined));
    expect(pitchCuts(ws, 'A', 0, ws.length, CFG)).toEqual([]);
    // without that, the same windows do cut
    expect(pitchCuts(tuneAt([0, 0, 0, 0, 7, 7, 7, 7]), 'A', 0, 8, CFG)).toEqual([4]);
  });

  it('does not cut a slow drift within a quarter tone either way', () => {
    const ws = tuneAt(Array.from({ length: 20 }, (_, i) => (0.6 * i) / 19));
    expect(pitchCuts(ws, 'A', 0, ws.length, CFG)).toEqual([]);
  });

  it('follows the pitch across the half semitone where the tuning wraps', () => {
    // +0.48 then -0.48 + 1 (the transposition took the step): the same pitch, 0.04 apart
    const ws = tuneAt([0.48, 0.49, 0.47, 0.52, 0.51, 0.53, 0.5]);
    expect(pitchCuts(ws, 'A', 0, ws.length, CFG)).toEqual([]);
  });

  it('ignores windows without a pitch (stored before) and puts the cut midway through them', () => {
    expect(pitchCuts(tuneAt([undefined, undefined, undefined, undefined]), 'A', 0, 4, CFG)).toEqual([]);
    const ws = tuneAt([0, 0, 0, 0, undefined, undefined, 2, 2, 2, 2]);
    expect(pitchCuts(ws, 'A', 0, ws.length, CFG)).toEqual([5]);
  });
});

describe('samePlayedPitch (merge with the previous one: same key only)', () => {
  const det = (settingId: string, pick: Partial<Detection['viterbiPick']>, extra: Partial<Detection> = {}): Detection => ({
    id: Math.random().toString(36), tuneId: 'A', settingId, displayName: 'tune a', dance: 'reel', meter: '4/4',
    start: 0, end: 60, confidence: 0.7, bucket: 'high', meanScore: 0.7, evidence: [], alternates: [],
    viterbiPick: { tuneId: 'A', settingId, displayName: 'tune a', dance: 'reel', meter: '4/4', meanScore: 0.7, ...pick },
    userConfirmed: false, liked: false, finalized: true, ...extra,
  });

  it('compares the engine\'s pitches within a quarter tone, whatever setting each was heard in', () => {
    expect(samePlayedPitch(det('s1', { pitch: 0.03 }), det('s2', { pitch: -0.1, transpose: 5 }))).toBe(true);
    expect(samePlayedPitch(det('s1', { pitch: 0 }), det('s1', { pitch: 2 }))).toBe(false);
    expect(samePlayedPitch(det('s1', { pitch: 5.9 }), det('s1', { pitch: -5.9 }))).toBe(true); // across the wrap
  });

  it('falls back on the transposition of one same setting, else allows as before', () => {
    // an analysis made before: no pitch
    expect(samePlayedPitch(det('s1', {}), det('s1', { transpose: 2 }))).toBe(false);
    expect(samePlayedPitch(det('s1', { transpose: 2 }), det('s1', { transpose: 2 }))).toBe(true);
    // two settings, no pitch: nothing to compare them by
    expect(samePlayedPitch(det('s1', {}), det('s2', { transpose: 2 }))).toBe(true);
    // a tune named by hand heard nothing
    expect(samePlayedPitch(det('s1', { pitch: 0 }), det('s1', {}, { manual: true }))).toBe(true);
  });
});

describe('playedPitch', () => {
  it('wraps to (-6, 6]', () => {
    expect(wrapSemitones(7)).toBe(-5);
    expect(wrapSemitones(6)).toBe(6);
    expect(wrapSemitones(-6.5)).toBeCloseTo(5.5);
  });

  it('finds how far one setting is written above another from the melodies', () => {
    const tune = 'otxxxvtvAAAAvxyyyCAyxxxxotxxxvtvAAAAvxyxyvsvtttt'; // 'a' = C, one letter a semitone
    const shift = (s: string, d: number) => [...s].map(ch => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV'[('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV'.indexOf(ch) + d)]).join('');
    expect(settingOffset(tune, tune)).toBe(0);
    expect(settingOffset(shift(tune, 2), tune)).toBe(2);
    expect(settingOffset(shift(tune, 7), tune)).toBe(-5);
  });

  it('brings every setting back to the main one and writes the other keys', () => {
    const main = 'otxxxvtvAAAAvxyyyCAyxxxxotxxxvtvAAAAvxyxyvsvtttt';
    const up2 = [...main].map(ch => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV'['abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV'.indexOf(ch) + 2]).join('');
    // tune 10: setting '10' is the main one (its id is the tune's), '25' is written a tone up
    const pp = new PlayedPitch(t => (t === '10' ? [['25', up2], ['10', main]] : []));
    const a = cand('10', 0.7);
    pp.annotate(a, { setting_id: '10', setting: { tune_id: '10' }, score: 0.7, transpose: 2 }, 0.03);
    const b = cand('10', 0.7);
    // setting 25 heard as written: the same pitch as the main one moved up a tone
    pp.annotate(b, { setting_id: '25', setting: { tune_id: '10' }, score: 0.7, transpose: 0, other_keys: [['10', 7, 0.4], ['25', 5, 0.3], ['10', 2, 0.65]] }, 0.03);
    expect(a.pitch).toBeCloseTo(2.03);
    expect(b.pitch).toBeCloseTo(2.03);
    // ['10', 2] is b's own pitch: left out; '25'+5 and '10'+7 both land on 7: the best kept
    expect(b.otherPitches).toEqual([[-4.97, 0.4]]);
    // an unknown tuning or tune leaves the candidate as it was
    const c = cand('10', 0.7);
    pp.annotate(c, { setting_id: '10', setting: { tune_id: '10' }, score: 0.7 }, undefined);
    pp.annotate(c, { setting_id: '99', setting: { tune_id: '99' }, score: 0.7 }, 0);
    expect(c.pitch).toBeUndefined();
  });
});

describe('IncrementalViterbiSegmenter with the pitch split', () => {
  function replay(windows: WindowResult[], cfg = DETECTION_TEMPORAL_CONFIG): Detection[] {
    const seg = new IncrementalViterbiSegmenter(5, cfg);
    const live = new Map<string, Detection>();
    const apply = (evs: ReturnType<IncrementalViterbiSegmenter['step']>) => {
      for (const e of evs) { if (e.type === 'retract') live.delete(e.id); else live.set(e.detection.id, e.detection); }
    };
    for (const w of windows) apply(seg.step(w));
    apply(seg.finalize());
    return [...live.values()].sort((a, b) => a.start - b.start);
  }
  const amThenBm = () => tuneAt([...Array(12).fill(0), ...Array(12).fill(2)]);

  it('makes two detections of the tune played again a tone up, cut between them', () => {
    const dets = replay(amThenBm());
    expect(dets.map(d => d.tuneId)).toEqual(['A', 'A']);
    // windows 0-11 then 12-23: the boundary midway between the centres of windows 11 and 12
    expect(dets[0]!.end).toBe(62.5);
    expect(dets[1]!.start).toBe(62.5);
    expect(dets[0]!.start).toBe(0);
    expect(dets[1]!.end).toBe(125);
    expect(dets.every(d => d.finalized)).toBe(true);
  });

  it('writes each part\'s played pitch on its decoder pick', () => {
    const dets = replay(amThenBm());
    expect(dets.map(d => d.viterbiPick.pitch)).toEqual([0, 2]);
    expect(replay(tuneAt(Array(24).fill(undefined)))[0]!.viterbiPick.pitch).toBeUndefined();
  });

  it('keeps one detection with the split off, or with windows that carry no pitch', () => {
    expect(replay(amThenBm(), { ...DETECTION_TEMPORAL_CONFIG, pitchSplitLambda: undefined })).toHaveLength(1);
    expect(replay(tuneAt(Array(24).fill(undefined)))).toHaveLength(1);
  });

  it('keeps the first part under its id while the second grows live', () => {
    const seg = new IncrementalViterbiSegmenter(5, DETECTION_TEMPORAL_CONFIG);
    const live = new Map<string, Detection>();
    let firstId: string | null = null;
    let retracted = 0;
    for (const w of amThenBm()) {
      for (const e of seg.step(w)) {
        if (e.type === 'retract') { retracted++; live.delete(e.id); continue; }
        live.set(e.detection.id, e.detection);
        firstId ??= e.detection.id;
      }
    }
    const dets = [...live.values()].sort((a, b) => a.start - b.start);
    expect(dets).toHaveLength(2);
    expect(dets[0]!.id).toBe(firstId);
    expect(retracted).toBe(0);
  });
});
