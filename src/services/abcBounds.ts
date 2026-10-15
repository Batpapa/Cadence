// ── The passage of a score: where it starts, where it ends (2026-10-15) ───────
// Set apart, each at the cursor, with two buttons — as the audio player's
// region is — and shared by the two faces of the viewer: a green mark before
// the first note in the text and a flag on the stave, a blue one after the
// last. A missing bound is the tune's own start or end, and is not drawn.
//
// A bound is held as the position, in the box's text, of the note it names:
// the one form both faces can read (the stave's source is the same text, see
// abcTextPlayback's playableSource), and the one that survives typing — see
// shiftPosition. Which note is there is read again each time it is needed.

import type { ParsedNote } from './abcTextPlayback';

export interface Bounds { in: number | null; out: number | null }

/** Where a position stands once `before` has been edited into `after`, or
 *  null when the edit went through it. The edit is what lies between the
 *  longest common head and tail of the two texts: typing before the note
 *  moves it along, typing after it leaves it be, and rewriting the note
 *  itself takes the bound away. Typing right in front of the note pushes it
 *  on, which is where the note has gone. */
export function shiftPosition(x: number, before: string, after: string): number | null {
  if (before === after) return x;
  const max = Math.min(before.length, after.length);
  let head = 0;
  while (head < max && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < max - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const editEnd = before.length - tail;
  if (x >= editEnd) return x + (after.length - before.length);
  if (x < head) return x;
  return null;
}

/** The note a bound names, at `at` in the source: the one the position is in;
 *  failing that — the text under it is no note any more — the next one for a
 *  start and the one before for an end, so that the passage only ever
 *  narrows. */
export function boundNote(notes: readonly ParsedNote[], at: number, side: 'in' | 'out'): ParsedNote | null {
  const inside = notes.find(n => at >= n.start && at < n.end);
  if (inside) return inside;
  if (side === 'in') return notes.find(n => n.start >= at) ?? null;
  let last: ParsedNote | null = null;
  for (const n of notes) if (n.end <= at) last = n;
  return last;
}

/** The first and the last note with a character in [from, to) — what a
 *  selection gives the two bounds. */
export function notesAcross(notes: readonly ParsedNote[], from: number, to: number): { first: ParsedNote; last: ParsedNote } | null {
  const hit = notes.filter(n => n.start < to && n.end > from);
  return hit.length ? { first: hit[0]!, last: hit[hit.length - 1]! } : null;
}

/** The passage as a range of the source, [from, to), from the notes the
 *  bounds name — or null with no bound at all. */
export function regionOf(notes: readonly ParsedNote[], inAt: number | null, outAt: number | null): { from: number; to: number; first: ParsedNote | null; last: ParsedNote | null } | null {
  const first = inAt === null ? null : boundNote(notes, inAt, 'in');
  const last = outAt === null ? null : boundNote(notes, outAt, 'out');
  if (!first && !last) return null;
  return { from: first?.start ?? 0, to: last?.end ?? Infinity, first, last };
}

/** A bound set at `at`, the other one kept unless it would now come before
 *  it — then it goes, as the audio player's start cannot pass its end. The
 *  same note may be both. */
export function setBound(bounds: Bounds, side: 'in' | 'out', at: number | null): Bounds {
  if (side === 'in') return { in: at, out: at !== null && bounds.out !== null && bounds.out < at ? null : bounds.out };
  return { out: at, in: at !== null && bounds.in !== null && bounds.in > at ? null : bounds.in };
}
