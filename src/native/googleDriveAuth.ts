import { registerPlugin } from '@capacitor/core';

/**
 * The app's own native plugin (android/…/GoogleDriveAuthPlugin.java): Drive
 * tokens from Google Play services instead of GIS's popup. Once the scope has
 * been granted, `authorize({ interactive: false })` returns a fresh token with
 * no UI at all — the end of the hourly renewal window.
 *
 * Rejections carry the codes driveService reasons about, as the error message:
 * 'needs_auth' (silent call, no grant yet), 'popup_closed', 'access_denied'.
 *
 * Imported dynamically, and only when isNative(): this is what pulls
 * @capacitor/core into the bundle, and the web build has no use for it.
 */
interface GoogleDriveAuthPlugin {
  authorize(options: { interactive: boolean; account?: string; selectAccount?: boolean }): Promise<{ accessToken: string }>;
  clearToken(options: { token: string }): Promise<void>;
  revoke(options: { account?: string }): Promise<void>;
}

export const GoogleDriveAuth = registerPlugin<GoogleDriveAuthPlugin>('GoogleDriveAuth');
