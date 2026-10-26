import type { ComponentChildren } from 'preact';
import { tIn, type Lang } from '../services/i18nService';
import { CadenceLogo, ArrowLeftIcon, InstallIcon } from '../components/icons';
import { WelcomePrefs } from '../components/welcomePrefs';
import { installAction } from '../components/installOffer';
import './shell.css';

// ── The standalone pages' frame (2026-10-26) ─────────────────────────────────
// TuneAnalyser/ and Trending/: two of the app's modules with nothing to sign
// in to and nothing kept — for using once, from a link. Both under the same
// header: Cadence's mark leading to the app, the install offer, and the
// language, theme and zoom — no module name (the module says it, and the tab's title), no second
// link to the app (the mark is one). Each page then shows the app's own module,
// across the whole width (shell.css).

/** The app, from a page one folder down. */
const APP_URL = new URL('../', location.href).href;

/** `onLanguageChange`: the language picked in the header (WelcomePrefs has
 *  already switched to it), for the page to redraw in it. */
export function StandaloneShell({ lang, onLanguageChange, onBack, notice, scroll, children }: {
  lang: Lang;
  onLanguageChange: () => void;
  /** Shown as an arrow before the mark, when there is somewhere to go back to
   *  inside the page (an analysis, back to the list of them). */
  onBack?: () => void;
  /** A line at the foot of the screen, on every screen of the page. */
  notice?: ComponentChildren;
  /** The page scrolls as a whole (Trending), rather than inside (the analyser). */
  scroll?: boolean;
  children: ComponentChildren;
}) {
  const install = installAction();
  return (
    <div class="sa-page">
      <header class="sa-header">
        {onBack && (
          <button type="button" class="sa-back" title={tIn(lang, 'standalone.back')} aria-label={tIn(lang, 'standalone.back')} onClick={onBack}>
            <ArrowLeftIcon size={20} />
          </button>
        )}
        <a class="sa-brand" href={APP_URL} title={tIn(lang, 'standalone.openApp')}>
          {/* The mark in its brand cyan, as on the welcome screen — a literal,
              like CadenceMark's: a logo does not follow the theme. Cropped
              (glyph) so that it reads at header size. */}
          <span class="sa-mark"><CadenceLogo size={34} glyph /></span>
          <span>Cadence</span>
        </a>
        <div class="sa-actions">
          {/* The welcome screen's offer too (2026-10-26): someone landing here
              from a link is meeting Cadence, and the step up — the Play app on
              Android, the web app elsewhere — is the app itself, not this
              page. Only when there is something to install. */}
          {install && (
            // The icon alone on a phone: beside the mark and the three
            // settings, the label would not fit.
            <button type="button" class="btn-ghost text-xs inline-flex items-center gap-1.5 text-accent" title={tIn(lang, 'settings.install')} aria-label={tIn(lang, 'settings.install')} onClick={install}>
              <InstallIcon size={13} /><span class="hidden sm:inline">{tIn(lang, 'settings.install')}</span>
            </button>
          )}
          {/* The welcome screen's own: language, theme, zoom — device
              settings, shared with the app as the origin is. */}
          <WelcomePrefs onLanguageChange={onLanguageChange} />
        </div>
      </header>
      <main class={`sa-main${scroll ? ' scroll' : ''}${notice ? ' above-notice' : ''}`}>{children}</main>
      {/* Pinned under the page, outside what scrolls: in view on every
          screen, an open analysis included (2026-10-26). */}
      {notice && <div class="sa-notice">{notice}</div>}
    </div>
  );
}
