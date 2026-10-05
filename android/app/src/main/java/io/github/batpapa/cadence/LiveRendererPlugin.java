package io.github.batpapa.cadence;

import android.os.Handler;
import android.os.Looper;
import android.view.View;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps the page running in the background while a live analysis records.
 *
 * Chromium freezes a page it believes hidden — every task stops, the
 * recognition worker and MediaRecorder included. Measured on the Galaxy A22
 * (2026-10-05): the page stopped ~59 s after the app left the screen, screen
 * off or another app on top, while Android kept both the app and the WebView's
 * renderer process at foreground-service priority, never frozen
 * (`dumpsys activity processes`: adj 50, procState 4, isFrozen=false), and the
 * microphone open at the system level. The foreground service alone therefore
 * cannot help: the freeze is Chromium's, decided from the WebView's visibility.
 *
 * The established answer — the Cordova/Capacitor background-mode plugins'
 * disableWebViewOptimizations(), in use for years — is to tell the WebView it
 * is still visible shortly after the activity hides it. Done here only while a
 * recording holds it: an always-"visible" page would keep running whatever it
 * runs whenever the app merely sits in the background.
 *
 * Measured and ruled out on the way: setRendererPriorityPolicy. The default on
 * this WebView is already IMPORTANT, not waived when hidden.
 */
@CapacitorPlugin(name = "LiveRenderer")
public class LiveRendererPlugin extends Plugin {

    private static final String TAG = "LiveRenderer";
    /** After the activity's own visibility change has reached the WebView —
     *  the same one-second delay the background-mode plugins use. */
    private static final long REVIVE_DELAY_MS = 1000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean held = false;
    private boolean activityHidden = false;

    private final Runnable revive = () -> {
        if (!held || !activityHidden) return;
        getBridge().getWebView().dispatchWindowVisibilityChanged(View.VISIBLE);
        Logger.info(TAG, "WebView told it is still visible");
    };

    @PluginMethod
    public void hold(PluginCall call) {
        main.post(() -> {
            held = true;
            // Started from the background (unlikely, a live starts from a tap)
            if (activityHidden) main.postDelayed(revive, REVIVE_DELAY_MS);
        });
        call.resolve();
    }

    @PluginMethod
    public void release(PluginCall call) {
        main.post(() -> {
            held = false;
            main.removeCallbacks(revive);
            // Released while the app is out of sight (stopped from the
            // notification): hand the WebView its real visibility back.
            if (activityHidden) {
                getBridge().getWebView().dispatchWindowVisibilityChanged(View.GONE);
                Logger.info(TAG, "WebView visibility restored to hidden");
            }
        });
        call.resolve();
    }

    @Override
    protected void handleOnStop() {
        activityHidden = true;
        if (held) {
            main.removeCallbacks(revive);
            main.postDelayed(revive, REVIVE_DELAY_MS);
        }
    }

    @Override
    protected void handleOnStart() {
        activityHidden = false;
        main.removeCallbacks(revive);
    }
}
