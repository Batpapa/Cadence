import { FolkFriendWASM } from '../../../vendor/folkfriend/folkfriend.js';
import { FF_PCM_WINDOW } from '../sessionConfig';
import { Novelty, estimateRate } from '../liveTempo';
import { transcribe, quaverContour, keyOfAbc, makeKey, modeOn, writeAbc, type Metre, type Mode } from './transcription';
import { hear, gridNovelty, asClassNotes } from '../../../transcriptor/src/decoder.ts';
import { FolkFriendView } from './folkfriendView';

// ── A recording written as ABC ───────────────────────────────────────────────
// The Transcription module's whole chain, out of scoreFollowWorker.ts (2026-11-26) so that a
// test can run it end to end in Node on scenes whose truth is known (transcribeAudio.test.ts).
// One engine of its own, keeping the frames' spectra (keep_magnitudes): the 48-note energies
// read off them (take_magnitude_features — take_features' bit for bit, the PCM not fed twice)
// for the novelty (liveTempo.ts), the tempo, the quaver grid, the metre and the bars; the notes
// from transcriptor/'s decoder, with FolkFriend's cleaned class energies as its extra view
// (folkfriendView.ts — the regime the recognition decodes in as well); then FolkFriend's key
// detection (contour_to_abc's K: line) on the notes found. The transcriptor's research journal
// (outside the repo) has every measurement.

/** FolkFriend's contour alphabet: one letter a semitone from MIDI 48. */
const CONTOUR_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV';

/** What the user may say of the recording beforehand (the Transcription module's settings): each
 *  one given replaces what would be told from the recording. Nothing here changes which notes
 *  are heard — the metre places the bars, the key spells the notes. No tempo: the user found
 *  it of no use (2026-11-28), the grid's own is kept. */
export interface TranscribeSettings {
  /** The metre, as M: writes it (parseMetre): else 4/4 or 6/8, told from the recording. */
  metre?: Metre;
  /** The key: its tonic's pitch class (0 = C) and its mode — or the tonic alone, the mode
   *  then the one whose scale holds the notes best (modeOn). Else FolkFriend's key detection. */
  key?: { tonic: number; mode?: Mode };
}

/** The ABC of `pcm` at `rate` — its M:, L:, Q:, K: lines and the tune — or null when no tune
 *  was heard. FolkFriend's module must be initialised (and the transcriptor's WebAssembly
 *  analysis, else the TypeScript one runs). */
export function transcribeAudio(pcm: Float32Array, rate: number, onRatio: (r: number) => void = () => {}, settings: TranscribeSettings = {}): string | null {
  const f = new FolkFriendWASM();
  const view = new FolkFriendView(rate);
  try {
    f.set_sample_rate(rate);
    f.keep_magnitudes();
    const at = f.alloc_single_pcm_window();
    const n = Math.floor(pcm.length / FF_PCM_WINDOW);
    for (let i = 0; i < n; i++) {
      f.get_allocated_pcm_window(at).set(pcm.subarray(i * FF_PCM_WINDOW, (i + 1) * FF_PCM_WINDOW));
      f.feed_single_pcm_window(at);
      if ((i & 255) === 0) onRatio((0.2 * i) / n);
    }
    const extra = view.of(pcm);
    const features = f.take_magnitude_features();
    onRatio(0.3);
    const fps = rate / FF_PCM_WINDOW;
    const heard = hear(pcm, rate, r => onRatio(0.3 + 0.65 * r), extra);
    const classes = asClassNotes(heard.notes, fps);
    onRatio(0.95);
    const novelty = new Novelty().of(features);
    const { metre, key: givenKey } = settings;
    const quaverRate = estimateRate(novelty, fps)?.rate;
    if (!quaverRate) return null;
    const tune = transcribe(classes, gridNovelty(novelty, heard, FF_PCM_WINDOW), features, fps, quaverRate, novelty, metre);
    if (!tune) return null;
    if (givenKey?.mode) return writeAbc(tune, makeKey(givenKey.tonic, givenKey.mode));
    const pitches = quaverContour(tune);
    const contour = pitches.map(m => CONTOUR_CHARS[Math.min(95, Math.max(48, m)) - 48]).join('');
    const detected = contour.length ? keyOfAbc(f.contour_to_abc(contour)) : null;
    if (!givenKey) return writeAbc(tune, detected ?? makeKey(0, 'maj'));
    // the tonic given, its mode told from the notes; the detected key's mode breaks a tie
    const heardMode = detected && detected.tonic.pc === givenKey.tonic ? (detected.name.slice(-3) as Mode) : undefined;
    return writeAbc(tune, makeKey(givenKey.tonic, modeOn(pitches, givenKey.tonic, heardMode)));
  } finally {
    f.free();
    view.free();
  }
}
