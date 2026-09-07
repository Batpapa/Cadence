// ── Microphone / device audio capture + screen wake lock ─────────────────────

/** Music-friendly audio constraints, shared by both live sources.
 *  echoCancellation / noiseSuppression / autoGainControl default to ON and are
 *  tuned for voice — they wreck music (killed harmonics, pumping AGC), so they
 *  are explicitly disabled. */
const MUSIC_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
} as const;

/** Opens the microphone with music-friendly constraints. */
export async function openMicForMusic(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: { ...MUSIC_AUDIO_CONSTRAINTS } });
}

// ── Device audio capture: a tab, a window, or the whole machine ──────────────

/** Why a local type: lib.dom's DisplayMediaStreamOptions only declares `audio`
 *  and `video` (checked in this repo's TypeScript). The surface-selection and
 *  system-audio hints below are real, specified members that the bundled
 *  typings simply haven't caught up with — declaring them here beats casting
 *  the whole options object to `any` and losing every other check with it. */
interface DisplayMediaOptions extends DisplayMediaStreamOptions {
  systemAudio?: 'include' | 'exclude';
  selfBrowserSurface?: 'include' | 'exclude';
  monitorTypeSurfaces?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
  preferCurrentTab?: boolean;
}

/** Thrown when the browser implements getDisplayMedia but hands back no audio
 *  track. Two very different causes, indistinguishable from here:
 *   - the user forgot to tick "share audio" in the picker;
 *   - the browser cannot do it at all (Firefox ignores `audio` entirely and
 *     reports no error; Safari, desktop and iOS, has never supported it).
 *  The caller words the message for both, since we cannot tell them apart. */
export class NoCapturedAudioError extends Error {
  constructor() { super('no-captured-audio'); this.name = 'NoCapturedAudioError'; }
}

/** Thrown when the browser has no getDisplayMedia at all (iOS Safari, Android). */
export class DisplayCaptureUnsupportedError extends Error {
  constructor() { super('display-capture-unsupported'); this.name = 'DisplayCaptureUnsupportedError'; }
}

/**
 * Opens whatever the user picks in the browser's share dialog - a tab, a
 * window, or a whole screen with its system audio - as an AUDIO source.
 *
 * Must be called from a user gesture — the spec requires transient activation
 * and Chrome enforces it. Nothing may be awaited between the click and this
 * call, which is why LiveSession.start() opens its source before anything else.
 *
 * The video track is collateral damage: `video: false` rejects with a TypeError
 * because getDisplayMedia is specified to always produce one. We therefore ask
 * for the cheapest frames the browser will agree to and stop the track as soon
 * as the stream is in hand — Chrome keeps the audio flowing and drops the
 * screen capturer, so nothing decodes or paints a single frame after this.
 */
export async function openDeviceAudio(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new DisplayCaptureUnsupportedError();

  const options: DisplayMediaOptions = {
    // Constraints, not exact values: the browser is free to ignore them, and a
    // rejected constraint here would cost us the whole capture over frames we
    // are about to throw away anyway.
    video: { frameRate: { max: 1 }, width: { max: 160 }, height: { max: 120 } },
    audio: {
      ...MUSIC_AUDIO_CONSTRAINTS,
      // The user has to keep hearing what they are sharing — `true` would
      // mute it locally while we record it, which looks exactly like a bug.
      suppressLocalAudioPlayback: false,
    } as MediaTrackConstraints,
    // Windows/ChromeOS only, and a hint the browser may ignore: lets the
    // "Share system audio" checkbox appear when a whole screen is picked.
    systemAudio: 'include',
    monitorTypeSurfaces: 'include',
    // Capturing Cadence itself would record silence and nothing else.
    selfBrowserSurface: 'exclude',
    // Lets the user move the capture to another tab without restarting the
    // session — the track stays the same one, so we never even notice.
    surfaceSwitching: 'include',
  };

  const stream = await navigator.mediaDevices.getDisplayMedia(options);

  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach(trk => trk.stop());
    throw new NoCapturedAudioError();
  }
  stream.getVideoTracks().forEach(trk => { stream.removeTrack(trk); trk.stop(); });
  return stream;
}

/**
 * Keeps the screen awake while recording (phone on the table for two hours).
 * Re-acquires the lock when the tab becomes visible again — the browser
 * silently releases it on visibility loss.
 */
export class WakeLockManager {
  private sentinel: WakeLockSentinel | null = null;
  private active = false;
  private onVisibility = () => {
    if (this.active && document.visibilityState === 'visible') void this.acquire();
  };

  async start(): Promise<void> {
    this.active = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    await this.acquire();
  }

  stop(): void {
    this.active = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    void this.sentinel?.release();
    this.sentinel = null;
  }

  private async acquire(): Promise<void> {
    try {
      if (!('wakeLock' in navigator)) return;
      this.sentinel = await navigator.wakeLock.request('screen');
    } catch {
      // Denied (battery saver…) — recording continues, screen may sleep.
    }
  }
}
