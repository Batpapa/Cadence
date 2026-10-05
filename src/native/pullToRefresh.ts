import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * The app's own native plugin (android/…/PullToRefreshPlugin.java): the pull
 * gesture around the WebView. Imported dynamically, and only when isNative().
 */
interface PullToRefreshPlugin {
  setEnabled(options: { enabled: boolean }): Promise<void>;
  addListener(event: 'refresh', fn: () => void): Promise<PluginListenerHandle>;
}

export const PullToRefresh = registerPlugin<PullToRefreshPlugin>('PullToRefresh');
