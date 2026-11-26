// ── What kind of device this is ──────────────────────────────────────────────
// Out of utils.ts since 2026-11-26.

export function isMobileDevice(): boolean {
  return window.innerWidth < 768 && navigator.maxTouchPoints > 0;
}

/** iPhone, iPad or iPod, whatever the browser (all of them are Safari's engine
 *  there). iPadOS's Safari has introduced itself as a Mac since iPadOS 13; a
 *  Mac has no touch screen, so more than one touch point gives the iPad away. */
export function isAppleTouchDevice(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
}

/** The `accept` filter of a file picker for one of Cadence's own formats
 *  (.cdb, .cds, .cdc). iOS filters by the types it knows, and greys out every
 *  file for an extension it has none for — a backup could not even be picked
 *  to restore it. No filter there: the import checks what it is given anyway. */
export function ownFormatAccept(extensions: string): string | undefined {
  return isAppleTouchDevice() ? undefined : extensions;
}

/** Safari on a Mac recent enough to install a site as an app (File → Add to
 *  Dock, Safari 17, 2023), which offers no prompt a page could trigger. */
export function isMacSafariInstallable(): boolean {
  const ua = navigator.userAgent;
  if (!/Macintosh/.test(ua) || navigator.maxTouchPoints > 1) return false;
  if (/Chrome|Chromium|Edg\/|Firefox|OPR\//.test(ua)) return false;
  const v = /Version\/(\d+)[\d.]* Safari\//.exec(ua);
  return !!v && Number(v[1]) >= 17;
}

/** Focus an input only on desktop (mouse+hover device). Prevents keyboard popup on mobile. */
export function focusIfDesktop(el: HTMLElement): void {
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    // `preventScroll` because focusing an element inside a scrollable container
    // scrolls that container to reveal it — and the library's search field sits
    // at the top of the card list. Returning to the library was therefore
    // restored to the right position and then yanked back to the top 30 ms
    // later by this very call (2026-09-08). Giving a field focus is not a
    // request to move the page.
    setTimeout(() => el.focus({ preventScroll: true }), 30);
  }
}

/** True on a touch-primary device (phone/tablet), false on desktop (mouse+hover) —
 *  same signal as focusIfDesktop, inverted. Not width-based (unlike isMobileDevice):
 *  stable across resizing/orientation, which matters for a one-time capability check
 *  like "will backgrounding this tab cut off microphone access" rather than a layout
 *  decision. Deliberately not OS-specific — the restriction isn't unique to one OS
 *  and this only needs "is background capture likely to be interrupted here". */
export function isTouchPrimaryDevice(): boolean {
  return !window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}
