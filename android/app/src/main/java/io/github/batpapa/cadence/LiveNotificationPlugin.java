package io.github.batpapa.cadence;

import android.Manifest;
import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/**
 * The page's handle on LiveRecordingService: show({...}) starts the service or
 * refreshes its notification, stop() ends it, and the notification's buttons
 * come back as an "action" event ({ action: "pause" | "resume" | "stop" }).
 *
 * `display` is POST_NOTIFICATIONS (Android 13+): without it the service still
 * runs and the recording still survives, but the notification — the lock-screen
 * control — never shows.
 */
@CapacitorPlugin(
    name = "LiveNotification",
    permissions = @Permission(alias = "display", strings = { Manifest.permission.POST_NOTIFICATIONS })
)
public class LiveNotificationPlugin extends Plugin {

    private static LiveNotificationPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    static void dispatchAction(String action) {
        LiveNotificationPlugin plugin = instance;
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("action", action);
        // Retained: a tap can land while the page is busy, and must not be lost.
        plugin.notifyListeners("action", data, true);
    }

    /** { title, text, elapsedMs, paused, labels: { pause, resume, stop }, channelName } */
    @PluginMethod
    public void show(PluginCall call) {
        JSObject labels = call.getObject("labels", new JSObject());
        Intent extras = new Intent()
            .putExtra(LiveRecordingService.EXTRA_TITLE, call.getString("title", ""))
            .putExtra(LiveRecordingService.EXTRA_TEXT, call.getString("text", ""))
            .putExtra(LiveRecordingService.EXTRA_ELAPSED_MS, elapsedMs(call))
            .putExtra(LiveRecordingService.EXTRA_PAUSED, Boolean.TRUE.equals(call.getBoolean("paused", false)))
            .putExtra(LiveRecordingService.EXTRA_LABEL_PAUSE, labels.getString("pause", "Pause"))
            .putExtra(LiveRecordingService.EXTRA_LABEL_RESUME, labels.getString("resume", "Resume"))
            .putExtra(LiveRecordingService.EXTRA_LABEL_STOP, labels.getString("stop", "Stop"))
            .putExtra(LiveRecordingService.EXTRA_CHANNEL_NAME, call.getString("channelName"));
        try {
            LiveRecordingService.show(getContext(), extras);
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()), "start_failed", e);
        }
    }

    /** Not call.getLong(): it answers only for a value parsed as a Long, and a
     *  JSON number under 2^31 arrives as an Integer — every recording shorter
     *  than 24 days read as 0 ms (seen on the lock screen, 2026-10-05). */
    private static long elapsedMs(PluginCall call) {
        Object value = call.getData().opt("elapsedMs");
        return value instanceof Number ? ((Number) value).longValue() : 0L;
    }

    @PluginMethod
    public void stop(PluginCall call) {
        LiveRecordingService.stop(getContext());
        call.resolve();
    }
}
