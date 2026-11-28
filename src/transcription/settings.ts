import { makeKey, parseMetre, type Metre, type Mode } from '../session/recognition/transcription';
import type { TranscriptionSettings } from './model';
import type { TranscribeSettings } from '../session/recognition/transcribeAudio';

// ── What the user can say of a recording before it is transcribed ────────────
// A dance, a metre, a key. Each is optional: what is not given is told from
// the recording — and only 4/4 and 6/8 can be (transcription.ts, metreOf): the
// other metres are the user's to give. A priori that the USER states, never
// guessed: the "no priors" rule stands for recognition (the user, 2026-11-27).
// The dance is not heard at all (the user, 2026-11-28: "just an info"): it
// presets its metre, and names the card's type when a card is made.

/** The dances offered — the Irish extension's (the user, 2026-11-28: none
 *  without it), as TheSession names its tune types (tagGroups.ts): the name is
 *  the card's type tag when a card is made of the transcription. Each with the
 *  metre it presets; a march none, being in 2/4, 4/4 or 6/8 alike. */
export const DANCES: ReadonlyArray<{ id: string; metre?: Metre }> = [
  { id: 'reel', metre: '4/4' },
  { id: 'jig', metre: '6/8' },
  { id: 'hornpipe', metre: '4/4' },
  { id: 'polka', metre: '2/4' },
  { id: 'slide', metre: '12/8' },
  { id: 'slip jig', metre: '9/8' },
  { id: 'waltz', metre: '3/4' },
  { id: 'mazurka', metre: '3/4' },
  { id: 'barndance', metre: '4/4' },
  { id: 'strathspey', metre: '4/4' },
  { id: 'three-two', metre: '3/2' },
  { id: 'march' },
];

export const MODES: ReadonlyArray<Mode> = ['maj', 'min', 'dor', 'mix'];

/** The twelve tonics, by pitch class. */
export const TONIC_PCS: ReadonlyArray<number> = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** A key as the transcription writes it (makeKey: its signature the simplest
 *  on the circle of fifths — E♭ major, never D♯; F♯ at six either way): its
 *  tonic's name and its signature, "B♭" and "2♭", "F♯" and "3♯", "C" and "". */
export function keyLabel(tonic: number, mode: Mode): { tonic: string; signature: string } {
  const key = makeKey(tonic, mode);
  const name = key.name.slice(0, key.name.length - mode.length).replace('#', '♯').replace('b', '♭');
  const alts = Object.values(key.signature);
  const sharps = alts.filter(a => a > 0).length, flats = alts.filter(a => a < 0).length;
  return { tonic: name, signature: sharps ? `${sharps}♯` : flats ? `${flats}♭` : '' };
}

/** Whether `text` is a metre the transcription can write (parseMetre); an
 *  empty one is "Auto". */
export function metreValid(text: string | undefined): boolean {
  return !text?.trim() || parseMetre(text) !== null;
}

/** What the transcriber is handed. */
export function transcribeSettingsOf(settings: TranscriptionSettings): TranscribeSettings {
  const metre = settings.metre?.trim();
  return {
    ...(metre && parseMetre(metre) ? { metre } : {}),
    ...(settings.key ? { key: settings.key } : {}),
  };
}

const MODE_WORD: Record<string, string> = { maj: 'major', min: 'minor', dor: 'dorian', mix: 'mixolydian' };

/** The key of an ABC text as TheSession writes a key ("Gmajor", "F#minor") —
 *  the card's key tag (tagGroups.ts keyTag) — or null. */
export function sessionKeyOf(abc: string): string | null {
  const m = /^K:\s*([A-G][#b]?)(maj|min|dor|mix)/m.exec(abc);
  return m ? m[1]! + MODE_WORD[m[2]!]! : null;
}
