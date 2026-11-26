import { render, type ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { ModalHost } from './components/modal';
import { WelcomePrefs } from './components/welcomePrefs';
import { GithubIcon, CloudDownIcon, UpdateIcon, InstallIcon, GooglePlayIcon, PlusIcon } from './components/icons';
import { InlineStatus } from './components/ui';
import { initialsOf } from './components/initials';
import { WelcomeTour } from './components/welcomeTour';
import { webAppButtonAction, openPlayStore } from './components/installOffer';
import { isNative } from './native/platform';
import { t } from './services/i18nService';
import { updateReady, applyUpdate, versionLabel } from './services/updateService';
import { initDriveClient } from './services/driveService';
import type { User } from './types';
import { CadenceMark } from './components/cadenceMark';

// The welcome screen: the users of this device, a new one, one found on Drive.
// Out of appRoot.tsx since 2026-11-26 — a Preact root of its own, which
// mounts its own ModalHost (see modal.tsx).

// ── User selector ─────────────────────────────────────────────────────────────

/** The source link and the version, at the foot of the welcome screen.
 *  No privacy/terms links here: index.html's static footer carries them on
 *  this screen, and is what the OAuth review reads. */
function Signature({ class: extra }: { class: string }) {
  return (
    <div class={`flex-col items-center gap-2.5 ${extra}`}>
      <a
        href="https://github.com/Batpapa/Cadence"
        target="_blank"
        rel="noopener noreferrer"
        title={t('welcome.sourceTitle')}
        class="flex items-center gap-1.5 text-2xs text-dim hover:text-primary transition-colors"
      >
        <GithubIcon size={12} />
        <span>Batpapa</span>
      </a>

      {/* Quiet, like the signature: for the screenshot someone sends
          when asking for help. When a newer build is ready it becomes the
          way to get it — nothing is open on this screen for a reload to
          lose, and there is no header here to carry the pill. */}
      <div class="flex items-center gap-2 text-2xs text-dim tabular-nums">
        <span>{versionLabel()}</span>
        {updateReady.value && (
          <button
            class="flex items-center gap-1 text-accent hover:underline cursor-pointer"
            title={t('update.title', { version: versionLabel(updateReady.value) })}
            onClick={applyUpdate}
          >
            <UpdateIcon size={12} />
            {t('update.button')}
          </button>
        )}
      </div>
    </div>
  );
}

/** How the welcome screen's Drive recovery ended (see main.ts). Only 'empty'
 *  hands control back: a Google account with no Cadence data on it, where the
 *  connection is kept only if a name is given for a new user. */
export type DriveRecovery =
  | { kind: 'opened' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; inAppBrowser: boolean }
  | { kind: 'empty'; email: string; finish: (name: string) => Promise<void>; cancel: () => void };

type EmptyDrive = Extract<DriveRecovery, { kind: 'empty' }>;

function UserSelector({ users, onSelect, onCreate, onRecover }: {
  users: User[];
  onSelect: (id: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  /** null when Drive sync is not configured in this build. */
  onRecover: (() => Promise<DriveRecovery>) | null;
}) {
  const [loading,  setLoading]  = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName,  setNewName]  = useState('');
  // Set while the name being typed is for a user bound to an empty Drive.
  const [emptyDrive, setEmptyDrive] = useState<EmptyDrive | null>(null);
  const [recoverError, setRecoverError] = useState<'failed' | 'inAppBrowser' | null>(null);
  // t() is not reactive: a language picked on this screen redraws it.
  const [, redraw] = useState(0);
  // Both ways in, side by side under the sign-in (2026-11-08) — it used to be
  // one discreet link in the top corner, which a visitor who had just scanned
  // a neighbour's QR at a session never saw. No "Web app" where it cannot
  // apply: inside the Android app, or inside the web app itself. No "Android
  // app" inside the Android app — so nothing at all there.
  const installWebApp = webAppButtonAction();
  const showPlay = !isNative();

  const select = async (id: string) => {
    setLoading(id);
    await onSelect(id);
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setLoading('new');
    if (emptyDrive) await emptyDrive.finish(name);
    else await onCreate(name);
  };

  const cancelCreate = () => {
    emptyDrive?.cancel();
    setEmptyDrive(null);
    setCreating(false);
    setNewName('');
  };

  const recover = async () => {
    if (!onRecover) return;
    setRecoverError(null);
    setLoading('drive');
    const outcome = await onRecover();
    if (outcome.kind === 'opened') return;
    setLoading(null);
    if (outcome.kind === 'failed') setRecoverError(outcome.inAppBrowser ? 'inAppBrowser' : 'failed');
    if (outcome.kind === 'empty') {
      setEmptyDrive(outcome);
      setCreating(true);
    }
  };

  // No way to REMOVE a user from here any more (2026-09-13). The ✕ it used to
  // carry was revealed by hover and by nothing else, so on a touch screen it
  // was reachable only because :hover sticks to whatever was tapped last —
  // an interaction nobody chose, holding a destructive action. Removing a user
  // now lives in Settings → User, where it is a button that is simply visible.
  return (
    // The sign-in, then what Cadence does (WelcomeTour) under it — beside it
    // on a wide screen, each column scrolling on its own so that the sign-in
    // stays in view. Auto margins rather than centring by flex: a column taller
    // than the screen must not lose its top.
    <div class="fixed inset-0 bg-bg overflow-y-auto flex flex-col lg:flex-row lg:overflow-hidden">
      {/* No Settings before a user exists: language and theme are here. Below
          the status bar where the page runs under it (Android 15+, iOS). */}
      <div class="fade-in absolute z-10 right-3 flex items-center gap-1" style="top:calc(var(--safe-top) + 8px);animation-delay:1s">
        <WelcomePrefs onLanguageChange={() => redraw(x => x + 1)} />
      </div>
      <div class="shrink-0 flex flex-col items-center px-4 pt-14 pb-12 lg:flex-1 lg:min-w-0 lg:overflow-y-auto lg:py-10">
      <div class="w-full max-w-[352px] lg:my-auto flex flex-col items-center">

        {/* ── Marque ── */}
        <div class="mark-in mb-[22px]">
          <CadenceMark size={78} />
        </div>

        <div class="rise-in text-center" style="animation-delay:.7s">
          <div class="text-[38px] font-extralight tracking-[-0.015em] leading-none text-primary">{/* ui-ok: Vitrine register */}
            Cadence
          </div>
          <p class="text-[13.5px] text-muted leading-relaxed mt-3.5 text-pretty">{/* ui-ok: Vitrine register */}
            {t('welcome.tagline')}
          </p>
        </div>

        <div class="fade-in w-11 h-px bg-border mt-[30px] mb-[26px]" style="animation-delay:1s" />

        {/* ── Sélection ── */}
        <div class="rise-in w-full" style="animation-delay:1.05s">
          <h1 class="text-2xs font-semibold text-dim uppercase tracking-[0.16em] text-center mb-3.5">
            {t('userSelector.title')}
          </h1>

          <div class="flex flex-col gap-2">
            {users.map((u, i) => (
              <button
                key={u.id}
                disabled={!!loading}
                onClick={() => void select(u.id)}
                class={`rise-in w-full flex items-center gap-3 px-3.5 py-[11px] rounded-xl border border-border bg-elevated hover:border-muted hover:bg-surface transition-colors cursor-pointer text-left ${loading === u.id ? 'opacity-60' : ''}`}
                style={`animation-delay:${1.1 + i * 0.07}s`}
              >
                <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style="background:rgb(var(--color-accent-ch)/0.18)">
                  <span class="text-xs font-mono font-bold text-accent">{initialsOf(u.name)}</span>
                </div>
                <span class="text-sm font-medium text-primary name-wrap flex-1">{u.name}</span>
              </button>
            ))}

            {creating ? (
              <div class="flex flex-col gap-2 pt-1">
                {emptyDrive && (
                  <p class="text-xs text-muted leading-relaxed text-pretty">
                    {t('userSelector.recover.empty', { account: emptyDrive.email || t('userSelector.recover.thisAccount') })}
                  </p>
                )}
                <div class="flex gap-2">
                  <input
                    autoFocus
                    type="text"
                    value={newName}
                    placeholder={t('userSelector.namePlaceholder')}
                    class="input flex-1 text-sm"
                    onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter')  void create();
                      if (e.key === 'Escape') cancelCreate();
                    }}
                  />
                  <button
                    class="btn-primary text-sm px-3"
                    disabled={!!loading || !newName.trim()}
                    onClick={() => void create()}
                  >
                    {t('common.confirm')}
                  </button>
                </div>
                {/* Escape alone was enough for a plain new user; here the
                    Drive connection made a moment ago has to be undone
                    deliberately, and a phone has no Escape key. */}
                {emptyDrive && (
                  <button class="btn-ghost text-xs self-center" disabled={!!loading} onClick={cancelCreate}>
                    {t('common.cancel')}
                  </button>
                )}
              </div>
            ) : (
              <>
                <button
                  class="rise-in w-full flex items-center justify-center gap-2 px-3.5 py-[11px] rounded-xl border border-dashed border-border text-dim hover:border-muted hover:text-primary transition-colors cursor-pointer text-[13.5px]" // ui-ok: Vitrine register
                  style={`animation-delay:${1.1 + users.length * 0.07}s`}
                  disabled={!!loading}
                  onClick={() => setCreating(true)}
                >
                  <PlusIcon size={14} />
                  {t('userSelector.new')}
                </button>
                {onRecover && (
                  <button
                    class={`rise-in w-full flex items-center justify-center gap-2 px-3.5 py-[11px] rounded-xl border border-dashed border-border text-dim hover:border-muted hover:text-primary transition-colors cursor-pointer text-[13.5px] ${loading === 'drive' ? 'opacity-60' : ''}`} // ui-ok: Vitrine register
                    style={`animation-delay:${1.1 + (users.length + 1) * 0.07}s`}
                    disabled={!!loading}
                    // Google's script is only fetched on first use. Starting it
                    // on approach keeps the consent window close to the click
                    // that opens it, which is what browsers let through.
                    onPointerEnter={preloadDrive}
                    onFocus={preloadDrive}
                    onPointerDown={preloadDrive}
                    onClick={() => void recover()}
                  >
                    <CloudDownIcon size={14} />
                    {loading === 'drive' ? t('settings.sync.connecting') : t('userSelector.recover')}
                  </button>
                )}
              </>
            )}
          </div>

          {/* An error, said as one (UI charter, 2026-11-11): it was grey. */}
          {recoverError && (
            <InlineStatus tone="error" class="justify-center text-center leading-relaxed text-pretty mt-2.5">
              {t(recoverError === 'inAppBrowser' ? 'settings.sync.inAppBrowserError' : 'userSelector.recover.failed')}
            </InlineStatus>
          )}

          {(installWebApp || showPlay) && (
            <div class="rise-in mt-8" style={`animation-delay:${1.1 + (users.length + 2) * 0.07}s`}>
              <div class="text-2xs font-semibold text-dim uppercase tracking-[0.16em] text-center mb-3.5">
                {t('settings.install')}
              </div>
              <div class="flex gap-2">
                {installWebApp && <InstallTile icon={<InstallIcon size={16} />} label={t('welcome.install.webApp')} onClick={installWebApp} />}
                {showPlay && <InstallTile icon={<GooglePlayIcon size={16} />} label={t('shareApp.target.android')} onClick={openPlayStore} />}
              </div>
            </div>
          )}

          {/* Under the sign-in when the tour is beside it; at the very end
              of the page when the tour is below. */}
          <Signature class="hidden lg:flex mt-10" />
        </div>
      </div>
      </div>

      <div
        class="fade-in shrink-0 px-[19px] sm:px-14 pt-6 pb-16 lg:flex-[1.3] lg:min-w-0 lg:overflow-y-auto lg:pt-[72px] lg:bg-surface/40 lg:border-l lg:border-border"
        style="animation-delay:1.3s"
      >
        {/* Below the sign-in, the whole width between the side-by-side
            layout's margins (2026-10-26): not the sign-in's narrow column. */}
        <div class="w-full lg:max-w-[640px]">
          <WelcomeTour />
          <Signature class="flex lg:hidden mt-14" />
        </div>
      </div>
      <ModalHost />
    </div>
  );
}

export function mountUserSelector(
  root: HTMLElement,
  users: User[],
  onSelect: (id: string) => Promise<void>,
  onCreate: (name: string) => Promise<void>,
  onRecover: (() => Promise<DriveRecovery>) | null,
): void {
  render(<UserSelector users={users} onSelect={onSelect} onCreate={onCreate} onRecover={onRecover} />, root);
}

/** One of the welcome screen's two install buttons: logo and name, nothing
 *  else — no state, no detection (the author, 2026-11-08). */
function InstallTile({ icon, label, onClick }: {
  icon: ComponentChildren;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      class="flex-1 min-w-0 flex items-center justify-center gap-2 px-3 py-[11px] rounded-xl border border-border bg-elevated hover:border-muted hover:bg-surface transition-colors cursor-pointer text-[13.5px] text-primary" // ui-ok: Vitrine register
      onClick={onClick}
    >
      <span class="shrink-0 flex">{icon}</span>
      <span class="truncate">{label}</span>
    </button>
  );
}

const preloadDrive = () => { void initDriveClient().catch(() => { /* retried by the click itself */ }); };
