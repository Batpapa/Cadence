import { registerPlugin } from '@capacitor/core';

/**
 * The app's own native plugin (android/…/LiveRendererPlugin.java): keeps
 * Chromium from freezing the page about a minute after the app leaves the
 * screen, for as long as a live analysis holds it — see the plugin's doc for
 * the measurement behind it. Imported dynamically, and only when isNative().
 */
interface LiveRendererPlugin {
  hold(): Promise<void>;
  release(): Promise<void>;
}

export const LiveRenderer = registerPlugin<LiveRendererPlugin>('LiveRenderer');
