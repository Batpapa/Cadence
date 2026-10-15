package io.github.batpapa.cadence;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.media.projection.MediaProjectionConfig;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import androidx.activity.result.ActivityResult;
import androidx.annotation.Nullable;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * A live analysis of what the phone itself plays — a video in another app, as
 * a tab is captured on a computer (asked for by the group, 2026-10-14).
 *
 * start({ notification }) walks the three steps Android 14+ imposes, in this
 * order and no other:
 *   1. RECORD_AUDIO, which a playback capture needs as much as a microphone;
 *   2. the system's screen-capture consent, asked EVERY time (the token it
 *      gives is good for one capture only);
 *   3. the foreground service, started with the mediaProjection type — only
 *      after the consent, or Android refuses it — and only then the
 *      projection itself (LiveRecordingService.startCapture).
 * `notification` is the live notification's first state, since this starts
 * the service the live's own notification (LiveNotificationPlugin) then
 * keeps updating.
 *
 * Resolves once samples flow. Rejects with code "unsupported" (Android 9 and
 * older), "denied" (the microphone or the consent refused) or "failed".
 * Then "pcm" events ({ data: base64 16-bit mono at `sampleRate` }), and
 * "ended" if the capture stops without stop() — the user's "Stop sharing".
 */
@CapacitorPlugin(
    name = "SystemAudioCapture",
    permissions = @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
)
public class SystemAudioCapturePlugin extends Plugin {

    @Nullable private static volatile SystemAudioCapturePlugin instance;
    /** start() waiting for the service to report. */
    @Nullable private PluginCall pending;

    @Override
    public void load() {
        instance = this;
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Playback capture needs Android 10", "unsupported");
            return;
        }
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "onMicrophone");
            return;
        }
        askConsent(call);
    }

    @PermissionCallback
    private void onMicrophone(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) askConsent(call);
        else call.reject("Microphone permission refused", "denied");
    }

    private void askConsent(PluginCall call) {
        MediaProjectionManager manager = getContext().getSystemService(MediaProjectionManager.class);
        // The whole display, never "a single app": that choice would open the
        // app picked, and what it means for the sound is not documented.
        Intent intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
            ? manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
            : manager.createScreenCaptureIntent();
        startActivityForResult(call, intent, "onConsent");
    }

    @ActivityCallback
    private void onConsent(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            call.reject("Screen capture consent refused", "denied");
            return;
        }
        if (pending != null) pending.reject("Superseded", "failed");
        pending = call;
        JSObject n = call.getObject("notification", new JSObject());
        JSObject labels = n.getJSObject("labels");
        if (labels == null) labels = new JSObject();
        Intent extras = new Intent()
            .putExtra(LiveRecordingService.EXTRA_TITLE, n.getString("title", ""))
            .putExtra(LiveRecordingService.EXTRA_TEXT, n.getString("text", ""))
            .putExtra(LiveRecordingService.EXTRA_ELAPSED_MS, 0L)
            .putExtra(LiveRecordingService.EXTRA_PAUSED, false)
            .putExtra(LiveRecordingService.EXTRA_LABEL_PAUSE, labels.getString("pause", "Pause"))
            .putExtra(LiveRecordingService.EXTRA_LABEL_RESUME, labels.getString("resume", "Resume"))
            .putExtra(LiveRecordingService.EXTRA_LABEL_STOP, labels.getString("stop", "Stop"))
            .putExtra(LiveRecordingService.EXTRA_CHANNEL_NAME, n.getString("channelName"));
        try {
            LiveRecordingService.startCapture(getContext(), extras, result.getResultCode(), data);
        } catch (Exception e) {
            pending = null;
            call.reject(String.valueOf(e.getMessage()), "failed", e);
        }
    }

    /** From the service: the capture runs (error null), or could not start. */
    static void reportStarted(@Nullable String error) {
        SystemAudioCapturePlugin plugin = instance;
        if (plugin == null) return;
        plugin.getBridge().executeOnMainThread(() -> {
            PluginCall call = plugin.pending;
            plugin.pending = null;
            if (call == null) return;
            if (error != null) { call.reject(error, "failed"); return; }
            JSObject ret = new JSObject();
            ret.put("sampleRate", SystemAudioCapture.SAMPLE_RATE);
            call.resolve(ret);
        });
    }

    static void dispatchChunk(String base64) {
        SystemAudioCapturePlugin plugin = instance;
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("data", base64);
        plugin.notifyListeners("pcm", data);
    }

    static void dispatchEnded() {
        SystemAudioCapturePlugin plugin = instance;
        if (plugin == null) return;
        // Not retained: kept for a listener to come, it would end the NEXT
        // capture the moment it starts.
        plugin.notifyListeners("ended", new JSObject());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        LiveRecordingService.stopCapture();
        call.resolve();
    }
}
