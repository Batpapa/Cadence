import { logBg } from './bgDiagnostics';

// ── Microphone capture + screen wake lock ─────────────────────────────────────

/**
 * Opens the microphone with music-friendly constraints.
 * echoCancellation / noiseSuppression / autoGainControl default to ON and are
 * tuned for voice — they wreck music (killed harmonics, pumping AGC), so they
 * are explicitly disabled.
 */
export async function openMicForMusic(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
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
    logBg(`visibilitychange: ${document.visibilityState}`);
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
      if (!('wakeLock' in navigator)) { logBg('wakelock: API unavailable'); return; }
      this.sentinel = await navigator.wakeLock.request('screen');
      logBg('wakelock: acquired');
      this.sentinel.addEventListener('release', () => logBg('wakelock: released'), { once: true });
    } catch (e) {
      // Denied (battery saver…) — recording continues, screen may sleep.
      logBg(`wakelock: acquire failed — ${String(e)}`);
    }
  }
}
