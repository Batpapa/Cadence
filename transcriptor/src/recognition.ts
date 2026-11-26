// The recogniser's query from these notes (2026-11-26): a 10 s window's notes made into
// FolkFriend's contour, one pitch class a quaver ('a' = C ... 'l' = B), to be queried against
// its index folded to pitch classes. The tempo is chosen per window as FolkFriend's contour.rs
// does (contour_from_notes: 60-175 crotchets a minute by 5, each note rounded to whole quavers,
// the rounding error weighed by the note's power, times a note-length model intercept - slope x
// quavers), with two changes measured on the 18 annotated sessions (recognition-research/
// JOURNAL.md, section 22; windows whose right tune is first, FolkFriend 91.8 %):
//   - more cuts than for writing ABC (cutCost 1, not 2): a swallowed note costs the alignment
//     more than an extra one — 89.8 -> 91.0 %;
//   - a gentler note-length slope (0.2, not 0.5) — 91.0 -> 92.4 %, flat from 0.1 to 0.3;
//   - a note lasts to the next onset (at most 0.25 s past its end): rests are not symbols.
// Final detections with the production segmenter: 686/703 tunes for 14 false positives,
// FolkFriend 683 for 11; averaged with FolkFriend's scores, 685 for 10 and half the wrong
// names shown briefly.

import { analyseAudio, decode } from './decoder.ts';

/** FolkFriend's frames: 1024 samples at 48 kHz. */
const FPS = 48000 / 1024;
const LOW_BPM = 60, HIGH_BPM = 180;
const INTERCEPT = 3, SLOPE = 0.2;
/** A note at most this long past its own end when the next onset is further (s). */
const GAP = 0.25;
/** Shortest note kept (FolkFriend frames, its MIN_NOTE_DURATION). */
const MIN_FRAMES = 3;
const CUT_COST = 1;

/** Notes as [class, frames, power] to FolkFriend's contour, '' when it would refuse (3 notes or
 *  fewer). A note of no power (heard before the long window's first frame: the window's very
 *  start) is left out, as FolkFriend leaves out its weak notes. */
export function contourOf(notes: [number, number, number][]): string {
  const kept = notes.filter(n => n[1] >= MIN_FRAMES && n[2] > 0);
  if (kept.length <= 3) return '';
  let total = 0;
  for (const n of kept) total += n[1];
  let best = -Infinity, bestQ: number[] = [];
  for (let bpm = LOW_BPM; bpm < HIGH_BPM; bpm += 5) {
    const fpq = FPS / ((bpm / 60) * 2);
    let err = 0, prob = 0;
    const q = kept.map(([, d, p]) => {
      const exact = d / fpq;
      const n = exact > 0.2 ? Math.max(1, Math.round(exact)) : 0;
      err += Math.abs(exact - n) * p;
      prob += INTERCEPT - SLOPE * n;
      return n;
    });
    const score = (prob / kept.length) * (1 - (err * fpq) / total);
    if (score > best) { best = score; bestQ = q; }
  }
  let s = '';
  kept.forEach(([c], i) => { s += String.fromCharCode(97 + c).repeat(bestQ[i]!); });
  return s;
}

/** A window of `pcm` (at `rate`, best 48 kHz as measured) as the recogniser's contour. */
export function recognitionContour(pcm: Float32Array, rate: number): string {
  const a = analyseAudio(pcm, rate, { gridSize: 0 });
  const notes = decode(a, { cutCost: CUT_COST });
  const out: [number, number, number][] = [];
  notes.forEach((n, i) => {
    const next = notes[i + 1]?.onset ?? n.offset;
    const end = Math.max(n.offset, Math.min(next, n.offset + GAP));
    out.push([n.cls, (end - n.onset) * FPS, n.power]);
  });
  return contourOf(out);
}
