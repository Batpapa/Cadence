package io.github.batpapa.cadence;

import android.graphics.Color;
import android.view.Window;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Paints Android's status and navigation bars in the app's own header colour.
 *
 * Capacitor's inset handling is switched off (capacitor.config.ts, SystemBars:
 * it double-counted the navigation bar under the keyboard), so on Android 14
 * and below the window no longer draws behind the bars and the system paints
 * them itself — a grey band above the header. The page tells this plugin its
 * theme's surface colour whenever the theme changes (src/native/systemBars.ts).
 *
 * On Android 15+ the colour setters do nothing — the app is drawn behind
 * transparent bars there, and the header's own env(safe-area-inset-*) padding
 * is what shows; only the icon contrast still applies.
 */
@CapacitorPlugin(name = "SystemBarsColor")
public class SystemBarsColorPlugin extends Plugin {

    /** { color: "#rrggbb", light: boolean } — `light` = a light background, dark icons. */
    @PluginMethod
    public void set(PluginCall call) {
        String color = call.getString("color");
        boolean light = Boolean.TRUE.equals(call.getBoolean("light", true));
        getActivity().runOnUiThread(() -> {
            Window window = getActivity().getWindow();
            try {
                int parsed = Color.parseColor(color);
                window.setStatusBarColor(parsed);
                window.setNavigationBarColor(parsed);
            } catch (Exception ignored) {
                // Not a colour this API reads: leave the bars as they are.
            }
            WindowInsetsControllerCompat controller = new WindowInsetsControllerCompat(window, window.getDecorView());
            controller.setAppearanceLightStatusBars(light);
            controller.setAppearanceLightNavigationBars(light);
        });
        call.resolve();
    }
}
