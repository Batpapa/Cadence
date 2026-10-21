/** Swing in compound time — jigs, slip jigs, slides — which abcjs cannot do.
 *
 *  abcjs's `addSwing` (create-synth.js) only ever swings PAIRS: it delays a
 *  note that falls on an odd half-beat, where the beat is a quarter in X/4 and
 *  an EIGHTH in X/8. So in 6/8 it swings the semiquavers, and a jig written in
 *  quavers has nothing on an odd semiquaver for it to move.
 *
 *  A jig's beat is swung as a whole instead (the user's rule, 2026-10-22): its
 *  three quavers become three unequal parts, a long first one and two equal
 *  short ones, `a + 2b` = the beat — see firstNoteGain. Time inside the beat is then stretched part by part, so EVERY note
 *  takes the new grid: three quavers come out long-short-short, `c2 B` comes
 *  out with its crotchet over the first two parts, a roll in semiquavers is
 *  stretched with the quaver it decorates. The beats themselves do not move.
 *
 *  A first version (same day) applied the reel's rule to the first two
 *  quavers and left the third alone, only on beats written as three quavers;
 *  this one has no case to leave out.
 *
 *  Done on the note map abcjs hands its public `sequenceCallback` after
 *  building it and before rendering a sound — so abcjs itself is not patched.
 *  The cursor follows the written timing, as it already does for a reel. */

import { NO_SWING } from './abcService';

/** A note of abcjs's note map, as far as swing is concerned: start and end
 *  in whole notes. The end is the start plus the length MINUS the articulation
 *  gap, so it need not be where the next note starts. */
export interface SwingNote { start: number; end: number }

/** abcjs's `getMeterFraction()`, whose typing leaves `den` optional. */
interface MeterFraction { num: number; den?: number }

const QUAVER = 1 / 8;
const BEAT = 3 * QUAVER;

/** How much of a quaver the first part of the beat GAINS — the reel's own
 *  measure, read off the setting exactly as abcjs's `addSwing` reads it
 *  (`swing / 50 − 1`, 75 its ceiling): 0,2, 0,32, 0,5. The user's call,
 *  2026-10-22: the setting measures how much the first note is lengthened,
 *  in a jig as in a reel, and the two short parts share what it takes. So
 *  "fort" is 1,5 / 0,75 / 0,75 quavers, as it is 1,5 / 0,5 in a reel. */
function firstNoteGain(swing: number): number {
  return Math.min(swing, 75) / 50 - 1;
}

/** Whether this metre is one swung here — three quavers to the beat — rather
 *  than by abcjs. 3/8 is in: abcjs counts it in threes too (abc_tune.js). */
function isCompoundMeter(meter: MeterFraction): boolean {
  return meter.den === 8 && meter.num % 3 === 0;
}

/** Swings every beat, in place, on every track. `pickupLength` is where the
 *  first full bar starts — abcjs's own `getPickupLength()`, in whole notes;
 *  a pickup is counted backwards from it, so its quavers are the end of a
 *  beat. */
export function swingJigNotes(tracks: SwingNote[][], swing: number, pickupLength: number): void {
  if (!(swing > NO_SWING)) return;
  // The long part and the two short ones, in quavers.
  const a = 1 + firstNoteGain(swing);
  const b = (3 - a) / 2;

  /** Where a written moment is heard. */
  const warp = (t: number): number => {
    const pos = t - pickupLength;
    // A moment exactly on a beat belongs to the beat it opens — the nudge
    // keeps abcjs's rounding (to 1e-6) from putting it at the end of the last.
    const beat = Math.floor(pos / BEAT + 1e-6);
    const u = Math.max(0, (pos - beat * BEAT) / QUAVER);
    const w = u <= 1 ? u * a : a + (u - 1) * b;
    return pickupLength + beat * BEAT + w * QUAVER;
  };

  for (const track of tracks) {
    for (const n of track) {
      n.start = warp(n.start);
      n.end = warp(n.end);
    }
  }
}

/** The options a synth needs to swing this tune, to merge into the ones it
 *  is given: abcjs's own `swing` in simple time, our `sequenceCallback` in
 *  compound time — never both, since abcjs would then go on to swing the
 *  semiquavers of every roll. Nothing in a metre neither of them swings. */
export function swingAudioParams(
  swing: number,
  meter: MeterFraction,
  pickupLength: number,
): Record<string, unknown> {
  if (swing === NO_SWING) return {};
  if (meter.den === 4) return { swing };
  if (isCompoundMeter(meter)) {
    return { sequenceCallback: (tracks: SwingNote[][]) => swingJigNotes(tracks, swing, pickupLength) };
  }
  return {};
}
