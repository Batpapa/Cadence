import { isNative } from '../native/platform';

const LS_THEME = 'cadence_theme';
export type Theme = 'dark' | 'light' | 'green';

/** The theme a device starts in before anyone chose one: light on a touch
 *  screen (phone, tablet), dark elsewhere. A pointer rather than a width: the
 *  width changes when the phone turns, and the score, which reads the theme
 *  on every draw, went dark in landscape on a phone that had never chosen
 *  (2026-10-29). Same rule in the bootstraps of index.html and
 *  standalone/page.html, which run first. */
function defaultTheme(): Theme {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 'light' : 'dark';
}

export function getTheme(): Theme {
  const stored = localStorage.getItem(LS_THEME) as Theme | null;
  if (stored !== null) return stored;
  // Written down the first time: a device whose main pointer changes (a mouse
  // plugged into a tablet) keeps the theme it started in.
  const theme = defaultTheme();
  try { localStorage.setItem(LS_THEME, theme); } catch { /* asked again next time */ }
  return theme;
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(LS_THEME, theme);
  applyTheme();
}

/** The header's colour per theme (--color-surface), for the browser's own bar:
 *  Safari's tab bar and status bar, Chrome's address bar on Android. The same
 *  table lives in index.html's bootstrap, which sets it before first paint. */
const BAR_COLOR: Record<Theme, string> = { dark: '#141414', light: '#f5f5f5', green: '#edf4e8' };

export function applyTheme(): void {
  const theme = getTheme();
  document.documentElement.dataset.theme = theme;
  const bar = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (bar) bar.content = BAR_COLOR[theme] ?? BAR_COLOR.dark;
  // The Android app's system bars follow the theme (native/systemBars.ts).
  if (isNative()) void import('../native/systemBars').then(m => m.syncSystemBars());
}
