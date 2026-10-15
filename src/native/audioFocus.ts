import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { hasNativePlugin } from './platform';

/**
 * The app's own native plugin (android/…/AudioFocusPlugin.java): Android's
 * audio focus for the Web Audio players — see services/audioSession.ts for
 * who claims it and why. Imported dynamically, and only when isNative().
 */
type FocusChange = 'loss' | 'lossTransient' | 'duck' | 'gain';

interface AudioFocusPlugin {
  request(): Promise<{ granted: boolean }>;
  abandon(): Promise<void>;
  addListener(event: 'change', fn: (e: { focus: FocusChange }) => void): Promise<PluginListenerHandle>;
}

const AudioFocus = registerPlugin<AudioFocusPlugin>('AudioFocus');

/** An app installed before the plugin existed runs this code too, through an
 *  over-the-air update: there, playing simply goes on as it always did. */
const available = (): boolean => hasNativePlugin('AudioFocus');

let listening: Promise<PluginListenerHandle> | null = null;

export async function requestAudioFocus(onLost: () => void): Promise<void> {
  if (!available()) return;
  // A duck lowers us without our help; a regained focus is not ours to act
  // on (see onAudioFocusLost).
  listening ??= AudioFocus.addListener('change', ({ focus }) => {
    if (focus === 'loss' || focus === 'lossTransient') onLost();
  });
  await listening;
  await AudioFocus.request();
}

export async function abandonAudioFocus(): Promise<void> {
  if (!available()) return;
  await AudioFocus.abandon();
}
