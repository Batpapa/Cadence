package io.github.batpapa.cadence;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Android's audio focus, for what the page plays through Web Audio.
 *
 * Reported 2026-10-12: Cadence played over YouTube, and YouTube over Cadence.
 * Android shares the speaker by focus: a music player asks for it when it
 * starts, and whoever had it pauses. Chromium asks on behalf of its media
 * elements, but the audio player of an attachment and the score's synth are an
 * AudioContext, which never does — so nothing was asked, nobody paused.
 *
 * request() takes the focus as a music player does (YouTube, a podcast app
 * pause); abandon() gives it back. Losing it comes back as a "change" event:
 * "loss" (another player for good), "lossTransient" (a call, an assistant),
 * "duck" (a navigation prompt: the system lowers us by itself, nothing to do)
 * and "gain" (the transient loss is over). What to pause is the page's call.
 */
@CapacitorPlugin(name = "AudioFocus")
public class AudioFocusPlugin extends Plugin {

    private AudioManager audio;
    private AudioFocusRequest request;

    private final AudioManager.OnAudioFocusChangeListener listener = change -> {
        String focus;
        switch (change) {
            case AudioManager.AUDIOFOCUS_LOSS: focus = "loss"; break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT: focus = "lossTransient"; break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK: focus = "duck"; break;
            case AudioManager.AUDIOFOCUS_GAIN: focus = "gain"; break;
            default: return;
        }
        JSObject data = new JSObject();
        data.put("focus", focus);
        notifyListeners("change", data);
    };

    @Override
    public void load() {
        audio = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    @PluginMethod
    public void request(PluginCall call) {
        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (request == null) {
                request = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build())
                    // A navigation prompt lowers us rather than stopping us.
                    .setWillPauseWhenDucked(false)
                    .setOnAudioFocusChangeListener(listener)
                    .build();
            }
            result = audio.requestAudioFocus(request);
        } else {
            result = audio.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }

        JSObject ret = new JSObject();
        // Refused during a phone call: the page plays anyway, as before.
        ret.put("granted", result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
        call.resolve(ret);
    }

    @PluginMethod
    public void abandon(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (request != null) audio.abandonAudioFocusRequest(request);
        } else {
            audio.abandonAudioFocus(listener);
        }
        call.resolve();
    }
}
