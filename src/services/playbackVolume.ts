import { signal } from '@preact/signals';

// ── How loud Cadence plays ───────────────────────────────────────────────────
// One setting for everything the app itself plays: the audio player of an
// attachment, a session's recording and its passages, and a score's synth.
// Asked for on 2026-10-12 by someone on a Linux laptop for whom Cadence was
// "much louder than YouTube" — which it can be on its own terms: YouTube
// normalises loudness, Cadence plays a file as it is, and abcjs boosts its
// default soundfont threefold (see ABCJS_SOUNDFONT_MULTIPLIER).
//
// Per DEVICE, in localStorage, like the theme: it is the laptop that is too
// loud, not the phone, and a level synced through Drive would turn one down
// to fix the other. Never in the user blob.
//
// What it does not reach: a video's own controls, an embedded page (YouTube),
// and on an iPhone the <audio> elements, whose `volume` iOS ignores — the
// hardware buttons own it there. The Web Audio paths do follow it on iOS too.

const LS_KEY = 'cadence_playback_volume';
export const DEFAULT_VOLUME_PERCENT = 100;

function read(): number {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw === null) return DEFAULT_VOLUME_PERCENT;
    const n = parseInt(raw, 10);
    return isNaN(n) ? DEFAULT_VOLUME_PERCENT : Math.max(0, Math.min(100, n));
  } catch {
    return DEFAULT_VOLUME_PERCENT;
  }
}

/** The setting as shown, 0–100. A signal so a player already playing follows
 *  the slider while it is being moved. */
export const playbackVolumePercent = signal<number>(read());

export function setPlaybackVolumePercent(percent: number): void {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  playbackVolumePercent.value = p;
  try {
    // Absent rather than stored at the default, like the other device prefs.
    if (p === DEFAULT_VOLUME_PERCENT) localStorage.removeItem(LS_KEY);
    else localStorage.setItem(LS_KEY, String(p));
  } catch { /* private mode: the level lasts as long as the page */ }
}

/** The amplitude factor, 0–1. Squared rather than linear: loudness is heard on
 *  a logarithmic scale, and a linear slider does almost nothing over its top
 *  half and everything in its last few percent. At 50 % this is −12 dB, which
 *  is roughly what "half as loud" sounds like. */
export function playbackGain(percent = playbackVolumePercent.value): number {
  const v = percent / 100;
  return v * v;
}

/** What abcjs multiplies its samples by when nobody says otherwise — for the
 *  FluidR3 soundfont it loads by default (create-synth.js, read in the source:
 *  3.0 for FluidR3 and MusyngKite, 0.4 for its original fonts). Passing our own
 *  `soundFontVolumeMultiplier` REPLACES that default, so the boost has to be
 *  carried over or 100 % would play three times quieter than before. */
const ABCJS_SOUNDFONT_MULTIPLIER = 3.0;

/** `soundFontVolumeMultiplier` for an abcjs synth. Baked in when the sound is
 *  prepared, so a change reaches a score at its next preparation (reopening
 *  it, changing version or instrument), not mid-phrase. */
export function abcjsVolumeMultiplier(): number {
  return ABCJS_SOUNDFONT_MULTIPLIER * playbackGain();
}
