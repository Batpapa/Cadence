// What kind of audio the page makes, told to the system — Safari 16.4+ only
// (`navigator.audioSession`); elsewhere every call here does nothing.
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

type AudioSessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';

function session(): { type: AudioSessionType } | undefined {
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
