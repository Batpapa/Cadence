const LS_THEME = 'cadence_theme';
export type Theme = 'dark' | 'light' | 'green';

export function getTheme(): Theme {
  return (localStorage.getItem(LS_THEME) as Theme | null) ?? 'dark';
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(LS_THEME, theme);
  applyTheme();
}

export function applyTheme(): void {
  document.documentElement.dataset.theme = getTheme();
}
