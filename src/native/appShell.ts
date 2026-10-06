import { effect } from '@preact/signals';
import { App } from '@capacitor/app';
import { anyOverlayOpen, closeTopOverlay, onOverlaysChanged } from '../components/overlayStack';
import { canGoBack, routeSignal } from '../store';
import { sessionRecordingSignal } from '../session/ui/sessionStore';
import { PullToRefresh } from './pullToRefresh';

/**
 * The Android app's system Back.
 *
 * Capacitor's default walks the WebView's history and, once there is nothing
 * left, FINISHES the activity — which destroys the WebView, and with it a live
 * recording running in the background. So at the root the app is sent to the
 * background instead, the way native apps behave.
 *
 * Above the root it does what Back already does in the browser (store.ts,
 * overlayStack.ts): one open layer is closed — overlays own no history entry,
 * so closing directly is exactly what popstate would have done — or else the
 * app goes back one page. Deciding here from the app's own `canGoBack` rather
 * than the WebView's skips the sentinel entry store.ts keeps behind the first
 * page, which would otherwise swallow one press at the root.
 *
 * Imported dynamically, and only when isNative().
 */
export function initNativeShell(): void {
  void App.addListener('backButton', () => {
    // An open layer first, on every screen — the recovery screen's language
    // and theme menus included.
    if (anyOverlayOpen()) { closeTopOverlay(); return; }
    // The recovery screen (?mode=recovery, reached from the version line) has
    // no way back of its own — on the web one closes the tab. Back is it here.
    if (new URLSearchParams(location.search).get('mode') === 'recovery') {
      location.replace('./');
      return;
    }
    if (canGoBack.value) history.back();
    else void App.minimizeApp();
  });
  initPullToRefresh();
}

/**
 * Pull-to-refresh (android/…/PullToRefreshPlugin.java): reloads the page, as
 * the browser's gesture did — the reload is what brings in what another device
 * put on Drive. Off while a dialog is open (pulling a dialog's own content
 * must not reload) and while a recording or an import runs (a reload ends it).
 *
 * Off as well unless everything is scrolled to the top. The native layout
 * can only see the WebView's own scroll, but Cadence scrolls an inner box
 * under the header: the WebView always looked "at the top", so every pull
 * back up the library reloaded instead of scrolling (2026-10-05). So the page
 * keeps the set of vertical scrollers not at their top; detached ones are
 * dropped, and a page change re-checks, since leaving a page removes its box.
 */
function initPullToRefresh(): void {
  const scrolledDown = new Set<Element>();
  const atTop = () => {
    for (const el of scrolledDown) if (!el.isConnected || el.scrollTop <= 0) scrolledDown.delete(el);
    return scrolledDown.size === 0;
  };
  const allowed = () => !anyOverlayOpen() && !sessionRecordingSignal.value && atTop();
  // A gesture that did not START at the top never refreshes, as in the
  // browser: scrolling back up past the top in one swipe stops there. So while
  // a finger is down the gesture may only be switched off, never on — the
  // layout would otherwise take over the rest of that very swipe.
  let touching = false;
  let last: boolean | null = null;
  const update = () => {
    const enabled = allowed();
    if (enabled === last || (enabled && touching)) return;
    last = enabled;
    void PullToRefresh.setEnabled({ enabled });
  };
  document.addEventListener('touchstart', () => { touching = true; }, { capture: true, passive: true });
  const release = () => { touching = false; update(); };
  document.addEventListener('touchend', release, { capture: true, passive: true });
  document.addEventListener('touchcancel', release, { capture: true, passive: true });
  document.addEventListener('scroll', (e) => {
    const el = e.target === document ? document.scrollingElement : e.target;
    // Vertical scrollers only: a horizontal strip says nothing about "top".
    if (!(el instanceof Element) || el.scrollHeight <= el.clientHeight) return;
    if (el.scrollTop > 0) scrolledDown.add(el);
    else scrolledDown.delete(el);
    update();
  }, { capture: true, passive: true });
  onOverlaysChanged(update);
  effect(() => { void sessionRecordingSignal.value; void routeSignal.value; update(); });
  // Checked again on arrival: the state may have changed during the pull.
  void PullToRefresh.addListener('refresh', () => { if (allowed()) location.reload(); });
}
