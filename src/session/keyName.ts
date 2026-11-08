// ── A key, moved by some semitones ───────────────────────────────────────────
// The recogniser says which key a tune was PLAYED in (DetectionAlternate.
// transpose, 2026-11-07): the setting's key, as TheSession writes it ("Dmajor",
// "Edorian", "Bminor"…), moved that many semitones. Spelled as a player would:
// the key signature with the fewest accidentals for that mode (F#minor, not
// Gbminor; Bbmajor, not A#major), the tonic then named from it.

import { t } from '../services/i18nService';

const LETTERS = 'CDEFGAB';
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
/** Each mode's tonic, in degrees and semitones above its relative major's. */
const MODES: Record<string, { degree: number; semis: number }> = {
  major: { degree: 0, semis: 0 }, ionian: { degree: 0, semis: 0 },
  dorian: { degree: 1, semis: 2 },
  phrygian: { degree: 2, semis: 4 },
  lydian: { degree: 3, semis: 5 },
  mixolydian: { degree: 4, semis: 7 },
  minor: { degree: 5, semis: 9 }, aeolian: { degree: 5, semis: 9 },
  locrian: { degree: 6, semis: 11 },
};
/** The major key of each pitch class with the fewest accidentals (F# over Gb:
 *  six of either, and sharps are the usual side in this music). */
const MAJOR = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

const pcOf = (letter: string, acc: string) =>
  (LETTER_PC[LETTERS.indexOf(letter)]! + (acc === '#' ? 1 : acc === 'b' ? -1 : 0) + 12) % 12;

/** A gap between a recording and its score, in words: "a tone higher". */
export function keyGapText(semitones: number): string {
  const n = Math.round(semitones);
  const up = n > 0;
  const m = Math.abs(n);
  if (m === 1) return t(up ? 'sessions.follow.keyGap.semitoneUp' : 'sessions.follow.keyGap.semitoneDown');
  if (m === 2) return t(up ? 'sessions.follow.keyGap.toneUp' : 'sessions.follow.keyGap.toneDown');
  return t(up ? 'sessions.follow.keyGap.semitonesUp' : 'sessions.follow.keyGap.semitonesDown', { n: String(m) });
}

/** `mode` (TheSession's spelling: tonic, then the mode's name) moved `semitones`
 *  up; returned as it came when 0, or when it is not a key this can read. */
export function transposeMode(mode: string, semitones: number): string {
  const m = /^([A-G])([#b]?)([a-z]+)$/.exec(mode);
  const shift = ((Math.round(semitones) % 12) + 12) % 12;
  if (!m || shift === 0) return mode;
  const [, letter, acc, name] = m;
  const kind = MODES[name!];
  if (!kind) return mode;
  const tonic = (pcOf(letter!, acc!) + shift) % 12;
  const major = MAJOR[(tonic - kind.semis + 12) % 12]!;
  // The tonic is the mode's degree of that major scale: its letter by
  // counting, its accidental by what is left to reach the pitch.
  const tonicLetter = LETTERS[(LETTERS.indexOf(major[0]!) + kind.degree) % 7]!;
  const diff = ((tonic - pcOf(tonicLetter, '') + 18) % 12) - 6;
  const accidental = diff === 1 ? '#' : diff === -1 ? 'b' : diff === 2 ? '##' : diff === -2 ? 'bb' : '';
  return `${tonicLetter}${accidental}${name}`;
}
