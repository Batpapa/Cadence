/** True inside the Android app (Capacitor), false in any browser.
 *
 *  Read from the global the native bridge injects before the bundle runs,
 *  rather than through `@capacitor/core`: the web build would otherwise carry
 *  the Capacitor runtime for every visitor, to answer a question that is
 *  always "no" for them. Native-only code is reached through dynamic imports
 *  behind this test, so it stays out of the web bundle's main chunk too. */
export function isNative(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return cap?.isNativePlatform?.() === true;
}
