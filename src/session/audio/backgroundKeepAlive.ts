import { t } from '../../services/i18nService';
import { logBg } from './bgDiagnostics';

// ── #17 background-throttling mitigation ──────────────────────────────────────
// Chrome/Android gives no signal at all when it silently stops feeding the
// recognition worklet in the background (confirmed on a real device: a
// multi-minute gap, AudioContext.state never left "running") — but apps that
// play real HTMLMediaElement audio with a declared MediaSession get treated
// like a music/podcast player and are known to be spared this throttling.
// This plays a real (if soft) looping tone to make the tab look like it's
// "playing media" for as long as a live session runs — pure digital silence
// doesn't grant this. Independent of the AudioContext used for recognition/
// recording — if that one still gets interrupted, this element (a different
// browser subsystem) is the point.
//
// IMPORTANT, confirmed via Chrome's own background-tabs docs (not a guess):
// there IS a genuine minimum-audibility threshold here, BY DESIGN, precisely
// to defeat tricks like this one — "Chrome exempts tabs from background
// throttling if they are playing audio above a certain volume level, to avoid
// pages sticking silent audio elements in to circumvent these protections"
// (Firefox: same idea, tied to its tab-audio-icon heuristic). So this cannot
// be turned down to "inaudible even at max device volume" without risking it
// silently stopping the whole #17 mitigation from working at all — the two
// goals (quiet vs. actually exempted) are in tension, not just a dial to turn
// down freely. The amplitude below targets roughly the same loudness as the
// broadband-noise version that was FIELD-TESTED and confirmed to work
// (10 min locked, zero gap) — a single low tone at that same level reads as
// much softer/less harsh to a human ear than noise did, without gambling on
// an unverified, much quieter number. Any further reduction needs its own
// real background test before being trusted, not just a smaller constant.

// 1 s, not longer: tried 30 s first (spaces the once-per-loop pulse far
// enough apart to stop reading as a rhythm) and it field-tested fine for the
// throttling exemption itself, BUT it also made Android show a persistent
// lock-screen media-player widget with a 30 s scrubber — the 1 s version
// never triggered that. Trading the softer envelope back for staying
// invisible; the waveform still closes into a perfectly smooth cycle either
// way (TONE_FREQUENCY_HZ * TONE_DURATION_S is an integer, so the phase step
// from the last sample back to the first matches every other consecutive
// pair — no discontinuity at the seam, just the once-a-second repetition
// itself being perceptible).
const TONE_DURATION_S = 1;
const TONE_SAMPLE_RATE = 8000;
/** Low and soft, not a frequency anyone would consciously pick out. */
const TONE_FREQUENCY_HZ = 55;
/** Amplitude out of 32767 (16-bit signed PCM) — matches the relative loudness
 *  of the field-tested noise version's ±2/128 (8-bit), not lower. */
const TONE_AMPLITUDE = 500;

function createSoftHumWavUrl(): string {
  const numSamples = TONE_DURATION_S * TONE_SAMPLE_RATE;
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, TONE_SAMPLE_RATE, true);
  view.setUint32(28, TONE_SAMPLE_RATE * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true);         // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  // TONE_FREQUENCY_HZ * TONE_DURATION_S is an integer (55 cycles in 1 s), so
  // the waveform's phase at the end exactly matches its phase at the start —
  // loops with no click at the seam.
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(TONE_AMPLITUDE * Math.sin((2 * Math.PI * TONE_FREQUENCY_HZ * i) / TONE_SAMPLE_RATE));
    view.setInt16(44 + i * 2, sample, true);
  }

  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

let audioEl: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let onVisibility: (() => void) | null = null;

/** Idempotent — safe to call even if already running. Playback starts
 *  immediately (foreground, inside the same user-gesture chain as the
 *  "start recording" tap) and never stops for the rest of the session —
 *  only `volume` toggles with visibility. Starting playback FROM a hidden
 *  tab is a much less reliable move: background tabs are exactly where
 *  autoplay-with-sound is most aggressively blocked, i.e. the one moment a
 *  fresh `.play()` call is least likely to be honoured. Muted-but-playing
 *  while visible sidesteps that entirely, and foreground tabs were never
 *  the ones getting throttled anyway — audible only needs to happen once
 *  hidden. */
export function startBackgroundKeepAlive(): void {
  if (audioEl) return;
  objectUrl = createSoftHumWavUrl();
  audioEl = new Audio(objectUrl);
  audioEl.loop = true;
  audioEl.volume = document.hidden ? 1 : 0;
  audioEl.play().then(
    () => logBg('keepalive: playing'),
    (e) => logBg(`keepalive: play() rejected — ${String(e)}`),
  );

  onVisibility = () => {
    if (!audioEl) return;
    audioEl.volume = document.hidden ? 1 : 0;
    logBg(`keepalive: volume=${audioEl.volume}`);
  };
  document.addEventListener('visibilitychange', onVisibility);

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t('sessions.recordingMediaTitle'),
    });
    navigator.mediaSession.playbackState = 'playing';
  }
}

export function stopBackgroundKeepAlive(): void {
  audioEl?.pause();
  audioEl = null;
  if (onVisibility) { document.removeEventListener('visibilitychange', onVisibility); onVisibility = null; }
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'none';
    navigator.mediaSession.metadata = null;
  }
}
