import { useState, useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { signal } from '@preact/signals';
import type { ComponentChildren, RefObject } from 'preact';
import type { AppContext } from '../types';
import { showCommandPalette } from './commandPalette';
import { showHelpModal } from './help';
import { showSettingsModal, showProfileModal } from './settingsModal';
import { showModal, closeModal } from './modal';
import { registerOverlay } from './overlayStack';
import { canInstallSignal, isStandalone, isIOS, triggerInstall } from '../services/pwaService';
import { isMacSafariInstallable } from '../utils';
import { t } from '../services/i18nService';
import { updateReady, applyUpdate } from '../services/updateService';
import { saveFailure } from '../services/saveHealth';
import { showSaveFailureModal } from './saveFailureModal';
import { getZoom } from '../services/zoomService';
import { sessionRecordingSignal } from '../session/ui/sessionStore';
import { softKeyboardOpen } from '../services/softKeyboard';
import {
  isDriveFeatureEnabled, getDriveStatus, onStatusChange, manualSync, type DriveStatus,
} from '../services/driveService';
import {
  HomeIcon, LibraryIcon, SearchIcon, HelpIcon, SettingsIcon, ModulesIcon,
  CloudUpIcon, ChevronDownIcon, CheckIcon, PanelLeftIcon, CadenceLogo,
  ArrowLeftIcon, ArrowRightIcon, RecordingPulseDot, InstallIcon, WarningTriangleIcon, UpdateIcon, MoreVerticalIcon,
} from './icons';
import { showAboutModal } from './aboutModal';
import { showStorageModal } from './storageModal';
import { pinnedModule, isPinnedRouteActive } from './pinnedModule';
import { storagePersisted, storageUsage, storageQuota, assessStorage, effectivePersisted } from '../services/storageService';

const initialsOf = (name: string) =>
  name.split(/[\s-]+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '—';

function HeaderBtn({ title, active, overflow, onClick, children }: {
  title: string; onClick: () => void; active?: boolean; overflow?: OverflowId; children: ComponentChildren;
}) {
  return (
    <button
      class={`hdr-btn cursor-pointer
        ${active ? 'bg-accent/10 text-accent' : 'text-dim hover:text-primary hover:bg-elevated'}`}
      title={title}
      data-overflow={overflow}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// ── Layout: wide or compact, and what goes into ⋮ ────────────────────────────
// Since 2026-10-23 (third version of the day, the author's design):
//   · ⋮ is always there, and always holds About, install, update and Settings.
//   · When room runs out, Search goes into it, then Help.
//   · When the centred profile no longer fits beside Home / Library / Modules,
//     the header switches to the phone's layout: those go to the bottom bar
//     with ‹ ›, and the profile becomes its initials on the right. A portrait
//     phone is always in that layout.
// Measured on the bar itself rather than decided by a breakpoint: the app's
// zoom, the language and the items that come and go (pinned module, alerts,
// recording) all change what fits, and only the rendered bar knows.

type OverflowId = 'search' | 'help';

/** First to leave the bar first. */
const OVERFLOW_ORDER: readonly OverflowId[] = ['search', 'help'];

/** True while the header is in its compact layout — read by AppRoot, which
 *  then shows the bottom bar. A signal because the header is the only place
 *  that can measure whether the wide layout fits. */
export const headerCompact = signal(false);

/** One step per call — switch layout, hide the next item or bring the last one
 *  back — and a re-render in between, so every decision is taken on a bar that
 *  is really laid out. An item comes back only with its whole measured width
 *  plus a margin to spare, and the wide layout only once the bar is wider than
 *  the width it was found missing at, so no step can undo the previous one at
 *  the same width. */
function useHeaderLayout(forceCompact: boolean) {
  const headerRef = useRef<HTMLElement>(null);
  const leftRef   = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const rightRef  = useRef<HTMLDivElement>(null);
  const widths    = useRef<Partial<Record<OverflowId, number>>>({});
  // The bar width the wide layout needs, worked out when it stopped fitting.
  const wideMinW  = useRef(0);
  // The safety net under the arithmetic: an item that went back into ⋮ right
  // after being brought out stays there until the bar's width changes. Any
  // width the measurement does not see (a divider, a margin) would otherwise
  // make it flip on every frame, and a flip on every frame is a frozen tab
  // (seen 2026-10-23, from a divider shown with Home only).
  const lastRestored = useRef<OverflowId | null>(null);
  const stuckAt   = useRef<Partial<Record<OverflowId, number>>>({});
  const steps     = useRef({ w: 0, n: 0 });
  const [hiddenIds, setHiddenIds] = useState<OverflowId[]>([]);
  const [compactState, setCompactState] = useState(false);
  const compact = forceCompact || compactState;
  const hidden = new Set(hiddenIds);

  const fit = useRef(() => {});
  fit.current = () => {
    const header = headerRef.current, left = leftRef.current, right = rightRef.current;
    if (!header || !left || !right) return;
    // Widths are remembered while an item is in the bar: once in ⋮, the width
    // it would take back is no longer on screen to be measured.
    header.querySelectorAll<HTMLElement>('[data-overflow]').forEach(el => {
      widths.current[el.dataset.overflow as OverflowId] = el.getBoundingClientRect().width;
    });
    // Rects come back in the zoomed space (zoomService), so the margin does too.
    const gap = 8 * getZoom() / 100;
    const barW = header.getBoundingClientRect().width;
    // Last resort, past the per-item guard: a bar still changing its mind after
    // this many steps at one width stops trying until the width changes.
    if (steps.current.w !== barW) steps.current = { w: barW, n: 0 };
    if (steps.current.n > 8) return;
    const step = () => { steps.current.n++; };

    const L = left.getBoundingClientRect();
    const R = right.getBoundingClientRect();
    const C = compact ? undefined : centerRef.current?.getBoundingClientRect();
    const leftRoom  = C ? C.left - gap - L.right : 0;
    const rightRoom = R.left - gap - (C ? C.right : L.right);
    const toHide = OVERFLOW_ORDER.find(id => !hidden.has(id));

    if (!forceCompact) {
      // The profile is centred, so the bar has to grow by twice what is
      // missing on one side for that side to gain it.
      const goCompact = () => {
        wideMinW.current = barW + 2 * Math.max(-leftRoom, -rightRoom, 0) + 2 * gap;
        step();
        setCompactState(true);
      };
      if (!compact && (leftRoom < 0 || (rightRoom < 0 && !toHide))) { goCompact(); return; }
      if (compactState && barW >= wideMinW.current) { step(); setCompactState(false); return; }
    }

    if (rightRoom < 0) {
      if (toHide) {
        if (toHide === lastRestored.current) stuckAt.current[toHide] = barW;
        lastRestored.current = null;
        step();
        setHiddenIds([...hiddenIds, toHide]);
      }
      // Still too tight with nothing left to hide: nothing better exists.
      return;
    }

    // The most important hidden item first: a less important one never shows
    // while a more important one is still in ⋮.
    const id = [...OVERFLOW_ORDER].reverse().find(h => hidden.has(h));
    if (id) {
      const stuck = stuckAt.current[id];
      const need = (widths.current[id] ?? 0) + gap;
      if ((stuck === undefined || Math.abs(stuck - barW) >= 1) && widths.current[id] !== undefined && rightRoom >= need) {
        lastRestored.current = id;
        step();
        setHiddenIds(hiddenIds.filter(h => h !== id));
        return;
      }
    }
    // Settled.
    lastRestored.current = null;
    steps.current.n = 0;
  };

  useLayoutEffect(() => fit.current());
  useLayoutEffect(() => { headerCompact.value = compact; }, [compact]);
  useEffect(() => {
    const ro = new ResizeObserver(() => fit.current());
    for (const el of [headerRef.current, leftRef.current, rightRef.current]) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { headerRef, leftRef, centerRef, rightRef, hidden, compact };
}

// ── Header menus ─────────────────────────────────────────────────────────────

/** A menu hung under a header button, portaled to <body>. On the overlay stack
 *  like every other popup, so Back and Escape close it — the Android app's Back
 *  used to send the whole app to the background past the profile menu (seen
 *  2026-10-05). */
function HeaderMenu({ anchor, align, onClose, children }: {
  anchor: RefObject<HTMLElement>; align: 'center' | 'right'; onClose: () => void; children: ComponentChildren;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // `document.documentElement` has a CSS `zoom` applied (zoomService); the portaled
  // menu stays a descendant of it, so its fixed top/left/right get re-scaled by that
  // zoom on render. Pre-divide by the factor to compensate.
  const [pos] = useState(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return {};
    const factor = getZoom() / 100;
    const top = `${(rect.bottom + 4) / factor}px`;
    return align === 'center'
      ? { top, left: `${(rect.left + rect.width / 2) / factor}px` }
      : { top, right: `${(window.innerWidth - rect.right) / factor}px` };
  });

  useEffect(() => registerOverlay(onClose), []);
  useEffect(() => {
    const onOutside = (e: PointerEvent) => {
      // The anchor toggles the menu itself: closing here as well would have its
      // click reopen it at once.
      if (ref.current?.contains(e.target as Node) || anchor.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, []);

  return createPortal((
    <div
      ref={ref}
      role="menu"
      class={`fixed z-30 bg-elevated border border-border rounded-xl overflow-hidden shadow-2xl p-1.5
        ${align === 'center' ? '-translate-x-1/2' : ''}`}
      style={pos}
    >
      {children}
    </div>
  ), document.body);
}

/** One line per entry, no subtitles (the author's call, 2026-10-23). The icon
 *  column is 24 px for every row, wide enough for the logo glyph, so the labels
 *  line up whatever the icon; `[&>svg]:shrink-0` because an SVG is a flex item
 *  that would otherwise shrink to the column instead of keeping its size. */
function MenuRow({ icon, label, accent, dot, onClick }: {
  icon: ComponentChildren; label: string; accent?: boolean; dot?: boolean; onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      class="w-full flex items-center gap-3 min-h-11 px-2.5 py-2 rounded-lg text-left text-sm text-primary hover:bg-surface cursor-pointer border-none bg-transparent transition-colors"
      onClick={onClick}
    >
      <span class={`w-6 flex items-center justify-center shrink-0 [&>svg]:shrink-0 ${accent ? 'text-accent' : 'text-muted'}`}>{icon}</span>
      <span class="flex-1 min-w-0 whitespace-nowrap">{label}</span>
      {dot && <span class="w-2 h-2 rounded-full bg-accent shrink-0" />}
    </button>
  );
}

// ── Status items ─────────────────────────────────────────────────────────────

const SYNC_TITLE: Record<DriveStatus, string> = {
  pending:      'sidebar.sync.pending',
  syncing:      'sidebar.sync.syncing',
  connected:    'sidebar.sync.connected',
  error:        'sidebar.sync.error',
  disconnected: '',
  connecting:   '',
};

function SyncBtn({ status, icon }: { status: DriveStatus; icon: number }) {
  const cls =
    status === 'pending'   ? 'text-yellow-400 cursor-pointer' :
    status === 'syncing'   ? 'text-accent animate-pulse cursor-default' :
    status === 'connected' ? 'text-green-500 cursor-default' :
                             'text-danger cursor-pointer';
  const clickable = status === 'pending' || status === 'error';
  return (
    <button
      class={`hdr-btn ${cls}`}
      title={t(SYNC_TITLE[status] as Parameters<typeof t>[0])}
      onClick={clickable ? () => void manualSync() : undefined}
    >
      <CloudUpIcon size={icon} />
    </button>
  );
}

/** Set once the install entry has been used on this device. From then on its
 *  dots go: a dot reads as "something needs you", and not installing can be a
 *  choice (the author's remark, 2026-10-23). The entry itself stays. Per
 *  device on purpose — installing is. */
const INSTALL_SEEN_KEY = 'cadence_install_offer_seen';
const installOfferSeen = signal(readInstallSeen());

function readInstallSeen(): boolean {
  try { return localStorage.getItem(INSTALL_SEEN_KEY) === '1'; } catch { return false; }
}

function markInstallSeen(): void {
  installOfferSeen.value = true;
  try { localStorage.setItem(INSTALL_SEEN_KEY, '1'); } catch { /* the dot comes back next time, nothing worse */ }
}

/** What installing takes here, or null when there is nothing to offer: a live
 *  `beforeinstallprompt` (Chrome/Edge/Android), or iOS and Mac Safari where the
 *  prompt does not exist and the steps have to be spelled out. Self-erasing:
 *  once installed the app runs standalone and the offer is gone.
 *
 *  In the header at all because most people never opened Settings → About, and
 *  so never learnt Cadence was installable. */
function installAction(): (() => void) | null {
  const canPrompt = canInstallSignal.value;
  const ios = isIOS();
  if (isStandalone() || (!canPrompt && !ios && !isMacSafariInstallable())) return null;
  return () => {
    if (canPrompt) { void triggerInstall(); return; }
    const body = document.createElement('p');
    body.className = 'text-sm text-muted leading-relaxed';
    body.textContent = t(ios ? 'settings.installIOS' : 'settings.installMac');
    showModal(t('settings.install'), body, [{ label: t('common.close'), primary: true, onClick: closeModal }]);
  };
}

interface Alert { key: string; label: string; danger: boolean; open: () => void }

/** Both warnings behind one triangle (2026-10-23), coloured by the worse of
 *  the two, with their count when there are two — one click then lists them.
 *
 *  A failed write (saveFailure) is red and, on a computer, labelled: data is
 *  being lost now. Its explanation opens by itself the first time a kind of
 *  failure appears — and only then, not on every retry that fails again.
 *
 *  The storage warning shows ONLY when the browser has not granted persistent
 *  storage — that is, when it may delete everything Cadence holds on this
 *  device without asking — or when the origin is full. Deliberately not tied to
 *  free space otherwise: a triangle that is sometimes on for a reason the user
 *  cannot act on is a triangle they stop reading. Unknown counts as a warning:
 *  a browser that will not say whether the data is safe is not one whose
 *  silence should be read as a yes (incident of 2026-09-09). Red when full — a
 *  full origin drops recording chunks silently — amber otherwise. */
function AlertBtn({ compact, icon }: { compact: boolean; icon: number }) {
  const failure = saveFailure.value;
  const seen = useRef<string[]>([]);
  useEffect(() => {
    const kinds = failure?.kinds ?? [];
    if (kinds.some(k => !seen.current.includes(k))) showSaveFailureModal();
    seen.current = kinds;
  }, [failure]);

  // Reads the signals, so this re-renders on its own when the boot request
  // settles and when the estimate is refreshed. assessStorage owns every case,
  // including "not asked yet".
  const risk = assessStorage(effectivePersisted(storagePersisted.value), storageUsage.value, storageQuota.value);

  const alerts: Alert[] = [];
  if (failure) alerts.push({ key: 'save', label: t('saveFailure.pillTitle'), danger: true, open: showSaveFailureModal });
  if (risk !== 'none') {
    const full = risk === 'full';
    alerts.push({ key: 'storage', label: t(full ? 'storage.warningFull' : 'storage.warning'), danger: full, open: showStorageModal });
  }

  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (alerts.length < 2) setOpen(false); }, [alerts.length]);
  if (alerts.length === 0) return null;

  const danger = alerts.some(a => a.danger);
  const labelled = !compact && !!failure;
  const only = alerts.length === 1 ? alerts[0]! : null;
  return (
    <>
      <button
        ref={btnRef}
        class={`hdr-btn relative gap-1.5 cursor-pointer ${
          labelled ? 'px-3 bg-danger/10 text-danger hover:bg-danger/20'
          : danger ? 'text-danger hover:bg-danger/10' : 'text-warn hover:bg-warn/10'
        }`}
        title={only ? only.label : t('header.alerts', { count: alerts.length })}
        onClick={() => { if (only) only.open(); else setOpen(o => !o); }}
      >
        <WarningTriangleIcon size={icon} />
        {labelled && <span class="text-xs font-medium">{t('saveFailure.pill')}</span>}
        {!only && (
          <span class={`absolute top-0.5 right-0.5 min-w-4 h-4 px-1 rounded-full text-[10px] font-semibold text-bg flex items-center justify-center ${
            danger ? 'bg-danger' : 'bg-warn'
          }`}>{alerts.length}</span>
        )}
      </button>
      {open && !only && (
        <HeaderMenu anchor={btnRef} align="center" onClose={() => setOpen(false)}>
          {alerts.map(a => (
            <MenuRow
              key={a.key}
              icon={<span class={a.danger ? 'text-danger flex' : 'text-warn flex'}><WarningTriangleIcon size={18} /></span>}
              label={a.label}
              onClick={() => { setOpen(false); a.open(); }}
            />
          ))}
        </HeaderMenu>
      )}
    </>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────

export function AppHeader({ ctx, sidebarCollapsed, onToggleSidebar, isPortraitPhone }: {
  ctx: AppContext;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  isPortraitPhone: boolean;
}) {
  const { route, user, canGoBack, canGoForward } = ctx;
  const currentProfile = user.profiles[user.currentProfileId];
  // Sizes follow the device, the layout follows the room: a narrow window on a
  // computer gets the phone's layout at the computer's sizes.
  const icon = isPortraitPhone ? 20 : 18;

  const [profileOpen, setProfileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const profileBtnRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  const [driveStatus, setDriveStatus] = useState<DriveStatus>(getDriveStatus);
  useEffect(() => {
    if (!isDriveFeatureEnabled()) return;
    // Re-read after subscribing: the boot sync starts before this effect runs,
    // so a status set in that gap (a Drive read that failed fast) would only
    // ever exist in the value captured at first render, and the icon would sit
    // on a stale — reassuring — green.
    setDriveStatus(getDriveStatus());
    return onStatusChange(setDriveStatus);
  }, []);

  const { headerRef, leftRef, centerRef, rightRef, hidden, compact } = useHeaderLayout(isPortraitPhone);
  // The layout changes under an open menu: its position no longer matches.
  useEffect(() => { setMenuOpen(false); setProfileOpen(false); }, [compact]);

  const install   = installAction();
  const pinned    = pinnedModule();
  const recording = sessionRecordingSignal.value;
  // Gone while a recording or an import runs: a reload would end it. It comes
  // back on its own once that is over.
  const update    = recording ? null : updateReady.value;

  const homeActive    = route.view === 'folder' && route.folderId === null;
  const libActive     = route.view === 'library';
  const modulesActive = route.view === 'modules' || route.view === 'sessions';

  const search = () => showCommandPalette(() => ctx);
  const help   = () => showHelpModal(ctx);
  /** Closes the menu, then acts: a modal opened over a still-open menu would
   *  leave the menu on the overlay stack under it. */
  const fromMenu = (action: () => void) => () => { setMenuOpen(false); action(); };

  const initials = initialsOf(currentProfile?.name ?? '—');
  const overflowInMenu = OVERFLOW_ORDER.filter(id => hidden.has(id));

  return (
    <header
      ref={headerRef}
      class={`relative flex items-center px-1.5 border-b border-border bg-surface shrink-0 ${isPortraitPhone ? 'hdr-phone' : ''}`}
      style={`padding-top: var(--safe-top); min-height: calc(${isPortraitPhone ? '3.25rem' : '3rem'} + var(--safe-top))`}
    >

      {/* Left group */}
      <div ref={leftRef} class="flex items-center gap-1 shrink-0">
        <HeaderBtn title={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')} onClick={onToggleSidebar}>
          <PanelLeftIcon size={icon} />
        </HeaderBtn>
        {/* In the bottom bar in the compact layout, never in ⋮. */}
        {!compact && (
          <>
            <HeaderBtn title={t('sidebar.home')} active={homeActive} onClick={() => ctx.navigate({ view: 'folder', folderId: null })}>
              <HomeIcon size={icon} />
            </HeaderBtn>
            <HeaderBtn title={t('sidebar.library')} active={libActive} onClick={() => ctx.navigate({ view: 'library' })}>
              <LibraryIcon size={icon} />
            </HeaderBtn>
            <HeaderBtn title={t('sidebar.modules')} active={modulesActive} onClick={() => ctx.navigate({ view: 'modules' })}>
              <ModulesIcon size={icon} />
            </HeaderBtn>
            {/* The pinned module, right after the three fixed destinations and
                before the status icons: it IS a destination, and grouping it
                with the warning triangle would file a shortcut under "things
                that are wrong". Absent for everyone who has not pinned one. */}
            {pinned && (
              <HeaderBtn
                title={t(pinned.labelKey)}
                active={isPinnedRouteActive(route, pinned)}
                onClick={() => ctx.navigate(pinned.route)}
              >
                <pinned.Icon size={icon} />
              </HeaderBtn>
            )}
            <span class="w-px h-5 bg-border mx-1 shrink-0" />
          </>
        )}
        {isDriveFeatureEnabled() && driveStatus !== 'disconnected' && driveStatus !== 'connecting' && (
          <SyncBtn status={driveStatus} icon={icon} />
        )}
        <AlertBtn compact={compact} icon={icon} />
        {/* In the compact layout the dot joins the status icons: there is no
            centre group there, the profile having moved to the right. */}
        {compact && recording && (
          <RecordingPulseDot
            title={t('sessions.recordingIndicator')}
            onClick={() => ctx.navigate({ view: 'sessions' })}
            size={16}
            class="hdr-btn"
          />
        )}
      </div>

      {/* Center: ← profile → — wide layout only. In the compact one the arrows
          are in the bottom bar and the profile, as its initials, on the right:
          centred, it was what everything else ran under. */}
      {!compact && (
        <div ref={centerRef} class="absolute left-1/2 -translate-x-1/2 flex items-center gap-1 pointer-events-none">
          <button
            class={`pointer-events-auto hdr-btn ${canGoBack ? 'text-dim hover:text-primary hover:bg-elevated cursor-pointer' : 'text-border cursor-default'}`}
            title={t('sidebar.back')}
            disabled={!canGoBack}
            onClick={() => ctx.back()}
          ><ArrowLeftIcon size={icon} /></button>

          <button
            ref={profileBtnRef}
            class="pointer-events-auto hdr-btn gap-2 px-2.5 hover:bg-elevated cursor-pointer border-none bg-transparent"
            onClick={() => setProfileOpen(o => !o)}
          >
            <span
              class="w-6 h-6 rounded-md flex items-center justify-center shrink-0 text-[10px] font-mono font-bold text-accent"
              style="background:rgb(var(--color-accent-ch)/0.18)"
            >{initials}</span>
            <span class="text-[13px] text-primary font-medium max-w-[100px] truncate">{currentProfile?.name ?? '—'}</span>
            <span class="text-dim flex items-center"><ChevronDownIcon size={11} /></span>
          </button>

          {recording && (
            <RecordingPulseDot
              title={t('sessions.recordingIndicator')}
              onClick={() => ctx.navigate({ view: 'sessions' })}
              // A 12 px dot is a 12 px target: it needs the class more than the
              // icon buttons do, not less. The dot keeps its size, the reachable
              // area around it does not.
              class="hdr-btn"
            />
          )}

          <button
            class={`pointer-events-auto hdr-btn ${canGoForward ? 'text-dim hover:text-primary hover:bg-elevated cursor-pointer' : 'text-border cursor-default'}`}
            title={t('sidebar.forward')}
            disabled={!canGoForward}
            onClick={() => ctx.forward()}
          ><ArrowRightIcon size={icon} /></button>
        </div>
      )}

      <div class="flex-1" />

      {/* Right group */}
      <div ref={rightRef} class="flex items-center gap-1 shrink-0">
        {!hidden.has('search') && (
          <HeaderBtn title={t('sidebar.search')} overflow="search" onClick={search}>
            <SearchIcon size={icon} />
          </HeaderBtn>
        )}
        {!hidden.has('help') && (
          <HeaderBtn title={t('sidebar.help')} overflow="help" onClick={help}>
            <HelpIcon size={icon} />
          </HeaderBtn>
        )}
        {compact && (
          <button
            ref={profileBtnRef}
            class="hdr-btn hover:bg-elevated cursor-pointer border-none bg-transparent"
            title={currentProfile?.name ?? '—'}
            onClick={() => setProfileOpen(o => !o)}
          >
            <span
              class="w-7 h-7 rounded-md flex items-center justify-center text-[11px] font-mono font-bold text-accent"
              style="background:rgb(var(--color-accent-ch)/0.18)"
            >{initials}</span>
          </button>
        )}
        <button
          ref={moreRef}
          class={`hdr-btn relative cursor-pointer ${menuOpen ? 'bg-elevated text-primary' : 'text-dim hover:text-primary hover:bg-elevated'}`}
          title={t('header.more')}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(o => !o)}
        >
          <MoreVerticalIcon size={icon} />
          {/* Installing and updating are the entries worth a nudge: both used
              to be filled pills in the bar. Installing only until the entry
              has been used once (installOfferSeen). */}
          {((install && !installOfferSeen.value) || update) && (
            <span class="absolute top-2 right-2 w-2 h-2 rounded-full bg-accent" style="box-shadow:0 0 0 2px var(--color-surface)" />
          )}
        </button>
      </div>

      {menuOpen && (
        <HeaderMenu anchor={moreRef} align="right" onClose={() => setMenuOpen(false)}>
          {/* No separators and no fixed width: one plain list, as wide as its
              longest label (the author's call, 2026-10-23). */}
          <>
            {overflowInMenu.map(id => id === 'search'
              ? <MenuRow key={id} icon={<SearchIcon size={18} />} label={t('header.menu.search')} onClick={fromMenu(search)} />
              : <MenuRow key={id} icon={<HelpIcon size={18} />} label={t('sidebar.help')} onClick={fromMenu(help)} />)}
            {install && (
              <MenuRow
                icon={<InstallIcon size={18} />}
                accent
                dot={!installOfferSeen.value}
                label={t('settings.install')}
                onClick={fromMenu(() => { markInstallSeen(); install(); })}
              />
            )}
            {/* The deployed version is on this device and one tap away. Never
                a modal: the likeliest way to meet it is a tablet resumed from
                sleep in the middle of a live session or a review, and it has to
                wait for the user rather than interrupt them. */}
            {update && (
              <MenuRow
                icon={<UpdateIcon size={18} />}
                accent
                dot
                label={t('update.button')}
                onClick={fromMenu(applyUpdate)}
              />
            )}
            <MenuRow icon={<SettingsIcon size={18} />} label={t('sidebar.settings')} onClick={fromMenu(() => showSettingsModal(ctx))} />
            {/* Last, a row like the others (the author's call, 2026-10-23). The
                logo had no job before; About now also carries sharing the app
                and the community — the job of a share button testers read as
                "share what is selected" (2026-10-22). */}
            <MenuRow icon={<CadenceLogo size={24} glyph />} accent label={t('about.title')} onClick={fromMenu(showAboutModal)} />
          </>
        </HeaderMenu>
      )}

      {profileOpen && (
        <HeaderMenu anchor={profileBtnRef} align={compact ? 'right' : 'center'} onClose={() => setProfileOpen(false)}>
          {(user.profileIds ?? []).map(pid => {
            const profile = user.profiles[pid];
            if (!profile) return null;
            const active = pid === user.currentProfileId;
            return (
              <button
                key={pid}
                class={`w-full flex items-center gap-2 px-3 py-1.5 text-xs rounded-md cursor-pointer border-none bg-transparent text-left transition-colors ${active ? 'text-accent' : 'text-muted hover:bg-surface'}`}
                onClick={() => {
                  setProfileOpen(false);
                  if (pid !== user.currentProfileId) void ctx.mutate(s => { s.currentProfileId = pid; });
                }}
              >
                <div
                  class="w-4 h-4 rounded flex items-center justify-center shrink-0"
                  style={active ? 'background:rgb(var(--color-accent-ch)/0.2)' : 'background:var(--color-border)'}
                >
                  <span class={`text-[8px] font-mono font-bold ${active ? 'text-accent' : 'text-dim'}`}>
                    {initialsOf(profile.name)}
                  </span>
                </div>
                <span class="flex-1 truncate">{profile.name}</span>
                {active && <span class="text-accent flex items-center"><CheckIcon size={11} /></span>}
              </button>
            );
          })}
          <div class="h-px bg-border my-1" />
          <button
            class="w-full flex items-center gap-2 px-3 py-1.5 text-xs rounded-md text-dim hover:text-primary hover:bg-surface cursor-pointer border-none bg-transparent text-left transition-colors"
            onClick={() => { setProfileOpen(false); showProfileModal(ctx); }}
          >
            <span class="flex items-center"><SettingsIcon size={12} /></span>
            {t('sidebar.manageProfiles')}
          </button>
        </HeaderMenu>
      )}

    </header>
  );
}

// ── Bottom nav (portrait phone, or a header in its compact layout) ────────────

function BottomNavBtn({ title, active, disabled, onClick, children }: {
  title: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ComponentChildren;
}) {
  return (
    <button
      class={`flex-1 flex items-center justify-center transition-colors
        ${active ? 'text-accent' : disabled ? 'text-border' : 'text-dim active:text-accent'}`}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function BottomNav({ ctx }: { ctx: AppContext }) {
  const { route, canGoBack, canGoForward } = ctx;
  const homeActive    = route.view === 'folder' && route.folderId === null;
  const libActive     = route.view === 'library';
  const modulesActive = route.view === 'modules' || route.view === 'sessions';
  const pinned        = pinnedModule();

  // The keyboard covers the bar rather than carrying it up (softKeyboard.ts).
  if (softKeyboardOpen.value) return null;

  return (
    // The minimum height counts the system bar's margin on top of the 3.5 rem:
    // `min-h-14` alone included it (border-box), and above a three-button bar
    // that left the icons a 20 px strip (Android 16, 2026-10-09).
    <nav
      class="flex items-stretch border-t border-border bg-surface shrink-0"
      style="padding-bottom: var(--safe-bottom); min-height: calc(3.5rem + var(--safe-bottom))"
    >
      <BottomNavBtn title={t('sidebar.home')} active={homeActive} onClick={() => ctx.navigate({ view: 'folder', folderId: null })}>
        <HomeIcon size={20} />
      </BottomNavBtn>
      <BottomNavBtn title={t('sidebar.library')} active={libActive} onClick={() => ctx.navigate({ view: 'library' })}>
        <LibraryIcon size={20} />
      </BottomNavBtn>
      <BottomNavBtn title={t('sidebar.modules')} active={modulesActive} onClick={() => ctx.navigate({ view: 'modules' })}>
        <ModulesIcon size={20} />
      </BottomNavBtn>
      {/* Between the destinations and the two history controls: it is one of
          the former, and putting it after Back would separate a pair that is
          read as a pair. Six items on a 360 px phone is 60 px each, still past
          the touch floor — and the bar only holds six for someone who asked
          for the sixth. */}
      {pinned && (
        <BottomNavBtn
          title={t(pinned.labelKey)}
          active={isPinnedRouteActive(route, pinned)}
          onClick={() => ctx.navigate(pinned.route)}
        >
          <pinned.Icon size={20} />
        </BottomNavBtn>
      )}
      <BottomNavBtn title={t('sidebar.back')} disabled={!canGoBack} onClick={() => ctx.back()}>
        <ArrowLeftIcon size={20} />
      </BottomNavBtn>
      <BottomNavBtn title={t('sidebar.forward')} disabled={!canGoForward} onClick={() => ctx.forward()}>
        <ArrowRightIcon size={20} />
      </BottomNavBtn>
    </nav>
  );
}
