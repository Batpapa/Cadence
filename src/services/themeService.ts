import { isMobileDevice } from '../utils';
import { isNative } from '../native/platform';

const LS_THEME = 'cadence_theme';
export type Theme = 'dark' | 'light' | 'green';

export function getTheme(): Theme {
  const stored = localStorage.getItem(LS_THEME) as Theme | null;
  if (stored !== null) return stored;
  return isMobileDevice() ? 'light' : 'dark';
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
