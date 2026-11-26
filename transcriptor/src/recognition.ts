// The recogniser's query from these notes (2026-11-26): a 10 s window's notes — decoded in the
// same regime as for writing ABC (decoder.ts's DEFAULTS, FolkFriend's cleaned class energies as
// the extra view) — made into FolkFriend's contour, one pitch class a quaver ('a' = C ... 'l' =
// B), to be queried against its index folded to pitch classes. The tempo is chosen per window as
// FolkFriend's contour.rs does (contour_from_notes: 60-175 crotchets a minute by 5, each note
// rounded to whole quavers, the rounding error weighed by the note's power, times a note-length
// model intercept - slope x quavers), with two changes measured on the 18 annotated sessions
// (research journals, outside the repo; windows whose right tune is first):
//   - a gentler note-length slope (0.2, not 0.5): 91.0 -> 92.4 %, flat from 0.1 to 0.3 (neutral
//     on FolkFriend's own notes: the gain comes from our onsets' precision);
//   - a note lasts to the next onset (at most 0.25 s past its end): rests are not symbols.
// The tempo estimated from our onsets instead of the search: 92.0 (fixed), 93.0 (searched around
// it), against 93.2 — not kept.
// The whole chain, FolkFriend's 91.8 % -> 93.2 %; final detections with the production segmenter
// (its settings swept again, cross-validated: they stay): 685/703 tunes for 13 false positives,
// FolkFriend 683 for 11; wrong names shown briefly 46 -> 33; the right name on screen 86.7 ->
// 88.2 % of the tunes' time. With the worker's two additions (Cadence's followedTunes.ts: the
// followed tune scored when it falls out of the shortlist, the shortlist re-scored by `opinions`):
// 688/703 for 12, wrong names shown briefly 21.

import { analyseAudio, decode, withView, type ClassView, type DecoderOptions } from './decoder.ts';

/** FolkFriend's frames: 1024 samples at 48 kHz. */
const FPS = 48000 / 1024;
const LOW_BPM = 60, HIGH_BPM = 180;
const INTERCEPT = 3, SLOPE = 0.2;
/** A note at most this long past its own end when the next onset is further (s). */
const GAP = 0.25;
/** Shortest note kept (FolkFriend frames, its MIN_NOTE_DURATION). */
const MIN_FRAMES = 3;

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

/** The window heard: its contour for the recogniser, other opinions on it (contours of the same
 *  window decoded otherwise, to re-score the shortlist with), and its tuning (semitones off
 *  A = 440). */
export interface RecognitionWindow { contour: string; opinions: string[]; tuning: number }

/** The other opinions' decodings (research journals, outside the repo, « Noms faux brefs »): the
 *  same analysis decoded otherwise — more cuts, its own views only — so that its errors fall
 *  elsewhere. The shortlist re-scored by it (each tune at the mean of its scores): wrong names
 *  shown briefly 33 -> 21, as few as averaging with FolkFriend's whole second search (20), the
 *  right tune first in 94.3 % of the windows (93.2). A second decoding of the same analysis costs
 *  a fraction of the first. One opinion measured; more would be listed here. */
const OPINIONS: DecoderOptions[] = [{ cutCost: 1, extraWeight: 0 }];

function contourOfNotes(notes: { cls: number; onset: number; offset: number; power: number }[]): string {
  const out: [number, number, number][] = [];
  notes.forEach((n, i) => {
    const next = notes[i + 1]?.onset ?? n.offset;
    const end = Math.max(n.offset, Math.min(next, n.offset + GAP));
    out.push([n.cls, (end - n.onset) * FPS, n.power]);
  });
  return contourOf(out);
}

/** A window of `pcm` (at `rate`, best 48 kHz as measured) as the recogniser's query; `view`: an
 *  extra class view of the same samples (in Cadence FolkFriend's cleaned energies, folkfriendView.ts;
 *  without it, the decoder reads its own views only: 92.3 % instead of 93.2). */
export function recognitionContour(pcm: Float32Array, rate: number, view?: ClassView): RecognitionWindow {
  const a = withView(analyseAudio(pcm, rate, { gridSize: 0 }), view);
  return { contour: contourOfNotes(decode(a)), opinions: OPINIONS.map(o => contourOfNotes(decode(a, o))), tuning: a.tuning };
}
