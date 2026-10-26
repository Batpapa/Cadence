import { render } from 'preact';
import { useState, useRef, useEffect, useLayoutEffect } from 'preact/hooks';
import { appState, routeSignal, stateEpoch, canGoBack, canGoForward, navigate, goBack, goForward, mutate } from './store';
import type { AppContext } from './types';
import { isMobileDevice } from './utils';
import { Sidebar } from './components/sidebar';
import { AppHeader, BottomNav, headerCompact } from './components/header';
import { ModalHost } from './components/modal';
import { CommandPaletteHost } from './components/commandPalette';
import { initScrollRestoration } from './components/scrollRestoration';
import { DeckPickerHost } from './components/deckSelector';
import { WelcomePrefs } from './components/welcomePrefs';
import { GithubIcon, CloudDownIcon, UpdateIcon, InstallIcon } from './components/icons';
import { WelcomeTour } from './components/welcomeTour';
import { installAction } from './components/installOffer';
import { t } from './services/i18nService';
import { updateReady, applyUpdate, versionLabel } from './services/updateService';
import { initDriveClient } from './services/driveService';
import type { User } from './types';
import { FolderView } from './views/folder';
import { DeckView } from './views/deck';
import { CardView } from './views/card';
import { LibraryView } from './views/library';
import { StudyView } from './views/study';
import { ModulesView } from './views/modules';
import { SessionsView } from './views/sessions';
import { TrendingView } from './views/trending';
import { CadenceMark } from './components/cadenceMark';

const SIDEBAR_WIDTH_KEY     = 'cadence_sidebar_width';
const SIDEBAR_COLLAPSED_KEY = 'cadence_sidebar_collapsed';
const SIDEBAR_DEFAULT       = 224;
const SIDEBAR_MIN           = 120;
const SIDEBAR_MAX           = 400;

// Routes to the appropriate Preact component.
// key= on stateful views forces a remount when the ID changes (resets local
// state) — and, via stateEpoch, when a Drive apply replaces the whole state
// (mount-time drafts would otherwise keep showing the pre-apply data).
// SessionsView is deliberately OUTSIDE the epoch: a remount there would tear
// down a live recording in progress, and its library reads reactively anyway.
function ContentSwitch() {
  const route = routeSignal.value;
  const e = `e${stateEpoch.value}:`;
  if (route.view === 'study')   return <StudyView key={e} deckId={route.deckId} cardIds={route.cardIds} studyTitle={route.studyTitle} strategy={route.strategy} currentCardId={route.currentCardId} contextDeckId={route.contextDeckId} skippedCardIds={route.skippedCardIds} />;
  if (route.view === 'deck')    return <DeckView   key={e + route.deckId}   deckId={route.deckId} />;
  if (route.view === 'library') return <LibraryView key={e} />;
  if (route.view === 'card')    return <CardView   key={e + route.cardId}   cardId={route.cardId} contextDeckId={route.contextDeckId} />;
  if (route.view === 'folder')  return <FolderView key={e + (route.folderId ?? 'root')} folderId={route.folderId} />;
  if (route.view === 'modules') return <ModulesView key={e} />;
  // Spread, not field by field: this route now carries the whole shape of the
  // list (tab, ordering, chips), and enumerating them here was one more place
  // to forget one.
  if (route.view === 'sessions') return <SessionsView key={route.sessionId ?? "library"} {...route} />;
  if (route.view === 'trending') return <TrendingView key={e} />;
  const _: never = route; return _;
}

