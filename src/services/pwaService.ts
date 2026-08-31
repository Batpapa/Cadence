import { signal } from '@preact/signals';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;

/** Whether the browser has handed us an install prompt we can still fire.
 *  A signal rather than a getter: `beforeinstallprompt` lands whenever the
 *  browser finishes its installability checks (after the service worker takes
 *  control), which is routinely *after* the header first rendered. A plain
 *  read would leave the install affordance hidden until some unrelated
 *  re-render happened to notice it had become available. */
export const canInstallSignal = signal(false);

/** Must be called at module-eval time, NOT once the app has booted.
 *  The browser fires `beforeinstallprompt` exactly once per page load and the
 *  offer is lost for good if nobody was listening — and boot here is async
 *  (IndexedDB open, user load, per-user session DB) and can also stop at the
 *  user-selector screen without ever reaching the end, which is exactly where
 *  a first-time visitor sits when the browser makes that offer. */
export function initPWA(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    canInstallSignal.value = true;
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    canInstallSignal.value = false;
  });
}

export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (navigator as any).standalone === true;
}

export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

export async function triggerInstall(): Promise<void> {
  if (!deferredPrompt) return;
  await deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  // Single-use: the event object cannot be prompted twice, whatever the user
  // chose. A decline leaves the browser free to fire a fresh one later.
  deferredPrompt = null;
  canInstallSignal.value = false;
}
