import { useState, useEffect, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { ComponentChildren } from 'preact';
import type { AppContext } from '../types';
import { showCommandPalette } from './commandPalette';
import { showHelpModal } from './help';
import { showSettingsModal, showProfileModal } from './settingsModal';
import { t } from '../services/i18nService';
import { getZoom } from '../services/zoomService';
import {
  isDriveFeatureEnabled, getDriveStatus, onStatusChange, manualSync, type DriveStatus,
} from '../services/driveService';
import {
  HomeIcon, LibraryIcon, SearchIcon, HelpIcon, SettingsIcon,
  CloudUpIcon, ChevronDownIcon, CheckIcon, PanelLeftIcon, CadenceLogo,
  ArrowLeftIcon, ArrowRightIcon,
} from './icons';

const initialsOf = (name: string) =>
  name.split(/[\s-]+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '—';

function HeaderBtn({ title, active, onClick, children }: {
  title: string; onClick: () => void; active?: boolean; children: ComponentChildren;
}) {
  return (
    <button
      class={`flex items-center px-2 py-1 rounded-md transition-colors cursor-pointer shrink-0
        ${active ? 'bg-accent/10 text-accent' : 'text-dim hover:text-primary hover:bg-elevated'}`}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const SYNC_TITLE: Record<DriveStatus, string> = {
  pending:      'sidebar.sync.pending',
  syncing:      'sidebar.sync.syncing',
  connected:    'sidebar.sync.connected',
  error:        'sidebar.sync.error',
  disconnected: '',
  connecting:   '',
};

function SyncBtn({ status }: { status: DriveStatus }) {
  const cls =
    status === 'pending'   ? 'text-yellow-400 cursor-pointer' :
    status === 'syncing'   ? 'text-accent animate-pulse cursor-default' :
    status === 'connected' ? 'text-green-500 cursor-default' :
                             'text-danger cursor-pointer';
  const clickable = status === 'pending' || status === 'error';
  return (
    <button
      class={`flex items-center px-2 py-1 rounded-md transition-colors shrink-0 ${cls}`}
      title={t(SYNC_TITLE[status] as Parameters<typeof t>[0])}
      onClick={clickable ? () => void manualSync() : undefined}
    >
      <CloudUpIcon size={14} />
    </button>
  );
}

export function AppHeader({ ctx, sidebarCollapsed, onToggleSidebar, isPortraitPhone }: {
  ctx: AppContext;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  isPortraitPhone: boolean;
}) {
  const { route, user, canGoBack, canGoForward } = ctx;
  const currentProfile = user.profiles[user.currentProfileId];

  const [profileOpen, setProfileOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const profileRef    = useRef<HTMLDivElement>(null);
  const profileBtnRef = useRef<HTMLButtonElement>(null);
  const dropdownRef   = useRef<HTMLDivElement>(null);

  const toggleProfileOpen = () => {
    if (!profileOpen) {
      const rect = profileBtnRef.current?.getBoundingClientRect();
      if (rect) {
        // `document.documentElement` has a CSS `zoom` applied (zoomService); the portaled
        // dropdown stays a descendant of it, so its fixed top/left get re-scaled by that
        // zoom on render. Pre-divide by the factor to compensate.
        const factor = getZoom() / 100;
        setDropdownPos({ top: (rect.bottom + 4) / factor, left: (rect.left + rect.width / 2) / factor });
      }
    }
    setProfileOpen(o => !o);
  };

  const [driveStatus, setDriveStatus] = useState<DriveStatus>(getDriveStatus);
  useEffect(() => {
    if (!isDriveFeatureEnabled()) return;
    return onStatusChange(setDriveStatus);
  }, []);

  useEffect(() => {
    if (!profileOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (profileRef.current?.contains(e.target as Node)) return;
      if (dropdownRef.current?.contains(e.target as Node)) return;
      setProfileOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [profileOpen]);

  const homeActive = route.view === 'folder' && route.folderId === null;
  const libActive  = route.view === 'library';

  return (
    <header class="relative flex items-center px-2 h-10 border-b border-border bg-surface shrink-0">

      {/* Left group */}
      <div class="flex items-center gap-1">
        <HeaderBtn title={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')} onClick={onToggleSidebar}>
          <PanelLeftIcon size={14} />
        </HeaderBtn>
        {!isPortraitPhone && (
          <>
            <HeaderBtn title={t('sidebar.home')} active={homeActive} onClick={() => ctx.navigate({ view: 'folder', folderId: null })}>
              <HomeIcon size={14} />
            </HeaderBtn>
            <HeaderBtn title={t('sidebar.library')} active={libActive} onClick={() => ctx.navigate({ view: 'library' })}>
              <LibraryIcon size={14} />
            </HeaderBtn>
          </>
        )}
      </div>

      {/* Center: ← logo profil → */}
      <div class="absolute left-1/2 -translate-x-1/2 flex items-center gap-1 pointer-events-none">
        {!isPortraitPhone && (
          <button
            class={`pointer-events-auto flex items-center px-2 py-1 rounded-md transition-colors shrink-0 ${canGoBack ? 'text-dim hover:text-primary hover:bg-elevated cursor-pointer' : 'text-border cursor-default'}`}
            title={t('sidebar.back')}
            disabled={!canGoBack}
            onClick={() => ctx.back()}
          ><ArrowLeftIcon size={14} /></button>
        )}

        <span class="text-accent flex items-center select-none">
          <CadenceLogo size={22} />
        </span>

        <div ref={profileRef} class="relative pointer-events-auto">
          <button
            ref={profileBtnRef}
            class="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-elevated transition-colors cursor-pointer border-none bg-transparent"
            onClick={toggleProfileOpen}
          >
            <div
              class="w-5 h-5 rounded flex items-center justify-center shrink-0"
              style="background:rgb(var(--color-accent-ch)/0.18)"
            >
              <span class="text-[9px] font-mono font-bold text-accent">{initialsOf(currentProfile?.name ?? '—')}</span>
            </div>
            <span class="text-xs text-primary font-medium max-w-[100px] truncate">{currentProfile?.name ?? '—'}</span>
            <span class="text-dim flex items-center"><ChevronDownIcon size={10} /></span>
          </button>

          {profileOpen && dropdownPos && createPortal((
            <div
              ref={dropdownRef}
              class="fixed -translate-x-1/2 z-30 bg-elevated border border-border rounded-lg overflow-hidden shadow-2xl py-1 min-w-[160px]"
              style={{ top: `${dropdownPos.top}px`, left: `${dropdownPos.left}px` }}
            >
              {(user.profileIds ?? []).map(pid => {
                const profile = user.profiles[pid];
                if (!profile) return null;
                const active = pid === user.currentProfileId;
                return (
                  <button
                    key={pid}
                    class={`w-full flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer border-none bg-transparent text-left transition-colors ${active ? 'text-accent' : 'text-muted hover:bg-surface'}`}
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
                class="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-dim hover:text-primary hover:bg-surface cursor-pointer border-none bg-transparent text-left transition-colors"
                onClick={() => { setProfileOpen(false); showProfileModal(ctx); }}
              >
                <span class="flex items-center"><SettingsIcon size={12} /></span>
                {t('sidebar.manageProfiles')}
              </button>
            </div>
          ), document.body)}
        </div>

        {!isPortraitPhone && (
          <button
            class={`pointer-events-auto flex items-center px-2 py-1 rounded-md transition-colors shrink-0 ${canGoForward ? 'text-dim hover:text-primary hover:bg-elevated cursor-pointer' : 'text-border cursor-default'}`}
            title={t('sidebar.forward')}
            disabled={!canGoForward}
            onClick={() => ctx.forward()}
          ><ArrowRightIcon size={14} /></button>
        )}
      </div>

      <div class="flex-1" />

      {/* Right group */}
      <div class="flex items-center gap-1">
        {isDriveFeatureEnabled() && driveStatus !== 'disconnected' && driveStatus !== 'connecting' && (
          <SyncBtn status={driveStatus} />
        )}
        <HeaderBtn title={t('sidebar.search')} onClick={() => showCommandPalette(() => ctx)}>
          <SearchIcon size={14} />
        </HeaderBtn>
        <HeaderBtn title={t('sidebar.help')} onClick={() => showHelpModal(ctx)}>
          <HelpIcon size={14} />
        </HeaderBtn>
        <HeaderBtn title={t('sidebar.settings')} onClick={() => showSettingsModal(ctx)}>
          <SettingsIcon size={14} />
        </HeaderBtn>
      </div>

    </header>
  );
}

// ── Bottom nav (portrait phone) ─────────────────────────────────────────────────

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
  const homeActive = route.view === 'folder' && route.folderId === null;
  const libActive  = route.view === 'library';

  return (
    <nav class="flex items-stretch border-t border-border bg-surface shrink-0 h-14" style="padding-bottom: env(safe-area-inset-bottom)">
      <BottomNavBtn title={t('sidebar.home')} active={homeActive} onClick={() => ctx.navigate({ view: 'folder', folderId: null })}>
        <HomeIcon size={20} />
      </BottomNavBtn>
      <BottomNavBtn title={t('sidebar.library')} active={libActive} onClick={() => ctx.navigate({ view: 'library' })}>
        <LibraryIcon size={20} />
      </BottomNavBtn>
      <BottomNavBtn title={t('sidebar.back')} disabled={!canGoBack} onClick={() => ctx.back()}>
        <ArrowLeftIcon size={20} />
      </BottomNavBtn>
      <BottomNavBtn title={t('sidebar.forward')} disabled={!canGoForward} onClick={() => ctx.forward()}>
        <ArrowRightIcon size={20} />
      </BottomNavBtn>
    </nav>
  );
}
