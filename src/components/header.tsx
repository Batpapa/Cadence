import { useState, useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { AppContext } from '../types';
import { showCommandPalette } from './commandPalette';
import { showHelpModal } from './help';
import { showSettingsModal, showProfileModal } from './settingsModal';
import { t } from '../services/i18nService';
import {
  isDriveFeatureEnabled, getDriveStatus, onStatusChange, manualSync, type DriveStatus,
} from '../services/driveService';
import {
  HomeIcon, LibraryIcon, SearchIcon, HelpIcon, SettingsIcon,
  CloudUpIcon, ChevronDownIcon, CheckIcon, PanelLeftIcon, CadenceLogo,
} from './icons';

const initialsOf = (name: string) =>
  name.split(/[\s-]+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '—';

function NavPill({ label, active, onClick, iconOnly, children }: {
  label: string; active: boolean; onClick: () => void; iconOnly?: boolean; children: ComponentChildren;
}) {
  return (
    <button
      class={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer border-none bg-transparent shrink-0
        ${active ? 'bg-accent/10 text-accent' : 'text-muted hover:text-primary hover:bg-elevated'}`}
      onClick={onClick}
      title={label}
    >
      {children}
      {!iconOnly && <span>{label}</span>}
    </button>
  );
}

function IconBtn({ title, onClick, children }: {
  title: string; onClick: () => void; children: ComponentChildren;
}) {
  return (
    <button
      class="inline-flex items-center text-dim hover:text-primary transition-colors cursor-pointer shrink-0"
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
      class={`inline-flex items-center transition-colors shrink-0 ${cls}`}
      title={t(SYNC_TITLE[status] as Parameters<typeof t>[0])}
      onClick={clickable ? () => void manualSync() : undefined}
    >
      <CloudUpIcon size={13} />
    </button>
  );
}

export function AppHeader({ ctx, sidebarCollapsed, onToggleSidebar }: {
  ctx: AppContext;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}) {
  const { route, user, canGoBack, canGoForward } = ctx;
  const currentProfile = user.profiles[user.currentProfileId];

  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);

  const [driveStatus, setDriveStatus] = useState<DriveStatus>(getDriveStatus);
  useEffect(() => {
    if (!isDriveFeatureEnabled()) return;
    return onStatusChange(setDriveStatus);
  }, []);

  useEffect(() => {
    if (!profileOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (!profileRef.current?.contains(e.target as Node)) setProfileOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [profileOpen]);

  const homeActive = route.view === 'folder' && route.folderId === null;
  const libActive  = route.view === 'library';

  return (
    <header class="relative flex items-center gap-1.5 px-3 h-10 border-b border-border bg-surface shrink-0">
      <div class="flex items-center gap-0.5">
        <button
          class={`flex items-center px-2.5 py-1 rounded-md transition-colors cursor-pointer shrink-0 ${sidebarCollapsed ? 'text-muted hover:text-primary hover:bg-elevated' : 'text-dim hover:text-primary hover:bg-elevated'}`}
          title={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          onClick={onToggleSidebar}
        >
          <PanelLeftIcon size={14} />
        </button>
        <NavPill label={t('sidebar.home')} active={homeActive} iconOnly onClick={() => ctx.navigate({ view: 'folder', folderId: null })}>
          <HomeIcon size={13} />
        </NavPill>
        <NavPill label={t('sidebar.library')} active={libActive} iconOnly onClick={() => ctx.navigate({ view: 'library' })}>
          <LibraryIcon size={13} />
        </NavPill>
      </div>

      <div class="absolute left-1/2 -translate-x-1/2 flex items-center gap-2 pointer-events-none">
        <button
          class={`pointer-events-auto text-xs px-1 transition-colors shrink-0 ${canGoBack ? 'text-dim hover:text-primary cursor-pointer' : 'text-border cursor-default'}`}
          title={t('sidebar.back')}
          disabled={!canGoBack}
          onClick={() => ctx.back()}
        >←</button>
        <span class="text-accent flex items-center select-none">
          <CadenceLogo size={22} />
        </span>
        <button
          class={`pointer-events-auto text-xs px-1 transition-colors shrink-0 ${canGoForward ? 'text-dim hover:text-primary cursor-pointer' : 'text-border cursor-default'}`}
          title={t('sidebar.forward')}
          disabled={!canGoForward}
          onClick={() => ctx.forward()}
        >→</button>
      </div>

      <div class="flex-1" />

      {isDriveFeatureEnabled() && driveStatus !== 'disconnected' && driveStatus !== 'connecting' && (
        <SyncBtn status={driveStatus} />
      )}

      <IconBtn title={t('sidebar.search')} onClick={() => showCommandPalette(() => ctx)}>
        <SearchIcon size={14} />
      </IconBtn>
      <IconBtn title={t('sidebar.help')} onClick={() => showHelpModal(ctx)}>
        <HelpIcon size={14} />
      </IconBtn>
      <IconBtn title={t('sidebar.settings')} onClick={() => showSettingsModal(ctx)}>
        <SettingsIcon size={14} />
      </IconBtn>

      {/* Profile selector */}
      <div ref={profileRef} class="relative ml-0.5">
        <button
          class="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-elevated transition-colors cursor-pointer border-none bg-transparent"
          onClick={() => setProfileOpen(o => !o)}
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

        {profileOpen && (
          <div class="absolute top-full right-0 mt-1 z-30 bg-elevated border border-border rounded-lg overflow-hidden shadow-2xl py-1 min-w-[160px]">
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
        )}
      </div>
    </header>
  );
}