function AppRoot() {
  const wrapperRef    = useRef<HTMLDivElement>(null);
  const resizeLineRef = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const n = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? '', 10);
    return isNaN(n) ? SIDEBAR_DEFAULT : Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, n));
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (stored !== null) return stored === 'true';
    return isMobileDevice();
  });
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < 768);

  // Hides the static legal footer of index.html while a user is open: its
  // links are in Settings → About here (see styles.css).
  useLayoutEffect(() => {
    document.documentElement.classList.add('app-open');
    return () => document.documentElement.classList.remove('app-open');
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => {
      const el = wrapperRef.current;
      if (el) el.style.transition = 'none';
      setIsNarrow(e.matches);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (el) el.style.removeProperty('transition');
      }));
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const PORTRAIT_PHONE_QUERY = '(max-width: 767px) and (orientation: portrait) and (pointer: coarse)';
  const [isPortraitPhone, setIsPortraitPhone] = useState(() => window.matchMedia(PORTRAIT_PHONE_QUERY).matches);

  useEffect(() => {
    const mq = window.matchMedia(PORTRAIT_PHONE_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsPortraitPhone(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed(c => {
      const next = !c;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  };

  // Explicitly read every signal so Preact subscribes AppRoot to re-render on each change.
  const ctx: AppContext = {
    user:         appState.value,
    route:        routeSignal.value,
    navigate,
    back:         goBack,
    forward:      goForward,
    canGoBack:    canGoBack.value,
    canGoForward: canGoForward.value,
    mutate,
  };

  const startResize = (startX: number) => {
    const startW = wrapperRef.current!.offsetWidth;
    wrapperRef.current!.style.transition = 'none';
    if (resizeLineRef.current) resizeLineRef.current.style.background = 'rgb(var(--color-accent-ch)/0.4)';

    const onMove = (x: number) => {
      const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startW + x - startX));
      wrapperRef.current!.style.width = w + 'px';
    };
    const onEnd = () => {
      const w = wrapperRef.current!.offsetWidth;
      wrapperRef.current!.style.removeProperty('transition');
      if (resizeLineRef.current) resizeLineRef.current.style.removeProperty('background');
      setSidebarWidth(w);
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onEnd);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    };

    const onMouseMove = (ev: MouseEvent) => onMove(ev.clientX);
    const onMouseUp   = onEnd;
    const onTouchMove = (ev: TouchEvent) => { ev.preventDefault(); onMove(ev.touches[0]!.clientX); };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onEnd);
  };

  const onResizeStart  = (e: MouseEvent) => { e.preventDefault(); startResize(e.clientX); };
  const onResizeTouch  = (e: TouchEvent) => { e.preventDefault(); startResize(e.touches[0]!.clientX); };

  return (
    <div class="flex flex-col flex-1 overflow-hidden">
      <AppHeader ctx={ctx} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} isPortraitPhone={isPortraitPhone} />
      <div class="relative flex flex-1 overflow-hidden min-h-0">
        {isNarrow && !sidebarCollapsed && (
          <div class="absolute inset-0 z-20 bg-black/40" onClick={toggleSidebar} />
        )}
        <div
          ref={wrapperRef}
          style={{ width: (isNarrow || !sidebarCollapsed) ? sidebarWidth + 'px' : '0px' }}
          class={isNarrow
            ? `absolute top-0 bottom-0 left-0 z-30 overflow-hidden transition-transform duration-200 ease-in-out ${sidebarCollapsed ? '-translate-x-full' : 'translate-x-0'}`
            : `shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out`}
        >
          <div class="h-full">
            <Sidebar ctx={ctx} />
          </div>
        </div>
        {!sidebarCollapsed && (
          <div
            class={`cursor-col-resize touch-none group ${isNarrow ? 'absolute top-0 bottom-0 w-2 z-30' : 'shrink-0 w-2'}`}
            style={isNarrow ? { left: sidebarWidth + 'px' } : undefined}
            onMouseDown={onResizeStart}
            onTouchStart={onResizeTouch}
          >
            <div ref={resizeLineRef} class="w-px h-full bg-transparent group-hover:bg-accent/40 transition-colors" />
          </div>
        )}
        <main class="flex-1 overflow-hidden bg-bg">
          <ContentSwitch />
        </main>
      </div>
      {/* Also wherever the header found no room for its wide layout: Home,
          Library, Modules and ‹ › then live down here, as on a phone. */}
      {(isPortraitPhone || headerCompact.value) && <BottomNav ctx={ctx} />}
      <ModalHost />
      <CommandPaletteHost />
      <DeckPickerHost />
    </div>
  );
}

