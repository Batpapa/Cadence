import { canInstallSignal, isStandalone, isIOS, triggerInstall } from '../services/pwaService';
import { isMacSafariInstallable } from '../utils';
import { isNative } from '../native/platform';
import { t } from '../services/i18nService';
import { showModal, closeModal } from './modal';

// ── Installing Cadence ───────────────────────────────────────────────────────
// Shared by the header's ⋮ menu and the welcome screen (2026-10-26), the day
// the Android app went live on Google Play.

export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=io.github.batpapa.cadence';

/** Whether the Play app can be offered to anyone. False while the listing is
 *  open to the testers only (2026-10-26): everyone else would land on a page
 *  that says the app is not available. Turn on once it is public. */
const PLAY_STORE_LIVE = false;

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
  const canPrompt = canInstallSignal.value;
  if (isNative()) return null;
  if (offersPlayApp()) return () => { window.open(PLAY_STORE_URL, '_blank', 'noopener'); };
  if (isStandalone()) return null;
  const ios = isIOS();
  if (!canPrompt && !ios && !isMacSafariInstallable()) return null;
  return () => {
    if (canPrompt) { void triggerInstall(); return; }
    const body = document.createElement('p');
    body.className = 'text-sm text-muted leading-relaxed';
    body.textContent = t(ios ? 'settings.installIOS' : 'settings.installMac');
    showModal(t('settings.install'), body, [{ label: t('common.close'), primary: true, onClick: closeModal }]);
  };
}

/** Where the header's "seen" mark for the install offer is kept. The Play offer
 *  has its own: whoever had already opened the web-app offer gets the dot again
 *  once, for the app. */
export function installSeenKey(): string {
  return offersPlayApp() ? 'cadence_play_offer_seen' : 'cadence_install_offer_seen';
}
