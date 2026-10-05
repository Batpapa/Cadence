package io.github.batpapa.cadence;

import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Pull-to-refresh for the app, which lost the browser's own gesture with the
 * browser. Refreshing is how Cadence is brought up to date with what another
 * device put on Drive (the boot reads Drive), so the gesture is kept.
 *
 * The WebView is wrapped in a SwipeRefreshLayout at load. The layout only
 * offers the pull when the WebView itself is scrolled to the top — Cadence
 * scrolls the document, not an inner box, so that reading is right. The page
 * decides the rest (src/native/appShell.ts): it switches the gesture off while
 * a dialog is open (scrolling a dialog's own content up must not reload) and
 * during a recording (reloading would end it), and performs the reload itself
 * on the "refresh" event.
 */
@CapacitorPlugin(name = "PullToRefresh")
public class PullToRefreshPlugin extends Plugin {

    private SwipeRefreshLayout swipe;

    @Override
    public void load() {
        WebView webView = getBridge().getWebView();
        ViewGroup parent = (ViewGroup) webView.getParent();
        int index = parent.indexOfChild(webView);
        ViewGroup.LayoutParams params = webView.getLayoutParams();
        parent.removeView(webView);

        swipe = new SwipeRefreshLayout(getContext());
        swipe.addView(webView, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        parent.addView(swipe, index, params);
        // Off until the page says otherwise: it knows about dialogs and recordings.
        swipe.setEnabled(false);
        swipe.setOnRefreshListener(() -> {
            notifyListeners("refresh", new JSObject());
            // The reload replaces the page anyway; a refusal must not leave the
            // spinner turning.
            swipe.setRefreshing(false);
        });
    }

    @PluginMethod
    public void setEnabled(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getActivity().runOnUiThread(() -> {
            if (swipe != null) swipe.setEnabled(enabled);
        });
        call.resolve();
    }
}
