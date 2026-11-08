import { signal } from '@preact/signals';
import { isAppleTouchDevice } from '../utils';

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

/** Which of Cadence's own installs this device already has, as far as the
 *  browser will say (2026-11-08, for the welcome screen, which shows both ways
 *  in with their state). From `navigator.getInstalledRelatedApps`, against the
 *  `related_applications` of manifest.json:
 *  - the web app: Chrome on Android (84+) and on a computer (140+), from a page
 *    within the manifest's scope;
 *  - the Play app: Chrome on Android (80+), and only from an app version whose
 *    AndroidManifest declares this site in `asset_statements`.
 *  Everywhere else both stay false, which reads as "not known to be installed",
 *  never as "not installed". The web app also turns true on `appinstalled`. */
export const installedSignal = signal<{ webApp: boolean; play: boolean }>({ webApp: false, play: false });

/** The Android app's application id (capacitor.config.ts). */
export const PLAY_APP_ID = 'io.github.batpapa.cadence';

interface RelatedApp { platform: string; id?: string; url?: string }

function queryInstalledApps(): void {
  const query = (navigator as { getInstalledRelatedApps?: () => Promise<RelatedApp[]> }).getInstalledRelatedApps;
  if (!query) return;
  // Silent on failure (an iframe, a browser that throws instead of answering):
  // the welcome screen then simply offers both installs.
  void query.call(navigator).then(apps => {
    const webApp = apps.some(a => a.platform === 'webapp');
    const play = apps.some(a => a.platform === 'play' && a.id === PLAY_APP_ID);
    if (webApp || play) installedSignal.value = { webApp: installedSignal.value.webApp || webApp, play };
  }).catch(() => { /* see above */ });
}

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
    installedSignal.value = { ...installedSignal.value, webApp: true };
  });
  queryInstalledApps();
}

export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (navigator as any).standalone === true;
}

export function isIOS(): boolean {
  return isAppleTouchDevice();
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
