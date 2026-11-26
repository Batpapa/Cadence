// ── Keeping the screen on ────────────────────────────────────────────────────
// While a recording runs with the phone on the table, while a score or a PDF
// is read from a music stand without being touched. One implementation since
// 2026-11-26: the viewer had its own, which also released a lock that arrived
// after it was let go — this one used to keep such a lock for good.
//
// Every step is optional: the API is absent on some browsers, the request is
// refused when the page is not visible (or by a battery saver), and the system
// drops the lock whenever the tab goes to the background — which is why it is
// taken again on `visibilitychange` rather than assumed to hold.

export class WakeLockManager {
  private sentinel: WakeLockSentinel | null = null;
  private active = false;
  private onVisibility = () => {
    if (this.active && document.visibilityState === 'visible') void this.acquire();
  };

  /** Asks for the lock, and for it again each time the page comes back.
   *  Resolves once asked, whether or not it was granted. */
  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    await this.acquire();
  }

  stop(): void {
    this.active = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    const held = this.sentinel;
    this.sentinel = null;
    void held?.release().catch(() => {});
  }

  private async acquire(): Promise<void> {
    try {
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      const sentinel = await navigator.wakeLock.request('screen');
      // Granted after stop(): let go at once, rather than held for a reader
      // or a recording that is no longer there.
      if (this.active) this.sentinel = sentinel;
      else void sentinel.release().catch(() => {});
    } catch {
      // Refused: everything goes on, the screen may sleep.
    }
  }
}
