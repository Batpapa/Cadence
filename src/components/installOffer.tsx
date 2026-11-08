import { canInstallSignal, installedSignal, isStandalone, isIOS, triggerInstall, PLAY_APP_ID } from '../services/pwaService';
import { isMacSafariInstallable } from '../utils';
import { isNative } from '../native/platform';
import { t } from '../services/i18nService';
import { showModal, closeModal } from './modal';

// ── Installing Cadence ───────────────────────────────────────────────────────
// Shared by the header's ⋮ menu and the welcome screen (2026-10-26), the day
// the Android app went live on Google Play.

export const PLAY_STORE_URL = `https://play.google.com/store/apps/details?id=${PLAY_APP_ID}`;

/** Whether the Play app can be offered to anyone. False while the listing was
 *  open to the testers only (2026-10-26): everyone else would have landed on a
 *  page that says the app is not available. Public since 2026-10-28. */
export const PLAY_STORE_LIVE = true;

/** Android, in a browser — not inside the app itself, which says Android too —
 *  and the Play app public: where the Play app is the step up. */
export function offersPlayApp(): boolean {
  return PLAY_STORE_LIVE && /Android/.test(navigator.userAgent) && !isNative();
}

/** What installing takes here, or null when there is nothing better to offer.
 *  Always the best step up from where the user is — native app > web app >
 *  website (the author's order, 2026-10-26) — and straight to it, with no
 *  window of choices in between (tried and dropped the same day):
 *  - Android, from the website or the installed web app: the Play app;
 *  - elsewhere, the web app: a live `beforeinstallprompt` (Chrome/Edge), or iOS
 *    and Mac Safari, where no page can start an install and the steps have to
 *    be spelled out. Gone once installed (standalone).
 *
 *  Reads canInstallSignal: a component calling it during render re-renders when
 *  the browser's offer arrives. */
export function installAction(): (() => void) | null {
  const webApp = webAppInstallAction();
  if (isNative()) return null;
  if (offersPlayApp()) return openPlayStore;
  return webApp;
}

export const openPlayStore = (): void => { window.open(PLAY_STORE_URL, '_blank', 'noopener'); };

/** One install as the welcome screen shows it (2026-11-08): always there, and
 *  saying where it stands — installable, already installed, or not possible
 *  here and why (the author: "if an install is not possible, say so; if it is
 *  already done, say so too"). `reason` is an i18n key. */
export type InstallState =
  | { kind: 'install'; run: () => void }
  /** `run` opens it, where a page can; otherwise `hint` says where it is. */
  | { kind: 'installed'; run?: () => void; hint?: string }
  /** `run`, when set, still leads somewhere: the Android app's listing from
   *  an iPhone (the author: it must navigate to the store all the same). */
  | { kind: 'unavailable'; reason: string; run?: () => void };

/** Opens the Android app from Chrome: an intent on the app's own scheme (the
 *  BROWSABLE filter in AndroidManifest.xml), falling back to the Play listing —
 *  which, for an installed app, shows "Open". Only offered once Chrome has
 *  reported the app installed, which takes the same app version as the filter;
 *  the fallback covers any mismatch. */
function openNativeApp(): void {
  location.href = `intent://open#Intent;scheme=${PLAY_APP_ID};package=${PLAY_APP_ID};`
    + `S.browser_fallback_url=${encodeURIComponent(PLAY_STORE_URL)};end`;
}

/** The web app. "Installed" only when known: running as one, installed during
 *  this visit, or reported by the browser (installedSignal) — iOS never says,
 *  and there the offer simply stays. No page can open an installed web app, so
 *  outside it the tile only says where to find it. A Chromium browser that has
 *  not (yet) handed over its prompt, or any Android browser, can still install
 *  from its own menu, so it gets the steps rather than a "not possible". */
export function webAppInstallState(): InstallState {
  const run = webAppInstallAction();
  const installed = installedSignal.value.webApp;
  if (isNative()) return { kind: 'unavailable', reason: 'welcome.install.notFromApp' };
  if (isStandalone()) return { kind: 'installed', hint: 'welcome.install.thisOne' };
  if (installed) return { kind: 'installed', hint: 'welcome.install.openFromIcon' };
  if (run) return { kind: 'install', run };
  if (/Android/.test(navigator.userAgent) || 'BeforeInstallPromptEvent' in window) {
    return { kind: 'install', run: () => showSteps('welcome.install.browserMenu') };
  }
  return { kind: 'unavailable', reason: 'welcome.install.notThisBrowser' };
}

/** The Android app. Installed when running in it, or when Chrome on Android
 *  reports it (only from app versions declaring this site, see installedSignal),
 *  and then opened by the tile. On an iPhone it stays on show, marked
 *  "Android only": an Apple user should still learn that it exists (the
 *  author, 2026-11-08). A computer keeps the offer: the Play listing installs
 *  onto the visitor's phone from there. */
export function playInstallState(): InstallState {
  const installed = installedSignal.value.play;
  if (isNative()) return { kind: 'installed', hint: 'welcome.install.thisOne' };
  if (installed) return { kind: 'installed', run: openNativeApp };
  if (!PLAY_STORE_LIVE) return { kind: 'unavailable', reason: 'welcome.install.notYet' };
  if (isIOS()) return { kind: 'unavailable', reason: 'welcome.install.androidOnly', run: openPlayStore };
  return { kind: 'install', run: openPlayStore };
}

function showSteps(key: string): void {
  const body = document.createElement('p');
  body.className = 'text-sm text-muted leading-relaxed';
  body.textContent = t(key);
  showModal(t('settings.install'), body, [{ label: t('common.close'), primary: true, onClick: closeModal }]);
}

/** Installing the web app, whatever else is on offer — the welcome screen's
 *  "Web app" button, and installAction's fallback where Play is not the step
 *  up. Null in the app itself, once installed, and where no page can start an
 *  install nor the steps be spelled out.
 *
 *  Reads canInstallSignal first, before any early return: a component calling
 *  it during render must subscribe whatever the outcome. */
export function webAppInstallAction(): (() => void) | null {
  const canPrompt = canInstallSignal.value;
  if (isNative() || isStandalone()) return null;
  const ios = isIOS();
  if (!canPrompt && !ios && !isMacSafariInstallable()) return null;
  return () => {
    if (canPrompt) { void triggerInstall(); return; }
    showSteps(ios ? 'settings.installIOS' : 'settings.installMac');
  };
}

/** Where the header's "seen" mark for the install offer is kept. The Play offer
 *  has its own: whoever had already opened the web-app offer gets the dot again
 *  once, for the app. */
export function installSeenKey(): string {
  return offersPlayApp() ? 'cadence_play_offer_seen' : 'cadence_install_offer_seen';
}
