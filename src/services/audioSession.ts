// What kind of audio the page makes, told to the system — Safari 16.4+ only
// (`navigator.audioSession`); elsewhere every call here does nothing. The
// Android app's audio focus, at the end, is the same idea on the other side.
//
// Why it matters on an iPhone: left to itself, WebKit files Web Audio under
// "ambient" sound, which the ring/silent switch mutes. <audio> elements play
// through it, so a muted phone played a session's passages and nothing else:
// the audio player (an AudioWorklet), the score's synth and the incipit were
// all dead silent, with no error anywhere. "playback" is the category of a
// music player, which is what Cadence is when it plays something.
//
// A live recording needs the microphone too, which "playback" does not allow:
// capture takes "play-and-record" for its whole duration and hands back "auto"
// after, so WebKit is free to choose again until the next play.

import { isNative } from '../native/platform';

type AudioSessionType ='auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';

function session(): { type: AudioSessionType } | undefined {
  // No `navigator` at all under Node before 21 — the nightly CI's Node 20,
  // where the capture test died on it (2026-10-18) while Node 26 passed.
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { audioSession?: { type: AudioSessionType } }).audioSession;
}

let captures = 0;

/** Before playing anything through Web Audio. Ignored during a capture. */
export function preferPlaybackSession(): void {
  const s = session();
  if (s && captures === 0 && s.type !== 'playback') s.type = 'playback';
}

/** abcjs plays every score and incipit through ONE shared context that it
 *  keeps at `window.abcjsAudioContext` (register-audio-context.js), created
 *  the first time it needs one — usually after an import or a soundfont
 *  download, so outside the tap. Safari only lets a context start inside the
 *  tap itself; started late, it refuses and the first press played nothing.
 *  Called synchronously from the tap, this creates or resumes that context
 *  then, and the playback session with it. */
export function unlockAbcjsAudio(): void {
  preferPlaybackSession();
  const w = window as Window & { abcjsAudioContext?: AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = window.AudioContext ?? w.webkitAudioContext;
  if (!w.abcjsAudioContext && Ctor) w.abcjsAudioContext = new Ctor();
  const ctx = w.abcjsAudioContext;
  const state = ctx?.state as string | undefined;
  if (ctx && (state === 'suspended' || state === 'interrupted')) void ctx.resume().catch(() => { /* refused: nothing to add */ });
}

/** Before opening the microphone. Pair with endCaptureSession(). */
export function beginCaptureSession(): void {
  captures++;
  const s = session();
  if (s) s.type = 'play-and-record';
}

export function endCaptureSession(): void {
  if (captures === 0) return;
  captures--;
  const s = session();
  if (s && captures === 0) s.type = 'auto';
}

// ── Android app: the audio focus ─────────────────────────────────────────────
// Android shares the speaker by "focus": a player asks for it when it starts,
// and the one that had it pauses. Chromium asks on behalf of <audio> and
// <video> (measured on the emulator, 2026-10-15: its AudioFocusDelegate sits
// on Android's focus stack as soon as a session's recording plays), but an
// AudioContext never does — so the attachment player and the score's synth
// played over YouTube, and YouTube over them (reported 2026-10-12).
// These two are claimed here, through the app's own plugin (AudioFocusPlugin).
//
// Not for the short sounds — a tapped note, an incipit's two bars: pausing
// someone's music for good over three seconds of sound would be worse than
// playing over it. And never during a live: in the app, a live may be
// recording that very music, from the device itself.

let focusHolder: (() => void) | null = null;
/** One import for every claim and release, so they reach the plugin in order. */
let focusModule: Promise<typeof import('../native/audioFocus')> | null = null;
const audioFocus = () => (focusModule ??= import('../native/audioFocus'));

/** A Web Audio player starts playing. `pause` is how it is stopped when
 *  another app takes the sound. Does nothing in a browser. */
export function claimAudioFocus(pause: () => void): void {
  if (!isNative() || captures > 0) return;
  focusHolder = pause;
  void audioFocus()
    .then(m => m.requestAudioFocus(onAudioFocusLost))
    .catch((err: unknown) => console.warn('[native] audio focus not requested', err));
}

/** The player that claimed it stopped. Another one's claim is left alone. */
export function releaseAudioFocus(pause: () => void): void {
  if (focusHolder !== pause) return;
  focusHolder = null;
  void audioFocus()
    .then(m => m.abandonAudioFocus())
    .catch(() => { /* nothing held */ });
}

/** For good or for a moment (a call): paused either way, never resumed on our
 *  own — nobody expects music to start again behind their back. */
function onAudioFocusLost(): void {
  const pause = focusHolder;
  focusHolder = null;
  pause?.();
}
