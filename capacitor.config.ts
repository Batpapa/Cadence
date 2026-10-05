import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android shell around the same `dist/` the web build ships. The origin
 * inside the app is `https://localhost`, which is also what keeps the service
 * worker unregistered there (main.ts): the assets are on the device already, a
 * second cache would only serve stale versions.
 *
 * Live reload (`npm run cap:dev`) points the WebView at the webpack dev server
 * through `localhost`, reached over the cable by `adb reverse` — never through
 * the PC's LAN address: that origin would be plain `http://192.168…`, not a
 * secure context, and getUserMedia — the whole live analysis — is refused
 * there. `localhost` counts as secure even over http.
 */
const config: CapacitorConfig = {
  // Permanent once published: Android keys the app's storage on it, and the
  // Google OAuth Android client is bound to it.
  appId: 'io.github.batpapa.cadence',
  appName: 'Cadence',
  webDir: 'dist',
  plugins: {
    // Capacitor's own system-bar inset handling double-counts the navigation
    // bar while the keyboard is up: on WebView 153 (Galaxy A22) it left a
    // blank band the bar's height between the app's bottom nav and the
    // keyboard. Known and open upstream (ionic-team/capacitor#8287, #8525);
    // the WebView handles env(safe-area-inset-*) itself from version 140 on.
    SystemBars: {
      insetsHandling: 'disable',
    },
    // Over-the-air updates, self-hosted (src/native/otaUpdate.ts): the app
    // checks GitHub Pages' version.json itself and asks for a download.
    // Everything that would talk to Capgo's own cloud is switched off — no
    // automatic checks against their servers and, `statsUrl` empty, no
    // statistics or health reports sent anywhere (read in the plugin's
    // source: an empty URL returns before any request).
    CapacitorUpdater: {
      autoUpdate: false,
      updateUrl: '',
      channelUrl: '',
      statsUrl: '',
      // A new APK carries its own, newer web app: start from that one rather
      // than from a bundle downloaded for the previous APK.
      resetWhenUpdate: true,
    },
  },
};

export default config;
