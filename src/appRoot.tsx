import { render } from 'preact';
import { useState, useRef, useLayoutEffect, useEffect } from 'preact/hooks';
import { appState, routeSignal, canGoBack, canGoForward, navigate, goBack, goForward, mutate } from './store';
import type { AppContext } from './types';
import { isMobileDevice } from './utils';
import { renderSidebar } from './components/sidebar';
import { AppHeader, BottomNav } from './components/header';
import { confirmModal } from './components/modal';
import { GithubIcon } from './components/icons';
import { t } from './services/i18nService';
import type { User } from './types';
import { FolderView } from './views/folder';
import { DeckView } from './views/deck';
import { CardView } from './views/card';
import { LibraryView } from './views/library';
import { StudyView } from './views/study';
import { ModulesView } from './views/modules';
import { SessionsView } from './views/sessions';
import { TrendingView } from './views/trending';

const SIDEBAR_WIDTH_KEY     = 'cadence_sidebar_width';
const SIDEBAR_COLLAPSED_KEY = 'cadence_sidebar_collapsed';
const SIDEBAR_DEFAULT       = 224;
const SIDEBAR_MIN           = 120;
const SIDEBAR_MAX           = 400;

// Routes to the appropriate Preact component.
// key= on stateful views forces a remount when the ID changes (resets local state).
function ContentSwitch() {
  const route = routeSignal.value;
  if (route.view === 'study')   return <StudyView deckId={route.deckId} cardIds={route.cardIds} studyTitle={route.studyTitle} strategy={route.strategy} currentCardId={route.currentCardId} contextDeckId={route.contextDeckId} />;
  if (route.view === 'deck')    return <DeckView   key={route.deckId}   deckId={route.deckId} />;
  if (route.view === 'library') return <LibraryView />;
  if (route.view === 'card')    return <CardView   key={route.cardId}   cardId={route.cardId} contextDeckId={route.contextDeckId} />;
  if (route.view === 'folder')  return <FolderView key={route.folderId ?? 'root'} folderId={route.folderId} />;
  if (route.view === 'modules') return <ModulesView />;
  if (route.view === 'sessions') return <SessionsView key={route.sessionId ?? 'library'} sessionId={route.sessionId} />;
  if (route.view === 'trending') return <TrendingView />;
  const _: never = route; return _;
}

function AppRoot() {
  const sidebarRef    = useRef<HTMLDivElement>(null);
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

  useLayoutEffect(() => {
    sidebarRef.current!.replaceChildren(renderSidebar(ctx));
  });

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
          <div ref={sidebarRef} class="h-full" />
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
      {isPortraitPhone && <BottomNav ctx={ctx} />}
    </div>
  );
}

export function mountApp(root: HTMLElement): void {
  render(null, root);
  render(<AppRoot />, root);
}

// ── User selector ─────────────────────────────────────────────────────────────

