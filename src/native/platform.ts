/** True inside the Android app (Capacitor), false in any browser.
 *
 *  Read from the global the native bridge injects before the bundle runs,
 *  rather than through `@capacitor/core`: the web build would otherwise carry
 *  the Capacitor runtime for every visitor, to answer a question that is
 *  always "no" for them. Native-only code is reached through dynamic imports
 *  behind this test, so it stays out of the web bundle's main chunk too. */
export function isNative(): boolean {
  return capacitor()?.isNativePlatform?.() === true;
}

/** Whether the app's native side has this plugin — false in a browser, and in
 *  an app installed before the plugin existed, which still receives the
 *  current page over the air (otaUpdate.ts). Read the same way, for the same
 *  reason. */
export function hasNativePlugin(name: string): boolean {
  return isNative() && capacitor()?.isPluginAvailable?.(name) === true;
}

function capacitor(): { isNativePlatform?: () => boolean; isPluginAvailable?: (name: string) => boolean } | undefined {
  return (globalThis as { Capacitor?: ReturnType<typeof capacitor> }).Capacitor;
}
