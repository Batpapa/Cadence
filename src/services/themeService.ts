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

export function applyTheme(): void {
  document.documentElement.dataset.theme = getTheme();
  // The Android app's system bars follow the theme (native/systemBars.ts).
  if (isNative()) void import('../native/systemBars').then(m => m.syncSystemBars());
}
