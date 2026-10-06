import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { setLanguage, t, type Lang } from '../services/i18nService';
import { setWelcomeLanguage, welcomeLanguage } from '../services/userService';
import { getTheme, setTheme, type Theme } from '../services/themeService';
import { registerOverlay } from './overlayStack';
import { CheckIcon, GlobeIcon, ThemeIcon } from './icons';

const THEMES: Array<{ id: Theme; labelKey: string }> = [
  { id: 'dark',  labelKey: 'settings.theme.dark' },
  { id: 'light', labelKey: 'settings.theme.light' },
  { id: 'green', labelKey: 'settings.theme.green' },
];

/** Each language under its own name — someone looking for theirs may not read
 *  the current one. A new language is one more line here. */
const LANGS: Array<{ id: Lang; name: string }> = [
  { id: 'en', name: 'English' },
  { id: 'fr', name: 'Français' },
];

/** A button and the menu of choices under it — the library's sort menu, same
 *  trigger, same panel, same rows. On the overlay stack, so Android's Back
 *  closes it; Escape is handled here because the app-wide Escape listener only
 *  exists once a user is open. */
function PrefMenu({ title, button, children }: {
  title: string;
  button: ComponentChildren;
  children: (close: () => void) => ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  useEffect(() => (open ? registerOverlay(close) : undefined), [open]);
  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} class="relative">
      <button
        type="button"
        class="btn-ghost text-xs inline-flex items-center justify-center gap-1.5"
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        {button}
      </button>
      {open && (
        <div role="menu" class="absolute top-full right-0 mt-1 z-30 bg-elevated border border-border rounded-lg overflow-hidden shadow-2xl py-1 min-w-[170px]">
          {children(close)}
        </div>
      )}
    </div>
  );
}

function MenuItem({ active, icon, onClick, children }: {
  active: boolean; icon?: ComponentChildren; onClick: () => void; children: ComponentChildren;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      class={`w-full flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer border-none bg-transparent text-left transition-colors ${active ? 'text-accent' : 'text-muted hover:bg-surface'}`}
      onClick={onClick}
    >
      {icon && <span class="shrink-0 flex items-center">{icon}</span>}
      <span class="flex-1">{children}</span>
      {active && <span class="text-accent flex items-center"><CheckIcon size={11} /></span>}
    </button>
  );
}

/**
 * Language and theme for the screens outside any user — the welcome screen and
 * the recovery screen (2026-10-06). Settings only exist inside a user, so
 * before this someone who landed in the wrong language, or on a theme that
 * hurt their eyes, could not change either until they had created a user.
 * Each is a button opening a menu, so that more languages are more lines,
 * not a wider bar.
 *
 * The theme is the device's own setting, the very one Settings changes. The
 * language is the welcome one (userService.welcomeLanguage): each user keeps
 * theirs. `onLanguageChange` lets the screen redraw in it.
 */
export function WelcomePrefs({ onLanguageChange }: { onLanguageChange: () => void }) {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const [lang, setLang] = useState<Lang>(welcomeLanguage);

  const pickLanguage = (l: Lang) => {
    setWelcomeLanguage(l);
    setLanguage(l);
    setLang(l);
    onLanguageChange();
  };

  return (
    <div class="flex items-center gap-1">
      <PrefMenu
        title={t('settings.language')}
        button={<><GlobeIcon size={13} /><span class="uppercase">{lang}</span></>}
      >
        {close => LANGS.map(l => (
          <MenuItem
            key={l.id}
            active={lang === l.id}
            icon={<span class="w-3 text-[9px] font-semibold uppercase text-center">{l.id}</span>}
            onClick={() => { close(); if (l.id !== lang) pickLanguage(l.id); }}
          >
            <span lang={l.id}>{l.name}</span>
          </MenuItem>
        ))}
      </PrefMenu>
      <PrefMenu title={t('settings.theme')} button={<ThemeIcon size={13} />}>
        {close => THEMES.map(th => (
          <MenuItem
            key={th.id}
            active={theme === th.id}
            onClick={() => { close(); setTheme(th.id); setThemeState(th.id); }}
          >
            {t(th.labelKey)}
          </MenuItem>
        ))}
      </PrefMenu>
    </div>
  );
}