export function mountApp(root: HTMLElement): void {
  render(null, root);
  render(<AppRoot />, root);
  initScrollRestoration();
}

// ── User selector ─────────────────────────────────────────────────────────────

const initialsOf = (name: string) =>
  name.split(/[\s-]+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '?';

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
        class="flex items-center gap-1.5 text-[10.5px] text-dim hover:text-primary transition-colors"
      >
        <GithubIcon size={12} />
        <span>Batpapa</span>
      </a>

      {/* Quiet, like the signature: for the screenshot someone sends
          when asking for help. When a newer build is ready it becomes the
          way to get it — nothing is open on this screen for a reload to
          lose, and there is no header here to carry the pill. */}
      <div class="flex items-center gap-2 text-[10px] text-dim tabular-nums">
        <span>{versionLabel()}</span>
        {updateReady.value && (
          <button
            class="flex items-center gap-1 text-accent hover:underline cursor-pointer"
            title={t('update.title', { version: versionLabel(updateReady.value) })}
            onClick={applyUpdate}
          >
            <UpdateIcon size={11} />
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
  const install = installAction();

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
        {/* The same offer as the header's ⋮ menu (2026-10-26): a first-time
            visitor lands here, and on Android the Play app is the better way
            in. Only when there is something to install. */}
        {install && (
          <button type="button" class="btn-ghost text-xs inline-flex items-center gap-1.5 text-accent" onClick={install}>
            <InstallIcon size={13} />{t('settings.install')}
          </button>
        )}
        <WelcomePrefs onLanguageChange={() => redraw(x => x + 1)} />
      </div>
      <div class="shrink-0 flex flex-col items-center px-4 pt-14 pb-12 lg:flex-1 lg:min-w-0 lg:overflow-y-auto lg:py-10">
      <div class="w-full max-w-[352px] lg:my-auto flex flex-col items-center">

        {/* ── Marque ── */}
        <div class="mark-in mb-[22px]">
          <CadenceMark size={78} />
        </div>

        <div class="rise-in text-center" style="animation-delay:.7s">
          <div class="text-[38px] font-extralight tracking-[-0.015em] leading-none text-primary">
            Cadence
          </div>
          <p class="text-[13.5px] text-muted leading-relaxed mt-3.5 text-pretty">
            {t('welcome.tagline')}
          </p>
        </div>

        <div class="fade-in w-11 h-px bg-border mt-[30px] mb-[26px]" style="animation-delay:1s" />

        {/* ── Sélection ── */}
        <div class="rise-in w-full" style="animation-delay:1.05s">
          <h1 class="text-[10.5px] font-semibold text-dim uppercase tracking-[0.16em] text-center mb-3.5">
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
                <span class="text-sm font-medium text-primary truncate flex-1">{u.name}</span>
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
                  class="rise-in w-full flex items-center justify-center gap-2 px-3.5 py-[11px] rounded-xl border border-dashed border-border text-dim hover:border-muted hover:text-primary transition-colors cursor-pointer text-[13.5px]"
                  style={`animation-delay:${1.1 + users.length * 0.07}s`}
                  disabled={!!loading}
                  onClick={() => setCreating(true)}
                >
                  + {t('userSelector.new')}
                </button>
                {onRecover && (
                  <button
                    class={`rise-in w-full flex items-center justify-center gap-2 px-3.5 py-[11px] rounded-xl border border-dashed border-border text-dim hover:border-muted hover:text-primary transition-colors cursor-pointer text-[13.5px] ${loading === 'drive' ? 'opacity-60' : ''}`}
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

          {recoverError && (
            <p class="text-xs text-muted leading-relaxed text-center text-pretty mt-2.5">
              {t(recoverError === 'inAppBrowser' ? 'settings.sync.inAppBrowserError' : 'userSelector.recover.failed')}
            </p>
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

const preloadDrive = () => { void initDriveClient().catch(() => { /* retried by the click itself */ }); };
