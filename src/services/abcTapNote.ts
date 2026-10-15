// ── A tapped note, heard on its own ─────────────────────────────────────────────
// Tapping a note on the score, or in the ABC text, sounds it while nothing
// plays (asked 2026-10-15: someone writing ABC by hand checks each note as it
// goes). abcjs has `synth.playEvent` for this, and it is not used: it plays at
// the soundfont's own loudness — the app's volume never reaches it — and holds
// a note for as long as it is written, so a tied minim in a slow air went on
// for seconds. What it does is done here instead, with those two changed.

import { abcjsVolumeMultiplier } from './playbackVolume';

/** One pitch of a note, as abcjs's MIDI flattener leaves it on the element
 *  (`midiPitches`) and on the timer's events. `duration` is in whole notes. */
export interface MidiPitch { pitch: number; duration?: number; instrument?: number; cents?: number }
/** A grace note, as abcjs leaves it (`midiGraceNotePitches`). */
export interface MidiGracePitch { pitch: number; instrument?: number; cents?: number }

/** One voice of what is played: its instrument and its notes in turn. */
export interface TapTrack { instrument: number; notes: { pitch: number; seconds: number; volume: number; cents?: number }[] }

/** Long enough to tell the pitch of a sixteenth in a fast reel, short enough
 *  that a held note is not still sounding at the next tap. */
export const TAP_MIN_SECONDS = 0.3;
export const TAP_MAX_SECONDS = 1;
/** A cut or a roll's grace, as abcjs's own playEvent plays them (1/64). */
export const TAP_GRACE_SECONDS = 0.06;
/** Even, rather than the note's own: the flattener accents the beat, and taps
 *  along a bar would come out loud, soft, soft. */
const TAP_VOLUME = 100;
const TAP_GRACE_VOLUME = 70;

/** What a tap plays: each pitch of the note (a chord is several) on a track of
 *  its own, the graces before the first, the length clamped. `program` is the
 *  instrument chosen in the viewer, which wins over the tune's own. Empty for
 *  a rest. */
export function tapTracks(
  pitches: readonly MidiPitch[], graces: readonly MidiGracePitch[] | null | undefined,
  secondsPerWhole: number, program: number | undefined,
): TapTrack[] {
  return pitches.map((p, i) => {
    const instrument = program ?? p.instrument ?? 0;
    const written = (p.duration ?? 0.25) * secondsPerWhole;
    const seconds = Math.min(TAP_MAX_SECONDS, Math.max(TAP_MIN_SECONDS, written));
    const notes: TapTrack['notes'] = [];
    if (i === 0) {
      for (const g of graces ?? []) notes.push({ pitch: g.pitch, seconds: TAP_GRACE_SECONDS, volume: TAP_GRACE_VOLUME, cents: g.cents });
    }
    notes.push({ pitch: p.pitch, seconds, volume: TAP_VOLUME, cents: p.cents });
    return { instrument, notes };
  });
}

/** The note at `char` in the source of a tune read by abcjs.parseOnly and
 *  then `setUpAudio` — which is what leaves `midiPitches` on each element.
 *  Null for anything that does not sound: a rest, a bar line, a header. */
export function tappedNote(tune: unknown, char: number): { pitches: MidiPitch[]; graces: MidiGracePitch[] | null } | null {
  const lines = (tune as { lines?: unknown[] } | null)?.lines;
  if (!Array.isArray(lines)) return null;
  for (const line of lines) {
    const staves = (line as { staff?: unknown[] }).staff;
    if (!Array.isArray(staves)) continue;
    for (const staff of staves) {
      const voices = (staff as { voices?: unknown[][] }).voices;
      if (!Array.isArray(voices)) continue;
      for (const voice of voices) {
        if (!Array.isArray(voice)) continue;
        for (const el of voice as { el_type?: string; startChar?: number; endChar?: number; midiPitches?: MidiPitch[]; midiGraceNotePitches?: MidiGracePitch[] }[]) {
          if (el.el_type !== 'note' || typeof el.startChar !== 'number' || typeof el.endChar !== 'number') continue;
          if (char < el.startChar || char >= el.endChar) continue;
          return el.midiPitches?.length ? { pitches: el.midiPitches, graces: el.midiGraceNotePitches ?? null } : null;
        }
      }
    }
  }
  return null;
}

/** The setting, read in one place. Absent = on. */
export function tapPlaysNote(st: { abcTapPlaysNote?: boolean }): boolean {
  return st.abcTapPlaysNote !== false;
}

/** Seconds a whole note lasts, from a tune abcjs has read: its measure's
 *  length at its tempo, at the viewer's speed. */
export function secondsPerWhole(
  tune: { millisecondsPerMeasure: () => number; getMeterFraction: () => { num: number; den: number } },
  tempoPercent: number,
): number {
  const meter = tune.getMeterFraction();
  const size = meter.num > 0 && meter.den > 0 ? meter.num / meter.den : 1;
  return tune.millisecondsPerMeasure() / 1000 / size * 100 / Math.max(1, tempoPercent);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sounding: any = null;
let tapId = 0;

/** Plays it. A tap cuts the one before it short: taps along a bar are heard
 *  one after the other, not piled up. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function playTap(abcjs: any, tracks: readonly TapTrack[]): void {
  stopTap();
  if (tracks.length === 0) return;
  const id = ++tapId;
  const sequence = new abcjs.synth.SynthSequence();
  for (const track of tracks) {
    const n = sequence.addTrack();
    sequence.setInstrument(n, track.instrument);
    // With a sequence, CreateSynth reads durations in measures of
    // `millisecondsPerMeasure` (1000 below) over a meter of 1: in seconds.
    for (const note of track.notes) sequence.appendNote(n, note.pitch, note.seconds, note.volume, note.cents);
  }
  const synth = new abcjs.synth.CreateSynth();
  void synth.init({
    sequence,
    millisecondsPerMeasure: 1000,
    options: { soundFontVolumeMultiplier: abcjsVolumeMultiplier() },
  })
    .then(() => synth.prime())
    .then(() => {
      // Another tap came in while the soundfont was loading.
      if (id !== tapId) return;
      sounding = synth;
      synth.start();
    })
    .catch((err: unknown) => console.warn('[abc] could not play the note', err));
}

/** Cuts the note short — at another tap, and when the music starts. */
export function stopTap(): void {
  tapId++;
  const synth = sounding;
  sounding = null;
  try { synth?.stop(); } catch { /* already over */ }
}
