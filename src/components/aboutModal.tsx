import { useRef } from 'preact/hooks';
import { showModal, closeModal, renderModalBody } from './modal';
import { t } from '../services/i18nService';
import { CadenceLogo } from './icons';
import { ShareAppBody } from './shareAppModal';
import { APP_BUILD, commitUrl } from '../services/updateService';
import { isNative } from '../native/platform';

// ── "About Cadence" ──────────────────────────────────────────────────────────
// Behind the logo, since the header redesign of 2026-10-23. It merges two
// places that each cost something: the share button, which testers read as
// "share what I have selected" rather than "pass Cadence on", and the About
// section of Settings, where nobody went looking. The logo had no job at all
// until then.

function AboutLine({ textKey, href }: { textKey: string; href?: string }) {
  return (
    <p class="text-xs text-muted">
      {href ? <a href={href} target="_blank" rel="noopener" class="text-accent hover:underline">{t(textKey)}</a> : t(textKey)}
    </p>
  );
}

function offerRecoveryScreen(): void {
  const body = document.createElement('p');
  body.className = 'text-sm text-muted leading-relaxed';
  body.textContent = t('native.recovery.message');
  showModal(t('native.recovery.title'), body, [
    { label: t('common.cancel'), onClick: closeModal },
    { label: t('native.recovery.open'), primary: true, onClick: () => { location.href = './?mode=recovery'; } },
  ]);
}

/** The commit links to its page on GitHub: the one thing someone reporting a
 *  bug can send that names the exact code they ran. */
function VersionLine() {
  const url = commitUrl();
  const commit = APP_BUILD.commit + (APP_BUILD.dirty ? '-dev' : '');
  // The Android app has no address bar to type ?mode=recovery into: a long
  // press on this line is the way in, easy to talk someone through.
  const pressTimer = useRef(0);
  const press = isNative()
    ? {
        onPointerDown: () => { pressTimer.current = window.setTimeout(offerRecoveryScreen, 800); },
        onPointerUp: () => clearTimeout(pressTimer.current),
        onPointerLeave: () => clearTimeout(pressTimer.current),
        onPointerCancel: () => clearTimeout(pressTimer.current),
      }
    : {};
  return (
    <p class={`text-xs text-muted tabular-nums ${isNative() ? 'select-none' : ''}`} {...press}>
      {t('settings.version', { version: APP_BUILD.version })}
      {' · '}
      {url ? <a href={url} target="_blank" rel="noopener" class="text-accent hover:underline">{commit}</a> : commit}
    </p>
  );
}

function AboutBody() {
  return (
    <div class="space-y-5">
      <div class="flex items-center gap-3">
        <span class="w-11 h-11 rounded-[10px] bg-accent/15 text-accent flex items-center justify-center shrink-0">
          <CadenceLogo size={32} />
        </span>
        <div class="min-w-0 space-y-0.5">
          <AboutLine textKey="settings.aboutLine1" />
          <VersionLine />
        </div>
      </div>

      <section class="space-y-3">
        <div class="section-title">{t('shareApp.title')}</div>
        <ShareAppBody />
      </section>

      <section class="space-y-2">
        <div class="section-title">{t('about.info')}</div>
        <AboutLine textKey="settings.aboutLine2" />
        <AboutLine textKey="settings.aboutLine3" href="https://github.com/Batpapa/Cadence" />
        {/* FolkFriend attribution (GPLv3) — required by the vendored recognition engine. */}
        <p class="text-xs text-muted">
          {t('settings.aboutFolkFriend')}{' '}
          <a href="https://github.com/TomWyllie/folkfriend" target="_blank" rel="noopener" class="text-accent hover:underline">github.com/TomWyllie/folkfriend (GPLv3)</a>
        </p>
        {/* Their only place once a user is open: the static footer of
            index.html shows on the user selector and recovery screens alone. */}
        <p class="text-xs text-muted">
          <a href="./privacy.html" rel="noopener" class="text-accent hover:underline">{t('settings.privacyPolicy')}</a>
          {' · '}
          <a href="./terms.html" rel="noopener" class="text-accent hover:underline">{t('settings.termsOfService')}</a>
        </p>
      </section>
    </div>
  );
}

export function showAboutModal(): void {
  const { el, cleanup } = renderModalBody(<AboutBody />);
  showModal(t('about.title'), el, [], { maxWidth: '22rem', onDismiss: cleanup });
}
