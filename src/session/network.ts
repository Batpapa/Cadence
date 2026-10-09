// ── What network this device is on (2026-10-09) ─────────────────────────────
// Shared by the two automatic transfers of recordings — the copy to Drive
// (db.ts) and the download from it (audioDownloads.ts) — each of which may be
// told to wait for Wi-Fi.

type NetworkInformationLike = EventTarget & { type?: string };

export function connection(): NetworkInformationLike | undefined {
  return (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
}

/** Whether this device says what network it is on — the Android app and
 *  Chrome on a phone do, a computer and Safari do not. Only then can "Wi-Fi
 *  only" mean anything, so only then is it offered. */
export function knowsNetworkType(): boolean {
  return connection()?.type !== undefined;
}

/** Wi-Fi, a cable, or a device that does not say — a desktop browser exposes
 *  no connection type, and is not on someone's data plan. Anything it DOES
 *  name otherwise (cellular, but also "unknown") is not Wi-Fi: the user asked
 *  not to spend their data, and a guess must fall on that side. */
export function onUnmeteredNetwork(): boolean {
  const type = connection()?.type;
  return type === undefined || type === 'wifi' || type === 'ethernet';
}

/** Calls `fn` when the device moves between networks — back on Wi-Fi, or off
 *  it. Nothing where the browser does not say. */
export function onNetworkChange(fn: () => void): void {
  connection()?.addEventListener?.('change', fn);
}
