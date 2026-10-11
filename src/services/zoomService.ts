import { isMobileDevice } from '../utils';

const LS_ZOOM = 'cadence_zoom';
export const ZOOM_LEVELS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];

/**
 * Whether this browser implements CSS `zoom` the standardised way, which the
 * whole app is written against: lengths (vh/dvh included) are scaled by the
 * zoom, and getBoundingClientRect() reports the zoomed box — hence the
 * divisions by the zoom factor in #app's height and in every popover's
 * placement. Chromium 128+ and Safari 26.4+ (2026-03) do; older Safari and
 * Chromium report the unzoomed box and do not scale viewport units, so #app
 * came out 111 % of the screen on an iPhone at 90 % and every popover landed
 * off its anchor. Firefox before 126 has no `zoom` at all. All of those get
 * 100 %, where both models agree.
 *
 * Measured once, on a probe hung off <html> before any zoom is set on it.
 */
let standardZoom: boolean | undefined;
export function zoomWorks(): boolean {
  if (standardZoom === undefined) {
    const html = document.documentElement;
    const own = html.style.zoom;
    html.style.zoom = '';
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;width:100px;height:1px;zoom:2';
    html.appendChild(probe);
    standardZoom = probe.getBoundingClientRect().width > 150;
    probe.remove();
    html.style.zoom = own;
  }
  return standardZoom;
}

export function getZoom(): number {
  if (!zoomWorks()) return 100;
  const stored = localStorage.getItem(LS_ZOOM);
  if (stored !== null) return parseInt(stored, 10);
  return isMobileDevice() ? 90 : 125;
}

export function setZoom(pct: number): void {
  localStorage.setItem(LS_ZOOM, String(pct));
  applyZoom();
}

export function zoomIn(): void {
  const current = getZoom();
  const next = ZOOM_LEVELS.find(v => v > current);
  if (next !== undefined) setZoom(next);
}

export function zoomOut(): void {
  const current = getZoom();
  const prev = [...ZOOM_LEVELS].reverse().find(v => v < current);
  if (prev !== undefined) setZoom(prev);
}

export function canZoomIn(): boolean  { return zoomWorks() && getZoom() < ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!; }
export function canZoomOut(): boolean { return zoomWorks() && getZoom() > ZOOM_LEVELS[0]!; }

export function applyZoom(): void {
  const z = getZoom();
  document.documentElement.style.zoom = `${z}%`;
  // #app's height is driven by CSS (`calc(100dvh / var(--zoom-factor))`, styles.css) rather
  // than a JS snapshot of window.innerHeight: mobile browsers resize their own chrome (address
  // bar, etc.) independently of any 'resize' event timing, and a stale JS-computed height left
  // #app taller or shorter than the real viewport whenever that chrome showed/hid — pushing the
  // header and bottom nav out of view. `dvh` tracks the live visual viewport natively.
  document.documentElement.style.setProperty('--zoom-factor', String(z / 100));
}

// Same reasoning as #app above: expressed in `dvh`/`dvw` (not a JS snapshot of
// window.innerWidth/innerHeight) so modal dialogs stay correctly sized across
// orientation changes and mobile browser-chrome resizing without needing a
// 'resize'/'orientationchange' listener to re-apply a stale px value.
export function modalMaxH(pct = 0.9): string {
  return `calc(${pct * 100}dvh / var(--zoom-factor, 1))`;
}

export function modalMaxW(pct = 0.9): string {
  return `calc(${pct * 100}dvw / var(--zoom-factor, 1))`;
}
