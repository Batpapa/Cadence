package io.github.batpapa.cadence;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;

/**
 * The foreground service of a live analysis, and its controls.
 *
 * Three jobs:
 *   - type microphone: Android keeps the microphone of an app that leaves the
 *     screen only under such a service;
 *   - a partial wake lock for the length of the recording, as the plugin this
 *     replaced held (the 47-minute screen-off test of 2026-10-05 ran with it);
 *   - the recording's lock-screen control.
 *
 * That control is a MEDIA session, not a plain notification: Samsung's lock
 * screen reduces ordinary notifications to an icon under its default
 * "icons only" style, but always shows the media player in full. So the
 * recording presents itself as something playing — the tune being heard as
 * the title, "Analysis in progress" beneath, its length on the progress bar,
 * Pause/Resume, and Stop.
 * Known consequences, accepted (2026-10-05): it takes the media player's place
 * while it runs, and a Bluetooth headset's play/pause button pauses it.
 *
 * Since Android 13 the player is drawn from the session's PlaybackState, not
 * from the notification: play/pause come from its actions, Stop is a custom
 * action with its own icon, and the elapsed time is the metadata's duration
 * (see metadata()), refreshed here every second while the screen is on.
 * The notification keeps its own actions and
 * a system chronometer for older versions.
 *
 * Started ONCE, when the live starts — from a tap, so in the foreground, the
 * only place Android 12+ lets a foreground service start. Every later change
 * (a new tune, a pause pressed on the lock screen) is applied to the running
 * instance instead: going through startForegroundService again from the
 * background would be refused.
 *
 * Every control comes back to the page through LiveNotificationPlugin, which
 * decides what it does — Stop in particular must take the very path of the
 * screen's own Stop button.
 */
public class LiveRecordingService extends Service {

    static final String ACTION_SHOW = "io.github.batpapa.cadence.live.SHOW";
    static final String ACTION_PAUSE = "io.github.batpapa.cadence.live.PAUSE";
    static final String ACTION_RESUME = "io.github.batpapa.cadence.live.RESUME";
    static final String ACTION_STOP = "io.github.batpapa.cadence.live.STOP";

    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_ELAPSED_MS = "elapsedMs";
    static final String EXTRA_PAUSED = "paused";
    static final String EXTRA_LABEL_PAUSE = "labelPause";
    static final String EXTRA_LABEL_RESUME = "labelResume";
    static final String EXTRA_LABEL_STOP = "labelStop";
    static final String EXTRA_CHANNEL_NAME = "channelName";

    private static final String CHANNEL_ID = "live_recording";
    private static final int NOTIFICATION_ID = 1;
    private static final String CUSTOM_STOP = "stop";

    /** The running instance — later updates go to it, not through a restart. */
    @Nullable private static volatile LiveRecordingService current;

