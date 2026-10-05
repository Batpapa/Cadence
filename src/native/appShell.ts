import { effect } from '@preact/signals';
import { App } from '@capacitor/app';
import { anyOverlayOpen, closeTopOverlay, onOverlaysChanged } from '../components/overlayStack';
import { canGoBack } from '../store';
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
    // The recovery screen (?mode=recovery, reached from the version line) has
    // no way back of its own — on the web one closes the tab. Back is it here.
    if (new URLSearchParams(location.search).get('mode') === 'recovery') {
      location.replace('./');
      return;
    }
    if (anyOverlayOpen()) closeTopOverlay();
    else if (canGoBack.value) history.back();
    else void App.minimizeApp();
  });
  initPullToRefresh();
}

/**
 * Pull-to-refresh (android/…/PullToRefreshPlugin.java): reloads the page, as
 * the browser's gesture did — the reload is what brings in what another device
 * put on Drive. Off while a dialog is open (pulling a dialog's own content
 * must not reload) and while a recording or an import runs (a reload ends it).
 */
function initPullToRefresh(): void {
  const allowed = () => !anyOverlayOpen() && !sessionRecordingSignal.value;
  let last: boolean | null = null;
  const update = () => {
    const enabled = allowed();
    if (enabled === last) return;
    last = enabled;
    void PullToRefresh.setEnabled({ enabled });
  };
  onOverlaysChanged(update);
  effect(() => { void sessionRecordingSignal.value; update(); });
  // Checked again on arrival: the state may have changed during the pull.
  void PullToRefresh.addListener('refresh', () => { if (allowed()) location.reload(); });
}