const initialsOf = (name: string) =>
  name.split(/[\s-]+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '?';

// Same three strokes as src/icons/icon.svg, unchanged — the app-icon tile
// (#2a2f34 background) is deliberately NOT shown here, just the mark itself
// on the app's own background. pathLength="1" normalizes each stroke so
// stroke-dasharray:1 / stroke-dashoffset:1→0 (styles.css's markDraw
// animation) works regardless of each path's real length.
const MARK_D = [
  'm 34.938038,224.24193 h 10.133205 c 1.692805,0.10418 2.467388,2.8912 3.546623,2.91329 2.519211,0.059 5.745988,-14.81212 8.23323,-14.69314 4.502632,-0.13544 4.030544,32.52667 8.866558,32.55292 4.826937,0.1718 2.180009,-18.57973 8.106564,-38.88618 4.102301,-11.90735 14.733752,-17.72954 24.461728,-19.40917 10.274454,-1.57623 18.489864,1.90532 26.287504,7.83787',
  'm 98.480177,220.92875 c 0.911732,-3.01425 2.599123,-5.4052 6.607143,-5.32315 5.03033,0.18731 8.56327,3.7084 8.82115,9.29411 0.10954,4.84835 -3.36941,9.73281 -9.25204,10.8233 -6.81755,0.98296 -15.452109,-2.92859 -17.514598,-13.7119 -1.710174,-14.80596 11.955842,-20.09785 18.376398,-20.042 12.17048,0.0505 23.53117,10.26188 23.26864,23.84318 -0.18698,16.28832 -15.16462,23.78684 -23.20916,23.95198 -11.725849,0.41409 -21.101004,-7.15282 -27.113393,-16.75287',
  'm 174.01374,224.85436 h -10.1332 c -1.69281,-0.10418 -2.46739,-2.8912 -3.54663,-2.91329 -2.51921,-0.059 -5.74599,14.81212 -8.23323,14.69314 -4.50263,0.13544 -4.03054,-32.52667 -8.86655,-32.55292 -4.82694,-0.1718 -2.18001,18.57973 -8.10657,38.88618 -4.1023,11.90735 -14.73375,17.72954 -24.46172,19.40917 -10.27446,1.57623 -18.489872,-1.90532 -26.287512,-7.83787',
];

/** Couleur littérale, hors palette applicative — l'accent violet reste
 *  réservé à l'UI (avatars, boutons) ; le cyan #6cf6e9 est la couleur de
 *  marque du logo, volontairement identique quel que soit le thème actif
 *  (light/green ne le retintent pas — comportement voulu pour un logo). */
function CadenceMark({ size = 78 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 154 154"
      class="cadence-mark block overflow-visible"
      aria-hidden="true"
    >
      <g
        transform="translate(-27.564509,-147.72464)"
        fill="none"
        stroke="#6cf6e9"
        stroke-width="3.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        {MARK_D.map(d => <path key={d} d={d} pathLength="1" />)}
      </g>
    </svg>
  );
}

function UserSelector({ users, onSelect, onCreate, onDelete }: {
  users: User[];
  onSelect: (id: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [loading,  setLoading]  = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName,  setNewName]  = useState('');

  const select = async (id: string) => {
    setLoading(id);
    await onSelect(id);
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setLoading('new');
    await onCreate(name);
  };

  const confirmDelete = (u: User) => {
    confirmModal(
      t('userSelector.delete.title'),
      t('userSelector.delete.message', { name: u.name }),
      t('userSelector.delete.confirm'),
      () => void onDelete(u.id),
    );
  };

  return (
    <div class="fixed inset-0 bg-bg flex items-center justify-center overflow-y-auto py-10">
      <div class="w-full max-w-[352px] mx-4 flex flex-col items-center">

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
              <div
                key={u.id}
                class={`rise-in group w-full flex items-center gap-3 px-3.5 py-[11px] rounded-xl border border-border bg-elevated hover:border-muted hover:bg-surface transition-colors ${loading === u.id ? 'opacity-60' : ''}`}
                style={`animation-delay:${1.1 + i * 0.07}s`}
              >
                <button
                  disabled={!!loading}
                  onClick={() => void select(u.id)}
                  class="flex items-center gap-3 flex-1 min-w-0 cursor-pointer text-left"
                >
                  <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style="background:rgb(var(--color-accent-ch)/0.18)">
                    <span class="text-xs font-mono font-bold text-accent">{initialsOf(u.name)}</span>
                  </div>
                  <span class="text-sm font-medium text-primary truncate flex-1">{u.name}</span>
                </button>
                <button
                  disabled={!!loading}
                  onClick={() => confirmDelete(u)}
                  class="opacity-0 group-hover:opacity-100 shrink-0 text-dim hover:text-danger transition-all cursor-pointer"
                  title={t('userSelector.delete.title')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            ))}

            {creating ? (
              <div class="flex gap-2 pt-1">
                <input
                  autoFocus
                  type="text"
                  value={newName}
                  placeholder={t('userSelector.namePlaceholder')}
                  class="input flex-1 text-sm"
                  onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')  void create();
                    if (e.key === 'Escape') { setCreating(false); setNewName(''); }
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
            ) : (
              <button
                class="rise-in w-full flex items-center justify-center gap-2 px-3.5 py-[11px] rounded-xl border border-dashed border-border text-dim hover:border-muted hover:text-primary transition-colors cursor-pointer text-[13.5px]"
                style={`animation-delay:${1.1 + users.length * 0.07}s`}
                onClick={() => setCreating(true)}
              >
                + {t('userSelector.new')}
              </button>
            )}
          </div>

          <div class="flex flex-col items-center gap-2.5 mt-5">
            <div class="flex justify-center gap-3.5">
              <a href="./privacy.html" rel="noopener" class="text-[10px] text-dim hover:text-muted transition-colors">{t('settings.privacyPolicy')}</a>
              <a href="./terms.html" rel="noopener" class="text-[10px] text-dim hover:text-muted transition-colors">{t('settings.termsOfService')}</a>
            </div>

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
          </div>
        </div>
      </div>
    </div>
  );
}

export function mountUserSelector(
  root: HTMLElement,
  users: User[],
  onSelect: (id: string) => Promise<void>,
  onCreate: (name: string) => Promise<void>,
  onDelete: (id: string) => Promise<void>,
): void {
  render(<UserSelector users={users} onSelect={onSelect} onCreate={onCreate} onDelete={onDelete} />, root);
}