    private final Handler main = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock wakeLock;
    private MediaSession session;
    @Nullable private Bitmap art;
    private Intent extras = new Intent();
    private boolean started = false;
    /** Wall-clock time the recording would have started with no pause in it. */
    private long anchorMs = 0;
    private long pausedElapsedMs = 0;
    private boolean paused = false;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (paused) return;
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            // Nobody can read a clock on a dark screen: no updates then.
            if (pm.isInteractive()) session.setMetadata(metadata());
            main.postDelayed(this, 1000);
        }
    };

    /** Starts the service, or refreshes the running one. */
    static void show(Context context, Intent extras) {
        LiveRecordingService running = current;
        if (running != null) {
            running.main.post(() -> running.apply(extras));
            return;
        }
        Intent intent = new Intent(context, LiveRecordingService.class).setAction(ACTION_SHOW).putExtras(extras);
        ContextCompat.startForegroundService(context, intent);
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, LiveRecordingService.class));
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_PAUSE.equals(action)) { LiveNotificationPlugin.dispatchAction("pause"); return START_NOT_STICKY; }
        if (ACTION_RESUME.equals(action)) { LiveNotificationPlugin.dispatchAction("resume"); return START_NOT_STICKY; }
        if (ACTION_STOP.equals(action)) { LiveNotificationPlugin.dispatchAction("stop"); return START_NOT_STICKY; }
        if (intent == null || !ACTION_SHOW.equals(action)) {
            // Restarted by the system with no recording behind it: nothing to show.
            stopSelf();
            return START_NOT_STICKY;
        }
        current = this;
        if (session == null) createSession();
        // Each startForegroundService() must be answered by startForeground():
        // reset so apply() calls it again even if a second start slipped in.
        started = false;
        apply(intent);
        acquireWakeLock();
        // Not sticky: a recording cannot be resumed by restarting this service,
        // so a service brought back on its own would only show a lie.
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        current = null;
        main.removeCallbacks(tick);
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        releaseWakeLock();
        super.onDestroy();
    }

    private void createSession() {
        session = new MediaSession(this, "CadenceLive");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { LiveNotificationPlugin.dispatchAction("resume"); }
            @Override public void onPause() { LiveNotificationPlugin.dispatchAction("pause"); }
            @Override public void onStop() { LiveNotificationPlugin.dispatchAction("stop"); }
            @Override public void onCustomAction(String action, @Nullable android.os.Bundle args) {
                if (CUSTOM_STOP.equals(action)) LiveNotificationPlugin.dispatchAction("stop");
            }
        });
        session.setSessionActivity(openAppIntent());
        session.setActive(true);
        art = appIconBitmap();
    }

    /** Takes a new state from the page and shows it everywhere. */
    private void apply(Intent next) {
        extras = next;
        paused = next.getBooleanExtra(EXTRA_PAUSED, false);
        long elapsedMs = next.getLongExtra(EXTRA_ELAPSED_MS, 0);
        anchorMs = System.currentTimeMillis() - elapsedMs;
        pausedElapsedMs = elapsedMs;

        ensureChannel(next.getStringExtra(EXTRA_CHANNEL_NAME));
        session.setMetadata(metadata());
        session.setPlaybackState(playbackState());
        Notification notification = buildNotification();
        if (!started) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            started = true;
        } else {
            getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification);
        }
        main.removeCallbacks(tick);
        if (!paused) main.postDelayed(tick, 1000);
    }

    private long elapsedNow() {
        return paused ? pausedElapsedMs : System.currentTimeMillis() - anchorMs;
    }

    /** The recording's length so far is published as the media's DURATION, with
     *  the position held at zero: the player then reads "0:00 ——— 12:34", the
     *  layout the user chose (2026-10-05) for something that has no total. */
    private MediaMetadata metadata() {
        MediaMetadata.Builder builder = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, extras.getStringExtra(EXTRA_TEXT))
            .putString(MediaMetadata.METADATA_KEY_ARTIST, extras.getStringExtra(EXTRA_TITLE))
            .putString(MediaMetadata.METADATA_KEY_ALBUM, "Cadence")
            .putLong(MediaMetadata.METADATA_KEY_DURATION, elapsedNow());
        if (art != null) builder.putBitmap(MediaMetadata.METADATA_KEY_ART, art);
        return builder.build();
    }

    private PlaybackState playbackState() {
        return new PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP)
            // Position 0 at speed 0: at speed 1 the player would run the
            // left-hand clock on its own, and the layout keeps it at 0:00.
            .setState(paused ? PlaybackState.STATE_PAUSED : PlaybackState.STATE_PLAYING, 0, 0f)
            .addCustomAction(new PlaybackState.CustomAction.Builder(
                CUSTOM_STOP, extras.getStringExtra(EXTRA_LABEL_STOP), R.drawable.ic_live_stop
            ).build())
            .build();
    }

    private void ensureChannel(@Nullable String name) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return;
        // DEFAULT rather than LOW: several launchers hide "silent" notifications
        // from the lock screen. Made quiet by the channel itself instead.
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, name == null ? "Live" : name, NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setShowBadge(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        builder
            .setSmallIcon(R.drawable.ic_stat_cadence)
            .setContentTitle(extras.getStringExtra(EXTRA_TEXT))
            .setContentText(extras.getStringExtra(EXTRA_TITLE))
            .setContentIntent(openAppIntent())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            // A paused chronometer cannot be frozen, so a paused recording shows
            // no clock at all rather than one that keeps running.
            .setShowWhen(!paused)
            .setUsesChronometer(!paused)
            .setWhen(anchorMs)
            .addAction(action(
                paused ? R.drawable.ic_live_resume : R.drawable.ic_live_pause,
                paused ? ACTION_RESUME : ACTION_PAUSE,
                extras.getStringExtra(paused ? EXTRA_LABEL_RESUME : EXTRA_LABEL_PAUSE),
                1
            ))
            .addAction(action(R.drawable.ic_live_stop, ACTION_STOP, extras.getStringExtra(EXTRA_LABEL_STOP), 2))
            .setStyle(new Notification.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1));
        if (art != null) builder.setLargeIcon(art);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return builder.build();
    }

    private Notification.Action action(int icon, String action, String label, int requestCode) {
        Intent intent = new Intent(this, LiveRecordingService.class).setAction(action);
        PendingIntent pending = PendingIntent.getService(
            this, requestCode, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        return new Notification.Action.Builder(Icon.createWithResource(this, icon), label, pending).build();
    }

    private PendingIntent openAppIntent() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) launch = new Intent(this, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** The app's icon as the player's artwork. Drawn rather than decoded: the
     *  launcher icon is an adaptive XML drawable, which BitmapFactory cannot read. */
    @Nullable
    private Bitmap appIconBitmap() {
        try {
            Drawable icon = getPackageManager().getApplicationIcon(getPackageName());
            Bitmap bitmap = Bitmap.createBitmap(256, 256, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            icon.setBounds(0, 0, 256, 256);
            icon.draw(canvas);
            return bitmap;
        } catch (Exception e) {
            return null;
        }
    }

    private void acquireWakeLock() {
        if (wakeLock != null) return;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Cadence::LiveRecording");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }

    private void releaseWakeLock() {
        if (wakeLock == null) return;
        if (wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }
}
