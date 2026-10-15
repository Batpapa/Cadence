package io.github.batpapa.cadence;

import android.Manifest;
import android.annotation.TargetApi;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.util.Base64;
import androidx.annotation.RequiresPermission;

/**
 * What the other apps of the phone play, as 16-bit mono PCM: Android's
 * playback capture (Android 10+), behind a screen-capture consent.
 *
 * Only what an app lets through: USAGE_MEDIA, USAGE_GAME and USAGE_UNKNOWN by
 * default, and an app may refuse altogether (allowAudioPlaybackCapture=false,
 * or a capture policy) — then this hears silence, with no error anywhere.
 * Cadence's own sound is left out, whatever the page plays meanwhile.
 *
 * The samples go to the page in base64 chunks of CHUNK_MS through the plugin's
 * events; the page turns them back into a MediaStream (systemAudioCapture.ts).
 */
@TargetApi(Build.VERSION_CODES.Q)
class SystemAudioCapture {

    interface Sink {
        void onChunk(String base64);
        /** The projection ended without us: the user's "Stop sharing", the system. */
        void onEnded();
    }

    static final int SAMPLE_RATE = 48000;
    /** 100 ms: ten bridge crossings a second, each a few kilobytes. */
    private static final int CHUNK_MS = 100;

    private final MediaProjection projection;
    private final Sink sink;
    private final Handler main = new Handler(Looper.getMainLooper());
    private AudioRecord record;
    private Thread reader;
    private volatile boolean running = false;

    private final MediaProjection.Callback onStop = new MediaProjection.Callback() {
        @Override
        public void onStop() {
            boolean wasRunning = running;
            stop();
            if (wasRunning) sink.onEnded();
        }
    };

    SystemAudioCapture(MediaProjection projection, Sink sink) {
        this.projection = projection;
        this.sink = sink;
    }

    @RequiresPermission(Manifest.permission.RECORD_AUDIO)
    void start() {
        // Registered first: Android 14 refuses some projection calls without one.
        projection.registerCallback(onStop, main);
        AudioPlaybackCaptureConfiguration config = new AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .excludeUid(Process.myUid())
            .build();
        AudioFormat format = new AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .build();
        int chunkBytes = SAMPLE_RATE * CHUNK_MS / 1000 * 2;
        int minBytes = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        record = new AudioRecord.Builder()
            .setAudioFormat(format)
            .setBufferSizeInBytes(Math.max(minBytes, chunkBytes) * 4)
            .setAudioPlaybackCaptureConfig(config)
            .build();
        if (record.getState() != AudioRecord.STATE_INITIALIZED) {
            record.release();
            record = null;
            throw new IllegalStateException("AudioRecord not initialized");
        }
        record.startRecording();
        running = true;
        reader = new Thread(() -> read(chunkBytes), "CadenceSystemAudio");
        reader.setPriority(Thread.MAX_PRIORITY);
        reader.start();
    }

    private void read(int chunkBytes) {
        byte[] chunk = new byte[chunkBytes];
        int fill = 0;
        while (running) {
            int n = record.read(chunk, fill, chunkBytes - fill);
            if (n < 0) break; // released under us, or a dead device
            fill += n;
            if (fill == chunkBytes) {
                sink.onChunk(Base64.encodeToString(chunk, Base64.NO_WRAP));
                fill = 0;
            }
        }
    }

    void stop() {
        if (!running && record == null) return;
        running = false;
        try { projection.unregisterCallback(onStop); } catch (Exception ignored) { /* already gone */ }
        if (record != null) {
            try { record.stop(); } catch (IllegalStateException ignored) { /* never started */ }
        }
        if (reader != null) {
            try { reader.join(500); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            reader = null;
        }
        if (record != null) {
            record.release();
            record = null;
        }
        projection.stop();
    }
}
