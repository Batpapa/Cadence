import { t } from '../../services/i18nService';
import { logBg } from './bgDiagnostics';

// ── #17 background-throttling mitigation ──────────────────────────────────────
// Chrome/Android gives no signal at all when it silently stops feeding the
// recognition worklet in the background (confirmed on a real device: a
// multi-minute gap, AudioContext.state never left "running") — but apps that
// play real HTMLMediaElement audio with a declared MediaSession get treated
// like a music/podcast player and are known to be spared this throttling.
// This plays an inaudible-but-non-zero looping noise clip (pure digital
// silence can get optimized away / not dispatched to the OS media session on
// some browsers — Firefox notably) purely to make the tab look like it's
// "playing media" for as long as a live session runs. Independent of the
// AudioContext used for recognition/recording — if that one still gets
// interrupted, this element (a different browser subsystem) is the point.

const NOISE_DURATION_S = 1;
const NOISE_SAMPLE_RATE = 8000;
/** Amplitude out of 128 (8-bit unsigned PCM, 128 = silence) — inaudible in
 *  practice but never exactly zero, so it can't be mistaken for true silence. */
const NOISE_AMPLITUDE = 2;

function createQuietNoiseWavUrl(): string {
  const numSamples = NOISE_DURATION_S * NOISE_SAMPLE_RATE;
  const dataSize = numSamples; // 8-bit mono = 1 byte/sample
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
  view.setUint32(24, NOISE_SAMPLE_RATE, true);
  view.setUint32(28, NOISE_SAMPLE_RATE, true); // byte rate (1 byte/sample)
  view.setUint16(32, 1, true);          // block align
  view.setUint16(34, 8, true);          // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < numSamples; i++) {
    view.setUint8(44 + i, 128 + Math.round((Math.random() - 0.5) * 2 * NOISE_AMPLITUDE));
  }

  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

let audioEl: HTMLAudioElement | null = null;
let objectUrl: string | null = null;

/** Idempotent — safe to call even if already running. */
export function startBackgroundKeepAlive(): void {
  if (audioEl) return;
  objectUrl = createQuietNoiseWavUrl();
  audioEl = new Audio(objectUrl);
  audioEl.loop = true;
  // Real (if inaudible) volume, not 0 — a muted element risks being treated
  // the same as no audio at all by the same throttling this is working around.
  audioEl.volume = 1;
  audioEl.play().then(
    () => logBg('keepalive: playing'),
    (e) => logBg(`keepalive: play() rejected — ${String(e)}`),
  );

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
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'none';
    navigator.mediaSession.metadata = null;
  }
}
